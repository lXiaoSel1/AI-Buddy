import {randomUUID} from 'node:crypto';
import {sameVoiceScope} from './conversation.mjs';
import {createVoiceSettings,mergeVoiceSettings} from './settings.mjs';
import {voiceSpeechText,voiceSpeechChunks as speechChunks} from './speech-text.mjs';
import {waitVoiceOperation,voicePreflight,VOICE_PREFLIGHT_TIMEOUT_MS} from './operation-wait.mjs';

const fault=(message,code)=>Object.assign(Error(message),{code});
const normalizeEngine=engine=>engine==='gpt-sovits'?'gpt':engine;
const copy=value=>value==null?value:structuredClone(value);
const maxCaptureBytes=120*16000*2;
const terminalReceipts=new Set(['audioCompleted','explicitlySkipped','interrupted','failed']);
const speechText=voiceSpeechText;


/** Only the trusted companion service admits model turns; UI actions never supply identity. */
export function createVoiceController({getScope,submit,send=()=>{},listPackages,runtime,assets,profiles,settings=createVoiceSettings(),preflightTimeoutMs=VOICE_PREFLIGHT_TIMEOUT_MS}) {
  let epoch=0,closed=false,stopping=null,capture=null,live=null;
  let lifecycle=new AbortController();
  let captureTail=Promise.resolve();
  let preparation={state:'idle',target:null},preparationJob,preparedSignature;
  const turns=new Map();
  const queued=[],inflight=new Set(),capacityWaiters=new Set();
  let pumping=false,pumpTask=null;
  let stateRead;
  let cleanupFailure,recoveryTask;
  const emit=event=>{try{send(event);}catch{}};
  const serialCapture=fn=>{const task=captureTail.then(fn);captureTail=task.catch(()=>{});return task;};
  const current=()=>copy(getScope?.());
  const matches=scope=>sameVoiceScope(scope,current());
  function cancelStateRead(){
    const previous=stateRead;stateRead=undefined;
    previous?.controller.abort(fault('旧语音状态查询已取消','VOICE_STATE_CANCELLED'));
  }
  function ensureOpen(){if(closed||stopping)throw fault('语音正在停止或已关闭','VOICE_STOPPING');}
  async function selected(signal,{management=false,packageId}={}){
    const config=await waitVoiceOperation(()=>settings.get(),signal);
    const rows=await waitVoiceOperation(()=>listPackages(),signal);
    const requested=packageId??config.selectedPackageId;
    if(packageId!=null&&!['ai-buddy.voice-breeze','ai-buddy.voice-gpt-sovits'].includes(packageId))throw fault('选中的语音插件未安装、已停用或未通过校验','VOICE_PACKAGE_UNAVAILABLE');
    const row=rows.find(value=>value.id===requested);
    if(!management&&!config.enabled)throw fault('语音尚未启用','VOICE_DISABLED');
    if(!row||!row.installed||row.trusted===false||!management&&(!row.enabled||!row.usable))throw fault('选中的语音插件未安装、已停用或未通过校验','VOICE_PACKAGE_UNAVAILABLE');
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
      const signal=lifecycle.signal;
      if(preparationJob)return null;
      if(!hostScopeValid(scope,target)||typeof scope.requestId!=='string'||!scope.requestId||turns.has(scope.requestId))return null;
      if(scope.channel==='app-private'&&[...turns.values()].some(turn=>sameVoiceScope(turn.scope,scope)))return null;
      const chosen=await selected(signal);
      const profile=await waitVoiceOperation(()=>profiles?.current({characterId:scope.characterId,engine:chosen.engine}),signal);
      if(!profile||profile.characterId!==scope.characterId||profile.engine!==chosen.engine||profile.version==null)return null;
      if(chosen.options.ttsProvider==='local'){
        const verified=await waitVoiceOperation(()=>assets.resolve(chosen.engine,chosen.row.id,{signal}),signal);
        const readiness=await waitVoiceOperation(()=>runtime.ready?.({engine:chosen.engine,packageId:chosen.row.id,assetProof:verified.proof}),signal);
        if(readiness?.ready!==true)return null;
      }
      else{
        if(!chosen.options.credentialRef)throw fault('请先在云配音配置中保存 MiniMax API Key','CLOUD_KEY_REQUIRED');
        if(typeof runtime.ready!=='function')throw fault('云配音组件尚未准备','CLOUD_UNAVAILABLE');
        const readiness=await waitVoiceOperation(()=>runtime.ready({engine:chosen.engine,packageId:chosen.row.id,characterId:scope.characterId,profileId:profile.id,profileVersion:profile.version,
          speechProvider:chosen.options.ttsProvider,credentialRef:chosen.options.credentialRef}),signal);
        if(readiness?.ready!==true)throw fault(readiness?.message??'当前角色的云声线尚未准备，请检查云配音设置',readiness?.code??'CLOUD_VOICE_REQUIRED');
      }
      if(generation!==epoch||!matches(target))return null;
      const checked=await selected(signal);if(generation!==epoch||!matches(target)||packageProof(checked)!==packageProof(chosen))return null;
      const turn={scope:copy(scope),target,epoch:generation,profile:copy(profile),chosen,proof:packageProof(chosen),segments:new Map(),finished:false,abort:new AbortController()};
      turns.set(scope.requestId,turn);
      emit({type:'turn',state:'admitted',requestId:scope.requestId,envelope:{...scope,epoch:generation,voiceProfileVersion:profile.version}});
      return {epoch:generation,voiceProfileVersion:profile.version};
    }catch(error){emit({type:'status',state:'waiting-configuration',code:error.code??'VOICE_NOT_READY',message:String(error.message)});return null;}
  }
  function assertTurnIdentity(turn){
    ensureOpen();
    if(!turn||turn.abort.signal.aborted||turn.epoch!==epoch||!matches(turn.target)||!turns.has(turn.scope.requestId))throw fault('旧语音回包已失效','VOICE_STALE_TURN');
  }
  async function assertTurn(turn,signal=turn?.abort.signal){
    assertTurnIdentity(turn);
    const chosen=await selected(signal);assertTurnIdentity(turn);
    if(packageProof(chosen)!==turn.proof)throw fault('语音插件配置已改变','VOICE_PACKAGE_CHANGED');
    const profile=await waitVoiceOperation(()=>profiles.current({characterId:turn.scope.characterId,engine:turn.chosen.engine}),signal);assertTurnIdentity(turn);
    if(!profile||profile.id!==turn.profile.id||profile.version!==turn.profile.version)throw fault('角色声线已改变','VOICE_PROFILE_CHANGED');
  }
  function wakeCapacity(){for(const wake of capacityWaiters)wake();capacityWaiters.clear();}
  async function resumeLive(){
    const session=live;
    if(!session?.waiting||closed||stopping||!matches(session.scope)||session.epoch!==epoch||turns.size)return;
    session.waiting=false;session.pending=null;
    try{await serialCapture(()=>beginCapture('live',session));}
    catch(error){
      if(session.epoch!==epoch||!matches(session.scope))return;
      if(live===session)live=null;
      emit({type:'error',code:error.code??'VOICE_CAPTURE_FAILED',message:String(error.message)});
    }
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
    if(status==='audioStarted')publishPhase(job,'playback-start');
    if(terminalReceipts.has(status)){
      publishPhase(job,['audioCompleted','explicitlySkipped'].includes(status)?'done':'error',status==='failed'?'VOICE_PLAYBACK_FAILED':status==='interrupted'?'VOICE_PLAYBACK_INTERRUPTED':undefined);
      job.terminal=true;inflight.delete(job);wakeCapacity();void pump();await settleTurn(turn);
    }
    return {accepted:true,playedMs};
  }
  function publishPhase(job,stage,code){
    if(job.turn.epoch!==epoch||job.turn.abort.signal.aborted||!matches(job.turn.target)||!turns.has(job.turn.scope.requestId)||job.phase===stage)return;
    if(!['queue','reference-check','component-check','model-loading','speak-sent','first-pcm','playback-start','done','error'].includes(stage))return;
    job.phase=stage;
    emit({type:'phase',envelope:job.envelope,requestId:job.envelope.requestId,segmentId:job.envelope.segmentId,index:job.envelope.index,
      engine:job.turn.chosen.engine,stage,elapsedMs:Math.max(0,Math.round(globalThis.performance.now()-job.queuedAt)),...(code?{code}:{})});
  }
  async function play(job){
    const {turn,envelope}=job;
    let preflight=voicePreflight(turn.abort.signal,preflightTimeoutMs);
    try{
    await assertTurn(turn,preflight.signal);
    const engine=turn.chosen.engine,speechProvider=turn.chosen.options.ttsProvider;
    // Announce metadata before the first PCM. The actual worker rate is repeated on every chunk.
    emit({type:'audio',phase:'start',envelope,text:job.text,speech_text:job.speech,engine,speechProvider,
      sampleRate:speechProvider==='minimax'?32000:engine==='breeze'?24000:48000});
    let lastRate,metrics;
    for(const part of job.parts){
      for(const text of speechChunks(part.text)){
        await assertTurn(turn,preflight.signal);
        for await(const event of runtime.speak({engine,packageId:turn.chosen.row.id,characterId:turn.scope.characterId,profileId:turn.profile.id,profileVersion:turn.profile.version,
          text,performance:part.performance,instruction:part.performance?.delivery??'',speechProvider,credentialRef:turn.chosen.options.credentialRef,signal:preflight.signal,
          onPhase:value=>{if(value.stage==='model-loading')preflight.pause();else if(value.stage==='component-check')preflight.resume();else if(value.stage==='speak-sent')preflight.sent();publishPhase(job,value.stage);}})){
          await assertTurn(turn,preflight.signal);
          if(job.terminal)return;
          if(event.type==='pcm'){
            const bytes=event.pcm;
            if(!(bytes instanceof Uint8Array)||!bytes.byteLength||bytes.byteLength%2||!Number.isInteger(event.sampleRate)||event.sampleRate<8000||event.sampleRate>192000)throw fault('配音返回了无效 PCM','VOICE_AUDIO_INVALID');
            if(!job.firstPcm){job.firstPcm=true;publishPhase(job,'first-pcm');}
            lastRate=event.sampleRate;emit({type:'audio',phase:'pcm',envelope,pcm:bytes,sampleRate:event.sampleRate});
          }else if(event.type==='done')metrics=event.metrics;
          else if(event.type==='reference')emit({type:'reference',envelope,style:event.style,source:event.source});
        }
        preflight.close();preflight=voicePreflight(turn.abort.signal,preflightTimeoutMs);
      }
    }
    await assertTurn(turn,preflight.signal);
    job.sent=true;
    emit({type:'audio',phase:'end',envelope,...(lastRate?{sampleRate:lastRate}:{}),metrics,skipped:!job.speech});
    }finally{preflight.close();}
  }
  function sealCleanup(error){
    const failure=fault(String(error?.message??error),'VOICE_CLEANUP_FAILED');
    cleanupFailure=failure;
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
          if(job.turn.abort.signal.aborted||job.turn.epoch!==epoch||!turns.has(job.turn.scope.requestId))return;
          publishPhase(job,'error',error.code??'VOICE_SYNTHESIS_FAILED');
          emit({type:'segment',state:'failed',envelope:job.envelope,code:error.code??'VOICE_SYNTHESIS_FAILED',message:String(error.message)});
          // The renderer persists a failed terminal receipt; never pretend failed audio was played.
          job.failed=true;
          live=null;captureState('idle');
          try{await runtime.stopEngine?.();}catch(failure){throw sealCleanup(failure);}
          if(job.turn.epoch===epoch&&!job.turn.abort.signal.aborted){
            preparedSignature=undefined;
            if(!preparationJob)publishPreparation({state:'failed',target:preparation.target??'speech',code:error.code??'VOICE_SYNTHESIS_FAILED',message:String(error.message)});
          }
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
      const job={turn,envelope:Object.freeze(copy(expected)),text,speech:parts.map(row=>row.text).join(''),parts,terminal:false,receipts:new Set(),queuedAt:globalThis.performance.now()};
      turn.segments.set(expected.segmentId,job);queued.push(job);
      emit({type:'segment',state:'queued',envelope:job.envelope,text,speech_text:job.speech});
      publishPhase(job,'queue');
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
  function publishPreparation(value,row) {
    if(row&&(preparationJob!==row||row.epoch!==epoch||row.controller.signal.aborted))return;
    preparation=value;
    // Verification progress can arrive every 100ms. It is presentation state,
    // not a request to re-authorize both ASR and TTS packages.
    emit({type:'preparation',epoch,preparation:copy(value)});
  }
  function assertPreparation(row) {
    if(preparationJob!==row||row.epoch!==epoch||row.controller.signal.aborted)throw fault('旧语音准备已取消','VOICE_PREPARATION_CANCELLED');
    ensureOpen();
    if(row.scope?!matches(row.scope):current()!=null)throw fault('角色已切换','VOICE_SCOPE_CHANGED');
  }
  function prepare(target='speech') {
    ensureOpen();
    if(!['speech','live'].includes(target))throw fault('语音准备目标无效','VOICE_PREPARE_INVALID');
    if(preparationJob){
      if(preparationJob.target===target)return preparationJob.task;
      throw fault('语音组件正在准备','VOICE_PREPARE_BUSY');
    }
    const row=preparationJob={target,epoch,scope:current(),controller:new AbortController()};
    publishPreparation({state:'checking',target},row);
    row.task=(async()=>{
      try {
        const chosen=await selected(row.controller.signal);assertPreparation(row);
        if(target==='live'&&!row.scope)throw fault('请先打开角色聊天','VOICE_SCOPE_CHANGED');
        let profile;
        if(chosen.options.ttsProvider==='minimax'){
          profile=row.scope&&await waitVoiceOperation(()=>profiles?.current({characterId:row.scope.characterId,engine:chosen.engine}),row.controller.signal);
          assertPreparation(row);
          if(!profile)throw fault('当前角色的声音档案尚未准备','VOICE_PROFILE_SCOPE');
          if(!chosen.options.credentialRef)throw fault('请先在云配音配置中保存 MiniMax API Key','CLOUD_KEY_REQUIRED');
        }
        if(typeof runtime.prepare!=='function')throw fault('语音运行组件尚未准备','VOICE_PREPARE_UNAVAILABLE');
        const result=await waitVoiceOperation(()=>runtime.prepare({engine:chosen.engine,packageId:chosen.row.id,target,
          characterId:row.scope?.characterId,profileId:profile?.id,profileVersion:profile?.version,
          speechProvider:chosen.options.ttsProvider,credentialRef:chosen.options.credentialRef,signal:row.controller.signal,
          onProgress:value=>{
            if(preparationJob!==row||row.epoch!==epoch||row.controller.signal.aborted)return;
            if(['verifying','loading'].includes(value?.state))publishPreparation({state:value.state,target,...(value.component?{component:value.component}:{})},row);
          }}),row.controller.signal);
        assertPreparation(row);
        if(result?.ready!==true)throw fault(result?.message??'语音组件尚未准备就绪',result?.code??'VOICE_NOT_READY');
        const checked=await selected(row.controller.signal);assertPreparation(row);
        if(packageProof(checked)!==packageProof(chosen))throw fault('语音插件配置已改变','VOICE_PACKAGE_CHANGED');
        preparedSignature={epoch,proof:packageProof(chosen),scope:row.scope,target};
        preparation={state:'ready',target};
        const snapshot=await state();assertPreparation(row);
        emit({type:'state',state:snapshot});return snapshot;
      } catch(error) {
        if(row.epoch!==epoch||row.controller.signal.aborted||preparationJob!==row)throw fault('旧语音准备已取消','VOICE_PREPARATION_CANCELLED');
        preparedSignature=undefined;
        try{await Promise.all([runtime.cancelCapture?.(),runtime.stopEngine?.()]);}
        catch(failure){throw sealCleanup(failure);}
        preparation={state:'failed',target,code:error.code??'VOICE_PREPARE_FAILED',message:String(error.message)};
        const snapshot=await state();assertPreparation(row);emit({type:'state',state:snapshot});
        throw error;
      } finally {if(preparationJob===row)preparationJob=undefined;}
    })();
    return row.task;
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
    const scope=current(),generation=epoch,signal=lifecycle.signal;
    if(!scope)throw fault('请先打开角色聊天','VOICE_SCOPE_CHANGED');
    const chosen=await selected(signal);ensureOpen();
    if(capture||live?.waiting)throw fault('麦克风正在使用或正在等待播放','VOICE_CAPTURE_BUSY');
    if(mode==='live'&&typeof runtime.prepare==='function'&&(!preparedSignature||preparedSignature.epoch!==epoch||preparedSignature.target!=='live'||preparedSignature.proof!==packageProof(chosen)))await prepare('live');
    await waitVoiceOperation(()=>assets.resolve('asr',chosen.row.id,{signal}),signal);
    ensureOpen();
    if(generation!==epoch||!matches(scope))throw fault('角色已切换','VOICE_SCOPE_CHANGED');
    const row={id:randomUUID(),mode,scope,epoch:generation,bytes:0,finishing:false};
    capture=row;
    try{
      await runtime.startCapture({engineId:chosen.row.id});
      assertCapture(row.id);
      const checked=await selected(signal);ensureOpen();assertCapture(row.id);
      if(packageProof(checked)!==packageProof(chosen))throw fault('语音插件已改变','VOICE_PACKAGE_CHANGED');
      if(session)live=session;
      captureState(mode==='live'?'listening':'recording',row);
      return {id:row.id,mode};
    }catch(error){if(row.epoch===epoch)await retireCapture(row);throw error;}
  }
  async function finalizeCapture(id,limit=false){
    const row=assertCapture(id);
    if(row.finishing)throw fault('录音正在完成','VOICE_CAPTURE_BUSY');
    row.finishing=true;captureState('processing',row);
    try{
      await selected(lifecycle.signal);
      assertCapture(id);
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
    }catch(error){if(row.epoch===epoch)await retireCapture(row);throw error;}
  }
  async function retainedSpeech(signature){
    if(!signature||typeof runtime.ready!=='function')return;
    const generation=epoch,scope=current(),check=()=>!closed&&generation===epoch&&sameVoiceScope(scope,current());
    const preflight=voicePreflight(lifecycle.signal,preflightTimeoutMs),signal=preflight.signal;
    try{
      const chosen=await selected(signal);
      if(!check()||packageProof(chosen)!==signature.proof||!scope)return;
      const profile=await waitVoiceOperation(()=>profiles?.current({characterId:scope.characterId,engine:chosen.engine}),signal);
      if(!check()||!profile||profile.characterId!==scope.characterId||profile.engine!==chosen.engine)return;
      // This is a resident-worker query, not a new use: marker status avoids
      // rehashing components. Admission keeps its existing resolve() verification.
      if(chosen.options.ttsProvider==='local'&&(await waitVoiceOperation(()=>assets.status(chosen.engine,chosen.row.id,{signal}),signal))?.state!=='ready')return;
      const ready=await waitVoiceOperation(()=>runtime.ready({engine:chosen.engine,packageId:chosen.row.id,target:'speech',
        characterId:scope.characterId,profileId:profile.id,profileVersion:profile.version,speechProvider:chosen.options.ttsProvider,credentialRef:chosen.options.credentialRef}),signal);
      const checked=await selected(signal),currentProfile=await waitVoiceOperation(()=>profiles?.current({characterId:scope.characterId,engine:chosen.engine}),signal);
      if(check()&&ready?.ready===true&&packageProof(checked)===signature.proof&&currentProfile?.id===profile.id&&currentProfile?.version===profile.version)
        return {epoch:generation,proof:signature.proof,scope,target:'speech'};
    }catch{
      // A missing/replaced proof is cold state, never authority to reload or reopen capture.
    }finally{preflight.close();}
  }
  function invalidate(reason='stopped',{retainEngine=['scope-changed','profile-changed','chat-stopped'].includes(reason)}={}){
    if(stopping)return stopping;
    const chatStop=reason==='chat-stopped';
    const canRestore=(chatStop||reason==='scope-changed')&&retainEngine&&typeof runtime.cancelCurrent==='function';
    // The prior speech proof remains current while Live prepares recognition.
    // A cold Live launch has no prior proof to restore.
    const speechWasReady=(!preparationJob&&preparation.state==='ready')||(chatStop&&preparationJob?.target==='live');
    const retained=canRestore&&speechWasReady&&preparedSignature?.epoch===epoch?preparedSignature:undefined;
    const keepWorker=chatStop?!!retained:retainEngine;
    epoch++;live=null;const old=capture;capture=null;
    lifecycle.abort(fault('旧语音操作已取消','VOICE_STALE_TURN'));lifecycle=new AbortController();
    cancelStateRead();
    const oldPreparation=preparationJob;oldPreparation?.controller.abort();preparedSignature=undefined;
    publishPreparation({state:'stopping',target:preparation.target});
    for(const turn of turns.values())turn.abort?.abort();
    turns.clear();
    queued.length=0;inflight.clear();
    wakeCapacity();
    // Revoke first, then await the owned workers. A failed cleanup keeps the gate sealed.
    const job=Promise.allSettled([
      Promise.resolve().then(()=>runtime.cancelCapture?.()),Promise.resolve().then(()=>keepWorker&&runtime.cancelCurrent?runtime.cancelCurrent():runtime.stopEngine?.()),pumpTask,captureTail,oldPreparation?.task?.catch(()=>{}),
    ]).then(async results=>{
      captureState('idle',old,{reason});emit({type:'invalidate',epoch,reason});
      const failure=results.find(row=>row.status==='rejected');
      if(failure){cleanupFailure=fault(String(failure.reason?.message??failure.reason),'VOICE_CLEANUP_FAILED');throw cleanupFailure;}
      cleanupFailure=undefined;
      // Scope revocation and chat stop recheck the resident speech engine after cleanup.
      for(;;){
        const scope=current(),unchanged=()=>scope?sameVoiceScope(scope,current()):current()==null;
        const restored=await retainedSpeech(retained);
        // A second navigation shares this stop gate. Discard its predecessor's
        // read-only result and authorize the latest destination before settling.
        if(!unchanged())continue;
        if(!restored){publishPreparation({state:'idle',target:null});break;}
        try{
          const snapshot=await state();
          if(!unchanged()||!sameVoiceScope(restored.scope,snapshot.scope))continue;
          preparedSignature=restored;publishPreparation({state:'ready',target:'speech'});
          emit({type:'state',state:{...snapshot,stopping:false,preparation:copy(preparation)}});
        }catch{
          if(!unchanged())continue;
          preparedSignature=undefined;publishPreparation({state:'idle',target:null});
        }
        break;
      }
    });
    stopping=job;
    void job.then(()=>{if(stopping===job)stopping=null;},()=>{});
    return job;
  }
  function recoverStop(){
    if(recoveryTask)return recoveryTask;
    if(closed)return Promise.reject(fault('语音功能已关闭','VOICE_STOPPING'));
    if(!cleanupFailure)return stopping??Promise.resolve({recovered:false});
    const task=(async()=>{
      try{
        // Only an explicit retry of the real runtime cleanup can clear this
        // layer. Keep the old rejected gate in place throughout that proof.
        await Promise.all([runtime.cancelCapture?.(),runtime.stopEngine?.()]);
        stopping=null;cleanupFailure=undefined;
        // Revoke all old turns before reopening; this synchronous call seals
        // the gate again before any new admission can observe the transition.
        await invalidate('recovered');
        return {recovered:true};
      }catch(error){throw sealCleanup(error);}
    })();
    recoveryTask=task;void task.finally(()=>{if(recoveryTask===task)recoveryTask=undefined;}).catch(()=>{});return task;
  }
  function state(){
    const scope=current(),sameScope=other=>scope?sameVoiceScope(scope,other):other==null;
    if(stateRead&&!stateRead.controller.signal.aborted&&stateRead.epoch===epoch&&sameScope(stateRead.scope))return stateRead.task;
    cancelStateRead();
    const read=stateRead={epoch,scope,controller:new AbortController()},signal=read.controller.signal;
    const check=()=>{if(signal.aborted||read.epoch!==epoch||!sameScope(current()))throw fault('旧语音状态查询已取消','VOICE_STATE_CANCELLED');};
    const wait=async operation=>{check();const result=await waitVoiceOperation(operation,signal);check();return result;};
    read.task=(async()=>{
      const config=await wait(()=>settings.get()),packages=await wait(()=>listPackages());
      const row=packages.find(item=>item.id===config.selectedPackageId),options=config.packages[config.selectedPackageId];
      const ready=async kind=>{try{return await wait(()=>assets.status(kind,config.selectedPackageId,{signal}));}catch(error){check();return {state:'unavailable',code:error.code};}};
      const asr=await ready('asr');check();
      const tts=options.ttsProvider==='local'?await ready(normalizeEngine(row?.engine)):{state:'not-required'};check();
      return {epoch,closed,stopping:!!stopping,preparation:copy(preparation),capture:capture?{id:capture.id,mode:capture.mode}:null,live:!!live,
        settings:config,packages,selectedPackageId:config.selectedPackageId,engine:normalizeEngine(row?.engine),speechProvider:options.ttsProvider,
        assets:{asr,tts},queue:{queued:queued.length,inflight:inflight.size},scope:current()};
    })().finally(()=>{if(stateRead===read)stateRead=undefined;});
    return read.task;
  }
  async function action(op,payload={}){
    if(op==='state')return state();
    if(op==='recover')return recoverStop();
    if(op==='stop')return invalidate('user-stop');
    if(op==='configure'){
      const previous=await settings.get(),next=mergeVoiceSettings(previous,payload);
      const identity=config=>{const options=config.packages[config.selectedPackageId];return JSON.stringify([config.enabled,config.selectedPackageId,options.ttsProvider,options.sttProvider,options.ttsProvider==='minimax'?options.credentialRef:null]);};
      await invalidate('configuration-changed',{retainEngine:identity(previous)===identity(next)});
      const result=await settings.update(payload);
      // Readers may have started after stop but before the settings commit.
      // Revoke that in-flight snapshot before publishing the new permissions.
      cancelStateRead();emit({type:'state',state:await state()});return result;
    }
    ensureOpen();
    if(op==='prepare')return prepare(payload.target);
    if(op==='receipt')return receipt(payload);
    if(op==='profile-selections'){
      const chosen=await selected(undefined,{management:true,packageId:payload.packageId});
      if(!profiles?.selectedProfiles)throw fault('声音档案未就绪','VOICE_PROFILE_SCOPE');
      return {packageId:chosen.row.id,engine:chosen.engine,selections:await profiles.selectedProfiles({engine:chosen.engine})};
    }
    if(op==='profiles'||op==='profile-select'){
      const chosen=await selected(undefined,{management:true,packageId:payload.packageId}),scope=current();
      if(!scope||!profiles)throw fault('声音档案未就绪','VOICE_PROFILE_SCOPE');
      if(op==='profiles'){
        const params={characterId:scope.characterId,engine:chosen.engine},rows=await profiles.list(params);
        if(payload.packageId==null)return rows;
        const active=await profiles.current(params);return rows.map(row=>({...row,selected:row.id===active?.id}));
      }
      if(chosen.row.id===chosen.config.selectedPackageId)await invalidate('profile-changed');
      return profiles.select({characterId:scope.characterId,engine:chosen.engine,profileId:payload.profileId});
    }
    if(op==='capture-start')return serialCapture(()=>{
      if(!['record','live'].includes(payload.mode))throw fault('录音模式无效','VOICE_CAPTURE_INVALID');
      return beginCapture(payload.mode,payload.mode==='live'?{epoch,scope:current(),waiting:false}:null);
    });
    if(op==='capture-feed')return serialCapture(async()=>{
      const row=assertCapture(payload.id);
      try{
        await selected(lifecycle.signal);
        assertCapture(row.id);
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
  return {admit,segment,finish,action,invalidate,recoverStop,state,close,busy:()=>!!stopping||!!recoveryTask||!!preparationJob||!!capture||!!live||turns.size>0||queued.length>0||inflight.size>0||pumping};
}
