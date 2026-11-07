import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpeechRuntime} from '../src/voice/speech-runtime.mjs';

function deviceRuntime(name, devices, {stopError} = {}) {
  return {
    async *speak() {
      assert.equal(devices.size, 0, 'the previous TTS device must retire before provider entry');
      devices.add(name);
      yield {type:'pcm', pcm:Buffer.from([1,0]), sampleRate:name === 'local' ? 48000 : 32000};
      yield {type:'done', metrics:{provider:name}};
    },
    async stopEngine() { devices.delete(name); if (stopError) throw stopError; },
    async close() { devices.delete(name); },
    async startCapture(request) { return {local:true, ...request}; },
    async feedCapture(request) { return request; },
    async finishCapture() { return {text:'本地识别'}; },
    async cancelCapture() { return {cancelled:true}; },
  };
}

test('either plugin can use cloud TTS while capture stays local and transitions release the old TTS', async () => {
  const devices = new Set();
  const runtime = createSpeechRuntime({local:deviceRuntime('local',devices), cloud:deviceRuntime('minimax',devices)});
  for (const engine of ['breeze','gpt']) {
    const local = await Array.fromAsync(runtime.speak({engine,text:'你好'}));
    assert.equal(local[0].sampleRate,48000);
    const cloud = await Array.fromAsync(runtime.speak({engine,text:'你好',speechProvider:'minimax'}));
    assert.equal(cloud[0].sampleRate,32000);
    await runtime.stopEngine();
  }
  assert.deepEqual(await runtime.startCapture({engineId:'gpt'}),{local:true,engineId:'gpt'});
  assert.deepEqual(await runtime.finishCapture(),{text:'本地识别'});
  await runtime.close();
  assert.equal(devices.size,0);
});

test('unbound cloud stays unavailable and stopping one failed provider still retires the other', async () => {
  const devices=new Set();
  const local=deviceRuntime('local',devices,{stopError:Object.assign(Error('not confirmed'),{code:'VOICE_STOP_UNCONFIRMED'})});
  const cloud=deviceRuntime('minimax',devices);
  cloud.status=async()=>({state:'unbound',code:'CLOUD_VOICE_REQUIRED'});
  const runtime=createSpeechRuntime({local,cloud});
  assert.deepEqual(await runtime.ready({speechProvider:'minimax'}),{ready:false,state:'unbound',code:'CLOUD_VOICE_REQUIRED'});
  devices.add('minimax');
  await assert.rejects(runtime.stopEngine(),{code:'VOICE_STOP_UNCONFIRMED'});
  assert.equal(devices.size,0);
  await assert.rejects(Array.fromAsync(runtime.speak({text:'不能重新启动'})),{code:'VOICE_STOP_UNCONFIRMED'});
  await runtime.close();
});

function ownedDevice(){
  const entered=[],stopped=[];let synthesizing=0;
  const local={
    async *speak(request){assert.equal(synthesizing,0,'one physical synthesizer at a time');synthesizing++;entered.push(request.text);try{yield {type:'pcm',pcm:new Uint8Array([0,0]),sampleRate:24000};}finally{synthesizing--;}}
    ,async stopEngine(){stopped.push('local');},async close(){stopped.push('close');},
    async startCapture(request){return request;},async feedCapture(request){return request;},async finishCapture(){return {text:'本地识别'};},async cancelCapture(){}
  };
  return {runtime:createSpeechRuntime({local}),entered,stopped};
}
async function tick(){await new Promise(resolve=>setTimeout(resolve,0));}

test('chat and card owners share FIFO synthesis until the preceding generator is consumed or returned',async()=>{
  const {runtime,entered}=ownedDevice(),chat=runtime.channel('chat'),cards=runtime.channel('card-table');
  const first=chat.speak({text:'chat-one'}),second=cards.speak({text:'card-two'});
  await first.next();const waiting=second.next();await tick();assert.deepEqual(entered,['chat-one']);
  await first.return();await waiting;assert.deepEqual(entered,['chat-one','card-two']);
  await second.return();await runtime.close();
});

test('cancelling a queued card owner cannot stop chat or let a third job bypass the active generator',async()=>{
  const {runtime,entered,stopped}=ownedDevice(),chat=runtime.channel('chat'),cards=runtime.channel('card-table');
  const first=chat.speak({text:'active-chat'});await first.next();const stopCount=stopped.length;
  const second=cards.speak({text:'cancelled-card'}),cancelled=second.next().then(()=>null,error=>error);
  const third=chat.speak({text:'third-chat'}),waiting=third.next();
  await cards.stopEngine();assert.equal((await cancelled).code,'VOICE_OWNER_STOPPED');await tick();
  assert.deepEqual(entered,['active-chat']);assert.equal(stopped.length,stopCount);
  await first.return();await waiting;assert.deepEqual(entered,['active-chat','third-chat']);
  await third.return();await runtime.close();
});

test('a global stop cancels current and pending owners, gates new work until shutdown, and permits a fresh turn afterward',{timeout:1000},async()=>{
  const {runtime,entered}=ownedDevice(),chat=runtime.channel('chat'),cards=runtime.channel('card-table');
  const first=chat.speak({text:'old-chat'});await first.next();
  const queued=cards.speak({text:'old-card'}).next().then(()=>null,error=>error);
  const lazy=cards.speak({text:'created-before-stop'});
  const stopping=runtime.stopEngine();
  await assert.rejects(Array.fromAsync(cards.speak({text:'during-stop'})),{code:'VOICE_STOPPING'});
  await stopping;assert.equal((await queued).code,'VOICE_RUNTIME_STOPPED');
  await assert.rejects(lazy.next(),{code:'VOICE_RUNTIME_STOPPED'});
  await assert.rejects(first.next(),{code:'VOICE_RUNTIME_STOPPED'});
  await Array.fromAsync(cards.speak({text:'fresh-card'}));assert.deepEqual(entered,['old-chat','fresh-card']);
  await runtime.close();await assert.rejects(Array.fromAsync(chat.speak({text:'after-close'})),{code:'VOICE_RUNTIME_CLOSED'});
});

