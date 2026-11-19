import React,{useEffect,useRef,useState} from 'react';
import {pluginClientResult} from '../plugin-client-result.mjs';
import {createChatPlayer,createSpeechOutputManager} from './browser.mjs';
import {createCardVoiceMix} from './card-volume.mjs';
import {createHostVoiceCapture} from './capture.mjs';
import {t} from '../i18n.mjs';
import {minimaxSpeechMessage} from './minimax-speech-errors.mjs';
import {CloudVoiceSettings,cloudVoiceError} from './cloud-settings-ui.mjs';
import {voiceL as L,VOICE_PLUGINS,voicePlugin,voiceName,chatVoiceState,isBuiltinCloud,builtinAsrPercent,builtinCloudStatus,openBuiltinCloudPage,VoiceIcon,VoiceButton,VoiceChip,VoicePopover,VoiceSpeakingIndicator,VoiceLiveStrip,VoiceRecordingRow,VoiceLiveAlert,VoiceWhere,VoiceEngineCard,VoiceCharacters,VoiceParts,VoiceImportDialog} from './design-ui.mjs';

const h=React.createElement;
const rates={breeze:24000,gpt:48000,minimax:32000};
const titles={'ai-buddy.voice-breeze':'Breeze','ai-buddy.voice-gpt-sovits':'GPT-SoVITS'};
const stateText={idle:'尚未开始录音',preparing:'正在准备模型与麦克风…',recording:'录音中',listening:'Live 已开启 · 正在听',processing:'识别中','waiting-playback':'等待回复播放完毕','waiting-configuration':'需要配置'};
const base64=bytes=>{if(typeof bytes==='string')return bytes;let out='';for(const value of bytes)out+=String.fromCharCode(value);return btoa(out);};
const rendererOutputs=new WeakMap();
// R13 diagnostic: bounded voice timing rows (numbers and indexes only) for diagnostics-main-profile.
// Off unless the main process starts it; collects at most 400 rows and is cleared when read.
const voiceProbe={rows:null,push(row){if(this.rows&&this.rows.length<400)this.rows.push(row);}};
globalThis.__buddyVoiceProbe={start(){voiceProbe.rows=[];return true;},stop(){const rows=voiceProbe.rows;voiceProbe.rows=null;return rows;}};
const probeClock=context=>{const row={audioNow:context.currentTime,perfNow:performance.now()};try{const at=context.getOutputTimestamp?.();if(at){row.outputContextTime=at.contextTime;row.outputPerfTime=at.performanceTime;}}catch{}return row;};
const probeReceipt=(action,payload)=>{
  if(!voiceProbe.rows)return action('receipt',payload);
  const row={type:'receipt',status:payload.status,index:payload.envelope?.index,sentAt:performance.now()};voiceProbe.push(row);
  return Promise.resolve(action('receipt',payload)).finally(()=>{row.doneAt=performance.now();});
};
const matchesChat=(scope,envelope)=>!!scope&&!!envelope&&scope.channel===envelope.channel&&scope.personaId===envelope.personaId&&scope.conversationId===envelope.conversationId&&(scope.channel==='app-group'||scope.characterId===envelope.characterId);
const matchesReply=(reply,envelope)=>!!reply?.replyId&&reply.replyId===envelope?.requestId&&(!reply.characterId||reply.characterId===envelope?.characterId);
const phaseText={queue:'正在等待配音队列…','reference-check':'正在检查角色声线…','component-check':'正在检查配音组件…','model-loading':'正在加载语音模型…','speak-sent':'配音请求已发送，等待音频…','first-pcm':'已收到音频，等待播放…','playback-start':'正在播放配音…',done:'配音已完成',error:'配音失败，回复文字已保留'};

export function voiceDialogueState(presentation,requestId){
  const pending=presentation?.requests?.find(row=>row.requestId===requestId);
  if(!pending)return null;
  const subtitle=pending.subtitle?.envelope?.requestId===requestId?pending.subtitle:null;
  return {waiting:!subtitle,subtitle,nextVisualEmotion:pending.nextVisualEmotion,status:phaseText[pending.phase?.stage]??(pending.hasSegments?'正在准备配音…':'正在等待回复语段…')};
}

export function VoiceDialogueLine({presentation,requestId,children,as='div',...props}){
  const current=voiceDialogueState(presentation,requestId),history=useRef({requestId,segments:new Map()});
  if(history.current.requestId!==requestId)history.current={requestId,segments:new Map()};
  if(current?.subtitle){const index=current.subtitle.envelope?.index;if(Number.isInteger(index))history.current.segments.set(index,current.subtitle.text);}
  const previous=current?.subtitle?[...history.current.segments.entries()].filter(([index])=>index<current.subtitle.envelope.index).sort(([a],[b])=>a-b):[];
  return h(as,{...props,...(current?{'data-voice-subtitle':!!current.subtitle,'data-voice-waiting':current.waiting,'aria-busy':current.waiting}:{} )},
    current?.waiting?h('span',{role:'status'},t(current.status)):current?.subtitle?h(React.Fragment,null,...previous.map(([index,text])=>h('span',{className:'vx-past',key:index},text)),current.subtitle.text):children);
}

