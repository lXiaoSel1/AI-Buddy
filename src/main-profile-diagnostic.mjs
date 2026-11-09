import {Session} from 'node:inspector/promises';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {startDesktopSample,stopDesktopSample} from './desktop-diagnostics.mjs';

// R13 diagnostic: a bounded CPU profile of the Electron main thread (CrBrowserMain), where the
// desktop pet's forwarded mouse hook runs. Read only: no settings, data, model or window changes.
export const MAIN_PROFILE_MAX_BYTES=24*1024*1024;
const MIN_SECONDS=5,MAX_SECONDS=60,DEFAULT_SECONDS=30,SAMPLING_US=1000,RENDERER_MS=3000,NODE_BYTES=320,SAMPLE_BYTES=16;
const fault=code=>Object.assign(Error(code),{code});
const numeric=value=>typeof value==='number'&&Number.isFinite(value);
const round=value=>Number.isFinite(value)?Math.round(value*100)/100:null;
const BUNDLE=/[\\/]((?:main|dashboard|preload[\w-]*|monitor-worker|voice[\w-]*|pet[\w-]*)\.c?js)(?:[?#].*)?$/;

// Call frames and numeric samples only: function names, bundle file names and positions.
// Never heap values, source text, query strings or user paths.
export function profileMetadata(raw){
 if(!raw||!Array.isArray(raw.nodes)||!Array.isArray(raw.samples)||!Array.isArray(raw.timeDeltas))throw fault('MAIN_PROFILE_INVALID');
 const nodes=raw.nodes.map(node=>{
  const frame=node.callFrame??{},url=String(frame.url??''),bundle=BUNDLE.exec(url);
  return {id:node.id,callFrame:{functionName:String(frame.functionName??'').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,256),scriptId:/^\d{1,20}$/.test(String(frame.scriptId))?String(frame.scriptId):'0',
   url:bundle?'buddy://'+bundle[1]:/^node:[\w/.-]{1,200}$/.test(url)?url:'',lineNumber:Number.isInteger(frame.lineNumber)?frame.lineNumber:-1,columnNumber:Number.isInteger(frame.columnNumber)?frame.columnNumber:-1},
   ...(Array.isArray(node.children)?{children:node.children.filter(Number.isSafeInteger)}:{})};
 });
 const profile={nodes,startTime:raw.startTime,endTime:raw.endTime,samples:raw.samples,timeDeltas:raw.timeDeltas};
 if(!numeric(profile.startTime)||!numeric(profile.endTime)||nodes.some(node=>!Number.isSafeInteger(node.id))||!profile.samples.every(Number.isSafeInteger)||!profile.timeDeltas.every(numeric))throw fault('MAIN_PROFILE_INVALID');
 return profile;
}

// Renderer voice timing rows: numbers and segment indexes only, no text.
function rendererRows(value){
 if(!Array.isArray(value))return null;
 return value.slice(0,400).map(row=>Object.fromEntries(Object.entries(row??{}).filter(([key,item])=>/^[a-zA-Z]{1,32}$/.test(key)&&(numeric(item)||typeof item==='boolean'||typeof item==='string'&&item.length<=64&&/^[\w:.-]*$/.test(item)))));
}

export function createMainProfileDiagnostic({isClosing=()=>false,processId,build,renderer=null,versions=process.versions,now=Date.now,createSession=()=>new Session(),setTimer=setTimeout,clearTimer=clearTimeout}){
 let active=null;
 const valid=request=>request&&Object.getPrototypeOf(request)===Object.prototype&&Object.keys(request).every(key=>['command','expectedProcessId','expectedBuild','seconds'].includes(key))&&request.command==='diagnostics-main-profile'&&request.expectedProcessId===processId&&request.expectedBuild===build&&(request.seconds===undefined||Number.isInteger(request.seconds)&&request.seconds>=MIN_SECONDS&&request.seconds<=MAX_SECONDS);
 // A renderer that is loading or stalled must not hold the single capture slot forever.
 const bounded=promise=>new Promise(resolve=>{const timer=setTimer(()=>resolve(undefined),RENDERER_MS);Promise.resolve(promise).then(value=>{clearTimer(timer);resolve(value);},()=>{clearTimer(timer);resolve(undefined);});});
 async function capture(op){
  const signal=op.controller.signal,session=createSession(),delay=monitorEventLoopDelay({resolution:10});let started=false,desktop=false,probe=false;
  try{
   session.connect();await session.post('Profiler.enable');await session.post('Profiler.setSamplingInterval',{interval:SAMPLING_US});signal.throwIfAborted();
   try{startDesktopSample('profile',{timeoutMs:op.seconds*1000+15000});desktop=true;}catch{}
   if(renderer)probe=(await bounded(renderer.start()))===true;signal.throwIfAborted();
   const before=process.cpuUsage();delay.enable();await session.post('Profiler.start');started=true;signal.throwIfAborted();
   const startedAt=now();
   // An abort that already happened is honoured here; addEventListener alone would never fire for it.
   await new Promise((resolve,reject)=>{if(signal.aborted){reject(signal.reason);return;}const onAbort=()=>{clearTimer(timer);reject(signal.reason);},timer=setTimer(()=>{signal.removeEventListener('abort',onAbort);resolve();},op.seconds*1000);signal.addEventListener('abort',onAbort,{once:true});});
   if(isClosing())throw fault('MAIN_PROFILE_CANCELLED');
   const {profile:raw}=await session.post('Profiler.stop');started=false;delay.disable();
   const usage=process.cpuUsage(before),timings=desktop?stopDesktopSample()?.timings??null:null;desktop=false;
   let voice=null;if(probe)voice=rendererRows(await bounded(renderer.stop()));probe=false;
   const result={ok:true,processId,build,seconds:op.seconds,startedAt,finishedAt:now(),target:{name:'electron-main',thread:'CrBrowserMain'},runtime:{node:versions.node,electron:versions.electron??null},
    cpuDelta:{user:usage.user,system:usage.system},
    eventLoop:{p50Ms:round(delay.percentile(50)/1e6),p95Ms:round(delay.percentile(95)/1e6),p99Ms:round(delay.percentile(99)/1e6),maxMs:round(delay.max/1e6),count:delay.count},
    timings,rendererVoice:voice,profile:profileMetadata(raw)};
   // Estimated from counts: stringifying many MB here would stall the very thread being diagnosed.
   if(result.profile.nodes.length*NODE_BYTES+result.profile.samples.length*SAMPLE_BYTES>MAIN_PROFILE_MAX_BYTES)throw fault('MAIN_PROFILE_TOO_LARGE');
   return result;
  }finally{
   delay.disable();
   if(started)try{await session.post('Profiler.stop');}catch{}
   if(desktop)try{stopDesktopSample();}catch{}
   if(probe&&renderer)await bounded(renderer.stop());
   try{session.disconnect();}catch{}
  }
 }
 async function handle(request){
  if(!valid(request))return {ok:false,code:'MAIN_PROFILE_REQUEST_INVALID',error:'MAIN_PROFILE_REQUEST_INVALID'};
  if(isClosing())return {ok:false,code:'MAIN_PROFILE_CANCELLED',error:'MAIN_PROFILE_CANCELLED'};
  if(active)return {ok:false,code:'MAIN_PROFILE_BUSY',error:'MAIN_PROFILE_BUSY'};
  const op={seconds:request.seconds??DEFAULT_SECONDS,controller:new AbortController()};active=op;
  const timer=setTimer(()=>{if(!op.controller.signal.aborted)op.controller.abort(fault('MAIN_PROFILE_TIMEOUT'));},op.seconds*1000+20000);
  try{return await capture(op);}
  catch(error){const code=String(error?.code??'').startsWith('MAIN_PROFILE_')?error.code:'MAIN_PROFILE_FAILED';return {ok:false,code,error:code};}
  finally{clearTimer(timer);if(active===op)active=null;}
 }
 return {handle,cancel(){if(active&&!active.controller.signal.aborted)active.controller.abort(fault('MAIN_PROFILE_CANCELLED'));}};
}
