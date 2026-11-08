export const VOICE_PREFLIGHT_TIMEOUT_MS=120000;

// Cancellation stops our continuation even when a read-only RPC cannot cancel
// its remote work. A late result remains observed, but can never start a phase.
export function waitVoiceOperation(operation,signal){
  signal?.throwIfAborted();
  if(!signal)return Promise.resolve().then(()=>typeof operation==='function'?operation():operation);
  return new Promise((resolve,reject)=>{
    const cancel=()=>reject(signal.reason??new DOMException('语音操作已停止','AbortError'));
    signal.addEventListener('abort',cancel,{once:true});
    Promise.resolve().then(()=>{signal.throwIfAborted();return typeof operation==='function'?operation():operation;}).then(value=>{
      signal.removeEventListener('abort',cancel);
      if(signal.aborted)cancel();else resolve(value);
    },error=>{signal.removeEventListener('abort',cancel);reject(error);});
  });
}

export function voicePreflight(signal,timeoutMs=VOICE_PREFLIGHT_TIMEOUT_MS){
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new TypeError('Invalid voice preflight deadline');
  const controller=new AbortController();
  const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  let timer,remaining=timeoutMs,began,finished=false;
  const resume=()=>{if(finished||timer||controller.signal.aborted)return;began=performance.now();timer=setTimeout(()=>{timer=undefined;controller.abort(Object.assign(Error('配音准备超时，已停止；回复文字已保留'),{code:'VOICE_PREFLIGHT_TIMEOUT'}));},Math.max(0,remaining));};
  const pause=()=>{if(!timer)return;remaining-=performance.now()-began;clearTimeout(timer);timer=undefined;};
  const sent=()=>{finished=true;clearTimeout(timer);timer=undefined;};
  resume();
  return {signal:combined,pause,resume,sent,close:sent};
}
