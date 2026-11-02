import test from 'node:test';
import assert from 'node:assert/strict';
import {createPluginKimiFactory} from '../src/plugin-harness-adapter.mjs';

function setup() {
  const hosts = [], resolutions = [];
  const manager = {resolveInstalled: async (id, options) => { resolutions.push({id, options}); return {directory: '/verified/' + id, dataDirectory: '/profile/' + id, manifest: {id, entry: 'bin/kimi.exe', nativeVersion: '2.3.1', files: [{path: 'bin/kimi.exe', sha256: 'a'.repeat(64)}]}}; }};
  const factory = createPluginKimiFactory({manager, runnerPath: '/runner.cjs', dataRoot: '/profile', hostFactory: options => {
    const row = {options, calls: [], stopped: false, turn: null}; hosts.push(row);
    return {activate: async value => { row.activation = value; row.disposeRegistration = options.services.harness.register({id: 'ai-buddy.kimi-engine.acp'}, async (method, params) => {
      row.calls.push({method, params});
      if (method === 'profileReceipt') return {keyPersisted: false, taskId: value.context.task.id};
      if (method === 'sendTurn') return new Promise((done, reject) => { row.turn = {done, reject}; });
      if (method === 'cancelTurn') { row.turn?.reject(Object.assign(Error('cancelled'), {code: 'ABORT_ERR'})); return {requested: true}; }
      return {method, params};
    }); }, stopAll: async () => { row.stopped = true; row.disposeRegistration?.(); }};
  }});
  const task = id => ({id, binding: {model: 'chosen-model', provider: 'kimi'}, scope: {characterId: 'kimi', personaId: 'p', lifeId: 'l'}, workspace: {path: '/project'}});
  return {factory, hosts, manager, resolutions, task};
}

test('each task gets one independent host with only Harness services and its selected connection', async () => {
  const f = setup(), connection = {kind: 'kimi', key: 'selected-key', model: 'chosen-model'}, first = await f.factory({task: f.task('one'), connection, context: {developerInstructions: 'first'}}), second = await f.factory({task: f.task('two'), connection, context: {developerInstructions: 'second'}});
  assert.equal(f.hosts.length, 2); assert.deepEqual(Object.keys(f.hosts[0].options.services), ['harness']);
  assert.equal(f.hosts[0].activation.context.connection, connection); assert.equal(f.hosts[0].activation.context.characterContext.developerInstructions, 'first');
  assert.equal(f.hosts[1].activation.context.characterContext.developerInstructions, 'second'); assert.equal(first.profileReceipt.taskId, 'one'); assert.equal(second.profileReceipt.taskId, 'two');
  assert.equal(f.resolutions[0].options.requireEnabled, true); assert.equal(f.resolutions[1].options.requireEnabled, false);
  const events = []; first.on('event', event => events.push(event)); f.hosts[0].options.services.harness.event('ai-buddy.kimi-engine', {harnessId: 'ai-buddy.kimi-engine.acp', event: {type: 'text', payload: {text: 'isolated'}}}); assert.equal(events.length, 1);
  assert.throws(() => f.hosts[0].options.services.harness.event('other', {harnessId: 'ai-buddy.kimi-engine.acp'}), /mismatch/);
  await f.factory.disposeAll(); assert.deepEqual(f.factory.activeTasks(), []); assert.ok(f.hosts.every(host => host.stopped));
});

test('AbortSignal becomes a native cancel request rather than an unserializable IPC value', async () => {
  const f = setup(), adapter = await f.factory({task: f.task('one'), connection: {kind: 'kimi'}}), controller = new AbortController();
  const pending = adapter.sendTurn({sessionId: 's', text: 'work', clientMessageId: 'turn', signal: controller.signal});
  assert.equal(adapter.busy, true); assert.equal(Object.hasOwn(f.hosts[0].calls.at(-1).params, 'signal'), false);
  controller.abort(); await assert.rejects(pending, {code: 'ABORT_ERR'});
  assert.equal(f.hosts[0].calls.at(-1).method, 'cancelTurn'); assert.equal(adapter.busy, false); await adapter.dispose();
});

test('unavailable signed package and concurrent duplicate task creation never start a host', async () => {
  const f = setup(); f.manager.resolveInstalled = async () => { throw Error('signature invalid'); };
  await assert.rejects(f.factory({task: f.task('one'), connection: {}}), {code: 'HARNESS_UNAVAILABLE'}); assert.equal(f.hosts.length, 0);
  const other = setup(), first = other.factory({task: other.task('duplicate'), connection: {}});
  await assert.rejects(other.factory({task: other.task('duplicate'), connection: {}}), {code: 'HARNESS_BUSY'}); await first; await other.factory.disposeAll();
});

test('runtime resolution stays pinned to the engine publisher across asynchronous registry changes', async () => {
  const f = setup(), original = f.manager.resolveInstalled;
  f.manager.resolveInstalled = async (id, options) => {
    if (id === 'ai-buddy.kimi-runtime' && options.sourceId !== 'trusted-engine-source') {
      throw Object.assign(Error('registry origin changed between resolutions'), {code: 'PLUGIN_SOURCE_CONFLICT'});
    }
    return {...await original(id, options), sourceId: 'trusted-engine-source'};
  };
  const adapter = await f.factory({task: f.task('pinned'), connection: {kind: 'kimi'}});
  assert.equal(f.resolutions[1].options.sourceId, 'trusted-engine-source');
  await adapter.dispose();
});