test('a failed owner shutdown seals every source and rejects other owners already waiting',{timeout:1000},async()=>{
  let failStop=false,active=0;
  const local={async *speak(){active++;try{yield {type:'pcm',pcm:new Uint8Array([0,0]),sampleRate:24000};}finally{active--;}}
    ,async stopEngine(){if(failStop)throw Object.assign(Error('worker still alive'),{code:'STOP_NOT_CONFIRMED'});},async close(){}};
  const runtime=createSpeechRuntime({local}),cards=runtime.channel('card-table'),chat=runtime.channel('chat');
  const first=cards.speak({text:'active-card'});await first.next();
  const pending=chat.speak({text:'queued-chat'}).next().then(()=>null,error=>error);
  failStop=true;await assert.rejects(cards.stopEngine(),{code:'STOP_NOT_CONFIRMED'});
  assert.equal((await pending).code,'STOP_NOT_CONFIRMED');
  await assert.rejects(Array.fromAsync(chat.speak({text:'new-chat'})),{code:'STOP_NOT_CONFIRMED'});
  await runtime.close();assert.equal(active,0);
});

test('closing cards leaves active chat and its local capture usable while permanently closing only the card owner',async()=>{
  const {runtime,stopped}=ownedDevice(),chat=runtime.channel('chat'),cards=runtime.channel('card-table');
  const first=chat.speak({text:'chat-stays-active'});await first.next();const before=stopped.length;
  await cards.close();assert.equal(stopped.length,before);
  await assert.rejects(cards.ready(),{code:'VOICE_OWNER_STOPPED'});
  await assert.rejects(Array.fromAsync(cards.speak({text:'closed-card'})),{code:'VOICE_OWNER_STOPPED'});
  assert.deepEqual(await chat.startCapture({engineId:'breeze'}),{engineId:'breeze'});
  assert.deepEqual(await chat.finishCapture(),{text:'本地识别'});
  assert.equal(cards.startCapture,undefined);
  await first.return();await runtime.close();assert.equal(stopped.filter(value=>value==='close').length,1);
});

test('the first failed stop seals other owners even while the old iterator has not returned',{timeout:1000},async()=>{
  let entered,release,failStop=false;
  const started=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
  const local={async *speak(){entered();await held;yield {type:'pcm',pcm:new Uint8Array([0,0]),sampleRate:24000};},async stopEngine(){if(failStop)throw Object.assign(Error('not stopped'),{code:'STOP_EARLY_FAILURE'});},async close(){release();}};
  const runtime=createSpeechRuntime({local}),cards=runtime.channel('card-table'),chat=runtime.channel('chat');
  const old=cards.speak({text:'held'}).next().then(()=>null,error=>error);await started;
  const queued=chat.speak({text:'waiting'}).next().then(()=>null,error=>error);
  failStop=true;const stopped=cards.stopEngine().then(()=>null,error=>error);await tick();
  await assert.rejects(Array.fromAsync(chat.speak({text:'new-after-failure'})),{code:'STOP_EARLY_FAILURE'});
  assert.equal((await queued).code,'STOP_EARLY_FAILURE');release();await old;
  assert.equal((await stopped).code,'STOP_EARLY_FAILURE');await runtime.close();
});


test('local readiness comes from the selected initialized worker instead of provider selection', async () => {
  const runtime=createSpeechRuntime({local:{ready:async()=>({ready:false,state:'loading'}),async close(){}}});
  assert.deepEqual(await runtime.ready({engine:'breeze'}),{ready:false,state:'loading'});
  await runtime.close();
});


test('a queued card stop cannot cancel active chat preparation or cross its owner boundary', async () => {
  let release,started;
  const held=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
  let stopped=0,prepared=false;
  const local={async prepare({signal}){started();await held;signal.throwIfAborted();prepared=true;return {ready:true};},
    async ready(){return {ready:prepared};},async stopEngine(){stopped++;},async close(){}};
  const runtime=createSpeechRuntime({local}),chat=runtime.channel('chat'),cards=runtime.channel('card-table');
  const pending=chat.prepare({engine:'breeze'});await entered;const before=stopped;
  await cards.stopEngine();assert.equal(stopped,before);
  release();assert.equal((await pending).ready,true);
  assert.equal((await chat.ready({engine:'breeze'})).ready,true);await runtime.close();
});

test('cloud speech preparation checks binding without synthesis or upload', async () => {
  let remoteCalls=0,localLoads=0;
  const local={async prepare(){localLoads++;return {ready:true};},async stopEngine(){},async close(){}};
  const cloud={async status(){return {state:'ready'};},async *speak(){remoteCalls++;},async prepareVoice(){remoteCalls++;},async stopEngine(){},async close(){}};
  const runtime=createSpeechRuntime({local,cloud});
  assert.equal((await runtime.prepare({engine:'gpt',speechProvider:'minimax',target:'speech'})).ready,true);
  assert.equal(remoteCalls,0);assert.equal(localLoads,0);await runtime.close();
});
