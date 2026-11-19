import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {createVoiceHost} from '../src/voice/host.mjs';

const providerId = 'minimax-cn';
const model = 'speech-2.8-turbo';
const systemVoice = 'Chinese (Mandarin)_Reliable_Executive';
const stream = 'data: {"base_resp":{"status_code":0},"data":{"status":1,"audio":"0200"}}\n\n' +
  'data: {"base_resp":{"status_code":0},"data":{"status":2}}\n\n';

async function chat(t, channel) {
  const root = await mkdtemp(join(tmpdir(),'builtin-voice-chat-'));
  const scope = {characterId:'deepseek',lifeId:'synthetic-life',operationId:'synthetic-operation',
    personaId:'synthetic-persona',channel,conversationId:'synthetic-room'};
  const game = {voiceScope:() => scope, viewState:() => ({characters:[{id:'deepseek'},{id:'qwen'}]}),
    voiceReceipt:async () => ({accepted:true}), voiceCancel() {}};
  const events = [], calls = [], vault = new Map(), waits = new Set();
  function observe(event) {
    events.push(event);
    for (const waiter of waits) waiter(event);
  }
  function waitFor(predicate) {
    if (events.some(predicate)) return Promise.resolve();
    return new Promise((resolve,reject) => {
      const listener = event => {if (predicate(event)) {clearTimeout(timer);waits.delete(listener);resolve();}};
      const timer = setTimeout(() => {waits.delete(listener);reject(Error('Cloud playback did not settle'));},10000);
      waits.add(listener);
    });
  }
  const host = createVoiceHost({dataRoot:root,build:root,getGame:() => game,
    getPlatform:() => ({voicePackageStatus:() => [],cardGames:{voiceScopeValid:scope => scope.channel === 'card-table'}}),send:observe,
    network:{fetch:async (url,{body}) => {
      const endpoint = new URL(url).pathname;
      const request = JSON.parse(body);
      if (endpoint === '/v1/get_voice') return Response.json({base_resp:{status_code:0},system_voice:[{voice_id:systemVoice}]});
      if (endpoint !== '/v1/t2a_v2') throw Error('Unexpected test endpoint');
      if (!request.stream) return Response.json({base_resp:{status_code:0},data:{status:2,audio:'0000'}});
      calls.push(request.voice_setting.voice_id);
      return new Response(stream,{headers:{'content-type':'text/event-stream'}});
    }},
    components:{
      credentials:{async save(value){const ref='synthetic-'+vault.size;vault.set(ref,value);return {ref};},async resolve(ref){return vault.get(ref);}},
      builtinAsr:{async status(){return {state:'missing'};},async auto(){},async close(){}},
      local:{async stopEngine(){},async cancelCapture(){},async close(){}},
      assets:{async close(){}},supervisor:{async close(){}},
    }});
  t.after(async () => {await host.close();await rm(root,{recursive:true, force:true});});
  const key = 'synthetic-test-only';
  const probe = await host.action('builtin-cloud-probe',{providerId,model,key});
  await host.action('builtin-cloud-save',{providerId,model,key,proof:probe.proof});
  await host.action('builtin-cloud-route',{route:'cloud:'+providerId});
  await host.action('builtin-cloud-bind',{targetCharacterId:'deepseek',voiceId:systemVoice});
  return {host,scope,events,calls,waitFor};
}

async function playAndAcknowledge({host,scope,events,waitFor}, requestId) {
  const turn = {...scope,characterId:'deepseek',requestId,messageId:'message-'+requestId};
  const lease = await host.controller.admit(turn);
  assert.ok(lease, 'host admitted the synthetic message for cloud narration');
  const envelope = {...turn,...lease,index:0,segmentId:requestId+':voice:0'};
  assert.equal(await host.controller.segment({envelope,text:'Synthetic reply.'}),true);
  await host.controller.finish({requestId});
  const relevant = () => events.filter(row => row.envelope?.requestId === requestId);
  await waitFor(row => row.envelope?.requestId === requestId && (['end','error'].includes(row.phase) || row.state === 'failed'));
  const rows = relevant();
  assert.equal(rows.some(row => row.state === 'failed' || row.phase === 'error' || row.stage === 'error'),false);
  assert.deepEqual(rows.filter(row => row.type === 'audio').map(row => row.phase),['start','pcm','end']);
  const pcm = rows.find(row => row.phase === 'pcm');
  assert.equal(pcm.sampleRate,32000);
  assert.deepEqual(Array.from(pcm.pcm),[2,0]);
  assert.equal((await host.action('receipt',{envelope,status:'audioStarted'})).accepted,true);
  assert.equal((await host.action('receipt',{envelope,status:'audioCompleted',playedMs:1})).accepted,true);
  assert.ok(relevant().some(row => row.type === 'phase' && row.stage === 'done'));
}

test('a private reply streams built-in cloud PCM and reaches a playback receipt without plugins or ASR', async t => {
  const context = await chat(t,'app-private');
  await playAndAcknowledge(context,'private-reply');
  assert.deepEqual(context.calls,[systemVoice]);
});

test('an unvoiced group member sends no speech request and the next voiced member still finishes playback', async t => {
  const context = await chat(t,'app-group');
  const unvoiced = {...context.scope,characterId:'qwen',requestId:'unvoiced-group-reply'};
  assert.equal(await context.host.controller.admit(unvoiced),null);
  assert.deepEqual(context.calls,[]);
  assert.ok(context.events.some(row => row.type === 'cloud-speech-status' && row.envelope?.requestId === unvoiced.requestId && row.status?.code === 'CLOUD_VOICE_REQUIRED'));
  await playAndAcknowledge(context,'voiced-group-reply');
  assert.deepEqual(context.calls,[systemVoice]);
});

test('the card table accepts its real built-in cloud voice and settles its play receipt without a plugin', async t => {
  const {host,scope,events,calls,waitFor} = await chat(t,'app-private');
  const tableScope = {...scope,channel:'card-table',tableId:'synthetic-table',handId:'synthetic-hand'};
  const eventId = 'synthetic-table-utterance';
  const request = {scope:tableScope,eventId,kind:'triple'};
  assert.equal((await host.cardEvent(request)).accepted,true);
  const matches = event => event.envelope?.channel === 'card-table' && event.envelope?.messageId === eventId;
  await waitFor(row => matches(row) && (row.phase === 'end' || row.state === 'failed' || row.phase === 'error') || row.type === 'error' && row.channel === 'card-table');
  assert.equal(events.find(row => matches(row) && row.state === 'failed')?.code,undefined);
  const audio = events.filter(row => matches(row) && row.type === 'audio');
  assert.deepEqual(audio.map(row => row.phase),['start','pcm','end']);
  assert.deepEqual(Array.from(audio[1].pcm),[2,0]);
  assert.equal(audio[1].sampleRate,32000);
  const envelope = audio[0].envelope;
  assert.equal((await host.action('receipt',{envelope,status:'audioStarted'})).accepted,true);
  assert.equal((await host.action('receipt',{envelope,status:'audioCompleted'})).accepted,true);
  assert.equal((await host.cardEvent(request)).status,'audioCompleted');
  assert.deepEqual(calls,[systemVoice]);
});
