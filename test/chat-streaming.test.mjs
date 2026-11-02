import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createGalgame} from '../src/galgame-host.mjs';
import {ModelRouter} from '../src/model-router.mjs';
import {fakeCrypto,stubCodex} from './support/mock-model-server.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const until=async fn=>{for(let i=0;i<300;i++){if(await fn())return;await pause(5);}throw Error('timed out');};
const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),release:()=>resolve()};};
function fixture(t,stream){const beforeRemove=[];const root=mkdtempSync(join(tmpdir(),'buddy-streamchat-'));let current;const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'m'}),listModels:()=>[{id:'m'}],listProviders:()=>[{id:'fixture'}],runTurn:fn=>fn(),async *stream(options){yield*stream(options,current);}};t.after(async()=>{for(const close of beforeRemove)await close();rmSync(root,{recursive:true,force:true});});return {root,provider,setGame:g=>current=g,beforeRemove:fn=>beforeRemove.push(fn)};}
test('private visible chunks precede completion and committed body never waits for suggestions',async t=>{
 const body=gate(),choices=gate(),events=[];let choicesStarted=false;
 const f=fixture(t,async function*(options){if(options.purpose==='choices'){choicesStarted=true;await choices.promise;yield {type:'text-delta',text:'{"positive":"好呀","neutral":"继续","negative":"等等"}'};}else{yield {type:'text-delta',text:'第一段正文'};await body.promise;yield {type:'text-delta',text:'，完整结尾 [[emotion:cheerful]]'};}yield {type:'finish',reason:{kind:'stop'}};});
 const game=await createGalgame({dataRoot:f.root,provider:f.provider,model:'m',onOutput:event=>events.push(event)});f.beforeRemove(async()=>{choices.release();body.release();await game.close();});
 let done=false;const pending=game.action('chat',{text:'你好'}).then(v=>{done=true;return v;});
 await until(()=>events.some(e=>e.type==='text.delta'));assert.equal(done,false);assert.equal(events.filter(e=>e.type==='text.delta').map(e=>e.payload.text).join(''),'第一段正文');body.release();
 const result=await pending;assert.match(result.history.at(-1).text,/完整结尾/);assert.doesNotMatch(result.history.at(-1).text,/emotion/);assert.equal(result.companion.busy,false,'body commit releases the foreground before suggestions');assert.equal((await game.action('view')).companion.busy,false);await until(()=>choicesStarted);assert.deepEqual((await game.action('view')).choices,[]);
 choices.release();await until(async()=>((await game.action('view')).choices??[]).length===3);
});
test('failed partial private output is retained separately and cannot award or become successful history',async t=>{
 const events=[],f=fixture(t,async function*(options){yield {type:'text-delta',text:'已经看见的正文'};throw Error('模型连接中断，请重试');});
 const game=await createGalgame({dataRoot:f.root,provider:f.provider,model:'m',onOutput:e=>events.push(e)});f.beforeRemove(()=>game.close());
 await assert.rejects(game.action('chat',{text:'测试断线'}),/中断/);const view=await game.action('view');assert.ok(!view.history.some(m=>m.text==='已经看见的正文'));assert.equal(view.companion.interruptedReply.text,'已经看见的正文');assert.equal(view.companion.interruptedReply.status,'incomplete');assert.ok(events.some(e=>e.type==='text.delta'));
});
test('live API truncation preserves its delivered prefix and does not submit a replacement',async t=>{
 let calls=0;const root=mkdtempSync(join(tmpdir(),'buddy-live-limit-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const router=new ModelRouter({codex:stubCodex(),dataRoot:root,crypto:fakeCrypto,fetchImpl:async()=>{calls++;return new Response('data: {"choices":[{"delta":{"content":"可见前缀"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}});await router.ready;t.after(()=>router.close());const p=await router.save({kind:'custom',name:'test',protocol:'chat-completions',baseUrl:'https://fixture.invalid/v1',model:'m',key:'k'});await router.activate(p.id);router.setEnabled(true);const seen=[];await assert.rejects(async()=>{for await(const v of router.stream({messages:[],incremental:true}))seen.push(v);},e=>e.code==='MODEL_OUTPUT_TRUNCATED'&&e.partial);assert.equal(calls,1);assert.equal(seen[0].text,'可见前缀');
});

test('unpresented group output is journalled and restart interrupts it without replay or reward',async t=>{
 let calls=0;const f=fixture(t,async function*(){calls++;yield {type:'text-delta',text:'{"text":"群聊的未结算正文","emotion":"cheerful","affection":1}'};yield {type:'finish',reason:{kind:'stop'}};});
 let game=await createGalgame({dataRoot:f.root,provider:f.provider,model:'m'});f.beforeRemove(()=>game.close());
 const saved=await game.action('companion-group-save',{name:'journal',memberIds:['deepseek'],mode:'list'}),group=saved.group;await game.action('companion-group-select',{id:group.id});await game.action('companion-group-send',{text:'启动本轮'});await until(async()=>(await game.action('view')).companion.groupRuntime.status==='awaiting-presentation');
 const before=(await game.action('view')).companion;assert.equal(before.groupMessages.length,1);assert.equal(before.groupRuntime.pendingMessage.text,'群聊的未结算正文');await game.close();
 game=await createGalgame({dataRoot:f.root,provider:f.provider,model:'m'});const after=(await game.action('view')).companion;assert.equal(calls,1);assert.equal(after.groupMessages.length,1);assert.equal(after.groupRuntime.pendingMessage,null);assert.equal(after.groupRuntime.interruptedReply.status,'interrupted');assert.equal(after.groupRuntime.interruptedReply.visibleText,'群聊的未结算正文');
});

test('a second private submission is rejected even while the first journal is opening',async t=>{
 const finish=gate(),f=fixture(t,async function*(options){if(options.purpose!=='choices')await finish.promise;yield {type:'text-delta',text:options.purpose==='choices'?'{"positive":"好","neutral":"嗯","negative":"等等"}':'唯一的一条正文'};yield {type:'finish',reason:{kind:'stop'}};});const game=await createGalgame({dataRoot:f.root,provider:f.provider,model:'m'});f.beforeRemove(async()=>{finish.release();await game.close();});const first=game.action('chat',{text:'第一条'});await assert.rejects(game.action('chat',{text:'连点第二条'}),/等待当前会话/);finish.release();await first;const messages=(await game.action('view')).companion.messages;assert.equal(messages.filter(m=>m.role==='user').length,1);
});
