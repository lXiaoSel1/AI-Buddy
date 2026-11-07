import {randomUUID} from 'node:crypto';
import {sameVoiceScope} from './conversation.mjs';
import {createVoiceSettings} from './settings.mjs';
import {voiceSpeechText,voiceSpeechChunks as speechChunks} from './speech-text.mjs';

const fault=(message,code)=>Object.assign(Error(message),{code});
const normalizeEngine=engine=>engine==='gpt-sovits'?'gpt':engine;
const copy=value=>value==null?value:structuredClone(value);
const maxCaptureBytes=120*16000*2;
const terminalReceipts=new Set(['audioCompleted','explicitlySkipped','interrupted','failed']);
const speechText=voiceSpeechText;


/** Only the trusted companion service admits model turns; UI actions never supply identity. */
export function createVoiceController({getScope,submit,send=()=>{},listPackages,runtime,assets,profiles,settings=createVoiceSettings()}) {
  let epoch=0,closed=false,stopping=null,capture=null,live=null;
  let captureTail=Promise.resolve();
  const turns=new Map();
  const queued=[],inflight=new Set(),capacityWaiters=new Set();
  let pumping=false,pumpTask=null;
  const emit=event=>{try{send(event);}catch{}};
  const serialCapture=fn=>{const task=captureTail.then(fn);captureTail=task.catch(()=>{});return task;};
  const current=()=>copy(getScope?.());
  const matches=scope=>sameVoiceScope(scope,current());
  function ensureOpen(){if(closed||stopping)throw fault('语音正在停止或已关闭','VOICE_STOPPING');}
  async function selected(){
    const config=await settings.get();
    const rows=await listPackages();
    const row=rows.find(value=>value.id===config.selectedPackageId);
    if(!config.enabled)throw fault('语音尚未启用','VOICE_DISABLED');
    if(!row||!row.installed||!row.enabled||row.trusted===false||!row.usable)throw fault('选中的语音插件未安装、已停用或未通过校验','VOICE_PACKAGE_UNAVAILABLE');
    const engine=normalizeEngine(row.engine);
    if(!['breeze','gpt'].includes(engine))throw fault('未知语音引擎','VOICE_PACKAGE_INVALID');
    return {config,row,engine,options:config.packages[row.id]};
  }
  const packageProof=chosen=>JSON.stringify([chosen.row.id,chosen.row.sourceId,chosen.row.version,chosen.row.archiveSha256,chosen.options]);
  function hostScopeValid(scope,target){
    if(!scope||!target||!['characterId','lifeId','operationId','personaId','conversationId','channel'].every(key=>typeof scope[key]==='string'&&scope[key]))return false;
    return scope.channel==='app-group'?target.channel===scope.channel&&target.conversationId===scope.conversationId&&target.personaId===scope.personaId:sameVoiceScope(scope,target);
  }
  async function admit(scope){
    try{
      ensureOpen();const target=current(),generation=epoch;
      if(!hostScopeValid(scope,target)||typeof scope.requestId!=='string'||!scope.requestId||turns.has(scope.requestId))return null;
      if(scope.channel==='app-private'&&[...turns.values()].some(turn=>sameVoiceScope(turn.scope,scope)))return null;
      const chosen=await selected();
      const profile=await profiles?.current({characterId:scope.characterId,engine:chosen.engine});
      if(!profile||profile.characterId!==scope.characterId||profile.engine!==chosen.engine||profile.version==null)return null;
      if(chosen.options.ttsProvider==='local')await assets.resolve(chosen.engine,chosen.row.id);
      else{
        if(!chosen.options.credentialRef||typeof runtime.ready!=='function')return null;
        const readiness=await runtime.ready({engine:chosen.engine,packageId:chosen.row.id,characterId:scope.characterId,profileId:profile.id,profileVersion:profile.version,
          speechProvider:chosen.options.ttsProvider,credentialRef:chosen.options.credentialRef});
        if(readiness?.ready!==true)return null;
      }
      if(generation!==epoch||!matches(target))return null;
      const checked=await selected();if(packageProof(checked)!==packageProof(chosen))return null;
      const turn={scope:copy(scope),target,epoch:generation,profile:copy(profile),chosen,proof:packageProof(chosen),segments:new Map(),finished:false,abort:new AbortController()};
      turns.set(scope.requestId,turn);
      return {epoch:generation,voiceProfileVersion:profile.version};
    }catch(error){emit({type:'status',state:'waiting-configuration',code:error.code??'VOICE_NOT_READY',message:String(error.message)});return null;}
  }
  async function assertTurn(turn){
    ensureOpen();
    if(!turn||turn.abort.signal.aborted||turn.epoch!==epoch||!matches(turn.target)||!turns.has(turn.scope.requestId))throw fault('旧语音回包已失效','VOICE_STALE_TURN');
    const chosen=await selected();
    if(packageProof(chosen)!==turn.proof)throw fault('语音插件配置已改变','VOICE_PACKAGE_CHANGED');
    const profile=await profiles.current({characterId:turn.scope.characterId,engine:turn.chosen.engine});
    if(!profile||profile.id!==turn.profile.id||profile.version!==turn.profile.version)throw fault('角色声线已改变','VOICE_PROFILE_CHANGED');
  }
  function wakeCapacity(){for(const wake of capacityWaiters)wake();capacityWaiters.clear();}
  async function resumeLive(){
    const session=live;
    if(!session?.waiting||closed||stopping||!matches(session.scope)||session.epoch!==epoch||turns.size)return;
    session.waiting=false;session.pending=null;
    try{await serialCapture(()=>beginCapture('live',session));}
    catch(error){if(live===session)live=null;emit({type:'error',code:error.code??'VOICE_CAPTURE_FAILED',message:String(error.message)});}
  }
  async function settleTurn(turn){
    if(!turn.finished||[...turn.segments.values()].some(row=>!row.terminal))return;
    turns.delete(turn.scope.requestId);
    await resumeLive();
  }
  function envelopeMatches(expected,actual){return !!actual&&Object.keys(expected).every(key=>expected[key]===actual[key]);}
  async function receipt({envelope,status,playedMs}={}){
    const turn=turns.get(envelope?.requestId),job=turn?.segments.get(envelope?.segmentId);
    if(!job||!envelopeMatches(job.envelope,envelope)||job.terminal||!['textDisplayed','audioStarted',...terminalReceipts].includes(status))return {accepted:false};
    try{await assertTurn(turn);}catch{return {accepted:false};}
    if(job.receipts.has(status))return {accepted:false};
    job.receipts.add(status);
    if(terminalReceipts.has(status)){
      job.terminal=true;inflight.delete(job);wakeCapacity();void pump();await settleTurn(turn);
    }
    return {accepted:true,playedMs};
  }
  async function play(job){
    const {turn,envelope}=job;
    await assertTurn(turn);
    const engine=turn.chosen.engine,speechProvider=turn.chosen.options.ttsProvider;
    // Announce metadata before the first PCM. The actual worker rate is repeated on every chunk.
    emit({type:'audio',phase:'start',envelope,text:job.text,speech_text:job.speech,engine,speechProvider,
      sampleRate:speechProvider==='minimax'?32000:engine==='breeze'?24000:48000});
    let lastRate,metrics;
    for(const part of job.parts){
      for(const text of speechChunks(part.text)){
        await assertTurn(turn);
        for await(const event of runtime.speak({engine,packageId:turn.chosen.row.id,characterId:turn.scope.characterId,profileId:turn.profile.id,profileVersion:turn.profile.version,
          text,performance:part.performance,instruction:part.performance?.delivery??'',speechProvider,credentialRef:turn.chosen.options.credentialRef,signal:turn.abort.signal})){
          await assertTurn(turn);
          if(job.terminal)return;
          if(event.type==='pcm'){
            const bytes=event.pcm;
            if(!(bytes instanceof Uint8Array)||!bytes.byteLength||bytes.byteLength%2||!Number.isInteger(event.sampleRate)||event.sampleRate<8000||event.sampleRate>192000)throw fault('配音返回了无效 PCM','VOICE_AUDIO_INVALID');
            lastRate=event.sampleRate;emit({type:'audio',phase:'pcm',envelope,pcm:bytes,sampleRate:event.sampleRate});
          }else if(event.type==='done')metrics=event.metrics;
          else if(event.type==='reference')emit({type:'reference',envelope,style:event.style,source:event.source});
        }
      }
    }
    await assertTurn(turn);
    job.sent=true;
    emit({type:'audio',phase:'end',envelope,...(lastRate?{sampleRate:lastRate}:{}),metrics,skipped:!job.speech});
  }
  function sealCleanup(error){
    const failure=fault(String(error?.message??error),'VOICE_CLEANUP_FAILED');
    stopping=Promise.reject(failure);void stopping.catch(()=>{});
    live=null;captureState('idle');emit({type:'status',state:'error',code:failure.code,message:failure.message});
    return failure;
  }
  async function runPump(){
    try{
      while(queued.length&&inflight.size<2&&!closed&&!stopping){
        const job=queued.shift();wakeCapacity();
        if(job.terminal||job.turn.abort.signal.aborted)continue;
        inflight.add(job);
        try{await play(job);}
        catch(error){
          emit({type:'segment',state:'failed',envelope:job.envelope,code:error.code??'VOICE_SYNTHESIS_FAILED',message:String(error.message)});
          // The renderer persists a failed terminal receipt; never pretend failed audio was played.
          job.failed=true;
          live=null;captureState('idle');
          try{await runtime.stopEngine?.();}catch(failure){throw sealCleanup(failure);}
          return;
        }
      }
    }finally{pumping=false;pumpTask=null;}
  }
  function pump(){
    if(pumping||closed||stopping)return pumpTask??Promise.resolve();
    pumping=true;
    const task=runPump();pumpTask=task;void task.catch(()=>{});return task;
  }
  async function segment({envelope,text,speech_text,performance,performances}={}){
    const turn=turns.get(envelope?.requestId);
    try{
      await assertTurn(turn);
      const expected={...turn.scope,epoch:turn.epoch,voiceProfileVersion:turn.profile.version,index:turn.segments.size,segmentId:turn.scope.requestId+':voice:'+turn.segments.size};
      if(turn.finished||!envelopeMatches(expected,envelope)||typeof text!=='string'||text.length>200000)throw fault('语段身份或顺序无效','VOICE_SEGMENT_INVALID');
      while(queued.length>=3){await new Promise(resolve=>capacityWaiters.add(resolve));await assertTurn(turn);}
      // Admission can yield while waiting; recheck sequence before claiming the slot.
      if(turn.segments.size!==envelope.index)throw fault('语段已经提交','VOICE_SEGMENT_INVALID');
      const source=typeof speech_text==='string'?speech_text:text;
      const parts=Array.isArray(performances)&&performances.length&&performances.every(row=>typeof row?.text==='string')
        ?performances.map(row=>({text:speechText(row.text),performance:row.performance??performance})): [{text:speechText(source),performance}];
      const job={turn,envelope:Object.freeze(copy(expected)),text,speech:parts.map(row=>row.text).join(''),parts,terminal:false,receipts:new Set()};
      turn.segments.set(expected.segmentId,job);queued.push(job);
      emit({type:'segment',state:'queued',envelope:job.envelope,text,speech_text:job.speech});
      void pump();return true;
    }catch(error){emit({type:'segment',state:'rejected',envelope,code:error.code??'VOICE_SEGMENT_INVALID'});return false;}
  }
  async function finish({requestId,failed=false,scope,submissionId,reason='reply-failed'}={}){
    const turn=turns.get(requestId);
    if(!turn){
      const session=live,pending=session?.pending;
      if(!failed||!session?.waiting||session.epoch!==epoch||!matches(session.scope)||!sameVoiceScope(scope,session.scope)||
         !pending||pending.submissionId!==submissionId||typeof requestId!=='string'||!requestId||pending.requestId&&pending.requestId!==requestId)return;
      live=null;
      captureState('idle',null,{reason,requestId,submissionId,submitted:true});
      emit({type:'status',state:'reply-unavailable',code:'VOICE_REPLY_UNAVAILABLE',message:'消息已保存，本次语音回复未能开始；请检查语音设置或聊天连接。'});
      try{await serialCapture(()=>runtime.cancelCapture?.());}catch(error){throw sealCleanup(error);}
      return;
    }
    turn.finished=true;
    emit({type:'turn',state:'generated',requestId,failed});
    if(failed){
      live=null;captureState('idle',null,{reason:'reply-failed'});
      turn.abort.abort();
      for(const job of turn.segments.values())job.terminal=true;
      for(let i=queued.length-1;i>=0;i--)if(queued[i].turn===turn)queued.splice(i,1);
      for(const job of inflight)if(job.turn===turn)inflight.delete(job);
      wakeCapacity();
      try{await Promise.all([runtime.stopEngine?.(),pumpTask]);}catch(error){throw sealCleanup(error);}
    }
    await settleTurn(turn);void pump();
  }
  function assertCapture(id){
    if(!capture||capture.id!==id||capture.epoch!==epoch||!matches(capture.scope))throw fault('这次录音已经结束或角色已切换','VOICE_STALE_CAPTURE');
    return capture;
  }
  function captureState(state,row=capture,extra={}){emit({type:'capture',state,id:row?.id??null,mode:row?.mode??null,...extra});}
  async function retireCapture(row){
    if(capture===row)capture=null;
    live=null;
    try{await runtime.cancelCapture?.();}catch(error){throw sealCleanup(error);}
    captureState('idle',row);
  }
  async function beginCapture(mode,session){
    ensureOpen();
    const scope=current(),generation=epoch;
    if(!scope)throw fault('请先打开角色聊天','VOICE_SCOPE_CHANGED');
    const chosen=await selected();ensureOpen();
    if(capture||live?.waiting)throw fault('麦克风正在使用或正在等待播放','VOICE_CAPTURE_BUSY');
    await assets.resolve('asr',chosen.row.id);
    ensureOpen();
    if(generation!==epoch||!matches(scope))throw fault('角色已切换','VOICE_SCOPE_CHANGED');
    const row={id:randomUUID(),mode,scope,epoch:generation,bytes:0,finishing:false};
    capture=row;
    try{
      await runtime.startCapture({engineId:chosen.row.id});
      assertCapture(row.id);
      const checked=await selected();ensureOpen();assertCapture(row.id);
      if(packageProof(checked)!==packageProof(chosen))throw fault('语音插件已改变','VOICE_PACKAGE_CHANGED');
      if(session)live=session;
      captureState(mode==='live'?'listening':'recording',row);
      return {id:row.id,mode};
    }catch(error){await retireCapture(row);throw error;}
  }
  async function finalizeCapture(id,limit=false){
    const row=assertCapture(id);
    if(row.finishing)throw fault('录音正在完成','VOICE_CAPTURE_BUSY');
    row.finishing=true;captureState('processing',row);
    try{
      await selected();
      const result=await runtime.finishCapture();
      assertCapture(id);capture=null;
      const text=String(result?.text??'').trim();
      if(row.mode==='record'||limit){
        if(limit)live=null;
        if(text)emit({type:'draft',text,append:true,captureId:row.id,scope:copy(row.scope),limit});
        captureState('idle',row);
        return {draft:text,limit};
      }
      if(!text){
        if(live&&live.epoch===epoch){live.waiting=false;await beginCapture('live',live);}else captureState('idle',row);
        return {submitted:false,empty:true};
      }
      // Disable capture before submitting: repeated endpoint callbacks cannot resubmit this ID.
      const session=live;
      if(!session||session.epoch!==epoch||!matches(row.scope))throw fault('Live 已停止','VOICE_STALE_CAPTURE');
      session.waiting=true;session.pending={submissionId:row.id,requestId:null};
      captureState('waiting-playback',row);
      const accepted=await submit({scope:copy(row.scope),text,submissionId:row.id});
      if(live===session&&session.pending?.submissionId===row.id)session.pending.requestId=accepted?.requestId??null;
      return {submitted:true,text,accepted};
    }catch(error){await retireCapture(row);throw error;}
  }
  function invalidate(reason='stopped'){
    if(stopping)return stopping;
    epoch++;live=null;const old=capture;capture=null;
    for(const turn of turns.values())turn.abort?.abort();
    turns.clear();
    queued.length=0;inflight.clear();
    wakeCapacity();
    // Revoke first, then await the owned workers. A failed cleanup keeps the gate sealed.
    const job=Promise.allSettled([
      Promise.resolve().then(()=>runtime.cancelCapture?.()),Promise.resolve().then(()=>runtime.stopEngine?.()),pumpTask,captureTail,
    ]).then(results=>{
      captureState('idle',old,{reason});emit({type:'invalidate',epoch,reason});
      const failure=results.find(row=>row.status==='rejected');
      if(failure)throw fault(String(failure.reason?.message??failure.reason),'VOICE_CLEANUP_FAILED');
    });
    stopping=job;
    void job.then(()=>{if(stopping===job)stopping=null;},()=>{});
    return job;
  }
  async function state(){
    const config=await settings.get(),packages=await listPackages();
    const row=packages.find(item=>item.id===config.selectedPackageId),options=config.packages[config.selectedPackageId];
    const ready=async kind=>{try{return await assets.status(kind,config.selectedPackageId);}catch(error){return {state:'unavailable',code:error.code};}};
    return {epoch,closed,stopping:!!stopping,capture:capture?{id:capture.id,mode:capture.mode}:null,live:!!live,
      settings:config,packages,selectedPackageId:config.selectedPackageId,engine:normalizeEngine(row?.engine),speechProvider:options.ttsProvider,
      assets:{asr:await ready('asr'),tts:options.ttsProvider==='local'?await ready(normalizeEngine(row?.engine)):{state:'not-required'}},
      queue:{queued:queued.length,inflight:inflight.size},scope:current()};
  }
  async function action(op,payload={}){
    if(op==='state')return state();
    if(op==='stop')return invalidate('user-stop');
    if(op==='configure'){
      await invalidate('configuration-changed');
      const result=await settings.update(payload);emit({type:'state',state:await state()});return result;
    }
    ensureOpen();
    if(op==='receipt')return receipt(payload);
    if(op==='profiles'||op==='profile-select'){
      const chosen=await selected(),scope=current();
      if(!scope||!profiles)throw fault('声音档案未就绪','VOICE_PROFILE_SCOPE');
      if(op==='profiles')return profiles.list({characterId:scope.characterId,engine:chosen.engine});
      await invalidate('profile-changed');
      return profiles.select({characterId:scope.characterId,engine:chosen.engine,profileId:payload.profileId});
    }
    if(op==='capture-start')return serialCapture(()=>{
      if(!['record','live'].includes(payload.mode))throw fault('录音模式无效','VOICE_CAPTURE_INVALID');
      return beginCapture(payload.mode,payload.mode==='live'?{epoch,scope:current(),waiting:false}:null);
    });
    if(op==='capture-feed')return serialCapture(async()=>{
      const row=assertCapture(payload.id);
      try{
        await selected();
        if(!(payload.pcm instanceof Uint8Array)||!payload.pcm.byteLength||payload.pcm.byteLength%2||payload.pcm.byteLength>32000)throw fault('录音 PCM 无效','VOICE_CAPTURE_INVALID');
        row.bytes+=payload.pcm.byteLength;
        const result=await runtime.feedCapture({pcm:payload.pcm});assertCapture(row.id);
        if(result?.partial)captureState(row.mode==='live'?'listening':'recording',row,{partial:String(result.partial)});
        const limit=result?.limit===true||row.bytes>=maxCaptureBytes;
        if(limit||row.mode==='live'&&result?.endpoint)return {...result,...await finalizeCapture(row.id,limit)};
        return result;
      }catch(error){if(capture===row)await retireCapture(row);throw error;}
    });
    if(op==='capture-finish')return serialCapture(()=>finalizeCapture(payload.id));
    throw fault('未知语音操作','VOICE_ACTION_INVALID');
  }
  async function close(){
    closed=true;let failure;
    try{await invalidate('closed');}catch(error){failure=error;}
    try{await runtime.close?.();}catch(error){failure??=error;}
    if(failure)throw failure;
  }
  return {admit,segment,finish,action,invalidate,state,close,busy:()=>!!stopping||!!capture||!!live||turns.size>0||queued.length>0||inflight.size>0||pumping};
}
