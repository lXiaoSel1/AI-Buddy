import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {ModelRouter} from '../src/model-router.mjs';
import {createCompanionService} from '../src/companion-service.mjs';
import {fakeCrypto,stubCodex} from './support/mock-model-server.mjs';
import {tmpDir,memoryStore,syntheticEngine,companionFixture,gate,sleep} from './support/audit-harness.mjs';

const immediate=()=>new Promise(r=>setImmediate(r));
async function router(t,fetchImpl=async()=>{throw Error('no network in tests');}){
 const value=new ModelRouter({codex:stubCodex(),dataRoot:tmpDir('b03-router',{t}),crypto:fakeCrypto,fetchImpl});await value.ready;t.after(()=>value.close());
 const add=async name=>{const saved=await value.save({kind:'custom',name,protocol:'chat-completions',baseUrl:'https://fixture.invalid/v1',model:'fixture-model',key:'fake-key',contextTokens:128000});return value.state.profiles.find(p=>p.id===saved.id);};
 const a=await add('A'),b=await add('B');await value.activate(a.id);value.setEnabled(true);return {router:value,a,b};
}

test('a background job on one connection does not delay chat on another connection',async t=>{
 const {router:r,a,b}=await router(t),hold=gate();
 const background=r.runBackground(a,async()=>{await hold.promise;return 'theme';});await sleep(20);
 const requested=performance.now();let started=null;
 await r.runProfile(b.id,async()=>{started=performance.now();});
 assert.ok(started-requested<200,`chat on B started after ${started-requested} ms`);
 hold.resolve();assert.equal(await background,'theme');
});

test('on the same connection chat runs before queued background work',async t=>{
 const {router:r,a}=await router(t),hold=gate(),order=[];
 const running=r.runBackground(a,async()=>{await hold.promise;order.push('running');});await sleep(10);
 const queued=[1,2].map(n=>r.runTurn(async()=>{order.push('memory'+n);},undefined,{background:true}));
 const chat=r.runTurn(async()=>{order.push('chat');});
 hold.resolve();await Promise.all([running,...queued,chat]);
 assert.deepEqual(order,['running','chat','memory1','memory2']);
});

test('the group 110 s limit starts with the model turn, not while it is queued',async t=>{
 let fetchCalls=0;const {router:r,a}=await router(t,async()=>{fetchCalls++;throw Error('no network');});
 const store=memoryStore(await companionFixture()),{engine}=syntheticEngine({getStore:()=>store});
 const service=await createCompanionService({store,engine,provider:r,dataRoot:tmpDir('b03-group',{t}),now:Date.now});t.after(()=>service.close());
 const group=(await service.action('companion-group-save',{name:'测试群',memberIds:['claude','gpt'],mode:'list'})).companion.groups[0];
 await service.action('companion-group-select',{id:group.id,entryCharacterId:'claude'});
 t.mock.timers.enable({apis:['setTimeout']});
 const hold=gate();const background=r.runBackground(a,async()=>{await hold.promise;});
 for(let n=0;n<5;n++)await immediate();
 await service.action('companion-group-send',{id:group.id,text:'大家好',forceCharacterId:'claude'});
 for(let n=0;n<20;n++)await immediate();
 assert.equal(service.viewState().groupRuntime.status,'waiting-model');
 t.mock.timers.tick(110_000);for(let n=0;n<5;n++)await immediate();
 assert.equal(service.viewState().groupRuntime.status,'waiting-model','time spent queued does not count');
 hold.resolve();await background;for(let n=0;n<80;n++)await immediate();
 assert.ok(fetchCalls>=1,'the queued turn was actually sent');assert.doesNotMatch(service.viewState().groupRuntime.error??'',/超时/);
});

test('a group message sent during a life save waits and is sent automatically, without unhandled rejections',async t=>{
 const unhandled=[],listener=error=>unhandled.push(String(error?.message??error));process.on('unhandledRejection',listener);t.after(()=>process.off('unhandledRejection',listener));
 const store=memoryStore(await companionFixture()),entered=gate(),release=gate();let hold=true,streamCalls=0;
 const {engine}=syntheticEngine({getStore:()=>store,hooks:{async call(action,args,{engineState}){if(action==='companion-life-content'&&hold){hold=false;entered.resolve();await release.promise;return {ok:true,content:structuredClone(engineState[args.characterId])};}}}});
 const provider={enabled:true,currentSelection:()=>({provider:'p1',model:'m'}),resolveConnection:()=>({mode:'global',connectionId:'p1',name:'p1',model:'m',error:null}),resolveContextCapacity:()=>({tokens:128000,source:'fixture',verified:true}),runTurn:async fn=>fn(),
  async *stream(){streamCalls++;yield {type:'text-delta',text:JSON.stringify({text:'大家好呀',emotion:'cheerful',interactionTarget:'group',affectionTarget:'none',affection:0})};yield {type:'finish',reason:{kind:'stop'}};}};
 const service=await createCompanionService({store,engine,provider,dataRoot:tmpDir('b05-group',{t}),now:Date.now});t.after(()=>service.close());
 const group=(await service.action('companion-group-save',{name:'测试群',memberIds:['claude','gpt'],mode:'list'})).companion.groups[0];
 await service.action('companion-group-select',{id:group.id,entryCharacterId:'claude'});
 const save=service.action('companion-life-save',{characterId:'claude'});await entered.promise;
 await service.action('companion-group-send',{id:group.id,text:'大家好',forceCharacterId:'claude'});await sleep(50);
 const waiting=service.viewState().groupRuntime;
 assert.equal(waiting.status,'waiting-life-save');assert.ok(waiting.waitDeadline>Date.now());assert.equal(streamCalls,0);
 release.resolve();await save;
 for(let n=0;n<40&&streamCalls===0;n++)await sleep(50);
 await sleep(100);
 assert.equal(streamCalls,1,'sent once the save finished');
 assert.equal(service.viewState().groupRuntime.status,'awaiting-presentation');
 assert.deepEqual(unhandled,[]);
});
