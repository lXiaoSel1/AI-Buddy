import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCompanionService} from '../src/companion-service.mjs';
import {companionFixture,memoryStore,syntheticEngine,gate} from './support/audit-harness.mjs';

async function fixture(t,{closeDrainMs=5000}={}){
 const store=memoryStore(await companionFixture()),dataRoot=mkdtempSync(join(tmpdir(),'r95-close-review-')),entered=gate(),cleanup=gate(),aborted=gate();let drained=false;
 const provider={enabled:true,resolveConnection:()=>({mode:'global',connectionId:'p',name:'p',model:'m',error:null}),currentSelection:()=>({provider:'p',model:'m'}),captureConnection:()=>({id:'p',model:'m',kind:'custom'}),resolveContextCapacity:()=>({tokens:272000}),runTurn:async fn=>fn(),runCaptured:async(_profile,fn)=>fn(),async *stream(options){
  if(options.purpose!=='group-chat'){yield {type:'text-delta',text:'{"changed":false}'};return;}
  entered.resolve();try{await new Promise(resolve=>{if(options.signal.aborted)resolve();else options.signal.addEventListener('abort',resolve,{once:true});});aborted.resolve();await cleanup.promise;yield {type:'text-delta',text:'{"text":"late abort cleanup","emotion":"normal","affection":0}'};}finally{drained=true;}
 }};
 const engine=syntheticEngine({getStore:()=>store}).engine,service=await createCompanionService({store,engine,provider,dataRoot,closeDrainMs,r95Options:{getRuntimeState:()=>({sleepPhase:'awake',canPresent:true,sleepIntentVersion:1})}});
 t.after(async()=>{cleanup.resolve();await service.close();await store.flush();rmSync(dataRoot,{recursive:true,force:true});});
 const group=(await service.action('companion-group-save',{name:'关闭链路',memberIds:['claude'],mode:'list'})).group;await service.action('companion-group-select',{id:group.id});await service.action('companion-group-send',{id:group.id,text:'要等待实际生成结束',clientRequestId:'close-review'});await entered.promise;
 return {store,service,dataRoot,cleanup,aborted,drained:()=>drained};
}

test('R95 close waits for the actual aborted group producer and its terminal journal before reporting completion',async t=>{
 const f=await fixture(t);let release;const closing=f.service.close();release=setTimeout(()=>f.cleanup.resolve(),80);
 try{await closing;assert.equal(f.drained(),true,'close must await the producer, not just abort and flush an earlier journal tail');const rows=readdirSync(join(f.dataRoot,'chat-requests')).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(readFileSync(join(f.dataRoot,'chat-requests',name),'utf8')));assert.equal(rows.length,1);assert.equal(rows[0].status,'cancelled');}
 finally{clearTimeout(release);f.cleanup.resolve();}
});

test('R95 close reports a bounded drain timeout and can finish on retry after an uncooperative producer drains',async t=>{
 const f=await fixture(t);
 // Exercise the real 5-second bound without making filesystem completion race
 // a 25ms wall-clock allowance. Only the intentionally held first drain uses
 // virtual time; retry still waits for real producer and journal completion.
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 try{
  const closing=f.service.close(),rejected=assert.rejects(closing,error=>{
   assert.equal(error.code,'COMPANION_CLOSE_TIMEOUT');assert.equal(error.stage,'producers');assert.ok(error.pendingTasks>0);return true;
  });
  await f.aborted.promise;t.mock.timers.tick(5001);await rejected;assert.equal(f.drained(),false);
 }finally{t.mock.timers.reset();}
 f.cleanup.resolve();await f.service.close();assert.equal(f.drained(),true);const rows=readdirSync(join(f.dataRoot,'chat-requests')).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(readFileSync(join(f.dataRoot,'chat-requests',name),'utf8')));assert.equal(rows[0].status,'cancelled');
});

test('R95 closing rejects new APP commands instead of allowing another producer to enter behind the final flush',async t=>{
 const f=await fixture(t),closing=f.service.close();await f.aborted.promise;
 try{await assert.rejects(f.service.action('companion-settings',{settings:{allowMessageCorrection:true}}),{code:'COMPANION_CLOSING'});}
 finally{f.cleanup.resolve();await closing;}
});

test('R95 concurrent and repeated close calls share one drain and remain safe after resources are closed',async t=>{
 const f=await fixture(t),first=f.service.close(),second=f.service.close();assert.equal(first,second,'two callers must await the same close operation');await f.aborted.promise;assert.equal(f.drained(),false);f.cleanup.resolve();await Promise.all([first,second]);await f.service.close();await assert.rejects(f.service.chat({text:'不能在关闭后新提交'}),{code:'COMPANION_CLOSING'});
});
