import React,{useEffect,useRef,useState} from 'react';
import {createChatPlayer,createSpeechOutputManager} from './browser.mjs';
import {createHostVoiceCapture} from './capture.mjs';

const h=React.createElement;
const rates={breeze:24000,gpt:48000,minimax:32000};
const titles={'ai-buddy.voice-breeze':'Breeze','ai-buddy.voice-gpt-sovits':'GPT-SoVITS'};
const stateText={idle:'就绪',preparing:'准备麦克风',recording:'录音中',listening:'正在听',processing:'识别中','waiting-playback':'等待回复播放完毕','waiting-configuration':'需要配置'};
const base64=bytes=>{if(typeof bytes==='string')return bytes;let out='';for(const value of bytes)out+=String.fromCharCode(value);return btoa(out);};
const rendererOutputs=new WeakMap();
const matchesChat=(scope,envelope)=>!!scope&&!!envelope&&scope.channel===envelope.channel&&scope.personaId===envelope.personaId&&scope.conversationId===envelope.conversationId&&(scope.channel==='app-group'||scope.characterId===envelope.characterId);

// The trusted dashboard owns playback; page hooks only observe it and own capture.
export function ensureVoiceOutput(api=globalThis.whale?.voice,{createContext}={}){
  if(!api)return null;
  if(rendererOutputs.has(api))return rendererOutputs.get(api);
  const subscribers=new Set(),events=new Set(),requests=new Map(),retired=new Set();
  const terminal=new Set(['audioCompleted','explicitlySkipped','interrupted','failed']);
  let owners=0,closed=false,active,scope,subtitle=null,speaking=false,error=null;
  const notify=()=>{for(const row of subscribers){const matches=matchesChat(row.scope,scope);row.listener({subtitle:matches?subtitle:null,speaking:matches&&speaking,error:matches?error:null});}};
  const action=(...args)=>api.action(...args);
  const onError=value=>{error=String(value?.message??value);notify();};
  const retire=id=>{retired.add(id);if(retired.size>32)retired.delete(retired.values().next().value);};
  const playback=createVoicePlayback({createContext,action:async(op,value)=>{
    if(op!=='receipt')return action(op,value);
    const row=requests.get(value.envelope?.requestId),key=value.envelope?.segmentId+':'+value.status;
    if(!row||row.cancelled||row.receipts.has(key)||row.terminal.has(value.envelope.segmentId))return {accepted:false};
    row.receipts.add(key);if(terminal.has(value.status))row.terminal.add(value.envelope.segmentId);
    return action(op,value);
  },
    onSubtitle:value=>{subtitle=value;if(value)scope=value.envelope;notify();},
    onBusy:(value,envelope)=>{speaking=value;if(envelope){scope=envelope;error=null;}notify();},onError,
    onDrained:({requestId})=>{if(active?.id!==requestId)return;requests.delete(requestId);retire(requestId);active=undefined;playback.reset();advance();},
    onFailure:envelope=>{if(envelope)void cancel(row=>row.id===envelope.requestId,'failed').catch(onError);}});
  function advance(){
    if(active||closed)return;
    active=requests.values().next().value;if(!active)return;
    for(const event of active.events.splice(0))void playback.handle(event).catch(()=>{});
  }
  function cancel(predicate,status='interrupted'){
    const removed=[...requests.values()].filter(predicate),receipts=[];
    for(const row of removed){row.cancelled=true;requests.delete(row.id);retire(row.id);}
    if(removed.includes(active)){active=undefined;playback.reset();}
    for(const row of removed)for(const envelope of row.segments.values()){
      if(row.terminal.has(envelope.segmentId))continue;row.terminal.add(envelope.segmentId);
      receipts.push(action('receipt',{envelope,status}));
    }
    advance();return Promise.allSettled(receipts);
  }
  const inChannel=(channel,row)=>channel==='all'||(channel==='card-table'?row.envelope.channel==='card-table':['app-private','app-group',undefined].includes(row.envelope.channel));
  function accept(event){
    if(closed)return Promise.resolve();
    if(event.type==='invalidate')return cancel(row=>inChannel(event.channel??'app-chat',row));
    const id=event.envelope?.requestId??event.requestId;
    if(!id||retired.has(id))return Promise.resolve();
    let row=requests.get(id);
    if(event.type==='segment'&&event.state==='failed'||event.type==='turn'&&event.failed){
      if(event.message)onError(Error(event.message));return cancel(value=>value.id===id,event.type==='segment'?'failed':'interrupted');
    }
    if(event.type==='segment'&&event.state==='queued'){
      if(!row){
        // The controller admits at most 2 inflight + 3 queued segments, plus one card request.
        if(requests.size>=6){retire(id);return action('receipt',{envelope:event.envelope,status:'failed'});}
        row={id,envelope:event.envelope,events:[],segments:new Map(),receipts:new Set(),terminal:new Set(),cancelled:false};requests.set(id,row);
      }
      if(row.segments.has(event.envelope.segmentId))return Promise.resolve();
      row.segments.set(event.envelope.segmentId,event.envelope);
    }else if(event.type!=='audio'&&!(event.type==='turn'&&event.state==='generated'))return Promise.resolve();
    if(!row)return Promise.resolve();
    if(active===row)return playback.handle(event).catch(()=>{});
    row.events.push(event);advance();return Promise.resolve();
  }
  const off=api.onEvent(event=>{for(const listener of events)listener(event);return accept(event).catch(onError);});
  const output={
    retain(){if(closed)throw Error('配音输出已关闭。');owners++;let released=false;return async()=>{if(released)return;released=true;if(--owners===0)await output.close();};},
    subscribe(expected,listener){const row={scope:expected,listener};subscribers.add(row);const matches=matchesChat(expected,scope);listener({subtitle:matches?subtitle:null,speaking:matches&&speaking,error:matches?error:null});return()=>subscribers.delete(row);},
    onEvent(listener){events.add(listener);return()=>events.delete(listener);},
    prepare:rate=>playback.prepare(rate),
    stopChat:async()=>{await Promise.all([cancel(row=>inChannel('app-chat',row)),action('stop',{channel:'app-chat'})]);},
    stop:async()=>{await Promise.all([cancel(()=>true),action('stop')]);},
    async close(){if(closed)return;closed=true;rendererOutputs.delete(api);off?.();await cancel(()=>true);subscribers.clear();events.clear();await playback.close();}
  };
  rendererOutputs.set(api,output);return output;
}

