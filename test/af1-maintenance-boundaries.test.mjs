import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMaintenanceQueue} from '../src/community/maintenance-queue.mjs';
import {communityDigest} from '../src/community/catalog.mjs';
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const intent={approved:'test-only'};
async function fixture(t,opts={}){const directory=await mkdtemp(join(tmpdir(),'af1-queue-'));let q;const executions=[];const config={directory,execute:async job=>executions.push(job.id),...opts};q=await createMaintenanceQueue(config);t.after(async()=>{await q.close();await rm(directory,{recursive:true,force:true});});return {directory,executions,get q(){return q;},async restart(){await q.close();q=await createMaintenanceQueue(config);return q;}};}
for(const stop of ['cancel','close'])test('AF1 maintenance '+stop+' during final busy check never executes',async t=>{
 const entered=gate(),release=gate();let checks=0;const f=await fixture(t,{isBusy:async()=>{if(++checks===2){entered.resolve();await release.promise;}return false;}});
 const job=await f.q.enqueue({operation:'enable',packageKey:'p',intent});const draining=f.q.drain();await entered.promise;
 const stopping=stop==='cancel'?f.q.cancel(job.id):f.q.close();if(stop==='cancel')await stopping;release.resolve();await Promise.all([draining,stopping]);assert.equal(f.executions.length,0);
});
test('AF1 closing between enqueue admission and mutation refuses new persisted work',async t=>{
 const f=await fixture(t);const pending=f.q.enqueue({operation:'enable',packageKey:'p',intent});const rejected=assert.rejects(pending,{code:'COMMUNITY_CLOSED'});await Promise.all([f.q.close(),rejected]);assert.equal(f.q.snapshot().jobs.length,0);
});
test('AF1 cancelled job is not rewritten by late failed source validation',async t=>{
 const entered=gate(),release=gate();const f=await fixture(t,{revalidate:async()=>{entered.resolve();await release.promise;return {allowed:false,code:'SOURCE_CHANGED'};}});
 const job=await f.q.enqueue({operation:'enable',packageKey:'p',intent});const draining=f.q.drain();await entered.promise;await f.q.cancel(job.id);release.resolve();await draining;assert.equal(f.q.snapshot().jobs[0].state,'cancelled');assert.equal(f.executions.length,0);
});
test('AF1 capacity is enforced before writing and duplicate intent remains idempotent',async t=>{
 const f=await fixture(t);await f.q.close();const jobs=Array.from({length:10000},(_,i)=>({id:String(i),operation:'enable',packageKey:'p',intent,intentDigest:communityDigest(intent),idempotencyKey:'key-'+i,state:'completed'}));
 await writeFile(join(f.directory,'maintenance-queue-v1.json'),JSON.stringify({schemaVersion:1,jobs}));await f.restart();
 assert.equal((await f.q.enqueue({operation:'enable',packageKey:'p',intent,idempotencyKey:'key-0'})).id,'0');
 await assert.rejects(f.q.enqueue({operation:'enable',packageKey:'new',intent}),{code:'COMMUNITY_QUEUE_CAPACITY'});await f.restart();assert.equal(f.q.snapshot().jobs.length,10000);
});
test('AF1 legacy over-capacity valid evidence can be inspected without executing or rewriting it',async t=>{
 const f=await fixture(t);await f.q.close();const jobs=Array.from({length:10001},(_,i)=>({id:String(i),operation:'enable',packageKey:'p',intent,intentDigest:communityDigest(intent),idempotencyKey:'key-'+i,state:'queued'}));
 const file=join(f.directory,'maintenance-queue-v1.json'),bytes=JSON.stringify({schemaVersion:1,jobs});await writeFile(file,bytes);await f.restart();await f.q.drain();assert.equal(f.q.snapshot().jobs.length,10001);assert.equal(f.executions.length,0);assert.equal(await readFile(file,'utf8'),bytes);
});
