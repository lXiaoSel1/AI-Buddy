import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProactiveService} from '../src/companion-proactive.mjs';
import {createCompanionR95} from '../src/companion-r95.mjs';
import {createEconomyStore} from '../src/companion-economy-store.mjs';
import {createFeedingService} from '../src/companion-feeding.mjs';
import {cleanModelCatalog} from '../src/reasoning-settings.mjs';
import {nativeSearchCapability} from '../src/native-search.mjs';
import {ModelRouter} from '../src/model-router.mjs';
import {companionFixture,memoryStore} from './support/audit-harness.mjs';

const scope={characterId:'a',personaId:'p',lifeId:'life',operationId:'op',channel:'app-private',conversationId:'current'};
function proactive(t,{runtime={},generate}={}){
 const store=memoryStore({lives:{a:{id:'life',operationId:'op'}},personas:{p:{},other:{}}});let time=1000;
 const calls=[],lines=[];
 const service=createProactiveService({store,now:()=>time,getActiveContext:()=>scope,getRuntimeState:()=>runtime,
  getEvidence:async({eventIds})=>eventIds.map(eventId=>({eventId,kind:'work-report'})),
  generate:async request=>{calls.push(request);return generate?generate(request):{speak:true,mode:request.mode,text:'Eligible current content'};},
  emit:async value=>{lines.push(value);}});
 t.after(()=>service.close());
 const offer=(key,which=scope,kind='share',extra={})=>service.offer({scope:which,kind,eventIds:[key],sourceKey:key,...extra});
 return {store,service,calls,lines,offer,setTime:value=>{time=value;}};
}

for(const [name,blockedScope,kind,runtime] of [
 ['old conversation',{...scope,conversationId:'old'},'share',{}],
 ['other Persona',{...scope,personaId:'other'},'share',{}],
 ['disabled selftalk',scope,'selftalk',{}],
 ['external channel without permit',{...scope,channel:'qq-private'},'share',{}],
 ['sleeping work report',scope,'report',{sleepPhase:'asleep'}]
])test('C01 eligible candidate is not starved by '+name,async t=>{
 const f=proactive(t,{runtime});await f.service.setSettings({proactive:true});
 const first=await f.offer('blocked',blockedScope,kind),second=await f.offer('eligible');
 const result=await f.service.tick();assert.equal(result.delivered,true);assert.equal(result.candidateId,second.candidate.id);
 assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].scope,scope);assert.equal(f.lines.length,1);
 assert.equal(f.store.state.lives.a.r95.proactive.candidates[first.candidate.id].status,'pending','retain another scope or temporarily blocked candidate');
});

test('C01 stale head does not starve an AI-planned future reconsideration',async t=>{
 let generated=0;const f=proactive(t,{generate:request=>({speak:true,mode:request.mode,text:'Planned message',...(generated++===0?{nextConsiderAt:31000}:{})})});
 await f.service.setSettings({proactive:true});const first=await f.offer('initial');await f.service.tick();await f.service.presented({candidateId:first.candidate.id,messageId:'shown'});
 await f.offer('old',{...scope,conversationId:'old'});f.setTime(31000);
 const result=await f.service.tick();assert.equal(result.delivered,true);assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].eventIds,['initial']);
});

async function core(t){
 const store=memoryStore(await companionFixture()),root=mkdtempSync(join(tmpdir(),'r95-admission-')),calls=[];
 let runtime={sleepPhase:'awake',sleepIntentVersion:1,waitingForReply:false,presenting:false,canPresent:true,activityAllowed:false};
 const provider={enabled:true,captureConnection:()=>({id:'fixture',model:'fixture',kind:'custom',contextTokens:272000}),runCaptured:(_p,fn)=>fn(),resolveSearchCapability:()=>({supported:false}),
  async *stream(options){calls.push(options);yield {type:'text-delta',text:'{"speak":true,"mode":"awake","text":"A real queued line"}'};yield {type:'finish',reason:{kind:'stop'}};}};
 const service=await createCompanionR95({store,dataRoot:root,provider,now:()=>100000,getContext:()=>({characterId:store.state.activeCharacterId,personaId:store.state.activePersonaId,conversationId:store.state.activeConversationId}),getRuntimeState:()=>runtime,memory:{context:async()=>({text:''})},delta:()=>{},audit:()=>{}});
 t.after(async()=>{await service.close();await store.flush();rmSync(root,{recursive:true,force:true});});
 await service.action('social-settings',{proactive:true});
 return {service,calls,setRuntime:patch=>{runtime={...runtime,...patch};}};
}

test('C02 actual main runtime false flags cannot overwrite an unread panel presentation',async t=>{
 const f=await core(t),s=f.service;await s.userInteraction({eventId:'first',text:'one'});assert.equal((await s.proactive.tick()).delivered,true);
 const line=s.view().lines[0];assert.ok(line.messageId);await s.userInteraction({eventId:'second',text:'two'});
 assert.equal((await s.proactive.tick()).skipped,'presentation-barrier');assert.equal(f.calls.length,1);
 await s.action('speech-read',{messageId:line.messageId});assert.equal((await s.proactive.tick()).delivered,true);assert.equal(f.calls.length,2);
});

