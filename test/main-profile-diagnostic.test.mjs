import test from 'node:test';
import {channel} from 'node:diagnostics_channel';
import assert from 'node:assert/strict';
import {createMainProfileDiagnostic,profileMetadata} from '../src/main-profile-diagnostic.mjs';

import {startDesktopSample,stopDesktopSample} from '../src/desktop-diagnostics.mjs';

const base={command:'diagnostics-main-profile',expectedProcessId:4242,expectedBuild:'B'};

test('main profile rejects requests for another process, build, unknown keys or out-of-range seconds',async()=>{
 const diag=createMainProfileDiagnostic({processId:4242,build:'B'});
 for(const request of [{...base,expectedProcessId:1},{...base,expectedBuild:'other'},{...base,extra:true},{...base,seconds:4},{...base,seconds:121},{...base,seconds:2.5}])
  assert.equal((await diag.handle(request)).code,'MAIN_PROFILE_REQUEST_INVALID');
});

test('main profile keeps only call frames and bundle names, never paths or queries',()=>{
 const raw={startTime:1,endTime:2,samples:[1,2],timeDeltas:[1,1],nodes:[
  {id:1,callFrame:{functionName:'(root)',scriptId:'0',url:'',lineNumber:-1,columnNumber:-1},children:[2]},
  {id:2,callFrame:{functionName:'absorbProgress\u0007',scriptId:'12',url:'file:///C:/Users/someone/AppData/builds/x/main.cjs?token=1',lineNumber:10,columnNumber:4},hitCount:3,positionTicks:[{line:1}]},
  {id:3,callFrame:{functionName:'x',scriptId:'13',url:'file:///C:/Users/someone/secret.js',lineNumber:1,columnNumber:1}}]};
 const out=profileMetadata(raw);
 assert.equal(out.nodes[1].callFrame.url,'buddy://main.cjs');
 assert.equal(out.nodes[1].callFrame.functionName,'absorbProgress');
 assert.equal(out.nodes[2].callFrame.url,'');
 assert.equal(JSON.stringify(out).includes('someone'),false);
 assert.equal('positionTicks' in out.nodes[1],false);
 assert.deepEqual(out.nodes[0].children,[2]);
});

test('main profile runs one capture at a time and returns a real main-thread profile with renderer rows',async()=>{
 const rows=[{type:'display',index:0,perfNow:12.5,text:'不应带出的台词'},{type:'receipt',status:'textDisplayed',index:0,sentAt:1,doneAt:40}];
 let started=0;
 const diag=createMainProfileDiagnostic({processId:4242,build:'B',renderer:{start:async()=>{started++;return true;},stop:async()=>rows}});
 const busy=setInterval(()=>{const t=Date.now();while(Date.now()-t<5){}},20);
 try{
  const first=diag.handle({...base,seconds:5});
  assert.equal((await diag.handle({...base,seconds:5})).code,'MAIN_PROFILE_BUSY');
  const result=await first;
  assert.equal(result.ok,true,JSON.stringify(result).slice(0,200));
  assert.equal(started,1);
  assert.ok(result.profile.nodes.length>1&&result.profile.samples.length>100);
  assert.ok(result.eventLoop.maxMs>=0&&result.cpuDelta.user>0);
  assert.deepEqual(result.rendererVoice[0],{type:'display',index:0,perfNow:12.5});
  assert.equal(result.rendererVoice[1].doneAt,40);
  assert.equal((await diag.handle({...base,seconds:5})).ok,true,'the lock is released after a capture');
 }finally{clearInterval(busy);}
});

test('a cancel during setup is not lost: the capture ends as cancelled at once',async()=>{
 const diag=createMainProfileDiagnostic({processId:4242,build:'B',renderer:{start:async()=>{await new Promise(r=>setTimeout(r,50));return true;},stop:async()=>[]}});
 const at=Date.now(),run=diag.handle({...base,seconds:30});
 diag.cancel();
 assert.equal((await run).code,'MAIN_PROFILE_CANCELLED');
 assert.ok(Date.now()-at<5000,'cancel waited for the full capture');
});

test('a renderer that never answers does not hold the capture slot',async()=>{
 const never=()=>new Promise(()=>{});
 const diag=createMainProfileDiagnostic({processId:4242,build:'B',renderer:{start:never,stop:never}});
 const result=await diag.handle({...base,seconds:5});
 assert.equal(result.ok,true);
 assert.equal(result.rendererVoice,null);
 assert.equal((await diag.handle({...base,seconds:5})).ok,true,'the slot is free for the next capture');
});

test('cancel ends an active capture as cancelled',async()=>{
 const diag=createMainProfileDiagnostic({processId:4242,build:'B'});
 const run=diag.handle({...base,seconds:30});
 setTimeout(()=>diag.cancel(),300);
 assert.equal((await run).code,'MAIN_PROFILE_CANCELLED');
});

