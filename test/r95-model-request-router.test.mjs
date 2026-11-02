import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ModelRouter} from '../src/model-router.mjs';
import {runR95Model} from '../src/r95-model-request.mjs';
const crypto={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()};
async function fixture(t,{outputLimit=512}={}){
 const dataRoot=mkdtempSync(join(tmpdir(),'r95-request-router-')),requests=[],usages=[],metadata=new AsyncLocalStorage();let limit=outputLimit;
 const provider=new ModelRouter({dataRoot,crypto,codex:{defaultModel:'fixture',setEnabled(){}},outputLimit:()=>limit,onUsage:value=>usages.push(value),fetchImpl:async(url,options)=>{requests.push({url:String(url),body:JSON.parse(options.body)});return new Response(JSON.stringify({id:'mock-response',status:'completed',output:[{content:[{type:'output_text',text:'{"manualEquivalentAffection":2.5,"reason":"mock"}'}]}],usage:{input_tokens:20,output_tokens:5,total_tokens:25}}),{headers:{'content-type':'application/json'}});}});t.after(async()=>{await provider.close();rmSync(dataRoot,{recursive:true,force:true});});await provider.ready;const profile=await provider.save({kind:'custom',name:'own isolated model',baseUrl:'http://127.0.0.1:3099/v1',model:'frozen-model',protocol:'responses',reasoningEffort:'xhigh',contextTokens:20000,models:[{id:'frozen-model',supportedReasoningEfforts:['xhigh','low'],maxOutputTokens:8192}]});await provider.activate(profile.id);provider.setEnabled(true);
 const scope={characterId:'claude',personaId:'persona',lifeId:'life',operationId:'operation',channel:'app-private',conversationId:'conversation'},card={id:'claude',revision:1,modelBinding:{enabled:true,connectionId:profile.id}};
 const options={provider,card,scope,input:{kind:'meal',meal:{id:'already-consumed',foodId:'rice'}},system:'Evaluate the real consumed meal. JSON only.',memory:{context:async()=>({messages:[],text:'permitted memory',lifeId:'life',operationId:'operation',capacity:{tokens:20000}})},withOrigin:(scope,kind,fn,{originId}={})=>provider.withRequestContext({scope,activityOriginId:originId??'temporary-feeding'},()=>fn(originId??'temporary-feeding')),withMemoryContext:(value,fn)=>metadata.run(value,fn),activityKind:'feeding-temporary',originId:'temporary-feeding'};
 return {provider,profile,requests,usages,options,metadata,setLimit:value=>limit=value};
}
test('production ModelRouter and API serialization use the captured model, effort, output setting and real usage',async t=>{
 const f=await fixture(t);f.options.memory.context=async()=>{assert.equal(f.metadata.getStore().connection.model,'frozen-model');assert.equal(f.metadata.getStore().frozenContextCapacity.tokens,20000);await f.provider.save({...f.profile,model:'new-model',reasoningEffort:'low',contextTokens:4096,models:[{id:'new-model',supportedReasoningEfforts:['low'],maxOutputTokens:65536}]});f.setLimit(65536);return {messages:[{role:'user',text:'permitted source'}],queryText:'source-preserving compressed request',text:'memory',capacity:{tokens:20000}};};
 const result=await runR95Model(f.options);assert.equal(result.manualEquivalentAffection,2.5);assert.equal(f.requests.length,1);const body=f.requests[0].body;assert.equal(body.model,'frozen-model');assert.equal(body.reasoning.effort,'xhigh');assert.equal(body.max_output_tokens,512);assert.equal(body.input.at(-1).content,'source-preserving compressed request');assert.equal(body.input[0].content,'permitted source');assert.equal(f.usages.length,1);assert.equal(f.usages[0].model,'frozen-model');assert.equal(f.usages[0].activityOriginId,'temporary-feeding');assert.deepEqual(f.usages[0].scope,f.options.scope);assert.equal(f.usages[0].usage.total,25);assert.equal(f.provider.state.profiles[0].model,'new-model','stored settings must remain the user current values, not be rolled back by the request');
});
test('auto survives real router serialization without a synthetic numeric output setting',async t=>{
 const f=await fixture(t,{outputLimit:'auto'});await runR95Model(f.options);assert.equal(f.requests.length,1);assert.equal(f.requests[0].body.max_output_tokens,undefined);assert.equal(f.provider.outputLimit(),'auto');
});
test('legacy runProfile execution refuses the changed dedicated profile before any HTTP request',async t=>{
 const f=await fixture(t);f.provider.runCaptured=undefined;f.options.memory.context=async()=>{await f.provider.save({...f.profile,reasoningEffort:'low'});return {messages:[],text:'memory'};};await assert.rejects(()=>runR95Model(f.options),error=>error.code==='R95_CONNECTION_CHANGED');assert.equal(f.requests.length,0);assert.equal(f.usages.length,0);
});
test('real router receives no request when memory returns an over-budget final envelope',async t=>{
 const f=await fixture(t);f.options.memory.context=async()=>({messages:[{role:'user',text:'\\"'.repeat(30000)}],text:'memory'});await assert.rejects(()=>runR95Model(f.options),error=>error.code==='MEMORY_CONTEXT_CAPACITY');assert.equal(f.requests.length,0);assert.equal(f.usages.length,0);
});
test('queued capacity compression retains the preserving origin instead of inheriting the prior ordinary lane',async t=>{
 const f=await fixture(t),captured=f.provider.captureConnection(f.options.card.modelBinding);let release,entered;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);t.after(()=>release());
 const prior=f.provider.withRequestContext({activityOriginId:'ordinary-chat',scope:f.options.scope},()=>f.provider.runCaptured(captured,async()=>{entered();await gate;}));await started;
 f.options.memory.context=async()=>{const metadata=f.metadata.getStore();await f.provider.runCaptured(metadata.connection,async()=>{for await(const chunk of f.provider.stream({system:'Compress supplied material only.',messages:[{role:'user',content:[{type:'text',text:'request source'}]}],maxTokens:512,purpose:'memory-query-compress-segment'})){};});return {queryText:'compressed source',messages:[],text:'memory'};};
 const current=runR95Model(f.options);await new Promise(resolve=>setImmediate(resolve));release();await Promise.all([prior,current]);assert.equal(f.requests.length,2);const compression=f.usages.find(value=>value.purpose==='memory-query-compress-segment');assert.equal(compression.activityOriginId,'temporary-feeding');assert.deepEqual(compression.scope,f.options.scope);assert.equal(f.usages.at(-1).activityOriginId,'temporary-feeding');
});
test('host current-scope guard prevents an old queued request from issuing any HTTP after revocation',async t=>{
 const f=await fixture(t),captured=f.provider.captureConnection(f.options.card.modelBinding);let release,entered,allowed=true;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);t.after(()=>release());const prior=f.provider.runCaptured(captured,async()=>{entered();await gate;});await started;f.options.checkCurrent=()=>{if(!allowed)throw Object.assign(Error('人生或origin已撤销'),{code:'MEMORY_STALE_LIFE'});};const current=runR95Model(f.options);const observed=assert.rejects(current,error=>error.code==='MEMORY_STALE_LIFE');await new Promise(resolve=>setImmediate(resolve));allowed=false;release();await Promise.all([prior,observed]);assert.equal(f.requests.length,0);assert.equal(f.usages.length,0);
});
test('plain host parser uses the same real HTTP frozen request and preserves real usage accounting',async t=>{
 const f=await fixture(t);f.options.parseOutput=({text,parts})=>({text,parts});const result=await runR95Model(f.options);assert.equal(result.text,'{"manualEquivalentAffection":2.5,"reason":"mock"}');assert.ok(result.parts.some(value=>value.type==='text-delta'));assert.equal(f.requests[0].body.model,'frozen-model');assert.equal(f.requests[0].body.reasoning.effort,'xhigh');assert.equal(f.requests[0].body.max_output_tokens,512);assert.equal(f.usages[0].usage.total,25);assert.equal(f.usages[0].activityOriginId,'temporary-feeding');
});
