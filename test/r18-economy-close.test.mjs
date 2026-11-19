import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import test from 'node:test';
import {Worker} from 'node:worker_threads';
import {createEconomyStore} from '../src/companion-economy-worker-client.mjs';
import {createFeedingService} from '../src/companion-feeding.mjs';
import {createCompanionService} from '../src/companion-service.mjs';
import {openCompanionStore} from '../src/companion-store.mjs';
import {companionFixture,syntheticEngine} from './support/audit-harness.mjs';

const checkpointFailure=error=>error?.code==='FIXTURE_ECONOMY_CHECKPOINT_FAILED'||error?.errors?.some(checkpointFailure)===true;
const failingEconomy=dataRoot=>createEconomyStore(dataRoot,{
 workerFactory:(url,options)=>new Worker(new URL('./fixtures/economy-close-fault.mjs',import.meta.url),{
  ...options,workerData:{...options.workerData,writerUrl:String(url)}
 })
});

async function persistenceFixture(t){
 const dataRoot=await mkdtemp(join(tmpdir(),'audit213-shutdown-')),closers=[];
 t.after(async()=>{
  t.mock.restoreAll();
  for(const close of closers.reverse())await Promise.resolve().then(close).catch(()=>{});
  assert.ok(resolve(dataRoot).startsWith(resolve(tmpdir())+sep));
  await rm(dataRoot,{recursive:true,force:true});
 });
 return {dataRoot,close:fn=>closers.push(fn)};
}

async function companionPersistenceFixture(t){
 const fixture=await persistenceFixture(t),{dataRoot}=fixture;
 const store=await openCompanionStore(dataRoot);
 fixture.close(()=>store.close());
 fixture.close(()=>store.flush());
 const seed=await companionFixture();
 await store.mutate(state=>Object.assign(state,seed));
 const {engine}=syntheticEngine({getStore:()=>store}),feedingStore=await failingEconomy(dataRoot);
 fixture.close(()=>feedingStore.close());
 const service=await createCompanionService({store,engine,provider:{enabled:false},dataRoot,automaticWorkAllowed:()=>false,r95Options:{feedingStore}});
 fixture.close(()=>service.close());
 return {service,store};
}

test('real feeding close never converts a failed economy checkpoint into a successful second close',async t=>{
 const fixture=await persistenceFixture(t),feeding=createFeedingService({store:await failingEconomy(fixture.dataRoot)});
 fixture.close(()=>feeding.close());
 await assert.rejects(feeding.close(),checkpointFailure);
 await assert.rejects(feeding.close(),checkpointFailure);
});

test('real R95 close propagates feeding persistence failure and retains the rejected close',async t=>{
 const {service}=await companionPersistenceFixture(t);
 await assert.rejects(service.r95.close(),checkpointFailure);
 await assert.rejects(service.r95.close(),checkpointFailure);
});

test('the real companion service propagates component save failures on every retry',async t=>{
 const {service,store}=await companionPersistenceFixture(t),flush=t.mock.method(store,'flush',store.flush.bind(store));
 await assert.rejects(service.close(),checkpointFailure);
 const saved=flush.mock.callCount();
 await assert.rejects(service.close(),checkpointFailure);
 assert.equal(flush.mock.callCount(),saved,'failed components must not repeat successful journal/store saves');
});
