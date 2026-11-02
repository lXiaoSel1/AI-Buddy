import test from 'node:test';
import assert from 'node:assert/strict';
import {createDailyCgScheduler,dailyCgTime} from '../src/daily-cg-scheduler.mjs';
const at=value=>Date.parse(value);
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function memoryJournal(){let content=JSON.stringify({version:1,claims:{}});return {readText:async()=>content,writeText:async value=>{content=value;},read:()=>JSON.parse(content)};}
function fixture(options={}){
 let time=at('2026-11-01T10:00:00Z'),enabled=true,role='deepseek';const calls=[],captures=[],storage=options.storage??memoryJournal();
 const scheduler=createDailyCgScheduler({storage,now:()=>time,getTimeZone:()=> 'UTC',admission:()=>enabled,capture:async context=>{captures.push(context);return {characterId:role,materials:[{id:'m-'+role,text:'known',sourceHash:'a'.repeat(64)}]};},enqueue:async(snapshot,context)=>{calls.push({snapshot,context});return {cgId:'cg-'+calls.length};},...options});
 return {scheduler,storage,calls,captures,time:value=>{time=at(value);},enable:value=>{enabled=value;},role:value=>{role=value;}};
}
test('daily CG has exactly two global slots even when roles change or ticks overlap',async()=>{
 const f=fixture();await Promise.all([f.scheduler.tick(),f.scheduler.tick()]);f.role('claude');await f.scheduler.tick();assert.equal(f.calls.length,1);assert.equal(f.calls[0].snapshot.characterId,'deepseek');
 f.time('2026-11-01T22:00:00Z');await f.scheduler.tick();assert.equal(f.calls.length,2);assert.equal(f.calls[1].snapshot.characterId,'claude');assert.equal(f.calls[1].context.previous[0].materialEventIds[0],'m-deepseek');
 assert.deepEqual(Object.keys(f.storage.read().claims),['daily:2026-11-01:1000','daily:2026-11-01:2200']);await f.scheduler.stopAndDrain();
});
test('off, missed slots and a delayed tick never create a catch-up backlog',async()=>{
 const f=fixture();f.enable(false);assert.equal((await f.scheduler.tick()).skipped,'denied');f.time('2026-11-01T10:01:00Z');f.enable(true);assert.equal((await f.scheduler.tick()).skipped,'not-due');
 f.time('2026-11-01T11:00:00Z');assert.equal((await f.scheduler.tick({at:at('2026-11-01T10:00:00Z')})).skipped,'missed');assert.equal(f.calls.length,0);await f.scheduler.stopAndDrain();
});
test('a persisted claim survives restart, failed enqueue, disable toggles and clock rollback',async()=>{
 const storage=memoryJournal(),f=fixture({storage,enqueue:async()=>{throw Error('queue failed');}});const result=await f.scheduler.tick();assert.equal(result.claim.status,'failed');await f.scheduler.stopAndDrain();
 const next=fixture({storage});assert.equal((await next.scheduler.tick()).skipped,'claimed');next.enable(false);next.enable(true);assert.equal((await next.scheduler.tick()).skipped,'claimed');next.time('2026-11-02T10:00:00Z');await next.scheduler.tick();next.time('2026-11-01T10:00:00Z');assert.equal((await next.scheduler.tick()).skipped,'claimed');assert.equal(next.calls.length,1);await next.scheduler.stopAndDrain();
});
test('a capture failure consumes its slot without persisting material text',async()=>{
 const f=fixture({capture:async()=>{throw Error('source unavailable');}});assert.equal((await f.scheduler.tick()).claim.status,'failed');assert.equal((await f.scheduler.tick()).skipped,'claimed');assert.equal(f.calls.length,0);assert.doesNotMatch(JSON.stringify(f.storage.read()),/known/);await f.scheduler.stopAndDrain();
});
test('shutdown waits for capture, prevents late enqueue, and keeps its slot consumed',async()=>{
 const entered=gate(),release=gate(),f=fixture({capture:async()=>{entered.resolve();await release.promise;return {materials:[]};}});const ticking=f.scheduler.tick();await entered.promise;
 let finished=false;const closing=f.scheduler.stopAndDrain().then(()=>{finished=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);release.resolve();await closing;assert.equal((await ticking).claim.status,'cancelled');assert.equal(f.calls.length,0);assert.equal((await f.scheduler.tick()).skipped,'closed');
 const next=fixture({storage:f.storage});assert.equal((await next.scheduler.tick()).skipped,'claimed');await next.scheduler.stopAndDrain();
});
test('revoked admission after capture cannot enqueue and cannot revive in the same slot',async()=>{
 const f=fixture();f.scheduler=createDailyCgScheduler({storage:f.storage,now:()=>at('2026-11-01T10:00:00Z'),getTimeZone:()=> 'UTC',admission:context=>context.snapshot?false:true,capture:async()=>({materials:[]}),enqueue:async()=>{throw Error('must not enqueue');}});
 assert.equal((await f.scheduler.tick()).claim.status,'cancelled');assert.equal((await f.scheduler.tick()).skipped,'claimed');await f.scheduler.stopAndDrain();
});
test('the durable slot exists before source capture or any enqueue side effect',async()=>{
 const storage=memoryJournal();const f=fixture({storage,capture:async context=>{assert.equal(storage.read().claims[context.sourceEventId].status,'claimed');return {materials:[]};}});await f.scheduler.tick();await f.scheduler.stopAndDrain();
});
test('local and explicit IANA zones use wall-clock slots across the DST date',()=>{
 assert.deepEqual(dailyCgTime(at('2026-11-01T15:00:00Z'),'America/New_York'),{logicalDay:'2026-11-01',slot:'10:00',timeZone:'America/New_York'});
 assert.equal(dailyCgTime(at('2026-11-02T03:00:00Z'),'America/New_York').slot,'22:00');
 assert.equal(dailyCgTime(at('2026-11-01T02:00:00Z'),'Asia/Shanghai').slot,'10:00');assert.ok(dailyCgTime(Date.now(),'local').timeZone);
});
test('changing zones cannot create another same-day same-slot claim',async()=>{
 let zone='UTC',time=at('2026-11-01T10:00:00Z');const f=fixture({getTimeZone:()=>zone,now:()=>time});await f.scheduler.tick();zone='America/New_York';time=at('2026-11-01T15:00:00Z');assert.equal((await f.scheduler.tick()).skipped,'claimed');assert.equal(f.calls.length,1);await f.scheduler.stopAndDrain();
});
test('startup outside a slot creates neither historical claims nor model work',async()=>{
 let interval;const f=fixture({now:()=>at('2026-11-01T12:00:00Z'),setIntervalImpl:fn=>{interval=fn;return 1;},clearIntervalImpl:()=>{interval=null;}});f.scheduler.start();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.length,0);assert.deepEqual(f.storage.read().claims,{});await f.scheduler.stopAndDrain();assert.equal(interval,null);
});