export function useVoiceOutput(){
  const api=globalThis.whale?.voice;
  useEffect(()=>{const release=ensureVoiceOutput(api)?.retain();return()=>{void release?.();};},[api]);
}

export function createVoicePlayback({action,onSubtitle=()=>{},onBusy=()=>{},onError=()=>{},onDrained=()=>{},onFailure=()=>{},createContext}){
  const outputs=createSpeechOutputManager(createContext),envelopes=new Map(),segments=new Map(),displayReceipts=new Map();
  let player,requestId,currentEnvelope,generation=0,tail=Promise.resolve(),finished=false;
  function clear(){player?.stop();player=undefined;requestId=currentEnvelope=undefined;finished=false;envelopes.clear();segments.clear();displayReceipts.clear();onSubtitle(null);onBusy(false);}
  function reset(){generation++;outputs.invalidate();clear();}
  function register(segment){
    const envelope=segment.envelope;
    if(envelopes.has(envelope.index))return;
    envelopes.set(envelope.index,envelope);
    player.accept({type:'segment',requestId,index:envelope.index,text:segment.text??'',speech_text:segment.speech_text??segment.speechText??segment.text??'',envelope});
  }
  function handle(event){
    if(event.type==='invalidate'){reset();return Promise.resolve();}
    const ticket=generation;
    const operation=tail.then(async()=>{
      if(ticket!==generation)return;
      const envelope=event.envelope;
      if(event.type==='segment'&&event.state==='failed'){
        await action('receipt',{envelope,status:'failed'});reset();await action('stop');onError(Error(event.message??'配音失败，回复文字已保留'));return;
      }
      if(event.type==='segment'&&event.state==='queued'){
        if(requestId&&requestId!==envelope.requestId)clear();
        requestId=envelope.requestId;currentEnvelope=envelope;
        const segment={...event,...event.segment,envelope};
        segments.set(envelope.segmentId,segment);onBusy(true,envelope);if(player)register(segment);return;
      }
      if(event.type==='turn'&&event.state==='generated'){
        if(event.failed){if(requestId===event.requestId)reset();return;}
        if(requestId===event.requestId){finished=true;player?.accept({type:'generated',requestId});}return;
      }
      if(event.type!=='audio'||!envelope)return;
      if(requestId&&requestId!==envelope.requestId)clear();
      requestId=envelope.requestId;currentEnvelope=envelope;
      const rate=event.sampleRate??event.sample_rate??event.outputSampleRate;
      // Start metadata is a prediction; wait for the first PCM's actual rate.
      if(event.phase==='start'){
        segments.set(envelope.segmentId,{...segments.get(envelope.segmentId),...event});
        return;
      }
      if(event.phase==='pcm'&&player&&outputs.current()?.sampleRate!==rate)throw Error('配音采样率在播放中改变，已停止；文字保留');
      if(!player){
        const context=await outputs.prepare(rate??segments.get(envelope.segmentId)?.sampleRate??32000);
        if(!context||ticket!==generation)return;
        player=createChatPlayer({context,
          onDisplay:segment=>{onSubtitle(segment);const pending=action('receipt',{envelope:segment.envelope,status:'textDisplayed'}).then(()=>segment.speech_text.trim()?action('receipt',{envelope:segment.envelope,status:'audioStarted'}):undefined);displayReceipts.set(segment.envelope.segmentId,pending);void pending.catch(onError);},
          onPlayed:async({index})=>{const env=envelopes.get(index),segment=segments.get(env?.segmentId);await displayReceipts.get(env?.segmentId);if(env&&envelopes.get(index)===env)await action('receipt',{envelope:env,status:(segment?.speech_text??segment?.speechText??segment?.text??'').trim()?'audioCompleted':'explicitlySkipped'});},
          onDrained:()=>{onSubtitle(null);onBusy(false);onDrained({requestId});},onError,onBlocked:blocked=>{if(blocked)onError(Error('请点击语音按钮允许播放音频'));}});
        player.accept({type:'start',requestId});
        for(const segment of [...segments.values()].filter(row=>row.envelope.requestId===requestId).sort((a,b)=>a.envelope.index-b.envelope.index))register(segment);
      }
      if(!envelopes.has(envelope.index)){
        const segment=segments.get(envelope.segmentId)??event;
        register({...segment,envelope});
      }
      if(event.phase==='pcm')player.accept({type:'pcm',requestId,index:envelope.index,pcm:base64(event.pcm),sample_rate:rate});
      if(event.phase==='end')player.accept({type:'segment_done',requestId,index:envelope.index});
      if(finished)player.accept({type:'generated',requestId});
    });
    tail=operation.catch(error=>{const envelope=currentEnvelope;reset();onError(error);void action('stop',{channel:envelope?.channel==='card-table'?'card-table':'app-chat'}).catch(()=>{});onFailure(envelope);});return operation;
  }
  return {handle,reset,prepare:rate=>outputs.prepare(rate),close:async()=>{reset();await outputs.close();}};
}

