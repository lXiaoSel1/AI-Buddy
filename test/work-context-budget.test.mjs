import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompanionService} from '../src/companion-service.mjs';
import {companionFixture,memoryStore,syntheticEngine,tmpDir} from './support/audit-harness.mjs';

async function fixture(t,tokens=65536){
 const store=memoryStore(await companionFixture()),{engine}=syntheticEngine({getStore:()=>store});let calls=0;
 const service=await createCompanionService({store,engine,dataRoot:tmpDir('work-budget',{t,beforeRemove:()=>service.close()}),provider:{enabled:false,resolveContextCapacity:()=>({tokens,source:'fixture',verified:true}),outputLimit:()=>4096,stream:async()=>{calls++;throw Error('Unexpected model call');}}});t.after(()=>service.close());
 const scope=service.workScope('claude'),task={id:'test-work',scope,instruction:'Keep the complete original goal',workspace:{id:'project-a',path:'isolated-project'}};
 return {service,task,store,calls:()=>calls};
}
test('work memory reserves trusted native instructions before selecting memory and returns the actual output reserve',async t=>{
 const f=await fixture(t),normal=await f.service.workContext(f.task,{nativeCapacity:{tokens:65536},reservedOutputTokens:4096}),withNative=await f.service.workContext(f.task,{systemOverheadTokens:15000,nativeCapacity:{tokens:65536},reservedOutputTokens:4096});
 assert.equal(withNative.capacity.estimatedInputTokens-normal.capacity.estimatedInputTokens,15000);
 assert.equal(withNative.capacity.reservedOutputTokens,4096);
 assert.equal(withNative.capacity.tokens,65536);
 assert.equal(f.task.instruction,'Keep the complete original goal');assert.equal(f.calls(),0);
});
test('work context never consults the companion connection or chat output setting',async t=>{
 const f=await fixture(t,512),snapshot={tokens:65536,source:'approved-native-binding',verified:false};
 const result=await f.service.workContext(f.task,{nativeCapacity:snapshot,reservedOutputTokens:3000});
 assert.equal(result.capacity.tokens,65536);assert.equal(result.capacity.reservedOutputTokens,3000);assert.equal(result.capacity.source,snapshot.source);assert.equal(f.calls(),0);
 const fallback=await f.service.workContext(f.task);assert.equal(fallback.capacity.source,'application-default');assert.notEqual(fallback.capacity.tokens,512);
});
test('insufficient work budget refuses before compression or a model call and preserves original records',async t=>{
 const f=await fixture(t,32768),messages=structuredClone(f.store.state.conversations);
 await assert.rejects(f.service.workContext(f.task,{systemOverheadTokens:50000,nativeCapacity:{tokens:32768}}),{code:'MEMORY_CONTEXT_CAPACITY'});
 assert.deepEqual(f.store.state.conversations,messages);assert.equal(f.calls(),0);
});
