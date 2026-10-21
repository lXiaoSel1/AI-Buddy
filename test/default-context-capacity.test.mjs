import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEFAULT_CONTEXT_TOKENS,defaultContextCapacity} from '../src/context-capacity.mjs';
import {ModelRouter} from '../src/model-router.mjs';
import {createCompanionMemory,dailyMemoryOutputReserve,memoryRequestTokens} from '../src/companion-memory.mjs';
import {createGalgame} from '../src/galgame-host.mjs';
import {openCompanionStore} from '../src/companion-store.mjs';
import {fakeCrypto,stubCodex} from './support/mock-model-server.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function routerFixture(t){
 const dataRoot=await mkdtemp(join(tmpdir(),'buddy-capacity-router-')),router=new ModelRouter({dataRoot,codex:stubCodex(),crypto:fakeCrypto});
 await router.ready;t.after(()=>router.close());return router;
}
const draft={kind:'codex',name:'Local fixture',model:'fixture'};
function assertDefault(actual){assert.equal(actual.tokens,272000);assert.equal(actual.source,'application-default');assert.equal(actual.verified,false);}

test('272000 application defaults are fresh objects and are not labeled as verified model limits',()=>{
 assert.equal(DEFAULT_CONTEXT_TOKENS,272000);const first=defaultContextCapacity();assertDefault(first);first.tokens=1;assertDefault(defaultContextCapacity());
 assert.equal(dailyMemoryOutputReserve(defaultContextCapacity()),8192,'larger input capacity must not increase the existing daily output ceiling');
});

test('Router uses 272000 only when unknown; explicit smaller catalog capacities and manual settings take precedence',async t=>{
 const router=await routerFixture(t);assertDefault(router.resolveContextCapacity());
 let profile=await router.save(draft);await router.activate(profile.id);assertDefault(router.resolveContextCapacity());
 for(const declared of [8192,32768,1000000]){
  // Model discovery is out of scope here. Exercise declarations already present
  // in the selected catalog, without pretending every upstream returns them.
  router.state.profiles[0].models=[{id:'fixture',contextWindow:declared}];
  assert.deepEqual(router.resolveContextCapacity(),{tokens:declared,source:'model-catalog',verified:true});
 }
 profile=await router.save({...profile,contextTokens:8192});assert.deepEqual(router.resolveContextCapacity(),{tokens:8192,source:'connection-setting',verified:false});
 profile=await router.save({...profile,contextTokens:''});assertDefault(router.resolveContextCapacity());
 profile=await router.save({...profile,contextTokens:32768});assert.equal(router.resolveContextCapacity().tokens,32768);
 await router.save({...profile,model:'another-model',contextTokens:null});assertDefault(router.resolveContextCapacity());
});

test('Dedicated character capacity remains separate from the global default and clearing a setting restores the default',async t=>{
 const router=await routerFixture(t),global=await router.save(draft),dedicated=await router.save({...draft,name:'Smaller model',model:'small',contextTokens:8192});
 await router.activate(global.id);assertDefault(router.resolveContextCapacity());assert.equal(router.resolveContextCapacity({enabled:true,connectionId:dedicated.id}).tokens,8192);
 await router.save({...dedicated,contextTokens:null});assertDefault(router.resolveContextCapacity({enabled:true,connectionId:dedicated.id}));assertDefault(router.resolveContextCapacity());
});

function memoryFixture(){
 let value={cards:{a:{id:'a',name:'A',revision:1,fields:{}}},personas:{p:{id:'p'}},conversations:{},groups:{},lives:{a:{id:'life-a',operationId:'op-a',mode:'normal',memory:{},personalEvents:[],groupIntervals:{}}},memorySettings:{timeZone:'UTC'}};
 let tail=Promise.resolve();return {get state(){return value;},snapshot:()=>structuredClone(value),mutate(fn){const task=tail.then(async()=>{const next=structuredClone(value),result=await fn(next);value=next;return result;});tail=task.catch(()=>{});return task;}};
}
test('Standalone memory defaults and invalid provider capacities all use the same explicit application default',async()=>{
 for(const supplied of ['omitted',null,undefined,{tokens:NaN},{tokens:0},{tokens:511},{tokens:'8192'}]){
  const memory=createCompanionMemory({store:memoryFixture(),autoStart:false,runModel:async()=>{throw Error('no model calls expected');},...(supplied==='omitted'?{}:{getCapacity:()=>supplied})});
  try{const view=await memory.view({characterId:'a',personaId:'p'});assertDefault(view.capacity);assert.equal(view.capacity.estimator,'utf8-byte-upper-bound');}finally{await memory.close();}
 }
});