test('an owned restore diagnostic can span 90 seconds and be stopped at a measured boundary',async()=>{
 let markStarted,ended;
 const started=new Promise(resolve=>{markStarted=resolve;});
 const profile={nodes:[{id:1,callFrame:{functionName:'(idle)'}}],startTime:1000,endTime:2000,samples:[1],timeDeltas:[1000]};
 const diag=createMainProfileDiagnostic({processId:4242,build:'B',createSession:()=>({connect(){},disconnect(){},async post(name){
  if(name==='Profiler.start')markStarted();
  if(name==='Profiler.stop'){ended=true;return {profile};}
 }})});
 const run=diag.handle({...base,seconds:90});
 try{
  await Promise.race([started,run.then(()=>assert.fail('Restore diagnostics must accept a 90 second bounded window'))]);
  await new Promise(resolve=>setImmediate(resolve));
  const active=await diag.handle({...base,phase:'status'});
  assert.equal(active.active,true);assert.equal(active.seconds,90);assert.ok(active.startedAt>0);
  assert.equal((await diag.handle({...base,phase:'finish',expectedProcessId:1})).code,'MAIN_PROFILE_REQUEST_INVALID');
  assert.equal((await diag.handle({...base,phase:'finish'})).ok,true);
  const captured=await run;
  assert.equal(captured.ok,true);assert.equal(ended,true);
  assert.equal(captured.seconds,90);assert.ok(captured.endedAt>=captured.startedAt);
  assert.deepEqual(await diag.handle({...base,phase:'status'}),{ok:true,active:false});
 }finally{diag.cancel();await run;}
});

test('desktop phase keeps profiling timings for the long native capture only',t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 try{
  startDesktopSample('profile',{timeoutMs:135000});
  t.mock.timers.tick(100000);
  assert.equal(stopDesktopSample()?.phase,'profile');
  startDesktopSample('history',{timeoutMs:135000});
  t.mock.timers.tick(90001);
  assert.equal(stopDesktopSample(),null);
 }finally{stopDesktopSample();}
});

test('main CPU profiling correlates bounded economy commits only inside the owned window',async()=>{
 const usage=channel('ai-buddy.companion.economy-sql');
 const profile={nodes:[{id:1,callFrame:{functionName:'(idle)'}}],startTime:1000,endTime:2000,samples:[1],timeDeltas:[1000]};
 const diag=createMainProfileDiagnostic({processId:4242,build:'B',createSession:()=>({connect(){},disconnect(){},async post(name){
  if(name==='Profiler.stop'){usage.publish({...event,operation:'initialize'});return {profile};}
 }})});
 const before=usage.hasSubscribers;
 const run=diag.handle({...base,seconds:90});
 const event={type:'companion-economy-commit',database:'economy',operation:'settle-hunger',startedAt:10,endedAt:15,elapsedMs:5,privateText:'must stay private'};
 try{
  await new Promise(resolve=>setImmediate(resolve));
  usage.publish(event);
  await diag.handle({...base,phase:'finish'});
  assert.deepEqual((await run).economyCommits,{dropped:0,rows:[{database:'economy',operation:'settle-hunger',startedAt:10,endedAt:15,elapsedMs:5},{database:'economy',operation:'initialize',startedAt:10,endedAt:15,elapsedMs:5}]});
  assert.equal(usage.hasSubscribers,before);
 }finally{diag.cancel();await run;}
});


test('main profile captures bounded companion write timing only in an opted-in profile',async()=>{
 const writes=channel('ai-buddy.companion.write-latency'),before=writes.hasSubscribers;
 const profile={nodes:[{id:1,callFrame:{functionName:'(idle)'}}],startTime:1000,endTime:2000,samples:[1],timeDeltas:[1000]};
 let failStop=false;
 const diag=createMainProfileDiagnostic({processId:4242,build:'B',createSession:()=>({connect(){},disconnect(){},async post(name){
  if(name==='Profiler.stop'){if(failStop)throw Error('synthetic stop failure');return {profile};}
 }})});
 const committed={operation:'memory.sync',status:'committed',rows:16,acceptedAt:20,committedAt:32,queueMs:2,workerWaitMs:8,workerMs:6,commitMs:1,acceptedToCommitMs:12,acceptedToOutcomeMs:13};
 const imported={...committed,operation:'conversation-import',workerMs:null,workerWaitMs:0};
 const noOp={...committed,status:'no-op',rows:0,committedAt:null,workerMs:null,commitMs:null,acceptedToCommitMs:null};
 async function arm(companionWrites){
  const run=diag.handle({...base,seconds:90,...companionWrites?{companionWrites:true}:{}});
  const active=await Promise.race([new Promise(resolve=>setImmediate(()=>resolve(diag.handle({...base,phase:'status'})))),run]);
  assert.ok(active.startedAt>0,'the profile must accept the opt-in and start');
  assert.equal(writes.hasSubscribers,companionWrites||before);
  return {run};
 }
 writes.publish(committed);
 let run;
 try{
  ({run}=await arm(true));
  writes.publish({...imported,privateBody:'synthetic secret'});
  writes.publish(noOp);
  writes.publish({...committed,operation:'private-operation'});
  writes.publish({...committed,acceptedToCommitMs:'private timing'});
  for(let i=0;i<4096;i++)writes.publish(committed);
  await diag.handle({...base,phase:'finish'});
  const result=await run;
  assert.equal(result.ok,true);
  assert.equal(result.companionWrites.rows.length,4096);
  assert.equal(result.companionWrites.dropped,2);
  assert.deepEqual(result.companionWrites.rows.slice(0,3),[imported,noOp,committed]);
  assert.equal(writes.hasSubscribers,before);

  ({run}=await arm(false));
  writes.publish(committed);
  await diag.handle({...base,phase:'finish'});
  assert.equal((await run).companionWrites,undefined);

  failStop=true;
  ({run}=await arm(true));
  await diag.handle({...base,phase:'finish'});
  assert.equal((await run).code,'MAIN_PROFILE_FAILED');
  assert.equal(writes.hasSubscribers,before);
 }finally{diag.cancel();await run;}
});
