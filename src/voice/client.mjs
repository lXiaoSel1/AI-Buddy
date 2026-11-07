import React,{useEffect,useRef,useState} from 'react';
import {createChatPlayer,createSpeechOutputManager} from './browser.mjs';
import {createHostVoiceCapture} from './capture.mjs';
import {t} from '../i18n.mjs';

const h=React.createElement;
const rates={breeze:24000,gpt:48000,minimax:32000};
const titles={'ai-buddy.voice-breeze':'Breeze','ai-buddy.voice-gpt-sovits':'GPT-SoVITS'};
const stateText={idle:'尚未开始录音',preparing:'正在准备模型与麦克风…',recording:'录音中',listening:'Live 已开启 · 正在听',processing:'识别中','waiting-playback':'等待回复播放完毕','waiting-configuration':'需要配置'};
const base64=bytes=>{if(typeof bytes==='string')return bytes;let out='';for(const value of bytes)out+=String.fromCharCode(value);return btoa(out);};
const rendererOutputs=new WeakMap();
const matchesChat=(scope,envelope)=>!!scope&&!!envelope&&scope.channel===envelope.channel&&scope.personaId===envelope.personaId&&scope.conversationId===envelope.conversationId&&(scope.channel==='app-group'||scope.characterId===envelope.characterId);

export function voiceDialogueState(presentation,requestId){
  const pending=presentation?.requests?.find(row=>row.requestId===requestId);
  if(!pending)return null;
  const subtitle=pending.subtitle?.envelope?.requestId===requestId?pending.subtitle:null;
  return {waiting:!subtitle,subtitle};
}

export function VoiceDialogueLine({presentation,requestId,children,...props}){
  const current=voiceDialogueState(presentation,requestId);
  return h('div',{...props,...(current?{'data-voice-subtitle':!!current.subtitle,'data-voice-waiting':current.waiting,'aria-busy':current.waiting}:{} )},
    current?.waiting?h('span',{role:'status'},t('正在准备配音…')):current?.subtitle?.text??children);
}