// The trusted dashboard owns playback; page hooks only observe it and own capture.
export function ensureVoiceOutput(api=globalThis.whale?.voice,{createContext}={}){
  if(!api)return null;
  if(rendererOutputs.has(api))return rendererOutputs.get(api);
  const subscribers=new Set(),events=new Set(),errors=new Set(),requests=new Map(),retired=new Set();
  const terminal=new Set(['audioCompleted','explicitlySkipped','interrupted','failed']);
  let owners=0,closed=false,active,scope,errorScope,subtitle=null,speaking=false,error=null,cloudFailure=false,cloudFailureCategory=null;
  const snapshot=(expected,reply)=>{const matches=matchesChat(expected,scope),failure=matchesChat(expected,errorScope);return {subtitle:matches?subtitle:null,speaking:matches&&speaking,activeRequestId:matches&&speaking?active?.id:null,error:failure&&(reply===undefined||matchesReply(reply,errorScope))?error:null,errorEnvelope:failure?errorScope:null,cloudFailure:failure&&cloudFailure,cloudFailureCategory:failure?cloudFailureCategory:null,
    requests:[...requests.values()].filter(row=>matchesChat(expected,row.envelope)).map(row=>{
      const current=active===row&&subtitle?.envelope?.requestId===row.id?subtitle:null;
      const nextVisualEmotion=row.visuals.get((current?.envelope?.index??-1)+1)??null;
      return {requestId:row.id,envelope:row.envelope,phase:row.phase,hasSegments:row.segments.size>0,subtitle:current,nextVisualEmotion};
    })};};
  const notify=()=>{for(const row of subscribers)row.listener(snapshot(row.scope,row.reply));};
  const action=(...args)=>Promise.resolve(api.action(...args)).then(pluginClientResult);
  const onError=(value,envelope=active?.envelope)=>{
    const reason=value?.category&&minimaxSpeechMessage(value,t);
    error=reason||String(value?.message??value);cloudFailure=!!reason;cloudFailureCategory=reason?value.category:null;errorScope=envelope;notify();
    for(const listener of errors)listener({message:error,envelope,code:value?.code,cloudFailure,cloudFailureCategory});
  };
  const retire=id=>{retired.add(id);if(retired.size>32)retired.delete(retired.values().next().value);};
  const playback=createVoicePlayback({createContext,action:async(op,value)=>{
    if(op!=='receipt')return action(op,value);
    const row=requests.get(value.envelope?.requestId),key=value.envelope?.segmentId+':'+value.status;
    if(!row||row.cancelled||row.receipts.has(key)||row.terminal.has(value.envelope.segmentId))return {accepted:false};
    row.receipts.add(key);if(terminal.has(value.status))row.terminal.add(value.envelope.segmentId);
    return action(op,value);
  },
    onSubtitle:value=>{subtitle=value;if(value){scope=value.envelope;active?.visuals.delete(value.envelope.index);}notify();},
    onBusy:(value,envelope)=>{speaking=value;if(envelope){scope=envelope;error=null;errorScope=null;}notify();},onError,
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
    if(status)for(const row of removed)for(const envelope of row.segments.values()){
      if(row.terminal.has(envelope.segmentId))continue;row.terminal.add(envelope.segmentId);
      receipts.push(action('receipt',{envelope,status}));
    }
    advance();notify();return Promise.allSettled(receipts);
  }
  const inChannel=(channel,row)=>channel==='all'||(channel==='card-table'?row.envelope.channel==='card-table':['app-private','app-group',undefined].includes(row.envelope.channel));
  function accept(event){
    if(closed)return Promise.resolve();
    if(event.type==='card-volume')return playback.handle(event);
    if(event.type==='invalidate'){
      const channel=event.channel??'app-chat';
      if(errorScope&&inChannel(channel,{envelope:errorScope})){error=null;errorScope=null;}
      return cancel(row=>inChannel(channel,row));
    }
    const id=event.envelope?.requestId??event.requestId;
    if(id&&retired.has(id))return Promise.resolve();
    if(event.type==='turn'&&event.state==='skipped'){
      if(id)retire(id);
      return cancel(row=>row.id===id,null);
    }
    const failed=event.type==='segment'&&event.state==='failed'||event.type==='turn'&&event.failed;
    if(failed)onError({...event,message:event.message??'配音失败，回复文字已保留'},event.envelope??null);
    if(!id)return Promise.resolve();
    let row=requests.get(id);
    if(event.type==='phase'){
      const segment=row?.segments.get(event.envelope?.segmentId);
      if(!segment||!Object.keys(segment).every(key=>segment[key]===event.envelope?.[key])||!phaseText[event.stage])return Promise.resolve();
      row.phase={stage:event.stage,elapsedMs:event.elapsedMs,...(event.code?{code:event.code}:{})};notify();return Promise.resolve();
    }
    if(failed)return cancel(value=>value.id===id,event.type==='segment'?'failed':'interrupted');
    if(event.type==='turn'&&event.state==='admitted'){
      if(!row){if(requests.size>=6){retire(id);return Promise.resolve();}row={id,envelope:event.envelope,events:[],segments:new Map(),visuals:new Map(),receipts:new Set(),terminal:new Set(),cancelled:false};requests.set(id,row);}
      notify();return Promise.resolve();
    }
    if(event.type==='turn'&&event.state==='generated'&&row&&!row.segments.size){requests.delete(id);retire(id);if(active===row)active=undefined;notify();advance();return Promise.resolve();}
    if(event.type==='segment'&&event.state==='queued'){
      if(!row){
        // The controller admits at most 2 inflight + 3 queued segments, plus one card request.
        if(requests.size>=6){retire(id);return action('receipt',{envelope:event.envelope,status:'failed'});}
        row={id,envelope:event.envelope,events:[],segments:new Map(),visuals:new Map(),receipts:new Set(),terminal:new Set(),cancelled:false};requests.set(id,row);
      }
      if(row.segments.has(event.envelope.segmentId))return Promise.resolve();
      row.segments.set(event.envelope.segmentId,event.envelope);
      if(event.visualEmotion)row.visuals.set(event.envelope.index,event.visualEmotion);
      notify();
    }else if(event.type!=='audio'&&!(event.type==='turn'&&event.state==='generated'))return Promise.resolve();
    if(!row)return Promise.resolve();
    if(active===row)return playback.handle(event).catch(()=>{});
    row.events.push(event);advance();return Promise.resolve();
  }
  const off=api.onEvent(event=>{for(const listener of events)listener(event);return accept(event).catch(onError);});
  const output={
    retain(){if(closed)throw Error('配音输出已关闭。');owners++;let released=false;return async()=>{if(released)return;released=true;if(--owners===0)await output.close();};},
    subscribe(expected,listener,reply){const row={scope:expected,listener,reply};subscribers.add(row);listener(snapshot(expected,reply));return()=>subscribers.delete(row);},
    onEvent(listener){events.add(listener);return()=>events.delete(listener);},
    onError(listener){errors.add(listener);return()=>errors.delete(listener);},
    prepare:rate=>playback.prepare(rate),
    setCardMix:value=>playback.setMix(value),
    stopChat:()=>action('stop',{channel:'app-chat'}),
    async stopReading(requestId){
      if(!requestId||active?.id!==requestId||!inChannel('app-chat',active))return;
      const envelope=active.envelope;
      try{
        const result=await action('stop-reading',{requestId});
        if(result?.stopped)await cancel(row=>row.id===requestId,null);
      }catch(error){onError(error,envelope);}
    },
    stop:async()=>{await Promise.all([cancel(()=>true),action('stop')]);},
    async close(){if(closed)return;closed=true;rendererOutputs.delete(api);off?.();await cancel(()=>true);subscribers.clear();events.clear();errors.clear();await playback.close();}
  };
  rendererOutputs.set(api,output);return output;
}

export function useVoiceOutput(){
  const api=globalThis.whale?.voice;
  useEffect(()=>{const release=ensureVoiceSession(api)?.retain();return()=>{void release?.();};},[api]);
}

export function createVoicePlayback({action,onSubtitle=()=>{},onBusy=()=>{},onError=()=>{},onDrained=()=>{},onFailure=()=>{},createContext}){
  const mix=createCardVoiceMix(),outputs=createSpeechOutputManager(createContext),envelopes=new Map(),segments=new Map(),displayReceipts=new Map();
  let player,requestId,currentEnvelope,generation=0,tail=Promise.resolve(),finished=false;
  function clear(){player?.stop();player=undefined;requestId=currentEnvelope=undefined;finished=false;envelopes.clear();segments.clear();displayReceipts.clear();onSubtitle(null);onBusy(false);}
  function reset(){generation++;outputs.invalidate();clear();}
  function register(segment){
    const envelope=segment.envelope;
    if(envelopes.has(envelope.index))return;
    envelopes.set(envelope.index,envelope);
    player.accept({type:'segment',requestId,index:envelope.index,text:segment.text??'',speech_text:segment.speech_text??segment.speechText??segment.text??'',visualEmotion:segment.visualEmotion,envelope});
  }
  function handle(event){
    if(event.type==='card-volume'){mix.set(event);return Promise.resolve();}
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
        player=createChatPlayer({context,destination:mix.destination(context,envelope.channel),onDiagnostic:event=>{if(voiceProbe.rows)voiceProbe.push({type:event.type,index:event.index,now:event.now,start:event.start,end:event.end,previousEnd:event.previousEnd,continuingSegment:event.continuingSegment,...probeClock(context)});},
          onDisplay:segment=>{if(voiceProbe.rows){const index=segment.envelope?.index;voiceProbe.push({type:'display',index,...probeClock(context)});requestAnimationFrame(at=>voiceProbe.push({type:'paint',index,perfNow:at}));}onSubtitle(segment);const pending=probeReceipt(action,{envelope:segment.envelope,status:'textDisplayed'}).then(()=>segment.speech_text.trim()?probeReceipt(action,{envelope:segment.envelope,status:'audioStarted'}):undefined);displayReceipts.set(segment.envelope.segmentId,pending);void pending.catch(onError);},
          onPlayed:async({index})=>{const env=envelopes.get(index),segment=segments.get(env?.segmentId);await displayReceipts.get(env?.segmentId);if(env&&envelopes.get(index)===env)await probeReceipt(action,{envelope:env,status:(segment?.speech_text??segment?.speechText??segment?.text??'').trim()?'audioCompleted':'explicitlySkipped'});},
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
    tail=operation.catch(error=>{
      const envelope=currentEnvelope;
      reset();onError(error);onFailure(envelope);
      if(envelope?.channel==='card-table')void action('stop',{channel:'card-table'}).catch(()=>{});
    });return operation;
  }
  return {handle,reset,setMix:mix.set,prepare:rate=>outputs.prepare(rate),close:async()=>{reset();mix.close();await outputs.close();}};
}

const rendererSessions=new WeakMap();
export function ensureVoiceSession(api=globalThis.whale?.voice,{createContext,captureOptions={}}={}){
  if(!api)return null;
  if(rendererSessions.has(api))return rendererSessions.get(api);
  const output=ensureVoiceOutput(api,{createContext}),subscribers=new Set(),draftListeners=new Set(),drafts=[];
  let value={state:null,captureState:'idle',captureMode:null,partial:'',error:'',working:false,cloudBatchWorking:false,cloudBatchCancelling:false,cloudBatch:null,cloudSelectionRevision:0,pendingDraft:null},revision=0,generation=0,operations=0,owners=0;
  let disposed=false,cloudExpiry,cloudUpdateTimer;
  const cloudSelection=state=>JSON.stringify([state?.scope,state?.selectedPackageId,state?.engine,state?.profile?.id,state?.profile?.version,state?.cloudConnections,state?.builtinCloud?.route,state?.builtinCloud?.accountRevision]);
  const publish=patch=>{
    if(disposed)return;
    if(Object.hasOwn(patch,'error')&&!Object.hasOwn(patch,'errorReplyId'))patch={...patch,errorReplyId:null,cloudFailure:false,cloudFailureCategory:null};
    if(patch.state&&cloudSelection(patch.state)!==cloudSelection(value.state))patch={...patch,cloudSelectionRevision:value.cloudSelectionRevision+1};
    value={...value,...patch};
    if(patch.state)scheduleCloudExpiry(patch.state);
    for(const listener of subscribers)listener(value);
  };
  function cancelCloudExpiry(){
    clearTimeout(cloudExpiry?.timer);
    cloudExpiry=undefined;
  }
  function scheduleCloudExpiry(state){
    const selected=state.settings?.enabled&&state.settings.packages?.[state.selectedPackageId]?.ttsProvider==='minimax';
    const status=Object.hasOwn(state,'cloudSpeech')?state.cloudSpeech:state.cloud;
    const retryAt=isBuiltinCloud(state)?state.builtinCloud.retryAt:selected?status?.retryAt:undefined;
    const selection=value.cloudSelectionRevision;
    if(cloudExpiry?.retryAt===retryAt&&cloudExpiry?.selection===selection)return;
    cancelCloudExpiry();
    if(!Number.isSafeInteger(retryAt))return;
    const expiry=cloudExpiry={retryAt,selection};
    function check(){
      if(cloudExpiry!==expiry)return;
      const remaining=retryAt-Date.now();
      if(remaining>0){expiry.timer=setTimeout(check,remaining);return;}
      // Fencing older state reads keeps a pre-expiry result from restoring the hold.
      revision++;
      void refresh().catch(()=>{
        if(cloudExpiry!==expiry||expiry.retried)return;
        expiry.retried=true;
        expiry.timer=setTimeout(check,1000);
      });
    }
    expiry.timer=setTimeout(check,Math.max(0,retryAt-Date.now()));
  }
  const onError=error=>{if(['VOICE_STATE_CANCELLED','VOICE_ASSET_CANCELLED','VOICE_PREPARATION_CANCELLED','VOICE_ACTION_REVOKED','ABORT_ERR'].includes(error?.code)||error?.name==='AbortError')return;publish({errorReplyId:error?.envelope?.requestId??null,cloudFailure:error?.cloudFailure===true,cloudFailureCategory:error?.cloudFailureCategory??null,error:error?.cloudFailure?error.message:error?.code==='VOICE_ASSET_VERIFY_FAILED'?L('校验没通过，请重新下载','Verification failed, please download again'):error?.code==='VOICE_ASSET_VERIFY_REQUIRED'?L('这台电脑上已经有这些文件，请先校验','These files are already on this PC. Verify them first.'):typeof error?.code==='string'&&error.code.startsWith('CLOUD_')?cloudVoiceError(error):t(String(error?.message??error))});};
  const offOutputError=output.onError(onError);
  const action=(...args)=>Promise.resolve(api.action(...args)).then(pluginClientResult);
  const capture=createHostVoiceCapture({...captureOptions,action:(op,payload)=>action(op,op==='stop'?{...payload,channel:'app-chat'}:payload),
    onState:(captureState,{resetPartial=false}={})=>publish({captureState,...(captureState==='idle'?{captureMode:null}:{}),...(resetPartial||captureState==='idle'?{partial:''}:{})}),
    onPartial:partial=>publish({partial}),onError});
  let refreshing,stoppingCapture,componentManagers=0;
  async function readProfiles(state){
    if(!state?.scope)return {profilesByPackage:{},profileErrorsByPackage:{}};
    const targets=(state.packages??[]).filter(row=>row.installed).map(row=>row.id).filter(id=>VOICE_PLUGINS.some(row=>row.id===id)&&state.settings?.packages?.[id]?.ttsProvider!=='minimax');
    const errors={};
    const profiles=await Promise.all(targets.map(async packageId=>{
      try{const listed=await action('profiles',packageId===state.selectedPackageId?undefined:{packageId});return [packageId,Array.isArray(listed)?listed:[]];}
      catch(error){errors[packageId]={state:'failed',code:error?.code??'VOICE_PROFILE_INVALID',message:String(error?.message??error)};return [packageId,[]];}
    }));
    return {profilesByPackage:Object.fromEntries(profiles),profileErrorsByPackage:errors};
  }
  async function readProfileSelections(state){
    const targets=(state?.packages??[]).filter(row=>row.installed&&VOICE_PLUGINS.some(plugin=>plugin.id===row.id)&&state.settings?.packages?.[row.id]?.ttsProvider!=='minimax');
    return Object.fromEntries(await Promise.all(targets.map(async({id})=>{
      try{const result=await action('profile-selections',{packageId:id});return [id,Array.isArray(result?.selections)?{...result,state:'ready'}:{state:'failed'}];}
      catch(error){return [id,{state:'failed',code:error?.code??'VOICE_PROFILE_INVALID'}];}
    })));
  }
  async function readComponentStatuses(state){
    const targets=(state?.packages??[]).filter(row=>row.installed&&VOICE_PLUGINS.some(plugin=>plugin.id===row.id));
    const rows=await Promise.all(targets.map(async({id})=>{
      try{const status=await action('component-status',{packageId:id});return status&&typeof status.state==='string'&&typeof status.ready==='boolean'?[id,status]:null;}
      catch(error){return [id,{ready:false,state:'unavailable',code:error?.code??'VOICE_ASSET_MANIFEST'}];}
    }));
    return Object.fromEntries(rows.filter(Boolean));
  }
  function refresh(){
    if(disposed)return Promise.resolve(value.state);
    if(refreshing&&refreshing.revision===revision)return refreshing.task;
    const row=refreshing={revision};
    row.task=(async()=>{
      const state=await action('state');if(row.revision!==revision)return value.state;
      // Package existence is authoritative even if an optional profile/asset
      // read fails. Clear old scope-derived lists before publishing the scope.
      output.setCardMix(state?.cardVoiceMix);publish({state,profiles:[],profilesByPackage:{},profileErrorsByPackage:{},componentStatuses:{},profileSelectionsByPackage:{},...(Object.keys(value.profileErrorsByPackage??{}).length?{error:''}:{}),...(state?.cloudBatch?{cloudBatch:state.cloudBatch}:{})});if(drafts.length)deliverDrafts();
      const cloudSpeech=state?.settings?.packages?.[state.selectedPackageId]?.ttsProvider==='minimax';
      const components=componentManagers||!cloudSpeech?readComponentStatuses(state):{};
      const [{profilesByPackage,profileErrorsByPackage},componentStatuses,profileSelectionsByPackage]=await Promise.all([readProfiles(state),components,readProfileSelections(state)]);
      if(row.revision===revision){publish({profiles:profilesByPackage[state?.selectedPackageId]??[],profilesByPackage,profileErrorsByPackage,componentStatuses,profileSelectionsByPackage});const failure=Object.values(profileErrorsByPackage).find(error=>!['VOICE_DISABLED','VOICE_PACKAGE_UNAVAILABLE','VOICE_PROFILE_SCOPE','VOICE_STOPPING'].includes(error.code));if(failure)onError(failure);}
      return state;
    })().finally(()=>{if(refreshing===row)refreshing=undefined;});return row.task;
  }
  function deliverDrafts(){const trusted=value.state?.scope;for(let i=0;i<drafts.length;){const event=drafts[i],listener=trusted&&[...draftListeners].find(row=>matchesChat(row.scope,event.scope)&&matchesChat(row.scope,trusted)&&['lifeId','operationId'].every(key=>!trusted[key]||trusted[key]===event.scope?.[key]));if(!listener){i++;continue;}listener.callback(event);drafts.splice(i,1);}publish({pendingDraft:drafts.at(-1)??null});}
  const off=output.onEvent(event=>{
    if(event.type==='invalidate'&&event.channel!=='card-table'){
      if(event.reason==='scope-changed')generation++;
      revision++;
      publish({phase:null,...(value.state?{state:{...value.state,live:false,capture:null,cloudSpeech:null}}:{})});
    }
    if(event.type==='cloud-speech-status'&&matchesChat(value.state?.scope,event.envelope)&&event.packageId===value.state.selectedPackageId&&value.state.settings?.packages?.[event.packageId]?.ttsProvider==='minimax'){
      const {characterId}=event.envelope,previous=value.state.cloudSpeech;
      revision++;publish({state:{...value.state,cloudSpeech:{...event.status,characterId,profile:characterId===previous?.characterId?previous.profile:null}}});
    }
    if(event.type==='segment'&&event.state==='failed'&&event.envelope?.channel==='card-table'&&event.category)void refresh().catch(onError);
    if(event.type==='turn'&&event.state==='admitted')publish({phase:null});
    if(event.type==='turn'&&event.state==='skipped'&&value.phase?.requestId===event.requestId)publish({phase:null});
    if(event.type==='capture'&&event.reason==='capture-stopped'&&value.state)publish({state:{...value.state,live:false,capture:null}});
    if(event.type==='phase'&&matchesChat(value.state?.scope,event.envelope)&&['lifeId','operationId'].every(key=>value.state.scope[key]===event.envelope[key])){
      publish({phase:{requestId:event.requestId,stage:event.stage}});
      if(event.stage==='error')onError({envelope:event.envelope,message:event.code==='VOICE_PREFLIGHT_TIMEOUT'?'配音准备超时，已停止；回复文字已保留':phaseText.error});
    }
    if(event.type==='state'){revision++;output.setCardMix(event.state?.cardVoiceMix);const state=event.state&&!Object.hasOwn(event.state,'builtinCloud')&&value.state?.builtinCloud?{...event.state,builtinCloud:value.state.builtinCloud}:event.state;const changed=cloudSelection(state)!==cloudSelection(value.state);publish({state,...(changed?{profiles:[],profilesByPackage:{},profileErrorsByPackage:{},componentStatuses:{},profileSelectionsByPackage:{}}:{}),...(event.state?.cloudBatch?{cloudBatch:event.state.cloudBatch}:{})});if(drafts.length)deliverDrafts();}
    if(event.type==='builtin-cloud-updated'&&!cloudUpdateTimer){
      cloudUpdateTimer=setTimeout(()=>{cloudUpdateTimer=undefined;revision++;void refresh().catch(onError);},100);
    }
    if(event.type==='cloud-batch'){
      const batch=event.cloudBatch??event.batch??event.snapshot??(typeof event.state==='object'?event.state:event);
      revision++;publish({cloudBatch:batch,...(value.state?{state:{...value.state,cloudBatch:batch}}:{})});
    }
    if(event.type==='preparation'){
      if(value.state&&event.epoch<value.state.epoch)return;
      revision++;publish({preparation:event.preparation,...(value.state?{state:{...value.state,epoch:event.epoch,preparation:event.preparation}}:{})});
    }
    if(event.type==='asset-progress'){
      revision++;publish({assetProgress:event,...(value.state?{state:{...value.state,assetProgress:event}}:{})});
      if(['ready','failed','cancelled'].includes(event.state))void refresh().catch(onError);
    }
    if((event.type==='error'||event.type==='status')&&event.message)onError(event);
    if(event.type==='draft'){drafts.push(event);deliverDrafts();}
    // A host listening event authorizes microphone acquisition; the browser
    // capture adapter reports listening only after its graph is really active.
    if(event.channel!=='card-table')capture.event(event);
  });
  const plugins=globalThis.whale?.plugins?.onUpdate?.(()=>{revision++;void refresh().catch(onError);});
  async function perform(fn,{cloudOperation=false,builtinOperation=false,waitForRefresh=true}={}){
    const ticket=generation,cloudTicket=value.cloudSelectionRevision,current=()=>ticket===generation&&(!cloudOperation||cloudTicket===value.cloudSelectionRevision);
    operations++;publish({working:true,error:''});
    try{return await fn();}catch(error){
      if(builtinOperation)return {ok:false,message:minimaxSpeechMessage(error,t)};
      if(current())onError(cloudOperation?{message:cloudVoiceError(error)}:error);
    }
    finally{
      operations--;publish({working:operations>0});
      const updated=refresh().catch(error=>{if(!cloudOperation&&waitForRefresh||current())onError(error);});
      if(waitForRefresh)await updated;
    }
  }
  const cloudFlights=new Map();
  function cloudAction(op,payload){
    if(cloudFlights.has(op))return cloudFlights.get(op);
    const field=op==='cloud-batch-cancel'?'cloudBatchCancelling':'cloudBatchWorking';
    publish({[field]:true,...(op!=='cloud-batch-cancel'?{error:''}:{})});
    const task=Promise.resolve().then(()=>action(op,payload)).catch(error=>onError({message:cloudVoiceError(error)})).finally(async()=>{cloudFlights.delete(op);publish({[field]:false});await refresh().catch(onError);});
    cloudFlights.set(op,task);return task;
  }
  const rate=patch=>{const id=patch?.selectedPackageId??value.state?.selectedPackageId,options={...value.state?.settings?.packages?.[id],...patch?.packages?.[id]};return options.ttsProvider==='minimax'?rates.minimax:rates[id?.includes('gpt')?'gpt':'breeze'];};
  const session={output,snapshot:()=>value,
    subscribe(listener){subscribers.add(listener);listener(value);return()=>subscribers.delete(listener);},
    onDraft(scope,callback){const row={scope,callback};draftListeners.add(row);deliverDrafts();return()=>draftListeners.delete(row);},
    refresh,
    manageComponents(){
      if(++componentManagers===1){revision++;void refresh().catch(onError);}
      let active=true;
      return()=>{if(active){active=false;componentManagers--;}};
    },
    configure(patch){const ticket=++generation;const enabled=patch.enabled??value.state?.settings?.enabled;
      // Call before IPC so AudioContext authorization belongs to this click.
      const unlocked=enabled?output.prepare(rate(patch)):Promise.resolve();
      if(!enabled)capture.release();
      return perform(async()=>{await unlocked;if(ticket!==generation)return;return action('configure',patch);});
    },
    startSpeech(){
      const ticket=++generation,unlocked=output.prepare(rate());
      return perform(async()=>{await unlocked;if(ticket!==generation)return;return action('prepare',{target:'speech'});});
    },
    start(mode){if(stoppingCapture)return;const ticket=++generation,unlocked=output.prepare(rate());publish({captureState:'preparing',captureMode:mode});
      return perform(async()=>{try{await unlocked;if(ticket!==generation)return;if(mode==='live'){const ready=await action('prepare',{target:'live'});if(ready?.cancelled){capture.release();publish({captureState:'idle',captureMode:null});return ready;}}if(ticket!==generation)return;return await capture.start(mode);}catch(error){if(ticket===generation)capture.release();throw error;}});
    },
    finish:()=>perform(()=>capture.finish()),
    stop(){generation++;capture.release();return perform(()=>output.stop());},
    stopChat(){
      if(stoppingCapture)return stoppingCapture;
      generation++;revision++;
      publish({stoppingCapture:true});
      capture.release();
      stoppingCapture=perform(()=>output.stopChat(),{waitForRefresh:false}).finally(()=>{
        stoppingCapture=undefined;
        publish({stoppingCapture:false});
      });
      return stoppingCapture;
    },
    runAction:(op,payload)=>{
      if(op.startsWith('cloud-connection-'))publish({cloudSelectionRevision:value.cloudSelectionRevision+1});
      return ['cloud-batch-prepare','cloud-batch-reconcile','cloud-batch-cancel'].includes(op)?cloudAction(op,payload):perform(()=>action(op,payload),{cloudOperation:op.startsWith('cloud-'),builtinOperation:op.startsWith('builtin-cloud-')});
    },
    retain(){const releaseOutput=output.retain();owners++;let released=false;return async()=>{
      if(released)return;released=true;
      if(--owners===0){
        disposed=true;generation++;revision++;
        cancelCloudExpiry();clearTimeout(cloudUpdateTimer);
        if(rendererSessions.get(api)===session)rendererSessions.delete(api);
        off();offOutputError();plugins?.();subscribers.clear();draftListeners.clear();capture.release();
      }
      await releaseOutput();
    };},
  };
  rendererSessions.set(api,session);return session;
}

export function useVoiceSession(){
  const api=globalThis.whale?.voice,session=useRef(null),[snapshot,setSnapshot]=useState(null);
  useEffect(()=>{const current=ensureVoiceSession(api);session.current=current;if(!current)return;const off=current.subscribe(setSnapshot);void current.refresh().catch(()=>{});return()=>{off();session.current=null;};},[api]);
  return {session,snapshot};
}

export function voiceStatus(snapshot){
  const {state,captureState='idle',working,error}=snapshot??{};
  if(error)return t(error);
  if(!state)return t('正在检查语音插件与组件…');
  if(isBuiltinCloud(state)&&captureState==='idle')return builtinCloudStatus(state.builtinCloud).label;
  if(!state.settings?.enabled)return t('语音已关闭');
  if(state.settings?.packages?.[state.selectedPackageId]?.ttsProvider==='minimax'&&captureState==='idle'){
    const cloud=chatVoiceState(snapshot);
    return t({ready:'就绪','key-missing':'缺少 Key','key-invalid':'Key 无效',unbound:'未绑定声音',unavailable:'云配音暂不可用',checking:'正在检查云配音…',stopping:'正在停止并释放语音…'}[cloud]??'正在检查云配音…');
  }
  const preparation=state.preparation??snapshot?.preparation??{state:'idle'},labels={checking:'正在检查语音配置…',verifying:'正在校验语音组件…',loading:'正在加载语音模型…',ready:'语音模型已就绪',failed:'语音启动失败，请检查设置',stopping:'正在停止并释放语音…',idle:working?'正在准备语音…':'语音尚未启动'};
  if(['checking','verifying','loading','failed','stopping'].includes(preparation.state))return t(labels[preparation.state]);
  if(captureState!=='idle')return t(stateText[captureState]??captureState);
  if(snapshot?.phase&&phaseText[snapshot.phase.stage]&&!['done','error'].includes(snapshot.phase.stage))return t(phaseText[snapshot.phase.stage]);
  return t(labels[preparation.state]??'正在准备语音…');
}

export function VoiceToggle({snapshot,onToggle,onStart}){
  const state=snapshot?.state,enabled=isBuiltinCloud(state)?state.builtinCloud.enabled:state?.settings?.enabled===true,phase=chatVoiceState(snapshot),loading=enabled&&phase!=='ready';
  return h('div',{className:'buddy-voice',style:{display:'flex',flexWrap:'wrap',gap:6,alignItems:'center',fontSize:12},'data-voice-controls':true},
    h('button',{type:'button',role:'switch','aria-checked':enabled,'aria-label':t('语音总开关'),className:'gx-gbtn',disabled:!state||!enabled&&snapshot?.working,onClick:()=>onToggle?.(!enabled)},t(enabled?(loading?'关闭语音':'语音已开启'):'开启语音')),
    (phase==='cold'||phase==='failed')&&h('button',{type:'button',className:'gx-gbtn','data-voice-chat-start':true,disabled:snapshot?.working,onClick:onStart},t(phase==='failed'?'重试':'启动声音')),
    h('span',{role:snapshot?.error||state?.preparation?.state==='failed'?'alert':'status','aria-live':'polite'},phase==='cold'?t('语音是开着的，声音引擎还没启动。回复先只显示文字。'):voiceStatus(snapshot)));
}

const canStartLive=(snapshot,scope)=>['app-private','app-group'].includes(scope?.channel)&&matchesChat(scope,snapshot?.state?.scope)&&(isBuiltinCloud(snapshot.state)?snapshot.state.builtinCloud.enabled&&snapshot.state.builtinCloud.asr?.state==='ready':snapshot.state.settings?.enabled===true&&snapshot.state.packages?.some(row=>row.id===snapshot.state.selectedPackageId&&row.installed&&row.usable&&row.enabled!==false&&row.trusted!==false))&&(snapshot.captureState??'idle')==='idle'&&!snapshot.working&&!snapshot.stoppingCapture&&!snapshot.state.stopping;

function CloudRecognitionEntry({asr,session,mic}){
 const [open,setOpen]=useState(false),ref=useRef(null),button=useRef(null);
 const downloading=asr?.state==='downloading',percentage=builtinAsrPercent(asr);
 const name=mic?L('录音输入','Voice input'):t('Live 轮流交谈');
 const title=downloading?L('语音识别下载中','Downloading speech recognition'):L('语音识别还没准备好','Speech recognition is not ready');
 const action=downloading?'pause':'resume';
 useEffect(()=>{
  if(!open)return;
  const outside=event=>{if(!ref.current?.contains(event.target))setOpen(false);};
  const dismiss=event=>{if(event.key==='Escape'){setOpen(false);button.current?.focus();}};
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',dismiss);
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',dismiss);};
 },[open]);
 return h('span',{className:'bc-asr-slot'+(mic?' bc-asr-mic':' bc-asr-live'),ref},
  h('button',{type:'button',ref:button,className:(mic?'vx-mic':'vx-livebtn')+' bc-asr-pending'+(mic&&downloading?' bc-asr-ring':''),
   'aria-label':`${name} · ${title}${percentage==null?'':` ${percentage}%`}`,title,'aria-haspopup':'dialog','aria-expanded':open,
   ...(mic&&downloading?{style:{'--bc-asr-progress':`${percentage??0}%`}}:{}),onClick:()=>setOpen(value=>!value)},VoiceIcon(mic?'mic':'turns',18),!mic&&h('span',null,'Live')),
  open&&h('span',{className:'bc-asr-tip',role:'dialog','aria-label':title},h('span',{className:'bc-asr-title'},VoiceIcon('mic',16),
   h('b',null,title),percentage!=null&&h('small',null,`${percentage}%`)),
   downloading&&h('span',{className:'bc-asr-meter',role:'progressbar','aria-label':title,'aria-valuenow':percentage},h('i',{style:{width:`${percentage??0}%`}})),
   h('span',{className:'bc-asr-note'},L('你可以先打字，她的回复照常读出来。','You can keep typing while her replies are read aloud.')),
   h('span',{className:'bc-asr-actions'},h(VoiceButton,{kind:'ghost sm',icon:'cloud',onClick:()=>openBuiltinCloudPage()},L('打开云配音','Open cloud voice')),
    h(VoiceButton,{kind:downloading?'ghost sm':'primary sm',onClick:()=>session?.runAction('builtin-cloud-asr',{action})},downloading?L('暂停','Pause'):asr?.state==='paused'?L('继续','Resume'):L('准备','Prepare')))));
}

export function VoiceChatControls({snapshot,session,scope,placement='legacy',presentation,characterName,open,captureAttempt,onCaptureAttempt,galgame=false,reply,cloudSpeaker,cloudMembers}){
  const [pending,setPending]=useState(null),flight=useRef(null),scopeKey=[scope?.channel,scope?.characterId,scope?.personaId,scope?.conversationId].join(':');
  useEffect(()=>{flight.current=null;setPending(null);return()=>{flight.current=null;};},[scopeKey]);
  const operation=pending?.scopeKey===scopeKey?pending.kind:null,matching=['app-private','app-group'].includes(scope?.channel)&&matchesChat(scope,snapshot?.state?.scope),phase=snapshot?.state?.preparation,loading=phase?.target==='live'&&['checking','verifying','loading'].includes(phase.state),stopping=operation==='stopping'||snapshot?.stoppingCapture,active=matching&&!stopping&&(operation==='starting'||snapshot?.captureMode==='live'||snapshot?.state?.live===true||snapshot?.state?.capture?.mode==='live'||loading),preparing=active&&(operation==='starting'||snapshot?.captureState==='preparing'||loading);
  function run(kind,fn){
    const current={kind,scopeKey};flight.current=current;setPending(current);
    const done=()=>{if(flight.current===current){flight.current=null;setPending(null);}};
    try{return Promise.resolve(fn()).then(done,done);}catch{done();}
  }
  function toggleLive(){
    if(stopping||flight.current?.kind==='stopping')return;
    const latest=session?.snapshot?.()??snapshot;
    if(active){if(!matchesChat(scope,latest?.state?.scope))return;return run('stopping',()=>session?.stopChat());}
    if(flight.current||!canStartLive(latest,scope))return;
    onCaptureAttempt?.('live');return run('starting',()=>session?.start('live'));
  }
  const p=voicePlugin(snapshot?.state?.selectedPackageId);
  const isCloud=value=>isBuiltinCloud(value?.state)||value?.state?.settings?.packages?.[value.state.selectedPackageId]?.ttsProvider==='minimax';
  const builtin=snapshot?.state?.builtinCloud,activeBuiltin=isBuiltinCloud(snapshot?.state);
  const ready=snapshot?.state?.preparation?.state==='ready',cloud=isCloud(snapshot),canRecord=canStartLive(snapshot,scope)&&(ready||cloud);
  const speaker=cloudSpeaker??reply?.characterId;
  const cloudStatus=snapshot?.state?.cloudSpeech;
  const speakerMatches=!speaker||speaker===snapshot?.state?.scope?.characterId;
  const cloudSnapshot=cloud&&speaker?{
    ...snapshot,state:{...snapshot.state,cloudSpeech:cloudStatus?.characterId===speaker?cloudStatus:speakerMatches?snapshot.state.cloud:null},
  }:snapshot;
  const liveReady=activeBuiltin?builtin?.asr?.state==='ready':cloud?chatVoiceState(cloudSnapshot)==='ready':ready;
  const openSettings=()=>activeBuiltin?openBuiltinCloudPage():globalThis.whale?.open?.('voice');
  const changeProvider=route=>{
    if(!builtin)return session?.configure({packages:{[p.id]:{ttsProvider:route}}});
    const next=route==='cloud'||route==='minimax'?`cloud:${builtin.providerId??'minimax-cn'}`:`local:${snapshot?.state?.engine??p.key}`;
    return session?.runAction('builtin-cloud-route',{route:next,...(next.startsWith('cloud:')?{enabled:true}:{})});
  };
  const toggleVoice=enabled=>activeBuiltin?session?.runAction('builtin-cloud-route',{route:builtin.route,enabled}):session?.configure({enabled});
  const recordMode=matching&&(snapshot?.captureMode==='record'||snapshot?.state?.capture?.mode==='record'),recording=recordMode&&snapshot?.captureState!=='idle';
  const onCancel=()=>{if(!matchesChat(scope,(session?.snapshot?.()??snapshot)?.state?.scope))return;return run('stopping',()=>session?.stopChat());};
  const onRecord=()=>{const latest=session?.snapshot?.()??snapshot;if(flight.current||!canStartLive(latest,scope)||latest?.state?.preparation?.state!=='ready'&&!isCloud(latest))return;onCaptureAttempt?.('record');return run('recording',()=>session?.start('record'));};
  const microphoneError=!snapshot?.cloudFailure&&!!snapshot?.error&&/NotAllowedError|NotFoundError|NotReadableError|PermissionDenied|permission|microphone|麦克风|录音设备/i.test(snapshot.error),replyError=!!snapshot?.error&&/VOICE_REPLY_UNAVAILABLE|本次语音回复未能开始|回复没能读出来|配音失败|voice reply|read aloud/i.test(snapshot.error);
  if(placement==='top')return h(VoiceChip,{snapshot:cloudSnapshot,presentation,open,galgame},h(VoicePopover,{snapshot:cloudSnapshot,galgame,cloudSpeaker:speaker,cloudMembers,onToggle:toggleVoice,onStart:()=>session?.startSpeech(),onPlugin:selectedPackageId=>session?.configure({selectedPackageId}),onProvider:changeProvider,onCheck:()=>session?.runAction('builtin-cloud-probe',{providerId:builtin?.providerId}),onOpen:openSettings}));
  if((placement==='input-left'||placement==='input-right')&&matching&&activeBuiltin&&builtin.enabled&&builtin.asr?.state!=='ready'&&!active)return h(CloudRecognitionEntry,{asr:builtin.asr,session,mic:placement==='input-left'});
  if(placement==='input-left')return h('button',{type:'button',className:'vx-mic','aria-label':L('录音输入','Voice input'),title:L('录音输入：说完把文字放进输入框','Voice input: puts what you said into the box'),disabled:!canRecord||!!presentation?.speaking,onClick:onRecord},VoiceIcon('mic',18));
  if(placement==='input-right')return h('button',{type:'button',className:'vx-livebtn'+(active?' on':''),role:'switch','aria-label':t('Live 轮流交谈'),'aria-checked':active&&!preparing,'aria-busy':preparing||stopping,'data-voice-live':true,disabled:stopping||!active&&(!canStartLive(snapshot,scope)||!liveReady||!!presentation?.speaking),onClick:toggleLive},VoiceIcon('turns'),h('span',null,'Live'));
  if(placement==='replacement'){
    if(recording)return h(VoiceRecordingRow,{partial:snapshot?.partial,preparing:snapshot?.captureState==='preparing',processing:snapshot?.captureState==='processing',onCancel,onFinish:()=>run('finishing',()=>session?.finish()),disabled:stopping});
    if(active&&!preparing){const livePhase=presentation?.subtitle?'say':snapshot?.captureState==='processing'?'hear':snapshot?.captureState==='waiting-playback'||presentation?.speaking?'think':'you';return h(VoiceLiveStrip,{phase:livePhase,name:characterName??voiceName(scope?.characterId),partial:snapshot?.partial,onEnd:toggleLive,disabled:stopping});}
    return null;
  }
  const showAlerts=placement==='alerts'||placement==='stage-alerts';
  if(showAlerts&&!activeBuiltin&&snapshot?.state?.packages?.some(row=>row.installed&&VOICE_PLUGINS.some(plugin=>plugin.id===row.id))===false)return null;
  const cloudFailureReason=reply===undefined?snapshot?.cloudFailure&&snapshot.error:presentation?.cloudFailure&&presentation.error;
  if(placement==='stage-alerts'&&matching&&!microphoneError&&!preparing&&(cloudFailureReason||(reply===undefined?replyError||snapshot?.phase?.stage==='error'||snapshot?.error===t('配音失败，回复文字已保留'):!!presentation?.error))){
    const category=activeBuiltin&&(reply===undefined?snapshot?.cloudFailureCategory:presentation?.cloudFailureCategory);
    const quota=category==='quota',auth=category==='auth',balance=category==='balance';
    const reason=auth?L('MiniMax Key 无效','the MiniMax key is invalid'):balance?L('MiniMax 余额不足','MiniMax balance is too low'):cloudFailureReason;
    const detail=quota?t('MiniMax 本时段额度已用完，先只显示文字，稍后自动恢复')
      :activeBuiltin&&reason?L('没读出来：{reason}，回复文字已保留','Not read aloud: {reason}; the text is kept',{reason:reason.replace(/[。.!]$/,'')})
      :reason||t('配音失败，回复文字已保留');
    const label=auth?L('去填 Key','Enter key'):activeBuiltin?L('打开云配音','Open cloud voice'):t('打开语音设置');
    return h('span',{className:'gx-dub-failure'+(quota?' warn':auth||balance?' err':''),role:'status'},VoiceIcon('alert',12),
      h('span',null,detail,quota?'':' · '),!quota&&h('button',{type:'button',onClick:auth?()=>openBuiltinCloudPage({account:true}):openSettings},label));
  }
  const staleCloudFailure=snapshot?.cloudFailure&&reply!==undefined&&reply?.replyId!==snapshot.errorReplyId;
  const alertError=staleCloudFailure||placement==='stage-alerts'&&reply!==undefined&&!microphoneError&&(replyError||snapshot?.errorReplyId)?undefined:snapshot?.error;
  if(showAlerts)return h(VoiceLiveAlert,{kind:microphoneError?'mic':preparing?'loading':alertError&&replyError&&active?'reply':null,message:alertError,onRetry:()=>{const latest=session?.snapshot?.()??snapshot;if(canStartLive(latest,scope)){const mode=captureAttempt??snapshot?.captureMode??snapshot?.state?.capture?.mode??'live';onCaptureAttempt?.(mode);return run('starting',()=>session?.start(mode));}},onCancel,onOpen:openSettings});
  if(placement==='legacy')return h('div',{'data-voice-chat-controls':true,style:{display:'flex',flexWrap:'wrap',gap:6,alignItems:'center'}},
    h(VoiceToggle,{snapshot,onToggle:toggleVoice,onStart:()=>session?.startSpeech()}),
    h('button',{type:'button',role:'switch','aria-label':t('Live 轮流交谈'),'aria-checked':active&&!preparing,'aria-busy':preparing||stopping,'data-voice-live':true,className:'gx-gbtn',disabled:stopping||!active&&!canStartLive(snapshot,scope),onClick:toggleLive},t(stopping?'正在停止 Live…':preparing?'取消 Live · 初始化中…':active?'停止 Live':'开启 Live')));
}

export function useVoiceClient(scopeKey,onDraft,reply,cloudMembers){
  const {session,snapshot}=useVoiceSession(),[observed,setPresentation]=useState(null),[draftScope,setDraftScope]=useState(null),[captureAttempt,setCaptureAttempt]=useState(null),draft=useRef(onDraft);draft.current=onDraft;
  const api=globalThis.whale?.voice;
  const [characterId,personaId,conversationId,groupId]=String(scopeKey??'').split(':'),expected={characterId,personaId,conversationId:groupId||conversationId,channel:groupId?'app-group':'app-private'};
  const presentation=observed?.scopeKey===scopeKey?{...observed.value,error:reply===undefined||matchesReply(reply,observed.value.errorEnvelope)?observed.value.error:null}:{subtitle:null,speaking:false,requests:[]};
  useEffect(()=>{
    setDraftScope(null);const current=session.current;if(!current)return;
    const off=current.output.subscribe(expected,value=>setPresentation({scopeKey,value})),draftOff=current.onDraft(expected,event=>{setDraftScope(scopeKey);draft.current?.(event);});
    return()=>{off();draftOff();};
  },[api,scopeKey]);
  const cloud=snapshot?.state?.settings?.packages?.[snapshot?.state?.selectedPackageId]?.ttsProvider==='minimax';
  const speaker=reply?.characterId;
  useEffect(()=>{
    if(!cloud)return;
    const current=session.current;
    if(!current)return;
    const state=current.snapshot()?.state;
    if(!matchesChat(expected,state?.scope)||speaker&&state?.cloudSpeech?.characterId!==speaker)void current.refresh().catch(()=>{});
  },[api,scopeKey,cloud,speaker]);
  const value=presentation.error?{...snapshot,error:presentation.error,cloudFailure:presentation.cloudFailure}:snapshot,matching=matchesChat(expected,value?.state?.scope),preparation=value?.state?.preparation,preparing=value?.captureState==='preparing'||preparation?.target==='live'&&['checking','verifying','loading'].includes(preparation.state);
  const live=matching&&!value?.stoppingCapture&&(value?.captureMode==='live'||value?.state?.live||value?.state?.capture?.mode==='live'),recording=matching&&!value?.stoppingCapture&&(value?.captureMode==='record'||value?.state?.capture?.mode==='record')&&value?.captureState!=='idle';
  useEffect(()=>{setCaptureAttempt(null);},[scopeKey,JSON.stringify(snapshot?.state?.scope)]);
  const control=placement=>h(VoiceChatControls,{snapshot:value,session:session.current,scope:expected,presentation,placement,reply,cloudMembers,captureAttempt,onCaptureAttempt:setCaptureAttempt,galgame:true});
  return {builtinCloud:isBuiltinCloud(snapshot?.state)&&snapshot?.state?.builtinCloud?.enabled?snapshot.state.builtinCloud:null,controls:control('legacy'),topControls:control('top'),inputLeft:control('input-left'),inputRight:control('input-right'),inputReplacement:control('replacement'),alerts:control('alerts'),stageAlerts:control('stage-alerts'),replacingInput:!!(recording||live&&!preparing),live:!!live,draftFromVoice:draftScope===scopeKey,clearDraftSource:()=>setDraftScope(null),speakingIndicator:presentation.subtitle?h(VoiceSpeakingIndicator):null,stopReading:presentation.speaking?h(VoiceButton,{kind:'ghost sm',icon:'stop',onClick:()=>session.current?.output.stopReading(presentation.activeRequestId)},L('停止朗读','Stop reading')):null,subtitle:presentation.subtitle,speaking:presentation.speaking,presentation};
}

export function VoiceSettingsPanel({snapshot,session,onPlugins,onChat,selectedPackageId,onSelectPackage}){
  const [text,setText]=useState(''),[importing,setImporting]=useState(false),[localSelection,setLocalSelection]=useState(null),[fullSettings,setFullSettings]=useState(false),importRun=useRef(0),importMounted=useRef(true),importContext=useRef(null);
  const {state,error,working,pendingDraft}=snapshot??{},id=selectedPackageId??localSelection??state?.selectedPackageId??VOICE_PLUGINS[0].id,p=voicePlugin(id),current=state?.scope?.characterId,installed=state?.packages?.filter(row=>row.installed)??[];
  const builtin=!!state?.builtinCloud,pluginSettings=state?.settings?.packages?.[id],options=builtin?{...pluginSettings,ttsProvider:'local'}:pluginSettings??{ttsProvider:'local'};
  const localView=builtin?{...snapshot,state:{...state,settings:{...state.settings,packages:{...state.settings?.packages,[id]:options}}}}:snapshot;
  useEffect(()=>session?.manageComponents?.(),[session]);
  const scopeStamp=value=>JSON.stringify(['channel','characterId','personaId','conversationId','lifeId','operationId'].map(key=>value?.[key]??null)),scopeIdentity=scopeStamp(state?.scope);
  importContext.current={scope:scopeIdentity,id,open:importing};
  useEffect(()=>{importMounted.current=true;return()=>{importMounted.current=false;importRun.current++;};},[]);
  const closeImport=()=>{importRun.current++;importContext.current={...importContext.current,open:false};setImporting(false);};
  const openImport=()=>{importRun.current++;setImporting(true);};
  useEffect(()=>{importRun.current++;setImporting(false);setText('');setFullSettings(false);},[scopeIdentity,id]);
  const choose=value=>{setLocalSelection(value);onSelectPackage?.(value);},configure=patch=>session?.configure(patch),ensureSelected=async()=>{if(id!==state?.selectedPackageId){await configure({selectedPackageId:id});return session?.snapshot?.()?.state?.selectedPackageId===id;}return true;};
  const start=selectedPackageId=>builtin?session?.runAction('builtin-cloud-route',{route:`local:${voicePlugin(selectedPackageId).key}`,enabled:true}):configure({enabled:true,selectedPackageId});
  const where=h(VoiceWhere,{provider:options.ttsProvider,disabled:working,onChange:ttsProvider=>builtin?(ttsProvider==='minimax'&&openBuiltinCloudPage()):configure({packages:{[id]:{ttsProvider}}})});
  const prepare=async(kind,op='assets-prepare',extra={})=>{setFullSettings(false);return session?.runAction(op,{kind,packageId:id,...extra});};
  const parts=()=>h(VoiceParts,{snapshot:localView,id,onPrepare:prepare,onPrepareOfficial:(kind,expectedProvider)=>prepare(kind,'assets-prepare',{official:true,expectedProvider}),onVerify:kind=>prepare(kind,'assets-verify'),onImport:kind=>prepare(kind,'assets-import'),onCancel:()=>session?.runAction('assets-cancel'),onRefresh:()=>session?.refresh()});
  const importRecording=async()=>{
    const ticket=++importRun.current,expectedScope=scopeIdentity,expectedId=id,transcript=text;
    const valid=()=>importMounted.current&&ticket===importRun.current&&importContext.current?.open&&importContext.current.id===expectedId&&importContext.current.scope===expectedScope&&scopeStamp(session?.snapshot?.()?.state?.scope??state?.scope)===expectedScope;
    if(!state?.scope||!valid())return;
    if(!await ensureSelected()||!valid())return;
    if(session?.snapshot?.()?.state?.selectedPackageId!==expectedId||!valid())return;
    const result=await session?.runAction('profile-import',{text:transcript,label:t('我的声音')});
    if(valid()&&result&&!result.cancelled)closeImport();
  };
  const browsedAssets=snapshot?.componentStatuses?.[id]??state?.assets,localPartsNeedAttention=options.ttsProvider==='local'&&(state?.assetProgress?.state==='preparing'||['missing','verification-needed','error','unavailable','preparing'].some(phase=>phase===browsedAssets?.asr?.state||phase===browsedAssets?.tts?.state));
  if(localPartsNeedAttention&&!fullSettings)return h('div',{className:'ws-page vx-page vx-narrow settings-voice','data-settings-voice':true},parts(),h(VoiceButton,{kind:'ghost sm',onClick:()=>setFullSettings(true),'data-voice-full-settings':true},L('返回完整语音设置','Open all voice settings')),error&&h('p',{role:'alert',className:'settings-error'},error));
  return h('div',{className:'ws-page vx-page settings-voice','data-settings-voice':true},
    !selectedPackageId&&h('div',{className:'ui-seg vx-pagetabs',role:'tablist','aria-label':L('语音插件','Voice plugins')},VOICE_PLUGINS.map(row=>h('button',{type:'button',role:'tab','aria-selected':id===row.id,key:row.id,onClick:()=>choose(row.id)},VoiceIcon(row.icon,14),row.short))),
    !installed.length&&h('p',{className:'settings-note'},L('去扩展中心安装语音插件','Install a voice plugin in Extensions'),' ',h(VoiceButton,{onClick:onPlugins},L('安装语音插件','Install voice plugin'))),
    h(VoiceEngineCard,{snapshot:localView,id,onStart:()=>start(id),onStop:()=>options.ttsProvider==='minimax'?configure({enabled:false}):session?.stop(),onPlugins,onOther:()=>start(VOICE_PLUGINS.find(row=>row.id!==id).id)}),
    options.ttsProvider==='minimax'?h(React.Fragment,null,h(CloudVoiceSettings,{key:id,snapshot,session,whereControl:where,browsedPackageId:id}),parts()):h('div',{className:'vx-cols'},h(VoiceCharacters,{snapshot,id,onImport:openImport,onSelect:profileId=>session?.runAction('profile-select',{profileId,packageId:id})}),h('div',{className:'vx-side'},where,parts())),
    pendingDraft&&h('div',{className:'settings-note'},h('label',null,t('录音草稿'),h('textarea',{readOnly:true,value:pendingDraft.text,rows:3})),h('p',null,t('打开对应对话后，录音文字会填入草稿。')),h(VoiceButton,{kind:'sm',onClick:onChat},t('打开对话'))),
    error&&h('p',{role:'alert',className:'settings-error'},error),
    importing&&h(VoiceImportDialog,{name:voiceName(current),text,onText:setText,onClose:closeImport,onConfirm:importRecording,working,error}));
}

export function VoiceSettings({onPlugins,onChat,selectedPackageId,onSelectPackage}){const {session,snapshot}=useVoiceSession();return h(VoiceSettingsPanel,{snapshot,session:session.current,onPlugins,onChat,selectedPackageId,onSelectPackage});}
