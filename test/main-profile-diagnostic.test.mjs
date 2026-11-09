import test from 'node:test';
import assert from 'node:assert/strict';
import {createMainProfileDiagnostic,profileMetadata} from '../src/main-profile-diagnostic.mjs';

const base={command:'diagnostics-main-profile',expectedProcessId:4242,expectedBuild:'B'};

test('main profile rejects requests for another process, build, unknown keys or out-of-range seconds',async()=>{
 const diag=createMainProfileDiagnostic({processId:4242,build:'B'});
 for(const request of [{...base,expectedProcessId:1},{...base,expectedBuild:'other'},{...base,extra:true},{...base,seconds:4},{...base,seconds:61},{...base,seconds:2.5}])
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
