import {waitVoiceOperation,voicePreflight,VOICE_PREFLIGHT_TIMEOUT_MS} from './operation-wait.mjs';

const fail = (code, message) => Object.assign(new Error(message), {code});

// ASR remains the local runtime. Only the explicitly selected TTS provider
// changes, after the previous provider has confirmed releasing its resources.
export function createSpeechRuntime({local, cloud,preflightTimeoutMs=VOICE_PREFLIGHT_TIMEOUT_MS}) {
  let provider;
  let active;
  let closed = false;
  let transition = Promise.resolve();
  let stopFailure;
  let globalEpoch=0,globalStopping=null,closePromise;
  let queueTail=Promise.resolve();
  const owners=new Map(),jobs=new Set();let residentOwner;
  function owner(name){if(!owners.has(name))owners.set(name,{name,epoch:0,closed:false});return owners.get(name);}
  function waitFor(previous,signal){
    signal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const cancelled=()=>{signal.removeEventListener('abort',cancelled);reject(signal.reason);};
      signal.addEventListener('abort',cancelled,{once:true});
      previous.then(()=>{signal.removeEventListener('abort',cancelled);resolve();},error=>{signal.removeEventListener('abort',cancelled);reject(error);});
    });
  }

  function serialize(operation) {
    const result = transition.then(operation);
    transition = result.catch(() => {});
    return result;
  }

  function assertOpen() {
    if (closed) throw fail('VOICE_RUNTIME_CLOSED','语音功能已停止');
    if (stopFailure) throw stopFailure;
    if(globalStopping)throw fail('VOICE_STOPPING','语音组件正在停止');
  }

  async function allStopped(operations) {
    const results = await Promise.allSettled(operations.map(operation=>Promise.resolve(operation).catch(error=>{
      // A stuck iterator must not delay sealing the gate after a physical stop has already failed.
      stopFailure??=error;
      for(const job of jobs)job.controller.abort(stopFailure);
      throw error;
    })));
    const errors = results.filter(row => row.status === 'rejected').map(row => row.reason);
    if (errors.length) {
      stopFailure = errors.length === 1 ? errors[0] : new AggregateError(errors,'语音组件退出尚未确认');
      for(const job of jobs)job.controller.abort(stopFailure);
      throw stopFailure;
    }
  }

  async function returnCancelled(target){
    try{await target?.iterator?.return?.();}
    catch(error){if(!target?.controller.signal.aborted||error?.name!=='AbortError'&&!['VOICE_OWNER_STOPPED','VOICE_RUNTIME_STOPPED','VOICE_RUNTIME_CLOSED'].includes(error?.code))throw error;}
  }

  function speakFor(source,request = {}) {
    const generation=source.epoch,runtimeGeneration=globalEpoch;
    return (async function*(){
      assertOpen();
      if(runtimeGeneration!==globalEpoch)throw fail('VOICE_RUNTIME_STOPPED','旧语音任务已停止');
      if(source.closed||generation!==source.epoch)throw fail('VOICE_OWNER_STOPPED','该语音来源已停止');
      if(source.stopping)throw fail('VOICE_OWNER_STOPPING','该语音来源正在停止');
      const selected = request.speechProvider ?? 'local';
      if (!['local','minimax'].includes(selected)) throw fail('VOICE_PROVIDER_INVALID','请选择本地或 MiniMax 云配音');
      if (selected === 'minimax' && !cloud) throw fail('CLOUD_UNAVAILABLE','云配音组件未准备');
      const controller=new AbortController(),preflight=voicePreflight(request.signal?AbortSignal.any([request.signal,controller.signal]):controller.signal,preflightTimeoutMs),signal=preflight.signal,started=performance.now();
      let sent=false,firstPcm=false;
      const onPhase=value=>{signal.throwIfAborted();if(value.stage==='model-loading')preflight.pause();else if(value.stage==='component-check')preflight.resume();else if(value.stage==='speak-sent'){sent=true;preflight.sent();}if(value.stage==='first-pcm')firstPcm=true;try{request.onPhase?.({...value,elapsedMs:Math.round(performance.now()-started)});}catch{}};
      let release;const released=new Promise(resolve=>{release=resolve;}),previous=queueTail;
      // A cancelled waiter may settle early, but its successor still waits for this predecessor.
      queueTail=previous.then(()=>released);
      const job={source,controller,release};jobs.add(job);
      try{
        onPhase({stage:'queue'});
        await waitFor(previous,signal);assertOpen();signal.throwIfAborted();
        if(runtimeGeneration!==globalEpoch)throw fail('VOICE_RUNTIME_STOPPED','旧语音任务已停止');
        if(source.closed||generation!==source.epoch)throw fail('VOICE_OWNER_STOPPED','该语音来源已停止');
        active=job;
        await waitVoiceOperation(()=>serialize(async () => {
        assertOpen();
        signal.throwIfAborted();
        if (provider !== selected) {
          await allStopped([Promise.resolve().then(() => local.stopEngine()), Promise.resolve().then(() => cloud?.stopEngine())]);
          signal.throwIfAborted();
          provider = selected;
        }
        residentOwner=source;
        }),signal);
        const runtime = selected === 'local' ? local : cloud;
        signal.throwIfAborted();
        const iterator=job.iterator=runtime.speak({...request,signal,onPhase});
        for await (const row of iterator) {
          signal.throwIfAborted();
          // The existing cloud adapter yields its reference only after start()
          // has submitted the request. Preserve its post-submit timeout rules.
          if(!sent&&(selected==='minimax'&&row.type==='reference'||row.type==='pcm'))onPhase({stage:'speak-sent'});
          if(!firstPcm&&row.type==='pcm')onPhase({stage:'first-pcm'});
          yield row;
          signal.throwIfAborted();
        }
      } finally {
        preflight.close();
        if (active === job) active = undefined;
        jobs.delete(job);
        release();
      }
    })();
  }
  function speak(request={}){return speakFor(owner('chat'),request);}

  async function prepareFor(source,request={}) {
    assertOpen();
    const generation=source.epoch,runtimeGeneration=globalEpoch;
    const selected=request.speechProvider??'local';
    if(!['local','minimax'].includes(selected))throw fail('VOICE_PROVIDER_INVALID','请选择本地或 MiniMax 云配音');
    if(source.closed||source.stopping)throw fail('VOICE_OWNER_STOPPED','该语音来源已停止');
    const controller=new AbortController(),signal=request.signal?AbortSignal.any([request.signal,controller.signal]):controller.signal;
    let release;const released=new Promise(resolve=>{release=resolve;}),previous=queueTail;
    queueTail=previous.then(()=>released);
    const job={source,controller,release};jobs.add(job);
    try {
      await waitFor(previous,signal);assertOpen();signal.throwIfAborted();
      if(runtimeGeneration!==globalEpoch||generation!==source.epoch||source.closed)throw fail('VOICE_OWNER_STOPPED','该语音来源已停止');
      active=job;
      await serialize(async()=>{
        assertOpen();signal.throwIfAborted();
        if(provider!==selected){
          await allStopped([Promise.resolve().then(()=>local.stopEngine()),Promise.resolve().then(()=>cloud?.stopEngine())]);
          signal.throwIfAborted();provider=selected;
        }
        residentOwner=source;
      });
      let result;
      if(selected==='local') {
        if(typeof local.prepare!=='function')throw fail('VOICE_PREPARE_UNAVAILABLE','本地语音组件尚未准备');
        result=await waitVoiceOperation(()=>local.prepare({...request,signal}),signal);
      } else {
        // Cloud preparation only reads the local binding. It never uploads a
        // reference, starts synthesis or makes a paid provider request.
        result=await root.ready(request);
        if(result.ready&&request.target==='live')await local.prepare({...request,target:'asr',signal});
      }
      signal.throwIfAborted();assertOpen();
      if(runtimeGeneration!==globalEpoch||generation!==source.epoch||source.closed)throw fail('VOICE_OWNER_STOPPED','该语音来源已停止');
      return result;
    } finally {
      if(active===job)active=undefined;jobs.delete(job);release();
    }
  }

  function stopOwner(source){
    if(source.stopping)return source.stopping;
    source.epoch++;
    const target=active?.source===source?active:null;
    for(const job of jobs)if(job.source===source)job.controller.abort(fail('VOICE_OWNER_STOPPED','该语音来源已停止'));
    source.stopping=serialize(async()=>{
      if(stopFailure||target||active?.source===source||!active&&residentOwner===source){
        await allStopped([Promise.resolve().then(()=>local.stopEngine()),Promise.resolve().then(()=>cloud?.stopEngine()),returnCancelled(target)]);
        provider=undefined;residentOwner=undefined;
        stopFailure=undefined;
      }
      if(target){if(active===target)active=undefined;target.release();}
    });
    const result=source.stopping;
    void result.finally(()=>{if(source.stopping===result)source.stopping=null;}).catch(()=>{});
    return result;
  }

  function cancelOwner(source){
    if(source.stopping)return source.stopping;
    if(stopFailure)return stopOwner(source);
    source.epoch++;
    const target=active?.source===source?active:null;
    // Revoke the old epoch immediately. Pending PCM is discarded while the
    // single Python request reader drains the same sequence to its terminal.
    for(const job of jobs)if(job.source===source)job.controller.abort(fail('VOICE_OWNER_STOPPED','该语音来源已停止'));
    source.stopping=serialize(async()=>{
      if(target){
        const selected=provider==='minimax'?cloud:local;
        const cleanup=selected?.cancelCurrent?selected.cancelCurrent():selected?.stopEngine?.();
        await allStopped([cleanup]);
        await returnCancelled(target);
        if(active===target)active=undefined;target.release();
      }
    });
    const result=source.stopping;
    void result.finally(()=>{if(source.stopping===result)source.stopping=null;}).catch(()=>{});
    return result;
  }

  function cancelCurrent(){return cancelOwner(owner('chat'));}

  function stopEngine() {
    if(closed)return closePromise??Promise.resolve();
    if(globalStopping)return globalStopping;
    globalEpoch++;const target=active;
    for(const job of jobs)job.controller.abort(fail('VOICE_RUNTIME_STOPPED','旧语音任务已停止'));
    globalStopping=serialize(async () => {
      await allStopped([Promise.resolve().then(() => local.stopEngine()),Promise.resolve().then(() => cloud?.stopEngine()),returnCancelled(target)]);
      provider=undefined;residentOwner=undefined;
      stopFailure=undefined;
      if(target){if(active===target)active=undefined;target.release();}
    });
    const result=globalStopping;
    void result.finally(()=>{if(globalStopping===result)globalStopping=null;}).catch(()=>{});
    return result;
  }

  function close() {
    if(closePromise)return closePromise;
    closed = true;
    globalEpoch++;const target=active;
    for(const job of jobs)job.controller.abort(fail('VOICE_RUNTIME_CLOSED','语音功能已停止'));
    closePromise=serialize(async()=>{
      await allStopped([Promise.resolve().then(() => local.close()),Promise.resolve().then(() => cloud?.close()),returnCancelled(target)]);
      provider=undefined;residentOwner=undefined;
      if(target){if(active===target)active=undefined;target.release();}
    });return closePromise;
  }

  const root={
    async ready(request = {}) {
      assertOpen();
      if ((request.speechProvider??'local') === 'local') return local.ready?.(request) ?? {ready:false,state:'idle'};
      if (request.speechProvider !== 'minimax') return {ready:false,state:'unavailable',code:'VOICE_PROVIDER_INVALID'};
      if (!cloud) return {ready:false,state:'unavailable',code:'CLOUD_UNAVAILABLE'};
      const result = await cloud.status(request);
      return {...result,ready:result.state==='ready'};
    },
    startCapture(request) { assertOpen(); return local.startCapture(request); },
    feedCapture(request) { assertOpen(); return local.feedCapture(request); },
    finishCapture(request) { assertOpen(); return local.finishCapture(request); },
    cancelCapture(request) { return local.cancelCapture(request); },
    prepare:request=>prepareFor(owner('chat'),request),speak,cancelCurrent, stopEngine, close,
    channel(name){
      if(!['chat','card-table'].includes(name))throw fail('VOICE_OWNER_INVALID','未知语音来源');
      const source=owner(name);
      return {prepare:request=>prepareFor(source,request),speak:request=>speakFor(source,request),async ready(request){assertOpen();if(source.closed)throw fail('VOICE_OWNER_STOPPED','该语音来源已停止');if(source.stopping)throw fail('VOICE_OWNER_STOPPING','该语音来源正在停止');return root.ready(request);},cancelCurrent:()=>cancelOwner(source),stopEngine:()=>stopOwner(source),close:()=>{source.closed=true;return stopOwner(source);},
        ...(name==='chat'?{startCapture:root.startCapture,feedCapture:root.feedCapture,finishCapture:root.finishCapture,cancelCapture:root.cancelCapture}:{})};
    },
  };
  return root;
}

export const createVoiceSpeechRuntime = createSpeechRuntime;
