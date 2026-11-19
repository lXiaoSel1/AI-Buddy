import {Session} from 'node:inspector/promises';
import {channel} from 'node:diagnostics_channel';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {DESKTOP_PROFILE_MAX_SECONDS,startDesktopSample,stopDesktopSample} from './desktop-diagnostics.mjs';

// R13 diagnostic: a bounded CPU profile of the Electron main thread (CrBrowserMain), where the
// desktop pet's forwarded mouse hook runs. Read only: no settings, data, model or window changes.
export const MAIN_PROFILE_MAX_BYTES=24*1024*1024;
const MIN_SECONDS=5,MAX_SECONDS=DESKTOP_PROFILE_MAX_SECONDS,DEFAULT_SECONDS=30,SAMPLING_US=1000,RENDERER_MS=3000,NODE_BYTES=320,SAMPLE_BYTES=16;
const economySql=channel('ai-buddy.companion.economy-sql');
const companionWriteLatency=channel('ai-buddy.companion.write-latency');
const ECONOMY_SAMPLE_MAX=2048,COMPANION_WRITE_SAMPLE_MAX=4096,COMPANION_WRITE_ROW_BYTES=512;
const companionWriteOperations=new Set([
 'mutate','conversation-import','memory.sync','memory.tick','memory.consolidate','memory.prepared-record',
 'life-restore-prepare','life-restore-stage','life-restore-staged','life-restore-publish',
 'life-restore-clear','life-restore-rolled-back','life-restore-abandoned'
]);
const companionWriteStatuses=new Set(['committed','failed','no-op']);
const fault=code=>Object.assign(Error(code),{code});
const numeric=value=>typeof value==='number'&&Number.isFinite(value);
const duration=value=>numeric(value)&&value>=0;
const optionalDuration=value=>value===null||duration(value);
const round=value=>Number.isFinite(value)?Math.round(value*100)/100:null;

