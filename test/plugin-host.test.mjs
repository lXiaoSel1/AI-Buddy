import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPluginApi} from '../src/plugin-api.mjs';
import {createPluginHost} from '../src/plugin-host.mjs';
import {buildPluginArchive, extractPluginArchive} from '../src/plugin-archive.mjs';

const content = Buffer.from('export function activate(){}'), sha = createHash('sha256').update(content).digest('hex');
const fixture = (capabilities = ['storage', 'commands.register', 'events.subscribe']) => ({schemaVersion: 1, id: 'official.demo', name: 'Demo', description: 'Host fixture', version: '1.0.0', kind: 'plugin', appRange: '>=1.9.2 <2.0.0', apiRange: '^1.0.0', platform: 'win32', arch: 'x64', entry: 'entry.mjs', activationEvents: ['onCommand:demo'], capabilities, dependencies: {}, files: [{path: 'entry.mjs', bytes: content.length, sha256: sha}]});
async function directory(t) { const root = await mkdtemp(join(tmpdir(), 'ai-buddy-plugin-host-')); t.after(() => rm(root, {recursive: true, force: true})); return root; }

test('host API enforces capabilities and namespaces before calling core services', async t => {
  const root = await directory(t), calls = [], api = createPluginApi({manifest: fixture(['storage']), dataDirectory: root, services: {models: {request: options => calls.push(options)}}});
  await assert.rejects(api.dispatch('models.request', {text: 'do not send'}), /not granted/); assert.equal(calls.length, 0);
  await assert.rejects(api.dispatch('storage.set', {key: '../outside', value: 1}), /storage key/);
  await api.dispatch('storage.set', {key: 'settings', value: {theme: 'blue'}});
  assert.deepEqual(await api.dispatch('storage.get', {key: 'settings'}), {theme: 'blue'});
  await api.close(); await assert.rejects(api.dispatch('storage.get', {key: 'settings'}), /closed/);
});

test('closing API disposes command and event subscriptions exactly once without removing saved data', async t => {
  const root = await directory(t), disposed = [], api = createPluginApi({manifest: fixture(), dataDirectory: root, services: {commands: {register: descriptor => () => disposed.push(descriptor.id)}, events: {subscribe: name => () => disposed.push(name)}}});
  await api.dispatch('commands.register', {id: 'official.demo.open', title: 'Open'});
  await api.dispatch('events.subscribe', {name: 'task:status'});
  await api.dispatch('storage.set', {key: 'progress', value: {step: 3}});
  await assert.rejects(api.dispatch('commands.register', {id: 'core.open'}), /namespace/);
  await assert.rejects(api.dispatch('commands.register', {id: 'official.demo.open'}), /Duplicate/);
  assert.equal(api.registered(), 2); await api.close(); await api.close();
  assert.deepEqual(disposed.sort(), ['official.demo.open', 'task:status'].sort()); assert.equal(await readFile(join(root, 'progress.json'), 'utf8'), '{"step":3}');
});

class Child extends EventEmitter {
  constructor() { super(); this.messages = []; this.killed = 0; }
  postMessage(message) { this.messages.push(message); if (message.type === 'request') setImmediate(() => this.emit('message', {type: 'response', id: message.id, result: {ok: true}})); }
  kill() { this.killed++; this.emit('exit', 0); }
}
test('plugin code stays dormant until activation; concurrent activations share one process', async t => {
  const root = await directory(t), code = join(root, 'code'), manifest = fixture(); await mkdir(code);
  await extractPluginArchive(buildPluginArchive(manifest, new Map([['entry.mjs', content]])), code, manifest);
  const children = [], host = createPluginHost({runnerPath: 'fixture-runner.mjs', processFactory: () => { const child = new Child(); children.push(child); return child; }});
  assert.equal(children.length, 0); assert.deepEqual(host.active(), []);
  const options = {manifest, directory: code, dataDirectory: join(root, 'data'), event: 'onCommand:demo'};
  await Promise.all([host.activate(options), host.activate(options)]); assert.equal(children.length, 1); assert.equal(host.isActive(manifest.id), true);
  await host.stop(manifest.id); assert.equal(host.isActive(manifest.id), false); assert.equal(children[0].killed, 1);
  assert.equal(children[0].listenerCount('message'), 0);
});

test('undeclared activation and changed package files cannot spawn a plugin process', async t => {
  const root = await directory(t), code = join(root, 'code'), manifest = fixture(); await mkdir(code);
  await extractPluginArchive(buildPluginArchive(manifest, new Map([['entry.mjs', content]])), code, manifest);
  let count = 0; const host = createPluginHost({runnerPath: 'fixture-runner.mjs', processFactory: () => { count++; return new Child(); }});
  const options = {manifest, directory: code, dataDirectory: join(root, 'data'), event: 'onHarness:other'};
  await assert.rejects(host.activate(options), /not declared/);
  await writeFile(join(code, 'entry.mjs'), 'changed');
  await assert.rejects(host.activate({...options, event: 'onCommand:demo'}), /signed index/); assert.equal(count, 0);
});

test('plugin process cannot bypass host API checks through raw messages', async t => {
  const root = await directory(t), code = join(root, 'code'), manifest = fixture(['storage']); await mkdir(code);
  await extractPluginArchive(buildPluginArchive(manifest, new Map([['entry.mjs', content]])), code, manifest);
  const child = new Child(), host = createPluginHost({runnerPath: 'fixture-runner.mjs', processFactory: () => child});
  await host.activate({manifest, directory: code, dataDirectory: join(root, 'data'), event: 'onCommand:demo'});
  child.emit('message', {type: 'api', id: 55, method: 'models.request', params: {key: 'no'}});
  await new Promise(done => setImmediate(done));
  assert.match(child.messages.find(row => row.type === 'api-result' && row.id === 55).error.message, /not granted/);
  await host.stopAll(); assert.deepEqual(host.active(), []);
});
