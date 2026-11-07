import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceRuntime} from '../src/voice/runtime.mjs';

async function fixture(t, {initializeDelay=0} = {}) {
  const {join} = await import('node:path');
  const {tmpdir} = await import('node:os');
  const {mkdtemp, rm, writeFile} = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'buddy-voice-runtime-'));
  const script = join(dir, 'fixture.mjs');
  await writeFile(script, `
import {createInterface} from 'node:readline';
const send = row => process.stdout.write(JSON.stringify(row) + '\\n');
for await (const line of createInterface({input:process.stdin})) {
  const request = JSON.parse(line);
  if (request.op === 'speak') {
    if (request.text === 'pending') continue;
    send({id:request.id, type:'pcm', sample_rate:48000, pcm:'AQACAA=='});
    send({id:request.id, type:'done', rtf:0.4});
  } else if (request.op === 'feed') {
    send({id:request.id, type:'result', partial:'SIL你', endpoint:true, limit:false});
  } else {
    if (request.op === 'initialize') await new Promise(resolve=>setTimeout(resolve,${initializeDelay}));
    send({id:request.id, type:'result', state:'ready', text:request.op === 'finish'?'SIL你好 SIL':undefined});
  }
}
`);
  const running = new Map(), admitted = [];
  const runtime = createVoiceRuntime({
    resolveAssets: async kind => ({python:process.execPath, script, root:dir, assetRoot:dir, cacheRoot:dir, proof:kind}),
    resolveProfile: async () => ({path:script, text:'参考', language:'zh', referenceStyle:'calm', referenceSource:'neutral-fallback'}),
    supervisor: {
      async registerRoot({runtimeId,pid}) { running.set(runtimeId,pid); admitted.push(runtimeId.split(':')[1]); },
      async releaseRoot({runtimeId}) { assert.ok(running.delete(runtimeId)); return {stopped:true}; }
    },
  });
  t.after(async () => { await runtime.close(); await rm(dir,{recursive:true,force:true}); });
  return {runtime,running,admitted};
}

test('shared ASR returns a partial and a single final without creating TTS', async t => {
  const {runtime,admitted} = await fixture(t);
  await runtime.startCapture();
  assert.deepEqual(await runtime.feedCapture({pcm:Buffer.alloc(320)}),{partial:'你',endpoint:true,limit:false});
  assert.deepEqual(await runtime.finishCapture(),{text:'你好'});
  await assert.rejects(runtime.finishCapture(), {code:'VOICE_CAPTURE_INACTIVE'});
  assert.deepEqual(admitted,['asr']);
});

test('synthesis preserves reference fallback and real rate and retires the previous engine', async t => {
  const {runtime,running,admitted} = await fixture(t);
  const rows = await Array.fromAsync(runtime.speak({engine:'gpt',characterId:'a',profileId:'v1',text:'你好'}));
  assert.deepEqual(rows[0],{type:'reference',style:'calm',source:'neutral-fallback'});
  assert.equal(rows[1].sampleRate,48000);
  assert.deepEqual(rows[1].pcm,Buffer.from([1,0,2,0]));
  assert.equal(rows[2].metrics.rtf,0.4);
  await Array.fromAsync(runtime.speak({engine:'breeze',characterId:'a',profileId:'v1',text:'你好'}));
  assert.deepEqual(admitted,['gpt','breeze']);
  assert.equal(running.size,1);
});

test('cancelling an in-flight synthesis retires only the owned worker', async t => {
  const {runtime,running} = await fixture(t);
  const controller = new AbortController();
  const pending = runtime.speak({engine:'gpt',characterId:'a',profileId:'v1',text:'pending',signal:controller.signal});
  await pending.next();
  const next = pending.next();
  controller.abort();
  await assert.rejects(next,{name:'AbortError'});
  assert.equal(running.size,0);
});


test('prepare reports selected TTS ready only after its real initialize response', async t => {
  const {runtime,admitted}=await fixture(t,{initializeDelay:80});
  const stages=[];
  const pending=runtime.prepare({engine:'gpt',target:'speech',onProgress:row=>stages.push(row)});
  assert.equal((await runtime.ready({engine:'gpt'})).ready,false);
  await pending;
  assert.equal((await runtime.ready({engine:'gpt'})).ready,true);
  assert.equal((await runtime.ready({engine:'breeze'})).ready,false);
  assert.deepEqual(admitted,['gpt']);
  assert.ok(stages.some(row=>row.state==='loading'&&row.component==='gpt'));
});


test('Live preparation initializes only the selected TTS plus shared ASR', async t => {
  const {runtime,admitted}=await fixture(t,{initializeDelay:20});
  assert.equal((await runtime.prepare({engine:'breeze',target:'live'})).ready,true);
  assert.deepEqual(admitted,['breeze','asr']);
  assert.equal((await runtime.ready({engine:'breeze',target:'live'})).ready,true);
  await runtime.cancelCapture();
  assert.equal((await runtime.ready({engine:'breeze',target:'live'})).ready,false);
  assert.equal((await runtime.ready({engine:'breeze'})).ready,true);
});

test('stopping actual worker initialization retires it and a fresh preparation can succeed', async t => {
  const {runtime,admitted,running}=await fixture(t,{initializeDelay:80});
  const pending=runtime.prepare({engine:'gpt'});
  const rejected=assert.rejects(pending,{name:'AbortError'});
  for(let i=0;i<100&&!admitted.length;i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(admitted.length,1);
  await runtime.stopEngine();await rejected;
  assert.equal(running.size,0);
  assert.equal((await runtime.ready({engine:'gpt'})).ready,false);
  assert.equal((await runtime.prepare({engine:'breeze'})).ready,true);
  assert.deepEqual(admitted,['gpt','breeze']);
});