export function useVoiceClient(scopeKey,onDraft){
  const [state,setState]=useState(null),[captureState,setCaptureState]=useState('idle'),[partial,setPartial]=useState(''),[subtitle,setSubtitle]=useState(null),[speaking,setSpeaking]=useState(false),[error,setError]=useState(''),[working,setWorking]=useState(false);
  const draft=useRef(onDraft);draft.current=onDraft;
  const api=globalThis.whale?.voice,session=useRef(null);
  const refresh=async()=>{if(api)setState(await api.action('state'));};
  useEffect(()=>{
    if(!api)return;
    const action=(...args)=>api.action(...args),onError=error=>setError(String(error?.message??error));
    const output=ensureVoiceOutput(api);
    const capture=createHostVoiceCapture({action,onState:setCaptureState,onError});
    session.current={output,capture};
    const off=output.onEvent(event=>{
      if(event.type==='draft')draft.current?.(event);
      if(event.type==='capture'){setCaptureState(event.state);if(event.partial)setPartial(event.partial);if(event.state==='idle')setPartial('');}
      if(event.type==='status'&&event.message)setError(event.message);
      if(event.type==='state')setState(event.state);
      if(event.channel!=='card-table')capture.event(event);
    });
    const plugins=globalThis.whale?.plugins?.onUpdate(()=>void refresh().catch(onError));
    void refresh().catch(onError);
    return()=>{off?.();plugins?.();capture.release();session.current=null;};
  },[api]);
  useEffect(()=>{
    const current=session.current;if(!current)return;
    const [characterId,personaId,conversationId,groupId]=String(scopeKey??'').split(':');
    const expected={characterId,personaId,conversationId:groupId||conversationId,channel:groupId?'app-group':'app-private'};
    setSubtitle(null);setSpeaking(false);setPartial('');current.capture.release();
    const off=current.output.subscribe(expected,value=>{setSubtitle(value.subtitle);setSpeaking(value.speaking);if(value.error)setError(value.error);});
    if(api)void refresh().catch(()=>{});
    return()=>{off();current.capture.release();void current.output.stopChat().catch(()=>{});};
  },[api,scopeKey]);
  async function perform(fn){setWorking(true);setError('');try{return await fn();}catch(error){setError(String(error?.message??error));}finally{setWorking(false);await refresh().catch(()=>{});}}
  const configure=patch=>perform(async()=>{
    const next=patch.selectedPackageId??state?.selectedPackageId,options=patch.packages?.[next]??state?.settings?.packages?.[next];
    await session.current?.output.prepare(options?.ttsProvider==='minimax'?32000:rates[next?.includes('gpt')?'gpt':'breeze']);
    await api.action('configure',patch);
  });
  const controls=h(VoiceControls,{state,error,working,captureState,partial,
    configure,perform,action:(...args)=>api?.action(...args),
    onRecord:()=>perform(()=>session.current.capture.start('record')),
    onFinish:()=>perform(()=>session.current.capture.finish()),
    onLive:()=>perform(()=>session.current.capture.start('live')),
    onStop:()=>perform(async()=>{session.current.capture.release();await session.current.output.stop();})});
  return {controls,subtitle,speaking};
}

