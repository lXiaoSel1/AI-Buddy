import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {ModelRouter} from '../src/model-router.mjs';
import {connectionView} from '../src/connection-view.mjs';
import {CgService} from '../src/cg-service.mjs';
import {createCompanionService} from '../src/companion-service.mjs';
import {fakeCrypto,stubCodex} from './support/mock-model-server.mjs';
import {tmpDir,memoryStore,syntheticEngine,companionFixture,gate,sleep} from './support/audit-harness.mjs';

const immediate=()=>new Promise(r=>setImmediate(r));
async function router(t,fetchImpl=async()=>{throw Error('no network in tests');},options={}){
 const value=new ModelRouter({codex:stubCodex(),dataRoot:tmpDir('b03-router',{t}),crypto:fakeCrypto,fetchImpl,...options});await value.ready;t.after(()=>value.close());
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
 const service=await createCompanionService({store,engine,provider:r,dataRoot:tmpDir('b03-group',{t,beforeRemove:()=>service.close()}),now:Date.now});t.after(()=>service.close());
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
 hold.resolve();await background;t.mock.timers.reset();for(let n=0;n<200&&!fetchCalls;n++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.ok(fetchCalls>=1,'the queued turn was actually sent');assert.doesNotMatch(service.viewState().groupRuntime.error??'',/超时/);
});

test('a group message sent during a life save waits and is sent automatically, without unhandled rejections',async t=>{
 const unhandled=[],listener=error=>unhandled.push(String(error?.message??error));process.on('unhandledRejection',listener);t.after(()=>process.off('unhandledRejection',listener));
 const store=memoryStore(await companionFixture()),entered=gate(),release=gate();let hold=true,streamCalls=0;
 const {engine}=syntheticEngine({getStore:()=>store,hooks:{async call(action,args,{engineState}){if(action==='companion-life-content'&&hold){hold=false;entered.resolve();await release.promise;return {ok:true,content:structuredClone(engineState[args.characterId])};}}}});
 const provider={enabled:true,currentSelection:()=>({provider:'p1',model:'m'}),resolveConnection:()=>({mode:'global',connectionId:'p1',name:'p1',model:'m',error:null}),resolveContextCapacity:()=>({tokens:128000,source:'fixture',verified:true}),runTurn:async fn=>fn(),
  async *stream(){streamCalls++;yield {type:'text-delta',text:JSON.stringify({text:'大家好呀',emotion:'cheerful',interactionTarget:'group',affectionTarget:'none',affection:0})};yield {type:'finish',reason:{kind:'stop'}};}};
 const service=await createCompanionService({store,engine,provider,dataRoot:tmpDir('b05-group',{t,beforeRemove:()=>service.close()}),now:Date.now});t.after(()=>service.close());
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


test('main chat can omit background notifications while publishing foreground locks and saves',async t=>{
 const seen=[],order=[],hold=gate(),entered=gate(),cancelled=new AbortController();
 let r;
 const fixture=await router(t,undefined,{notifyBackgroundTurns:false,onChange:view=>{
  if(r)seen.push({busy:view.busy,locked:connectionView(r).profiles.filter(row=>row.locked).map(row=>row.id)});
 }});
 r=fixture.router;
 const {a,b}=fixture;
 const running=r.runCaptured(a,async()=>{entered.resolve();await hold.promise;order.push('running');return 'background-result';},undefined,{background:true});
 const tasks=[running];
 try{
  await entered.promise;
  assert.deepEqual(seen,[]);
  const cancelledTurn=r.runBackground(a,()=>assert.fail('cancelled background ran'),cancelled.signal);
  tasks.push(cancelledTurn);
  const wasCancelled=assert.rejects(cancelledTurn,{code:'ABORT_ERR'});
  await immediate();
  cancelled.abort();
  await wasCancelled;
  assert.deepEqual(seen,[]);

  const queued=r.runBackground(a,()=>{order.push('queued');throw Error('synthetic background error');});
  tasks.push(queued);
  const failed=assert.rejects(queued,/synthetic background error/);
  const chat=r.runTurn(()=>order.push('chat'));
  tasks.push(chat);
  await immediate();
  assert.deepEqual(seen,[{busy:true,locked:[a.id]}]);
  hold.resolve();
  assert.equal(await running,'background-result');
  await Promise.all([chat,failed]);
  assert.deepEqual(order,['running','chat','queued']);
  assert.deepEqual(seen,[{busy:true,locked:[a.id]},{busy:false,locked:[]}]);

  await r.activate(b.id);
  assert.equal(r.view().activeId,b.id);
  assert.deepEqual(seen.at(-1),{busy:false,locked:[]});
  assert.equal(seen.length,3,'an explicit connection change is still published');
 }finally{hold.resolve();await Promise.allSettled(tasks);}
});

test('default ModelRouter and CG still notify their own background turn transitions',async t=>{
 const changes=[];
 const {router:r,a}=await router(t,undefined,{onChange:view=>changes.push(view.busy)});
 changes.length=0;
 await r.runBackground(a,()=>undefined);
 assert.deepEqual(changes,[false,false]);

 let cg;
 const cgChanges=[];
 const dataRoot=tmpDir('b03-cg-notifications',{t,beforeRemove:()=>cg?.close()});
 cg=new CgService({dataRoot,crypto:fakeCrypto,codex:{...stubCodex(),close(){}},onChange:view=>cgChanges.push(view.busy)});
 await cg.ready;
 const profile=await cg.save({kind:'custom',model:'fixture',baseUrl:'http://127.0.0.1:3999'});
 await cg.activate(profile.id);
 cgChanges.length=0;
 await cg.runBackground(cg.captureConnection(),()=>undefined);
 assert.deepEqual(cgChanges,[true,false]);
});
