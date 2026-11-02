// Closing is an admission barrier, not a timeout. In particular, an accepted
// companion log append must finish before the monitor flushes and acknowledges.
export function createMonitorWorkerLifecycle({ready,run,close,postMessage,closePort=()=>{}}={}){
 if([run,close,postMessage,closePort].some(fn=>typeof fn!=='function'))throw Error('Invalid monitor worker lifecycle');
 const inFlight=new Set();let closing=false,closed=false,closeAttempt=null;
 function report(error,message){
  if(message?.type==='source-action'||message?.type==='managed-work-source')postMessage({type:'source-result',id:message.id,error:error.message,...error.code?{code:error.code}:{}});
  else postMessage({type:'error',message:error.stack??String(error),...error.code?{code:error.code}:{}});
 }
 function requestClose(){
  closing=true;
  if(closeAttempt)return closeAttempt;
  closeAttempt=(async()=>{
   // A failed initialization must still release its resources. Previously
   // admitted operations handle/report their own errors and cannot be dropped.
   await Promise.allSettled([ready,...inFlight]);
   if(!closed){await close();closed=true;}
   postMessage({type:'closed',durable:true});closePort();
   return {closed:true,durable:true};
  })().catch(error=>{
   // Keep admission closed, but permit another close after a recoverable flush
   // failure. There is no new writer and no successful acknowledgement here.
   closeAttempt=null;postMessage({type:'close-error',durable:false,message:error.stack??String(error),code:error.code??'MONITOR_CLOSE_FAILED'});
   return {closed:false,durable:false,error};
  });
  return closeAttempt;
 }
 function dispatch(message){
  if(message?.type==='close')return requestClose();
  if(closing){const error=Object.assign(Error('Monitor worker is closing; new operations are refused'),{code:'MONITOR_CLOSING'});if(!closed)report(error,message);return Promise.resolve({accepted:false,error});}
  const task=(async()=>{try{await run(message);return {accepted:true};}catch(error){report(error,message);return {accepted:true,error};}})();
  inFlight.add(task);void task.finally(()=>inFlight.delete(task));return task;
 }
 return {dispatch,state:()=>({closing,closed,inFlight:inFlight.size})};
}