for(const kind of ['request','input','audio','awaiting-user'])test('C02 Core '+kind+' barrier survives explicitly idle runtime flags',async t=>{
 const f=await core(t),s=f.service,current=s.activeScope();f.setRuntime({typing:false,audioPlaying:false,awaitingUserAnswer:false});
 await s.userInteraction({eventId:'event',text:'message'});
 if(kind==='request')s.presentation.beginRequest(current,'held');
 if(kind==='input')s.presentation.beginInput(current,'held');
 if(kind==='audio'){s.presentation.beginPresentation(current,{id:'held',hasAudio:true});s.presentation.finishText(current,'held');}
 if(kind==='awaiting-user')s.presentation.setAwaitingUser(current,true);
 assert.equal((await s.proactive.tick()).skipped,'presentation-barrier');assert.equal(f.calls.length,0);
 if(kind==='request')s.presentation.endRequest(current,'held');
 if(kind==='input')s.presentation.endInput(current,'held');
 if(kind==='audio')s.presentation.finishAudio(current,'held');
 if(kind==='awaiting-user')s.presentation.setAwaitingUser(current,false);
 f.setRuntime({canPresent:false});assert.equal((await s.proactive.tick()).skipped,'presentation-barrier');assert.equal(f.calls.length,0);
 f.setRuntime({canPresent:true});assert.equal((await s.proactive.tick()).delivered,true);assert.equal(f.calls.length,1);
});

test('C03 active Persona retry survives an older pending Persona, restart and limit one',async t=>{
 const root=mkdtempSync(join(tmpdir(),'r95-persona-meals-')),current={characterId:'a',personaId:'current',lifeId:'life',operationId:'op'},other={...current,personaId:'old'};
 let store=createEconomyStore(root,{now:()=>10000}),service;
 t.after(async()=>{if(service)await service.close();else store.close();rmSync(root,{recursive:true,force:true});});
 store.initializeRewards({cursor:'new'});store.ingestUsageFact({canonicalRequestId:'funds',totalTokens:100000},{trusted:true});store.ensureScope(current);store.settleHunger(current,{elapsedMs:10*3600000});
 store.purchase({scope:current,foodId:'biscuit',requestId:'buy'});
 for(const [id,which] of [['old-meal',other],['current-meal',current]]){store.consume({scope:which,foodId:'biscuit',requestId:id});store.updateMeal(id,{attempts:1,retryAt:1000});}
 const before=store.view(current);store.close();store=createEconomyStore(root,{now:()=>10000});
 assert.deepEqual(store.pendingMeals(current).map(x=>x.id),['current-meal']);assert.deepEqual(store.pendingMeals(other,{limit:10}).map(x=>x.id),['old-meal']);
 assert.deepEqual(store.pendingMeals({...current,operationId:'stale'}),[]);
 const settled=[];service=createFeedingService({store,now:()=>10000,monotonicNow:()=>0,evaluateMeal:async()=>({manualEquivalentAffection:1}),settleAffection:async value=>{settled.push(value);}});service.activeScope(current);
 await service.tick();await service.tick();assert.deepEqual(settled.map(x=>x.mealId),['current-meal']);
 assert.deepEqual(store.wallet(),before.wallet);assert.deepEqual(store.view(current).inventory,before.inventory);assert.equal(store.getMeal('old-meal').attempts,1);assert.equal(store.getMeal('current-meal').affectionState,'settled');
});

const openai={kind:'openai',protocol:'responses',baseUrl:'https://api.openai.com/v1',model:'gpt-6.1-sol',reasoningEffort:null};
test('C04 catalog cleaning retains bounded boolean server web-search denial',()=>{
 for(const supported of [false,true]){
  const models=cleanModelCatalog([{id:openai.model,capabilities:{tools:true,server_tools:{web_search:{supported,untrusted:'must-drop'},shell:{supported:true}},untrusted:'must-drop'}}]);
  assert.deepEqual(models[0].capabilities,{tools:true,server_tools:{web_search:{supported}}});
  if(!supported)assert.equal(nativeSearchCapability({...openai,models}).status,'unsupported');
 }
 for(const supported of ['false',0,null,{}])assert.equal(cleanModelCatalog([{id:openai.model,capabilities:{server_tools:{web_search:{supported}}}}])[0].capabilities?.server_tools,undefined);
});

test('C04 catalog fetch/save/restart preserves denial and blocks required search before model submission',async t=>{
 const root=mkdtempSync(join(tmpdir(),'r95-search-catalog-')),routers=[];let models=0,submissions=0;
 const options={dataRoot:root,codex:{defaultModel:openai.model,enabled:false,setEnabled(){}},crypto:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},searchPolicy:()=>({allowed:true,required:true}),
  fetchImpl:async url=>{if(url.endsWith('/models')){models++;return new Response(JSON.stringify({data:[{id:openai.model,capabilities:{server_tools:{web_search:{supported:false}}}}]}),{headers:{'content-type':'application/json'}});}submissions++;throw Error('denied search must not submit');}};
 t.after(async()=>{for(const router of routers){router.close();await router.tail;}rmSync(root,{recursive:true,force:true});});
 let router=new ModelRouter(options);routers.push(router);await router.ready;
 const saved=await router.save({...openai,key:'fixture-not-real'});await router.activate(saved.id);await router.saveModels(saved.id,await router.fetchModels({...openai,key:'fixture-not-real'}));router.close();await router.tail;
 router=new ModelRouter(options);routers.push(router);await router.ready;router.setEnabled(true);
 assert.equal(router.resolveSearchCapability().status,'unsupported');
 await assert.rejects(async()=>{for await(const _ of router.stream({messages:[{role:'user',content:'search'}]})){}},{code:'NATIVE_SEARCH_UNAVAILABLE'});
 assert.equal(models,1);assert.equal(submissions,0);
});
