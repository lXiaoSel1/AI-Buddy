const closures=new WeakMap();
const failure=(message,code,details={})=>Object.assign(Error(message),{code,...details});

/** Wait for this worker's explicit durable close acknowledgement. No process
 * termination is attempted: failure leaves the host able to retain/retry state.
 * The first in-flight caller owns its timeout; successful duplicate calls share
 * the settled promise, while any failure permits a fresh close request. */
export function closeMonitorWorker(worker,{timeoutMs=120000,setTimer=setTimeout,clearTimer=clearTimeout,onDiagnostic=()=>{}}={}){
 if(!worker||typeof worker!=='object'||typeof worker.on!=='function'||typeof worker.removeListener!=='function'||typeof worker.postMessage!=='function')return Promise.reject(failure('Monitor worker is required','MONITOR_WORKER_INVALID'));
 const prior=closures.get(worker);if(prior)return prior.promise;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647||typeof setTimer!=='function'||typeof clearTimer!=='function')return Promise.reject(failure('Monitor close timeout is invalid','MONITOR_CLOSE_OPTIONS_INVALID'));
 if(worker.threadId===-1)return Promise.reject(failure('Monitor worker exited before durable close','MONITOR_WORKER_EARLY_EXIT'));
 let resolve,reject,settled=false,timer,legacyNoted=false;
 const promise=new Promise((done,fail)=>{resolve=done;reject=fail;}),entry={promise};
 closures.set(worker,entry);
 const diagnostic=value=>{try{onDiagnostic(value);}catch{}};
 function cleanup(){
  worker.removeListener('message',message);worker.removeListener('error',errored);worker.removeListener('exit',exited);
  if(timer!==undefined){const handle=timer;timer=undefined;clearTimer(handle);}
 }
 function finish(error){
  if(settled)return;settled=true;cleanup();
  if(error){if(closures.get(worker)===entry)closures.delete(worker);diagnostic({type:'monitor-close-failed',code:error.code});reject(error);}
  else{diagnostic({type:'monitor-closed',durable:true});resolve({closed:true,durable:true});}
 }
 function message(value){
  if(value?.type==='closed'){
   if(value.durable===true)finish();
   else if(!legacyNoted){legacyNoted=true;diagnostic({type:'monitor-close-legacy-ack-ignored'});}
  }else if(value?.type==='close-error'){const detail=value.error??value;finish(failure(String(detail.message??'Monitor persistence did not finish').slice(0,2000),detail.code??'MONITOR_WORKER_CLOSE_FAILED'));}
 }
 function errored(error){finish(failure('Monitor worker failed before durable close: '+String(error?.message??error).slice(0,2000),'MONITOR_WORKER_CLOSE_ERROR',{cause:error}));}
 function exited(exitCode){finish(failure('Monitor worker exited without durable close acknowledgement','MONITOR_WORKER_EARLY_EXIT',{exitCode}));}
 worker.on('message',message);worker.on('error',errored);worker.on('exit',exited);
 try{
  const handle=setTimer(()=>finish(failure('Monitor durable close timed out; current data is retained','MONITOR_WORKER_CLOSE_TIMEOUT')),timeoutMs);
  timer=handle;
  // A controlled timer may complete during registration. Do not leave its
  // returned handle live or send a close request after a settled failure.
  if(settled){timer=undefined;clearTimer(handle);return promise;}
  worker.postMessage({type:'close'});
 }catch(error){finish(error);}
 return promise;
}