function collectCompanionWrite(sample,value){
 if(!value||typeof value!=='object')return;
 const {operation,status,rows,acceptedAt,committedAt,queueMs,workerWaitMs,workerMs,commitMs,acceptedToCommitMs,acceptedToOutcomeMs}=value;
 if(!companionWriteOperations.has(operation)||!companionWriteStatuses.has(status)||!Number.isSafeInteger(rows)||rows<0||
  !duration(acceptedAt)||!duration(queueMs)||!duration(workerWaitMs)||!optionalDuration(workerMs)||!duration(acceptedToOutcomeMs))return;
 if(status==='committed'){
  if(!duration(committedAt)||!duration(commitMs)||!duration(acceptedToCommitMs))return;
 }else if(committedAt!==null||commitMs!==null||acceptedToCommitMs!==null)return;
 if(sample.rows.length>=COMPANION_WRITE_SAMPLE_MAX)sample.dropped++;
 else sample.rows.push({operation,status,rows,acceptedAt,committedAt,queueMs,workerWaitMs,workerMs,commitMs,acceptedToCommitMs,acceptedToOutcomeMs});
}
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
 const allowedKeys=new Set(['command','expectedProcessId','expectedBuild','seconds','phase','companionWrites']);
 function valid(request){
  if(!request||Object.getPrototypeOf(request)!==Object.prototype||Object.keys(request).some(key=>!allowedKeys.has(key)))return false;
  if(request.command!=='diagnostics-main-profile'||request.expectedProcessId!==processId||request.expectedBuild!==build)return false;
  if(request.phase!==undefined)return ['status','finish'].includes(request.phase)&&request.seconds===undefined&&request.companionWrites===undefined;
  return (request.companionWrites===undefined||typeof request.companionWrites==='boolean')&&
   (request.seconds===undefined||Number.isInteger(request.seconds)&&request.seconds>=MIN_SECONDS&&request.seconds<=MAX_SECONDS);
 }
 // A renderer that is loading or stalled must not hold the single capture slot forever.
 const bounded=promise=>new Promise(resolve=>{const timer=setTimer(()=>resolve(undefined),RENDERER_MS);Promise.resolve(promise).then(value=>{clearTimer(timer);resolve(value);},()=>{clearTimer(timer);resolve(undefined);});});
 async function capture(op){
  const signal=op.controller.signal,session=createSession(),delay=monitorEventLoopDelay({resolution:10});let started=false,desktop=false,probe=false,stopEconomySample,stopCompanionWriteSample;
  try{
   session.connect();await session.post('Profiler.enable');await session.post('Profiler.setSamplingInterval',{interval:SAMPLING_US});signal.throwIfAborted();
   try{startDesktopSample('profile',{timeoutMs:op.seconds*1000+15000});desktop=true;}catch{}
   if(renderer)probe=(await bounded(renderer.start()))===true;signal.throwIfAborted();
   const before=process.cpuUsage();delay.enable();await session.post('Profiler.start');started=true;signal.throwIfAborted();
   const startedAt=now();let firstMinuteCpu,timer60;
   const economyCommits={dropped:0,rows:[]};
   const onEconomyCommit=({type,database,operation,startedAt,endedAt,elapsedMs})=>{
    if(type!=='companion-economy-commit'||!['economy','cg-reward-facts'].includes(database)||
     typeof operation!=='string'||!/^[a-z-]{1,35}$/.test(operation)||!numeric(startedAt)||!numeric(endedAt)||!numeric(elapsedMs))return;
    if(economyCommits.rows.length>=ECONOMY_SAMPLE_MAX)economyCommits.dropped++;
    else economyCommits.rows.push({database,operation,startedAt,endedAt,elapsedMs});
   };
   economySql.subscribe(onEconomyCommit);
   stopEconomySample=()=>{economySql.unsubscribe(onEconomyCommit);stopEconomySample=undefined;};
   const companionWrites=op.companionWrites?{dropped:0,rows:[]}:null;
   if(companionWrites){
    const onCompanionWrite=value=>collectCompanionWrite(companionWrites,value);
    companionWriteLatency.subscribe(onCompanionWrite);
    stopCompanionWriteSample=()=>{companionWriteLatency.unsubscribe(onCompanionWrite);stopCompanionWriteSample=undefined;};
   }
   if(op.seconds>=60)timer60=setTimer(()=>{firstMinuteCpu={...process.cpuUsage(before),elapsedMs:now()-startedAt};},60000);
   // An abort that already happened is honoured here; addEventListener alone would never fire for it.
   try{await new Promise((resolve,reject)=>{
    if(signal.aborted){reject(signal.reason);return;}
    const cleanup=()=>{clearTimer(timer);signal.removeEventListener('abort',onAbort);op.finish=null;};
    const onAbort=()=>{cleanup();reject(signal.reason);};
    const finish=()=>{cleanup();resolve();};
    const timer=setTimer(finish,op.seconds*1000);
    signal.addEventListener('abort',onAbort,{once:true});op.startedAt=startedAt;op.finish=finish;
   });}finally{if(timer60!==undefined)clearTimer(timer60);}
   if(isClosing())throw fault('MAIN_PROFILE_CANCELLED');
   const {profile:raw}=await session.post('Profiler.stop');started=false;delay.disable();stopEconomySample();stopCompanionWriteSample?.();
   const endedAt=now(),usage=process.cpuUsage(before),timings=desktop?stopDesktopSample()?.timings??null:null;desktop=false;
   let voice=null;if(probe)voice=rendererRows(await bounded(renderer.stop()));probe=false;
   const result={ok:true,processId,build,seconds:op.seconds,startedAt,endedAt,finishedAt:now(),target:{name:'electron-main',thread:'CrBrowserMain'},runtime:{node:versions.node,electron:versions.electron??null},
    cpuDelta:{user:usage.user,system:usage.system},
    ...(firstMinuteCpu?{firstMinuteCpu}:{}),
    eventLoop:{p50Ms:round(delay.percentile(50)/1e6),p95Ms:round(delay.percentile(95)/1e6),p99Ms:round(delay.percentile(99)/1e6),maxMs:round(delay.max/1e6),count:delay.count},
    timings,economyCommits,...(companionWrites?{companionWrites}:{}),rendererVoice:voice,profile:profileMetadata(raw)};
   // Estimated from counts: stringifying many MB here would stall the very thread being diagnosed.
   if(result.profile.nodes.length*NODE_BYTES+result.profile.samples.length*SAMPLE_BYTES+(companionWrites?.rows.length??0)*COMPANION_WRITE_ROW_BYTES>MAIN_PROFILE_MAX_BYTES)throw fault('MAIN_PROFILE_TOO_LARGE');
   return result;
  }finally{
   delay.disable();
   stopCompanionWriteSample?.();
   stopEconomySample?.();
   if(started)try{await session.post('Profiler.stop');}catch{}
   if(desktop)try{stopDesktopSample();}catch{}
   if(probe&&renderer)await bounded(renderer.stop());
   try{session.disconnect();}catch{}
  }
 }
 async function handle(request){
  if(!valid(request))return {ok:false,code:'MAIN_PROFILE_REQUEST_INVALID',error:'MAIN_PROFILE_REQUEST_INVALID'};
  if(isClosing())return {ok:false,code:'MAIN_PROFILE_CANCELLED',error:'MAIN_PROFILE_CANCELLED'};
  if(request.phase==='status')return active?{ok:true,active:true,seconds:active.seconds,startedAt:active.startedAt??null}:{ok:true,active:false};
  if(request.phase==='finish'){
   if(!active?.finish)return {ok:false,code:'MAIN_PROFILE_NOT_RECORDING',error:'MAIN_PROFILE_NOT_RECORDING'};
   active.finish();return {ok:true};
  }
  if(active)return {ok:false,code:'MAIN_PROFILE_BUSY',error:'MAIN_PROFILE_BUSY'};
  const op={seconds:request.seconds??DEFAULT_SECONDS,companionWrites:request.companionWrites===true,controller:new AbortController()};active=op;
  const timer=setTimer(()=>{if(!op.controller.signal.aborted)op.controller.abort(fault('MAIN_PROFILE_TIMEOUT'));},op.seconds*1000+20000);
  try{return await capture(op);}
  catch(error){const code=String(error?.code??'').startsWith('MAIN_PROFILE_')?error.code:'MAIN_PROFILE_FAILED';return {ok:false,code,error:code};}
  finally{clearTimer(timer);if(active===op)active=null;}
 }
 return {handle,cancel(){if(active&&!active.controller.signal.aborted)active.controller.abort(fault('MAIN_PROFILE_CANCELLED'));}};
}