// The trusted dashboard owns playback; page hooks only observe it and own capture.
export function ensureVoiceOutput(api=globalThis.whale?.voice,{createContext}={}){
  if(!api)return null;
  if(rendererOutputs.has(api))return rendererOutputs.get(api);
  const subscribers=new Set(),events=new Set(),requests=new Map(),retired=new Set();
  const terminal=new Set(['audioCompleted','explicitlySkipped','interrupted','failed']);
  let owners=0,closed=false,active,scope,subtitle=null,speaking=false,error=null;
  const snapshot=expected=>{const matches=matchesChat(expected,scope);return {subtitle:matches?subtitle:null,speaking:matches&&speaking,error:matches?error:null,
    requests:[...requests.values()].filter(row=>matchesChat(expected,row.envelope)).map(row=>({requestId:row.id,envelope:row.envelope,subtitle:active===row&&subtitle?.envelope?.requestId===row.id?subtitle:null}))};};
  const notify=()=>{for(const row of subscribers)row.listener(snapshot(row.scope));};
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
    advance();notify();return Promise.allSettled(receipts);
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
    if(event.type==='turn'&&event.state==='admitted'){
      if(!row){if(requests.size>=6){retire(id);return Promise.resolve();}row={id,envelope:event.envelope,events:[],segments:new Map(),receipts:new Set(),terminal:new Set(),cancelled:false};requests.set(id,row);}
      notify();return Promise.resolve();
    }
    if(event.type==='turn'&&event.state==='generated'&&row&&!row.segments.size){requests.delete(id);retire(id);if(active===row)active=undefined;notify();advance();return Promise.resolve();}
    if(event.type==='segment'&&event.state==='queued'){
      if(!row){
        // The controller admits at most 2 inflight + 3 queued segments, plus one card request.
        if(requests.size>=6){retire(id);return action('receipt',{envelope:event.envelope,status:'failed'});}
        row={id,envelope:event.envelope,events:[],segments:new Map(),receipts:new Set(),terminal:new Set(),cancelled:false};requests.set(id,row);
      }
      if(row.segments.has(event.envelope.segmentId))return Promise.resolve();
      row.segments.set(event.envelope.segmentId,event.envelope);
      notify();
    }else if(event.type!=='audio'&&!(event.type==='turn'&&event.state==='generated'))return Promise.resolve();
    if(!row)return Promise.resolve();
    if(active===row)return playback.handle(event).catch(()=>{});
    row.events.push(event);advance();return Promise.resolve();
  }
  const off=api.onEvent(event=>{for(const listener of events)listener(event);return accept(event).catch(onError);});
  const output={
    retain(){if(closed)throw Error('配音输出已关闭。');owners++;let released=false;return async()=>{if(released)return;released=true;if(--owners===0)await output.close();};},
    subscribe(expected,listener){const row={scope:expected,listener};subscribers.add(row);listener(snapshot(expected));return()=>subscribers.delete(row);},
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
  useEffect(()=>{const release=ensureVoiceSession(api)?.retain();return()=>{void release?.();};},[api]);
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

const rendererSessions=new WeakMap();
export function ensureVoiceSession(api=globalThis.whale?.voice,{createContext,captureOptions={}}={}){
  if(!api)return null;
  if(rendererSessions.has(api))return rendererSessions.get(api);
  const output=ensureVoiceOutput(api,{createContext}),subscribers=new Set(),draftListeners=new Set(),drafts=[];
  let value={state:null,captureState:'idle',partial:'',error:'',working:false,pendingDraft:null},revision=0,generation=0,operations=0,owners=0;
  const publish=patch=>{value={...value,...patch};for(const listener of subscribers)listener(value);};
  const onError=error=>publish({error:String(error?.message??error)});
  const action=(...args)=>api.action(...args);
  const capture=createHostVoiceCapture({...captureOptions,action,onState:captureState=>publish({captureState,...(captureState==='idle'?{partial:''}:{})}),onError});
  async function refresh(){const ticket=revision;const state=await action('state');if(ticket===revision){publish({state});if(drafts.length)deliverDrafts();}return state;}
  function deliverDrafts(){const trusted=value.state?.scope;for(let i=0;i<drafts.length;){const event=drafts[i],listener=trusted&&[...draftListeners].find(row=>matchesChat(row.scope,event.scope)&&matchesChat(row.scope,trusted)&&['lifeId','operationId'].every(key=>!trusted[key]||trusted[key]===event.scope?.[key]));if(!listener){i++;continue;}listener.callback(event);drafts.splice(i,1);}publish({pendingDraft:drafts.at(-1)??null});}
  const off=output.onEvent(event=>{
    if(event.type==='invalidate'&&event.reason==='scope-changed'&&event.channel!=='card-table'){generation++;revision++;}
    if(event.type==='state'){revision++;publish({state:event.state,...(event.state.preparation?.state==='ready'?{error:''}:{})});if(drafts.length)deliverDrafts();}
    if((event.type==='error'||event.type==='status')&&event.message)onError(event);
    if(event.type==='draft'){drafts.push(event);deliverDrafts();}
    if(event.type==='capture'&&event.partial)publish({partial:event.partial});
    // A host listening event authorizes microphone acquisition; the browser
    // capture adapter reports listening only after its graph is really active.
    if(event.channel!=='card-table')capture.event(event);
  });
  const plugins=globalThis.whale?.plugins?.onUpdate(()=>void refresh().catch(onError));
  async function perform(fn){const ticket=generation;operations++;publish({working:true,error:''});try{return await fn();}catch(error){if(ticket===generation)onError(error);}finally{operations--;publish({working:operations>0});await refresh().catch(onError);}}
  const rate=patch=>{const id=patch?.selectedPackageId??value.state?.selectedPackageId,options={...value.state?.settings?.packages?.[id],...patch?.packages?.[id]};return options.ttsProvider==='minimax'?rates.minimax:rates[id?.includes('gpt')?'gpt':'breeze'];};
  const session={output,snapshot:()=>value,
    subscribe(listener){subscribers.add(listener);listener(value);return()=>subscribers.delete(listener);},
    onDraft(scope,callback){const row={scope,callback};draftListeners.add(row);deliverDrafts();return()=>draftListeners.delete(row);},
    refresh,
    configure(patch){const ticket=++generation;const enabled=patch.enabled??value.state?.settings?.enabled;
      // Call before IPC so AudioContext authorization belongs to this click.
      const unlocked=enabled?output.prepare(rate(patch)):Promise.resolve();
      if(!enabled)capture.release();
      return perform(async()=>{await unlocked;if(ticket!==generation)return;await action('configure',patch);if(ticket!==generation)return;if(enabled)await action('prepare',{target:'speech'});});
    },
    start(mode){const ticket=++generation,unlocked=output.prepare(rate());publish({captureState:'preparing'});
      return perform(async()=>{try{await unlocked;if(ticket!==generation)return;if(mode==='live')await action('prepare',{target:'live'});if(ticket!==generation)return;return await capture.start(mode);}catch(error){if(ticket===generation)capture.release();throw error;}});
    },
    finish:()=>perform(()=>capture.finish()),
    stop(){generation++;capture.release();return perform(()=>output.stop());},
    runAction:(op,payload)=>perform(()=>action(op,payload)),
    retain(){const releaseOutput=output.retain();owners++;let released=false;return async()=>{
      if(released)return;released=true;
      if(--owners===0){
        generation++;
        if(rendererSessions.get(api)===session)rendererSessions.delete(api);
        off();plugins?.();subscribers.clear();draftListeners.clear();capture.release();
      }
      await releaseOutput();
    };},
  };
  rendererSessions.set(api,session);return session;
}

function useVoiceSession(){
  const api=globalThis.whale?.voice,session=useRef(null),[snapshot,setSnapshot]=useState(null);
  useEffect(()=>{const current=ensureVoiceSession(api);session.current=current;if(!current)return;const off=current.subscribe(setSnapshot);void current.refresh().catch(()=>{});return()=>{off();session.current=null;};},[api]);
  return {session,snapshot};
}

export function voiceStatus(snapshot){
  const {state,captureState='idle',working,error}=snapshot??{};
  if(error)return t(error);
  if(!state)return t('正在检查语音插件与组件…');
  if(!state.settings?.enabled)return t('语音已关闭');
  const preparation=state.preparation??{state:'idle'},labels={checking:'正在检查语音配置…',verifying:'正在校验语音组件…',loading:'正在加载语音模型…',ready:'语音模型已就绪',failed:'语音启动失败，请检查设置',stopping:'正在停止并释放语音…',idle:working?'正在准备语音…':'语音尚未启动'};
  if(['checking','verifying','loading','failed','stopping'].includes(preparation.state))return t(labels[preparation.state]);
  if(captureState!=='idle')return t(stateText[captureState]??captureState);
  return t(labels[preparation.state]??'正在准备语音…');
}

export function VoiceToggle({snapshot,onToggle}){
  const state=snapshot?.state,enabled=state?.settings?.enabled===true,phase=state?.preparation?.state??'idle',loading=enabled&&phase!=='ready',cold=enabled&&['idle','failed'].includes(phase)&&!snapshot?.working&&(!snapshot?.captureState||snapshot.captureState==='idle');
  return h('div',{className:'buddy-voice',style:{display:'flex',flexWrap:'wrap',gap:6,alignItems:'center',fontSize:12},'data-voice-controls':true},
    h('button',{type:'button',role:'switch','aria-checked':enabled&&!cold,'aria-label':t('语音总开关'),className:'gx-gbtn',disabled:!state||!enabled&&snapshot?.working,onClick:()=>onToggle?.(cold||!enabled)},t(cold?'启动语音':enabled?(loading?'关闭语音':'语音已开启'):'开启语音')),
    h('span',{role:snapshot?.error||state?.preparation?.state==='failed'?'alert':'status','aria-live':'polite'},voiceStatus(snapshot)));
}

export function useVoiceClient(scopeKey,onDraft){
  const {session,snapshot}=useVoiceSession(),[presentation,setPresentation]=useState({subtitle:null,speaking:false,requests:[]}),draft=useRef(onDraft);draft.current=onDraft;
  const api=globalThis.whale?.voice;
  useEffect(()=>{
    const current=session.current;if(!current)return;
    const [characterId,personaId,conversationId,groupId]=String(scopeKey??'').split(':'),expected={characterId,personaId,conversationId:groupId||conversationId,channel:groupId?'app-group':'app-private'};
    const off=current.output.subscribe(expected,setPresentation),draftOff=current.onDraft(expected,event=>draft.current?.(event));
    return()=>{off();draftOff();};
  },[api,scopeKey]);
  return {controls:h(VoiceToggle,{snapshot:presentation.error?{...snapshot,error:presentation.error}:snapshot,onToggle:enabled=>session.current?.configure({enabled})}),subtitle:presentation.subtitle,speaking:presentation.speaking,presentation};
}

export function VoiceSettingsPanel({snapshot,session,onPlugins,onChat}){
  const [key,setKey]=useState(''),[text,setText]=useState('');
  const {state,error,working,captureState='idle',partial,pendingDraft}=snapshot??{},id=state?.selectedPackageId,options=state?.settings?.packages?.[id]??{},installed=state?.packages?.filter(row=>row.installed)??[],enabled=state?.settings?.enabled===true;
  const button=(label,fn,disabled=false)=>h('button',{type:'button',className:'ui-btn sm',disabled:disabled||working,onClick:fn},t(label)),idle=captureState==='idle',usable=!!state?.packages?.find(row=>row.id===id)?.usable;
  return h('section',{className:'ws-card ws-set settings-voice','data-settings-voice':true},h('h2',{className:'ws-sec'},t('语音设置')),
    h(VoiceToggle,{snapshot,onToggle:value=>session?.configure({enabled:value})}),
    !installed.length&&button('安装语音插件',onPlugins),
    h('p',{className:'settings-note'},t('开启后等待所选模型加载完成。Live 会在配音、识别和麦克风均准备好后开始。')),
    h('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},
      button(captureState==='recording'?'结束录音到草稿':'录音输入',()=>captureState==='recording'?session?.finish():session?.start('record'),!enabled||!usable||!idle&&captureState!=='recording'),
      button('Live 轮流交谈',()=>session?.start('live'),!enabled||!usable||!idle),
      h('button',{type:'button',className:'ui-btn sm',onClick:()=>session?.stop()},t('停止并释放'))),
    partial&&h('p',{role:'status'},partial),
    pendingDraft&&h('div',{className:'settings-note'},h('label',null,t('录音草稿'),h('textarea',{readOnly:true,value:pendingDraft.text,rows:3})),h('p',null,t('打开对应对话后，录音文字会填入草稿。')),button('打开对话',onChat)),
    state&&h('div',{style:{display:'grid',gap:10,marginTop:12}},
      h('label',null,t('插件 '),h('select',{'aria-label':t('配音插件'),value:id,disabled:working,onChange:e=>session?.configure({selectedPackageId:e.target.value})},...Object.entries(titles).map(([value,label])=>h('option',{key:value,value,disabled:!installed.some(row=>row.id===value)},label)))),
      h('label',null,t('配音方式 '),h('select',{'aria-label':t('配音方式'),value:options.ttsProvider,disabled:working,onChange:e=>session?.configure({packages:{[id]:{ttsProvider:e.target.value}}})},h('option',{value:'local'},t('本地配音')),h('option',{value:'minimax'},t('MiniMax 云配音')))),
      h('small',null,t('识别：本地流式 · 录音保存草稿；Live 播完再听')),
      h('span',null,t('当前角色声音：'),state.profile?.label??t('待导入')),
      !state.scope&&h('p',{role:'status'},t('请先在 Galgame 选择角色与对话，再设置该角色声音。')),
      h('label',null,t('参考音逐字稿 '),h('input',{value:text,onChange:e=>setText(e.target.value),'aria-label':t('参考音逐字稿'),disabled:working})),
      button('选择并导入当前角色平静参考音',()=>session?.runAction('profile-import',{text,label:t('我的声音')}),!text.trim()||!state.scope),
      options.ttsProvider==='minimax'?h(React.Fragment,null,
        h('label',null,'MiniMax API Key ',h('input',{type:'password',autoComplete:'off',value:key,onChange:e=>setKey(e.target.value),'aria-label':'MiniMax API Key',disabled:working,placeholder:t(options.credentialRef?'已保存，可更换':'只需填写 API Key')})),
        button('保存 API Key（两插件共用）',async()=>{const saved=await session?.runAction('save-key',{key});if(saved?.configured)setKey('');},!key.trim()),
        h('span',{role:'status'},t(state.cloud?.state==='ready'?'当前角色云音色已绑定':'当前角色云音色待准备')),
        button('上传当前角色参考音并准备云音色',()=>{if(globalThis.confirm(t('将当前角色的完整参考音和逐字稿上传至 MiniMax，准备该角色云音色。是否继续？')))void session?.runAction('cloud-prepare',{consentUpload:true});},!options.credentialRef||!state.profile||!state.scope)):
        h('span',null,t('本地配音组件：'),t(state.assets?.tts?.state==='ready'?'已准备，使用前复核':state.assets?.tts?.state??'待准备')),
      button('准备本地识别组件',()=>session?.runAction('assets-prepare',{kind:'asr'})),
      options.ttsProvider==='local'&&button('准备所选本地配音组件',()=>session?.runAction('assets-prepare',{kind:state.engine}),!state.engine)),
    error&&h('p',{role:'alert',className:'settings-error'},error));
}

export function VoiceSettings({onPlugins,onChat}){const {session,snapshot}=useVoiceSession();return h(VoiceSettingsPanel,{snapshot,session:session.current,onPlugins,onChat});}