function VoiceControls({state,error,working,captureState,partial,configure,perform,action,onRecord,onFinish,onLive,onStop}){
  const [key,setKey]=useState(''),[text,setText]=useState('');
  if(!state)return h('span',{role:'status',className:'buddy-voice'},'正在检查语音插件与组件…');
  const id=state.selectedPackageId,options=state.settings.packages[id],installed=state.packages.filter(row=>row.installed),enabled=state.settings.enabled;
  const ready=state.packages.find(row=>row.id===id)?.usable&&enabled;
  const idle=captureState==='idle',button=(label,fn,disabled=false)=>h('button',{type:'button',className:'gx-gbtn',disabled:disabled||working,onClick:fn},label);
  return h('div',{className:'buddy-voice',style:{display:'flex',flexWrap:'wrap',gap:6,alignItems:'center',fontSize:12},'data-voice-controls':true},
    installed.length?button(enabled?'语音已开启':'开启语音',()=>configure({enabled:!enabled})):button('安装语音插件',()=>globalThis.whale.open('plugins')),
    ready&&h(React.Fragment,null,button(captureState==='recording'?'结束录音到草稿':'录音输入',captureState==='recording'?onFinish:onRecord,!idle&&captureState!=='recording'),button('Live 轮流交谈',onLive,!idle),button('停止并释放',onStop)),
    h('span',{role:'status'},partial||stateText[captureState]||captureState),
    h('details',{style:{maxWidth:'100%',position:'relative'}},h('summary',{style:{cursor:'pointer'}},'语音设置'),
      h('div',{style:{display:'grid',gap:8,padding:10,maxHeight:'40vh',overflow:'auto',background:'var(--buddy-surface)',border:'1px solid var(--buddy-border)',borderRadius:8}},
        h('label',null,'插件 ',h('select',{'aria-label':'配音插件',value:id,onChange:e=>configure({selectedPackageId:e.target.value})},...Object.entries(titles).map(([value,label])=>h('option',{key:value,value,disabled:!installed.some(row=>row.id===value)},label)))),
        h('label',null,'配音方式 ',h('select',{'aria-label':'配音方式',value:options.ttsProvider,onChange:e=>configure({packages:{[id]:{ttsProvider:e.target.value}}})},h('option',{value:'local'},'本地配音'),h('option',{value:'minimax'},'MiniMax 云配音'))),
        h('span',null,'识别：本地流式 · 录音保存草稿；Live 播完再听'),
        h('span',null,'当前角色声音：',state.profile?.label??'待导入'),
        h('label',null,'参考音逐字稿 ',h('input',{value:text,onChange:e=>setText(e.target.value),'aria-label':'参考音逐字稿'})),
        button('选择并导入当前角色平静参考音',()=>perform(()=>action('profile-import',{text,label:'我的声音'})),!text.trim()),
        options.ttsProvider==='minimax'?h(React.Fragment,null,
          h('label',null,'MiniMax API Key ',h('input',{type:'password',autoComplete:'off',value:key,onChange:e=>setKey(e.target.value),'aria-label':'MiniMax API Key',placeholder:options.credentialRef?'已保存，可更换':'只需填写 API Key'})),
          button('保存 API Key（两插件共用）',()=>perform(async()=>{await action('save-key',{key});setKey('');}),!key.trim()),
          h('span',{role:'status'},state.cloud?.state==='ready'?'当前角色云音色已绑定':'当前角色云音色待准备'),
          button('上传当前角色参考音并准备云音色',()=>{if(globalThis.confirm('将当前角色的完整参考音和逐字稿上传至 MiniMax，准备该角色云音色。是否继续？'))void perform(()=>action('cloud-prepare',{consentUpload:true}));},!options.credentialRef||!state.profile)):
          h('span',null,'本地配音组件：',state.assets.tts.state==='ready'?'已准备，使用前复核':state.assets.tts.state),
        button('准备本地识别组件',()=>perform(()=>action('assets-prepare',{kind:'asr'}))),
        options.ttsProvider==='local'&&button('准备所选本地配音组件',()=>perform(()=>action('assets-prepare',{kind:state.engine}))))),
    error&&h('span',{role:'alert',style:{color:'var(--buddy-danger,#d66)'}},error));
}
