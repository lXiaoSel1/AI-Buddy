export const MONITOR_PROFILE_MAX_BYTES=4*1024*1024;
const DURATION_MS=5000,DEADLINE_MS=10000;
const fault=code=>Object.assign(Error(code),{code});
const numeric=value=>typeof value==='number'&&Number.isFinite(value);

// CPU call frames and numeric samples only: never heap values, source text,
// arbitrary profile fields, source URL queries, or user-selected file paths.
function profileMetadata(raw){
 if(typeof raw==='string'){if(Buffer.byteLength(raw)>MONITOR_PROFILE_MAX_BYTES)throw fault('MONITOR_PROFILE_TOO_LARGE');raw=JSON.parse(raw);}
 if(!raw||!Array.isArray(raw.nodes)||!Array.isArray(raw.samples)||!Array.isArray(raw.timeDeltas))throw fault('MONITOR_PROFILE_INVALID');
 const profile={nodes:raw.nodes.map(node=>{
  const frame=node.callFrame??{},url=String(frame.url??'');
  return {id:node.id,callFrame:{functionName:String(frame.functionName??'').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,256),scriptId:/^\d{1,20}$/.test(String(frame.scriptId))?String(frame.scriptId):'0',url:/[\\/]monitor-worker\.cjs(?:[?#].*)?$/.test(url)?'buddy-monitor/monitor-worker.cjs':/^node:[\w./:-]{1,200}$/.test(url)?url:url?'[other-script]':'',lineNumber:frame.lineNumber,columnNumber:frame.columnNumber},hitCount:numeric(node.hitCount)?node.hitCount:0,children:Array.isArray(node.children)?node.children.filter(Number.isSafeInteger):[]};
 }),startTime:raw.startTime,endTime:raw.endTime,samples:raw.samples,timeDeltas:raw.timeDeltas};
 if(!numeric(profile.startTime)||!numeric(profile.endTime)||profile.nodes.some(node=>!Number.isSafeInteger(node.id)||!Number.isInteger(node.callFrame.lineNumber)||!Number.isInteger(node.callFrame.columnNumber))||!profile.samples.every(Number.isSafeInteger)||!profile.timeDeltas.every(numeric))throw fault('MONITOR_PROFILE_INVALID');
 return profile;
}

export function createMonitorProfileDiagnostic({getWorker,isClosing=()=>false,processId,build,versions=process.versions,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
 let active=null;
 const valid=request=>request&&Object.getPrototypeOf(request)===Object.prototype&&Object.keys(request).every(key=>['command','expectedProcessId','expectedBuild'].includes(key))&&request.command==='diagnostics-monitor-profile'&&request.expectedProcessId===processId&&request.expectedBuild===build;
 const wait=signal=>new Promise((resolve,reject)=>{
  if(signal.aborted){reject(signal.reason);return;}
  const done=()=>{signal.removeEventListener('abort',cancel);resolve();},timer=setTimer(done,DURATION_MS),cancel=()=>{clearTimer(timer);signal.removeEventListener('abort',cancel);reject(signal.reason);};signal.addEventListener('abort',cancel,{once:true});
 });
 async function capture(op){
  let handle,stopping;
  const check=()=>{op.controller.signal.throwIfAborted();if(isClosing())throw fault('MONITOR_PROFILE_CANCELLED');if(getWorker()!==op.worker||op.worker.threadId!==op.threadId)throw fault('MONITOR_PROFILE_REPLACED');};
  const stop=()=>stopping??=Promise.resolve().then(()=>handle.stop());
  try{
   check();const before=await op.worker.cpuUsage();check();handle=await op.worker.startCpuProfile();check();
   const startedAt=now();await wait(op.controller.signal);check();const raw=await stop();check();const after=await op.worker.cpuUsage();check();
   const result={ok:true,processId,durationMs:DURATION_MS,startedAt,finishedAt:now(),target:{name:'buddy-monitor',threadId:op.threadId},runtime:{node:versions.node,electron:versions.electron??null},cpuDelta:{user:after.user-before.user,system:after.system-before.system},profile:profileMetadata(raw)};
   if(!numeric(result.cpuDelta.user)||!numeric(result.cpuDelta.system))throw fault('MONITOR_PROFILE_INVALID');
   // This bounds the complete pipe reply, not V8's profiling memory.
   if(Buffer.byteLength(JSON.stringify(result))>MONITOR_PROFILE_MAX_BYTES)throw fault('MONITOR_PROFILE_TOO_LARGE');return result;
  }finally{if(handle&&typeof handle.stop==='function')try{await stop();}catch{}}
 }
 async function handle(request){
  if(!valid(request))return {ok:false,code:'MONITOR_PROFILE_REQUEST_INVALID',error:'MONITOR_PROFILE_REQUEST_INVALID'};
  if(isClosing())return {ok:false,code:'MONITOR_PROFILE_CANCELLED',error:'MONITOR_PROFILE_CANCELLED'};
  if(active)return {ok:false,code:'MONITOR_PROFILE_BUSY',error:'MONITOR_PROFILE_BUSY'};
  const worker=getWorker();
  if(!worker||!Number.isInteger(worker.threadId)||worker.threadId<1)return {ok:false,code:'MONITOR_PROFILE_UNAVAILABLE',error:'MONITOR_PROFILE_UNAVAILABLE'};
  if(typeof worker.startCpuProfile!=='function'||typeof worker.cpuUsage!=='function')return {ok:false,code:'MONITOR_PROFILE_UNSUPPORTED',error:'MONITOR_PROFILE_UNSUPPORTED'};
  const op={worker,threadId:worker.threadId,controller:new AbortController()};active=op;
  const abort=code=>{if(!op.controller.signal.aborted)op.controller.abort(fault(code));},exited=()=>abort('MONITOR_PROFILE_EXITED');
  worker.once('exit',exited);const timer=setTimer(()=>abort('MONITOR_PROFILE_TIMEOUT'),DEADLINE_MS);
  let onAbort;const aborted=new Promise((_,reject)=>{onAbort=()=>reject(op.controller.signal.reason);op.controller.signal.addEventListener('abort',onAbort,{once:true});});
  const task=capture(op),cleanup=()=>{clearTimer(timer);worker.off('exit',exited);op.controller.signal.removeEventListener('abort',onAbort);if(active===op)active=null;};
  // A disconnected/timed-out requester must not free the lock while native
  // start/stop still owns the profiler. Late start completion still runs stop.
  task.then(cleanup,cleanup);
  try{return await Promise.race([task,aborted]);}
  catch(error){const code=String(error?.code??'').startsWith('MONITOR_PROFILE_')?error.code:'MONITOR_PROFILE_FAILED';return {ok:false,code,error:code};}
 }
 return {handle,cancel(){active?.controller.abort(fault('MONITOR_PROFILE_CANCELLED'));}};
}
