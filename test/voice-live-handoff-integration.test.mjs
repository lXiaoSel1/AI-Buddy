import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {createGalgame} from '../src/galgame-host.mjs';
import {createVoiceController} from '../src/voice/controller.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';
import {createHostVoiceCapture} from '../src/voice/capture.mjs';

const transcript = '这一条识别文本必须保存一次';
async function until(check) {
  for (let i = 0; i < 100; i++) { const value = await check(); if (value) return value; await pause(5); }
  throw Error('Live handoff scenario timed out');
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'buddy-live-handoff-'));
  const events = [], modelCalls = [];
  let game, browser, routeError = false, micStopped = false, profileReady = true;
  const settings = createVoiceSettings(); await settings.update({enabled: true});
  const provider = {
    enabled: true, currentSelection: () => ({provider: 'fixture', model: 'fixture'}),
    listProviders: () => [{id: 'fixture'}], listModels: () => [{id: 'fixture'}], runTurn: fn => fn(),
    resolveConnection: () => routeError ? {error: 'controlled route preflight failure'} : {provider: 'fixture', model: 'fixture'},
    async *stream(options) {
      if (!options.purpose) modelCalls.push(options);
      yield {type: 'text-delta', text: options.purpose === 'choices' ? '{"positive":"好","neutral":"继续","negative":"暂停"}' : options.purpose === 'emotion' ? 'normal' : '文本回复已保留。[[emotion:normal]]'};
      yield {type: 'finish', reason: {kind: 'stop'}};
    },
  };
  const controller = createVoiceController({settings,
    getScope: () => game?.voiceScope(), submit: args => game.voiceSubmit(args),
    send: event => { events.push(event); browser?.event(event); },
    listPackages: () => [{id: 'ai-buddy.voice-breeze', engine: 'breeze', installed: true, enabled: true, usable: true}],
    assets: {resolve: async () => ({}), status: async () => ({state: 'ready'})},
    profiles: {current: async ({characterId, engine}) => profileReady ? {id: characterId + '-voice', characterId, engine, version: 1} : null},
    runtime: {startCapture: async () => {}, feedCapture: async () => ({endpoint: true}), finishCapture: async () => ({text: transcript}),
      cancelCapture: async () => {}, stopEngine: async () => {}, async *speak() { throw Error('unexpected synthesis'); }},
  });
  game = await createGalgame({dataRoot: root, provider, model: 'fixture', voice: controller,
    automaticWorkAllowed: () => false, r95Options: {tickAllowed: () => false}});
  const track = {stop() { micStopped = true; }};
  const connect = () => ({connect() {}, disconnect() {}});
  browser = createHostVoiceCapture({action: (op, args) => controller.action(op, args),
    getMedia: async () => ({getTracks: () => [track], getAudioTracks: () => [track]}),
    makeContext: () => ({audioWorklet: {addModule: async () => {}}, resume: async () => {}, close: async () => {},
      createMediaStreamSource: connect, createGain: () => ({...connect(), gain: {value: 0}}), destination: {}}),
    makeNode: () => ({...connect(), port: {postMessage() {}}}), workletURL: 'fixture://voice-capture.js'});
  t.after(async () => { browser.release(); await controller.close(); await game.close(); await rm(root, {recursive: true, force: true}); });
  return {game, controller, browser, events, modelCalls, failRoute: () => { routeError = true; }, micStopped: () => micStopped, loseProfile: () => { profileReady = false; }};
}

test('a saved Live submission releases the microphone when routing fails before voice admission', async t => {
  const f = await fixture(t);
  const scope = f.game.voiceScope(), capture = await f.browser.start('live');
  f.failRoute();
  const result = await f.controller.action('capture-feed', {id: capture.id, pcm: new Uint8Array(320)});
  assert.equal(result.submitted, true);
  const view = await until(async () => { const view = await f.game.action('view'); return view.companion.messages.some(row => row.role === 'user' && row.status === 'failed') && view; });
  assert.equal((await f.controller.state()).live, false, 'accepted text without a voice turn must not leave Live waiting');
  assert.equal(f.micStopped(), true);
  const users = view.companion.messages.filter(row => row.role === 'user');
  assert.equal(users.length, 1);
  assert.equal(users[0].text, transcript);
  assert.equal(f.modelCalls.length, 0);
  assert.equal(f.events.some(row => row.type === 'draft'), false);
  const repeated = await f.game.voiceSubmit({scope, text: transcript, submissionId: capture.id});
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.messageId, result.accepted.messageId);
});


test('missing TTS admission ends Live while the accepted message receives one ordinary text reply', async t => {
  const f = await fixture(t);
  const scope = f.game.voiceScope(), capture = await f.browser.start('live');
  f.loseProfile();
  const result = await f.controller.action('capture-feed', {id: capture.id, pcm: new Uint8Array(320)});
  assert.equal(result.submitted, true);
  const view = await until(async () => { const view = await f.game.action('view'); return view.companion.messages.some(row => row.role === 'assistant' && row.text.includes('文本回复已保留')) && !view.companion.busy && view; });
  assert.equal((await f.controller.state()).live, false, 'text-only success must settle the owning Live wait');
  assert.equal(f.micStopped(), true);
  assert.equal(view.companion.messages.filter(row => row.role === 'user').length, 1);
  assert.equal(view.companion.messages.find(row => row.role === 'user').text, transcript);
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.events.some(row => row.type === 'draft' || row.type === 'audio'), false);
  const repeated = await f.game.voiceSubmit({scope, text: transcript, submissionId: capture.id});
  assert.equal(repeated.duplicate, true);
  assert.equal(f.modelCalls.length, 1);
});


test('an accepted group Live submission releases capture on pre-admission routing failure', async t => {
  const f = await fixture(t);
  const {group} = await f.game.action('companion-group-save', {name: 'Live scope', memberIds: ['deepseek', 'gemini'], mode: 'list'});
  await f.game.action('companion-group-select', {id: group.id});
  await until(async () => !(await f.controller.state()).stopping);
  const scope = f.game.voiceScope(), capture = await f.browser.start('live');
  f.failRoute();
  const result = await f.controller.action('capture-feed', {id: capture.id, pcm: new Uint8Array(320)});
  assert.equal(result.submitted, true);
  const view = await until(async () => { const view = await f.game.action('view'); return view.companion.groupRuntime.status === 'failed' && view; });
  assert.equal((await f.controller.state()).live, false, 'a failed group preflight must settle its original capture');
  assert.equal(f.micStopped(), true);
  assert.equal(view.companion.groupMessages.filter(row => row.role === 'user').length, 1);
  assert.equal(view.companion.groupMessages[0].text, transcript);
  assert.equal(f.modelCalls.length, 0);
  const repeated = await f.game.voiceSubmit({scope, text: transcript, submissionId: capture.id});
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.messageId, result.accepted.messageId);
});