test('Actual private/group/day-end paths share the 272000 default, bounded output and source-verified originals',async t=>{
 const dataRoot=await mkdtemp(join(tmpdir(),'buddy-capacity-host-')),calls=[];
 const provider={enabled:true,currentSelection:()=>({provider:'local-fixture',model:'local-model'}),listProviders:()=>[{id:'local-fixture'}],listModels:()=>[{id:'local-model'}],runTurn:async fn=>fn(),async *stream(options){
  calls.push(options);let output;
  if(options.purpose==='memory-daily'){
   const input=JSON.parse(options.messages[0].content[0].text);assert.equal(options.maxTokens,8192);assert(memoryRequestTokens(options.system,input,options.maxTokens)<=272000);
   output=JSON.stringify({coverageHash:input.coverageHash,summary:{text:'原文完整，来源已经核验。',eventIds:input.todayEventIds},guide:{text:'',eventIds:[]},core:[],branches:[],growthCandidates:[]});
  }else if(options.purpose==='group-chat')output=JSON.stringify({text:'同伴，我听到了。',emotion:'serious',affection:0});
  else if(/选项生成器/.test(options.system))output=JSON.stringify({positive:'继续',neutral:'想想',negative:'休息'});
  else output='本地测试回复[[emotion:serious]]';
  yield {type:'text-delta',text:output};yield {type:'finish',reason:{kind:'stop'}};
 }};
 let game=await createGalgame({dataRoot,provider,model:'local-model'});t.after(()=>game.close());
 const state=async()=>(await game.action('companion-state')).companion;
 await game.action('chat',{text:'本次私聊原文必须完整保存。'});let snapshot=await state();assertDefault(snapshot.messages.at(-1).request.capacity);
 await game.action('companion-private-present',{id:snapshot.messages.at(-1).id,conversationId:snapshot.activeConversationId});
 const group=(await game.action('companion-group-save',{name:'本地容量测试',memberIds:['deepseek','claude'],mode:'list'})).group;
 await game.action('companion-group-select',{id:group.id});await game.action('companion-group-send',{text:'群聊原文也必须完整。',forceCharacterId:'deepseek'});
 for(let n=0;n<300;n++){snapshot=await state();if(snapshot.groupRuntime.pendingMessage)break;assert.notEqual(snapshot.groupRuntime.status,'failed',snapshot.groupRuntime.error);await delay(5);}
 const pending=snapshot.groupRuntime.pendingMessage;assert(pending);assertDefault(pending.request.capacity);await game.action('companion-group-present',{requestId:pending.id});
 game.close();await delay(20);
 const disk=await openCompanionStore(dataRoot),day=new Date(Date.now()-86400000).toISOString().slice(0,10);let original;
 await disk.mutate(s=>{s.memorySettings.timeZone='UTC';const conversation=Object.values(s.conversations).find(row=>row.characterId==='deepseek'&&row.personaId==='default');original={id:'daily-capacity-source',role:'user',text:'昨日的完整原文与出处。',createdAt:Date.parse(day+'T12:00:00Z'),lifeId:conversation.lifeId,status:'sent'};conversation.messages.push(original);});await disk.flush();
 game=await createGalgame({dataRoot,provider,model:'local-model'});
 const result=await game.action('companion-memory-retry',{characterId:'deepseek',personaId:'default',day});assert.equal(result.memoryResult.status,'committed',result.memoryResult.error);
 const summary=result.memoryResult.summary;assertDefault(result.memory.capacity);assert.equal(summary.budget.capacity,272000);assert.equal(summary.budget.capacitySource,'application-default');assert.equal(summary.budget.capacityVerified,false);assert.equal(summary.budget.outputReserveTokens,8192);
 assert.equal(summary.cutoff.length,1);assert.match(summary.cutoff[0].hash,/^[a-f0-9]{64}$/);assert.equal(summary.eventIds.length,1);assert.equal(calls.filter(row=>row.purpose==='memory-daily').length,1);
 const stored=(await state()).messages.find(row=>row.id===original.id);assert.deepEqual(stored,original);
});
