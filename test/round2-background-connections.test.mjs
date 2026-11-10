import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ModelRouter} from '../src/model-router.mjs';
import {createCompanionR95} from '../src/companion-r95.mjs';
import {createGalgame} from '../src/galgame-host.mjs';
import {companionFixture,memoryStore,gate} from './support/audit-harness.mjs';
import {fakeCrypto,stubCodex} from './support/mock-model-server.mjs';

const root=process.env.ROUND2_MODEL_OUTPUT??join(tmpdir(),'round2-mood-source');
const immediate=()=>new Promise(resolve=>setImmediate(resolve));
async function setup(t,{respond=()=>null}={}){
 mkdirSync(root,{recursive:true});const dataRoot=mkdtempSync(join(root,'connection-fixture-')),requests=[],entered=gate();
 const router=new ModelRouter({dataRoot,crypto:fakeCrypto,codex:stubCodex(),fetchImpl:async(url,options)=>{
  const row={url:String(url),body:JSON.parse(options.body),signal:options.signal};requests.push(row);entered.resolve(row);
  const text=respond(row);if(text!==null)return new Response(JSON.stringify({choices:[{message:{content:text},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});
  return new Promise((resolve,reject)=>{row.release=()=>resolve(new Response(JSON.stringify({choices:[{message:{content:'{"changed":false}'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}}));const abort=()=>reject(options.signal.reason??Object.assign(Error('cancelled'),{name:'AbortError'}));if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});});
 }});
 await router.ready;const add=async name=>router.save({kind:'custom',name,protocol:'chat-completions',baseUrl:'http://127.0.0.1:3999/v1',model:name,contextTokens:128000});
 const a=await add('A'),b=await add('B');await router.activate(a.id);router.setEnabled(true);t.after(()=>{router.close();for(const row of requests)row.release?.();});
 return {router,a,b,requests,entered,dataRoot};
}

test('switching the selected connection cancels its in-flight background mood and retains pending events',async t=>{
 const f=await setup(t),store=memoryStore(await companionFixture()),core=await createCompanionR95({store,dataRoot:f.dataRoot,provider:f.router,getContext:()=>({characterId:store.state.activeCharacterId,personaId:store.state.activePersonaId,conversationId:store.state.activeConversationId}),getRuntimeState:()=>({sleepPhase:'awake',canPresent:true}),memory:{context:async()=>({text:''})},delta:()=>{},audit:()=>{}});
 t.after(()=>core.close());await core.userInteraction({eventId:'chat-1',kind:'chat',text:'synthetic'});await core.tick();const request=await f.entered.promise;
 await f.router.activate(f.b.id);
 assert.equal(f.router.view().activeId,f.b.id);assert.equal(request.signal.aborted,true,'old background HTTP request was cancelled');assert.equal(request.body.model,'A','the old request kept its captured model');
 for(let n=0;n<100&&core.busy();n++)await immediate();assert.equal(core.busy(),false);assert.deepEqual(store.state.lives.claude.r95.pendingMoodEventIds,['chat-1']);assert.equal(store.state.lives.claude.r95.moodFailure,undefined,'a deliberate switch is cancellation, not model failure');
});

test('switching with real deferred reply choices cancels them and preserves the committed chat',async t=>{
 const f=await setup(t,{respond:row=>{const system=row.body.messages.find(message=>message.role==='system')?.content??'';return /选项生成器/.test(system)?null:/评估你自己当前持续心情/.test(system)?'{"changed":false}':/情绪分类器/.test(system)?'normal':'Synthetic committed reply';}});
 const outputs=[],game=await createGalgame({dataRoot:f.dataRoot,provider:f.router,model:'A',onOutput:event=>outputs.push(event)});t.after(()=>game.close());
 await game.action('chat',{text:'synthetic chat'});for(let n=0;n<200&&!f.requests.some(row=>row.release);n++)await immediate();
 const choices=f.requests.find(row=>row.release);assert.ok(choices,'actual scheduleChoices reached the HTTP boundary');assert.equal(f.router.view().busy,false,'background choices leave both connection selectors unlocked');
 await f.router.activate(f.b.id);assert.equal(choices.signal.aborted,true);
 for(let n=0;n<20;n++)await immediate();const state=(await game.action('companion-state')).companion;
 assert.equal(outputs.some(event=>event.type==='choices.failed'),false,'a deliberate switch must not report a model failure');assert.equal(state.messages.at(-1).text,'Synthetic committed reply');
});

test('a foreground request keeps the connection guard and is not cancelled by a rejected switch',async t=>{
 const f=await setup(t),task=f.router.runTurn(async()=>{for await(const _part of f.router.stream({messages:[{role:'user',content:'synthetic'}],purpose:'galgame'})){} });task.catch(()=>{});const request=await f.entered.promise;
 assert.equal(f.router.view().busy,true);await assert.rejects(f.router.activate(f.b.id),/请等待当前对话完成/);assert.equal(request.signal.aborted,false);assert.equal(f.router.view().activeId,f.a.id);request.release();await task;
});

test('switching cancels queued and running background work only on the old connection',async t=>{
 const f=await setup(t),run=profile=>f.router.runCaptured(profile,async()=>{for await(const _part of f.router.stream({messages:[{role:'user',content:'synthetic'}],purpose:'choices'})){} },undefined,{background:true});
 const old=run(f.a),other=run(f.b),queued=run(f.a);old.catch(()=>{});queued.catch(()=>{});other.catch(()=>{});
 for(let n=0;n<100&&f.requests.length<2;n++)await immediate();assert.equal(f.requests.length,2);const oldRequest=f.requests.find(row=>row.body.model==='A'),otherRequest=f.requests.find(row=>row.body.model==='B');
 assert.equal(f.router.view().busy,false);await f.router.activate(f.b.id);assert.equal(oldRequest.signal.aborted,true);assert.equal(otherRequest.signal.aborted,false,'other captured connection remains alive');
 await assert.rejects(old,{code:'ABORT_ERR'});await assert.rejects(queued,{code:'ABORT_ERR'});otherRequest.release();await other;assert.equal(f.requests.length,2,'cancelled queued work never submitted');
});
