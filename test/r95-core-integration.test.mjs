import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createCompanionR95} from '../src/companion-r95.mjs';
import {openCompanionStore,restoreCompanionExport} from '../src/companion-store.mjs';
import {TokenMonitor} from '../src/token-monitor.mjs';
import {companionFixture,memoryStore} from './support/audit-harness.mjs';

async function setup(t,options={}){
 const dataRoot=mkdtempSync(join(tmpdir(),'r95-core-')),store=options.store??memoryStore(await companionFixture());
 const ctx=new AsyncLocalStorage(),calls=[];let runtime={sleepPhase:'awake',sleepIntentVersion:1,canPresent:true};
 const provider={enabled:true,resolveSearchCapability:()=>({supported:true}),captureConnection:()=>({id:'fixture',model:'fixture-model',kind:'custom',contextTokens:272000}),withRequestContext:(value,fn)=>ctx.run(value,fn),runCaptured:(_profile,fn)=>fn(),
  async *stream(options){calls.push({...options,context:ctx.getStore()});yield {type:'text-delta',text:options.purpose==='meal'?'{"manualEquivalentAffection":1.5}':'{"changed":false}'};yield {type:'finish',reason:{kind:'stop'}};}};
 const relationships=[];const service=await createCompanionR95({...options,store,dataRoot,provider,getContext:()=>({characterId:store.state.activeCharacterId,personaId:store.state.activePersonaId,conversationId:store.state.activeConversationId}),memory:{context:async()=>({text:''})},getRuntimeState:()=>runtime,delta:(...args)=>relationships.push(args),audit:options.audit??(()=>{})});
 t.after(async()=>{await service.close();await store.flush();rmSync(dataRoot,{recursive:true,force:true});});
 return {store,service,provider,calls,relationships,setRuntime:value=>runtime={...runtime,...value}};
}
test('refreshes the right open private conversation after a consumed portion has durable evidence',async t=>{
 const notices=[];const {service,store}=await setup(t,{onMealCommitted:scope=>notices.push({scope,evidence:Object.keys(store.state.lives[scope.characterId].r95.evidence)})});
 const scope=service.activeScope(),feeding=service.feeding,tx='meal-chat-low';
 feeding.lifeBridge.prepare({transactionId:tx,scope,target:{scope,satiety:20}});feeding.lifeBridge.apply({transactionId:tx});feeding.lifeBridge.finalize({transactionId:tx});feeding.activeScope(scope);
 feeding.ingestUsageFact({canonicalRequestId:'meal-chat-credit',revision:1,basis:'actual',origin:'native-ledger',usage:{total:30000}},{trusted:true});
 await feeding.action('buy',{foodId:'rice',requestId:'meal-chat-buy'});
 const result=await feeding.action('feed',{foodId:'rice',requestId:'meal-chat-feed'});
 assert.equal(result.consumed,true);assert.equal(notices.length,1);assert.equal(notices[0].scope.conversationId,store.state.activeConversationId);
 assert.ok(notices[0].evidence.includes('feeding:'+result.meal.id+':experience'));
 await feeding.action('feed',{foodId:'rice',requestId:'meal-chat-feed'});assert.equal(notices.length,1);
});
test('Core keeps attention independent from tokens and never delays a chat on mood generation',async t=>{
 const {store,service,calls}=await setup(t),scope=service.activeScope();
 await service.userInteraction({scope,eventId:'actual-user',kind:'chat',text:'你好'});
 assert.equal(calls.length,0);assert.equal(service.attention.view({scope}).lastAttentionAt>0,true);
 await service.evaluateInteraction({scope,eventIds:['actual-user']});assert.equal(calls.length,1);
 assert.equal(calls[0].context.scope.characterId,'claude');assert.ok(calls[0].activityOriginId);
 assert.equal(store.state.lives.claude.r95.moodEvaluations['actual-user'].status,'committed');
});
test('Core defaults missing native search to enabled and invalidates an in-flight grant by disabling',async t=>{
 const events=[],{service,store}=await setup(t,{audit:event=>events.push(event)}),scope=service.activeScope();
 assert.equal(service.view().search.enabled,true);
 await service.withOrigin(scope,'chat',async id=>{const policy=service.searchPolicy({activityOriginId:id});assert.equal(policy.allowed,true);policy.check();assert.equal(service.searchPolicy({activityOriginId:id,purpose:'mood'}),false);await service.action('search-settings',{enabled:false});assert.equal(service.view().search.enabled,false);assert.throws(policy.check,/失效/);await service.action('search-settings',{enabled:true});assert.equal(service.searchPolicy({activityOriginId:id}).allowed,true);await store.mutate(state=>{state.r95.searchEnabled='true';});assert.equal(service.view().search.enabled,false);assert.equal(service.searchPolicy({activityOriginId:id}),false);});
 assert.equal(service.searchPolicy({activityOriginId:'forged'}),false);
 assert.deepEqual(events.filter(event=>event.type==='r95-search-setting-invalid'),[{type:'r95-search-setting-invalid',reason:'invalid-setting-type'}]);
});
test('an explicit search disable survives conversation restore and disk reopening',async t=>{
 const path=mkdtempSync(join(tmpdir(),'r95-search-store-'));
 t.after(()=>rmSync(path,{recursive:true,force:true}));
 const store=await openCompanionStore(path),{schema,...fixture}=await companionFixture();
 await store.mutate(state=>Object.assign(state,fixture));
 const {service}=await setup(t,{store});
 assert.equal(service.view().search.enabled,true);
 await service.action('search-settings',{enabled:false});
 await store.mutate(state=>restoreCompanionExport(state,{format:'ai-buddy-conversations',version:1,conversations:[{...fixture.conversations.conversation,id:'restored'}],r95:{searchEnabled:true}}));
 assert.equal(service.view().search.enabled,false);
 await service.close();await store.flush();
 const reopened=await openCompanionStore(path),restored=await setup(t,{store:reopened});
 assert.ok(reopened.state.conversations.restored);
 assert.equal(restored.service.view().search.enabled,false);
});
test('Core wallet receives only private canonical facts, shared across Persona and isolated from life facets',async t=>{
 const {service,store}=await setup(t);
 assert.throws(()=>service.feeding.ingestUsageFact({canonicalRequestId:'fake',totalTokens:100000,revision:1}));
 service.feeding.ingestUsageFact({canonicalRequestId:'api:r',totalTokens:20000,revision:1,live:true,baseline:false},{trusted:true});
 const first=service.feeding.view().wallet;service.feeding.ingestUsageFact({canonicalRequestId:'api:r',totalTokens:20000,revision:1,live:true,baseline:false},{trusted:true});
 assert.deepEqual(service.feeding.view().wallet,first);
 const facet=service.coreStateBridge.snapshot(service.activeScope());assert.equal(facet.feeding.format,'ai-buddy-feeding-state');assert.equal('wallet' in facet,false);assert.equal('inventory' in facet,false);
 await assert.rejects(service.action('usage-fact',{totalTokens:100000}),/未知/);
 await store.mutate(state=>{state.lives.claude.operationId='new-op';});
 assert.equal(service.origins.resolve('fake'),null);
});
test('Core rejects a stale input after character switch and keeps dream usage separate from real work',async t=>{
 const {service,store,setRuntime}=await setup(t),old=service.activeScope();
 await store.mutate(state=>{state.activeCharacterId='gpt';});
 await assert.rejects(service.action('input',{active:true,scope:old}),/范围/);
 setRuntime({sleepPhase:'asleep'});const scope=service.activeScope();
 const id=service.origins.issue({scope,kind:'dream',sleepIntentGeneration:1});
 service.origins.recordUsage({originId:id,requestKey:'dream:1',totalTokens:100,live:true});
 service.origins.recordUsage({requestKey:'work:1',totalTokens:200,live:true});
 assert.equal(service.origins.summary().sleepPreservingTokens,100);assert.equal(service.origins.summary().wakeTokens,200);
});
test('actual monitor startup/import establishes a baseline; subsequent canonical requests deliver durable reward facts',async t=>{
 const dataRoot=mkdtempSync(join(tmpdir(),'r95-monitor-'));let monitor;
 t.after(async()=>{await monitor?.close();rmSync(dataRoot,{recursive:true,force:true});});
 const file=join(dataRoot,'api-usage.jsonl'),row=(id,n)=>({provider:'deepseek',model:'deepseek-chat',requestId:id,timestamp:new Date().toISOString(),usage:{input:n,output:0,total:n},purpose:'galgame'});
 writeFileSync(file,JSON.stringify(row('historical',9999))+'\n');
 monitor=new TokenMonitor({dataRoot,roots:[{provider:'companion',path:file}],home:dataRoot,env:{},refreshIntervalMs:1000});await monitor.prices.ready;monitor.prices.state.autoUpdate=false;await monitor.start();
 monitor.syncAnalytics();const initial=monitor.analytics.rewardOutbox.pending();assert.ok(initial.some(f=>f.totalTokens===9999&&f.baseline));monitor.analytics.rewardOutbox.ack(initial.map(f=>f.seq));
 appendFileSync(file,JSON.stringify({...row('new',10000),activityOriginId:'private-origin'})+'\n');await monitor.scan(true);monitor.syncAnalytics();const facts=monitor.analytics.rewardOutbox.pending();
 const live=facts.find(f=>f.totalTokens===10000);assert.ok(live);assert.equal(live.baseline,false);assert.equal(live.live,true);assert.equal(live.activityOriginId,'private-origin');
 await monitor.close();monitor=null;
 monitor=new TokenMonitor({dataRoot,roots:[{provider:'companion',path:file}],home:dataRoot,env:{},refreshIntervalMs:1000});await monitor.prices.ready;monitor.prices.state.autoUpdate=false;await monitor.start();monitor.syncAnalytics();
 assert.equal(monitor.analytics.rewardOutbox.pending().filter(f=>f.canonicalRequestId===live.canonicalRequestId).length,1);
});



 test('Core quiescence refuses a fresh model origin and feeding action while retaining read-only life facets',async t=>{const {store,service,calls}=await setup(t),scope=service.activeScope();await store.mutate(state=>{state.lifeTransaction={characterId:scope.characterId,id:'in-progress-reset'};});let entered=false;await assert.rejects(service.withOrigin(scope,'chat',async()=>{entered=true;}),/失效/);assert.equal(entered,false);assert.equal(calls.length,0);await assert.rejects(service.action('feeding-feed',{foodId:'rice',requestId:'blocked-during-reset'}),/人生事务/);assert.equal(service.coreStateBridge.snapshot(scope).lifeId,scope.lifeId);});
