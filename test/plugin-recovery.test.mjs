import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, mkdir, writeFile, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createPluginManager} from '../src/plugin-manager.mjs';
import {createPluginMaintenanceClient} from '../src/plugin-maintenance-client.mjs';

const tick = () => new Promise(done => setImmediate(done));
async function until(check, limit = 5000) {
  const end = Date.now() + limit;
  while (!check()) { if (Date.now() >= end) assert.fail('condition did not settle'); await new Promise(done => setTimeout(done, 5)); }
}
async function profile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-plugin-recovery-')), root = join(directory, 'app'), dataRoot = join(directory, 'data');
  await mkdir(root); await mkdir(dataRoot);
  t.after(() => rm(directory, {recursive: true, force: true}));
  return {root, dataRoot, appVersion: '1.9.2'};
}
function locked() { return Object.assign(Error('installation is locked'), {code: 'EBUSY', path: 'install.lock'}); }

test('LOCAL-02 clean startup is read-only and does not take the installation mutation lock', async t => {
  const options = await profile(t); let locks = 0;
  const manager = await createPluginManager({...options, withMaintenanceLock: async run => { locks++; return run(); }});
  t.after(() => manager.close());
  assert.equal(locks, 0);
  assert.equal(manager.snapshot().service.state, 'ready');
  await assert.rejects(stat(join(options.root, 'local/plugins')), {code: 'ENOENT'});
});

test('LOCAL-02 interrupted recovery waits without blocking startup, then resumes in the same manager', async t => {
  const options = await profile(t), id = randomUUID(), control = join(options.root, 'local/plugins'), stage = join(control, 'staging', id);
  await mkdir(stage, {recursive: true}); await mkdir(join(control, 'transactions'));
  await writeFile(join(stage, 'partial'), 'keep until lock acquired');
  await writeFile(join(control, 'transactions', id + '.json'), JSON.stringify({id, phase: 'prepared', stage: 'staging/' + id}));
  let held = true;
  const manager = await createPluginManager({...options, startupRetryMs: 5, startupRetryLimitMs: 1000, withMaintenanceLock: async run => { if (held) throw locked(); return run(); }});
  t.after(() => manager.close());
  assert.equal(manager.snapshot().service.state, 'waiting-installation');
  assert.equal(manager.snapshot().operation, null);
  assert.equal(await readFile(join(stage, 'partial'), 'utf8'), 'keep until lock acquired');
  held = false; await until(() => manager.snapshot().service.state === 'ready');
  await assert.rejects(stat(stage), {code: 'ENOENT'});
  assert.ok(JSON.parse(await readFile(join(control, 'transactions', id + '.json'), 'utf8')).recovery);
});

class Process extends EventEmitter {
  constructor({failure = null, ignoreClose = false} = {}) { super(); this.failure = failure; this.ignoreClose = ignoreClose; this.messages = []; this.killed = 0; }
  postMessage(value) {
    this.messages.push(value);
    if (value.method === 'initialize') setImmediate(() => this.emit('message', {type: 'response', id: value.id, ...(this.failure ? {error: {message: this.failure, code: 'PLUGIN_FIXTURE_FAILURE'}} : {result: {installed: {}, packages: [], operation: null, service: {state: 'ready', usable: true, retryable: false, lastError: null}}})}));
    if (value.method === 'close' && !this.ignoreClose) setImmediate(() => this.emit('message', {type: 'response', id: value.id, result: true}));
  }
  kill() { this.killed++; setImmediate(() => this.emit('exit', 0)); }
}

test('LOCAL-02 stable maintenance facade survives initialization failure and manual retry', async t => {
  const children = [], updates = [];
  const client = await createPluginMaintenanceClient({runnerPath: '/fixture', root: '/fixture-app', dataRoot: '/fixture-data', appVersion: '1.9.2', processFactory: () => { const child = new Process({failure: children.length ? null : 'broken startup'}); children.push(child); return child; }, timeoutMs: 1000, closeTimeoutMs: 20, onUpdate: value => updates.push(value)});
  t.after(() => client.close());
  await until(() => client.snapshot().service.state === 'failed');
  const original = client;
  await Promise.all([client.action({action: 'retry'}), client.action({action: 'retry'})]);
  await until(() => client.snapshot().service.state === 'ready');
  assert.equal(client, original); assert.equal(children.length, 2); assert.equal(children[0].killed, 1);
  children[0].emit('message', {type: 'update', value: {installed: {}, packages: [], operation: null, service: {state: 'failed'}}});
  assert.equal(client.snapshot().service.state, 'ready');
});

test('LOCAL-02 close has its own deadline and releases child listeners after a hung close request', async t => {
  const child = new Process({ignoreClose: true});
  const client = await createPluginMaintenanceClient({runnerPath: '/fixture', root: '/fixture-app', dataRoot: '/fixture-data', appVersion: '1.9.2', processFactory: () => child, timeoutMs: 500, closeTimeoutMs: 20});
  await tick(); const started = Date.now(); await client.close();
  assert.ok(Date.now() - started < 250, 'close must not reuse the normal operation timeout');
  assert.equal(child.killed, 1); assert.equal(child.listenerCount('message'), 0); assert.equal(child.listenerCount('error'), 0); assert.equal(child.listenerCount('exit'), 0);
  await client.close(); assert.equal(child.killed, 1);
});

test('LOCAL-02 exited maintenance process cannot publish a late ready snapshot and releases listeners', async () => {
  const child = new Process();
  const client = await createPluginMaintenanceClient({runnerPath: '/fixture', root: '/fixture-app', dataRoot: '/fixture-data', appVersion: '1.9.2', processFactory: () => child});
  child.emit('exit', 7);
  child.emit('message', {type: 'update', value: {installed: {}, packages: [], operation: null, service: {state: 'ready', usable: true}}});
  assert.equal(client.snapshot().service.state, 'failed'); assert.equal(child.listenerCount('message'), 0); assert.equal(child.listenerCount('error'), 0); assert.equal(child.listenerCount('exit'), 0);
  await client.close();
});

test('LOCAL-02 kill teardown absorbs late errors until exit and never starts a second live process', async () => {
  const child = new Process({failure: 'initial failure'}); child.kill = () => { child.killed++; };
  let spawned = 0;
  const client = await createPluginMaintenanceClient({runnerPath: '/fixture', root: '/fixture-app', dataRoot: '/fixture-data', appVersion: '1.9.2', processFactory: () => { spawned++; return child; }, closeTimeoutMs: 10});
  assert.doesNotThrow(() => child.emit('error', Error('late pipe error')));
  await client.action({action: 'retry'}); assert.equal(spawned, 1); assert.equal(client.snapshot().service.lastError.code, 'PLUGIN_PROCESS_EXIT_TIMEOUT');
  child.emit('exit', 0); assert.equal(child.listenerCount('error'), 0); assert.equal(child.listenerCount('exit'), 0);
  await client.close();
});

test('LOCAL-02 lock timeout remains retryable and closing cancels every scheduled recovery attempt', async t => {
  const options = await profile(t), id = randomUUID(), control = join(options.root, 'local/plugins'), stage = join(control, 'staging', id);
  await mkdir(stage, {recursive: true}); await mkdir(join(control, 'transactions'));
  await writeFile(join(stage, 'partial'), 'retain'); await writeFile(join(control, 'transactions', id + '.json'), JSON.stringify({id, phase: 'prepared', stage: 'staging/' + id}));
  let calls = 0, held = true;
  const manager = await createPluginManager({...options, startupRetryMs: 5, startupRetryLimitMs: 20, withMaintenanceLock: async run => { calls++; if (held) throw locked(); return run(); }});
  await until(() => manager.snapshot().service.state === 'failed'); assert.equal(manager.snapshot().service.lastError.code, 'PLUGIN_INSTALLATION_WAIT_TIMEOUT');
  held = false; await manager.action({action: 'retry'}); assert.equal(manager.snapshot().service.state, 'ready');
  await manager.close(); const stoppedCalls = calls; await new Promise(done => setTimeout(done, 30)); assert.equal(calls, stoppedCalls); assert.equal(manager.snapshot().service.state, 'closed');
});

test('LOCAL-02 closing during installation wait cancels its timer and retains untouched staging', async t => {
  const options = await profile(t), id = randomUUID(), control = join(options.root, 'local/plugins'), stage = join(control, 'staging', id);
  await mkdir(stage, {recursive: true}); await mkdir(join(control, 'transactions')); await writeFile(join(stage, 'partial'), 'keep');
  await writeFile(join(control, 'transactions', id + '.json'), JSON.stringify({id, phase: 'prepared', stage: 'staging/' + id}));
  let calls = 0;
  const manager = await createPluginManager({...options, startupRetryMs: 10, withMaintenanceLock: async () => { calls++; throw locked(); }});
  assert.equal(manager.snapshot().service.state, 'waiting-installation'); await manager.close(); const stopped = calls;
  await new Promise(done => setTimeout(done, 40)); assert.equal(calls, stopped); assert.equal(await readFile(join(stage, 'partial'), 'utf8'), 'keep');
});

test('LOCAL-02 non-lock recovery errors fail once, retain staging and do not become automatic retries', async t => {
  const options = await profile(t), id = randomUUID(), control = join(options.root, 'local/plugins'), stage = join(control, 'staging', id);
  await mkdir(stage, {recursive: true}); await mkdir(join(control, 'transactions')); await writeFile(join(stage, 'partial'), 'keep');
  await writeFile(join(control, 'transactions', id + '.json'), JSON.stringify({id, phase: 'prepared', stage: 'staging/' + id}));
  let calls = 0;
  const manager = await createPluginManager({...options, startupRetryMs: 5, withMaintenanceLock: async () => { calls++; throw Object.assign(Error('I/O failure'), {code: 'EIO', path: 'install.lock'}); }});
  t.after(() => manager.close()); assert.equal(manager.snapshot().service.state, 'failed'); assert.equal(manager.snapshot().service.lastError.code, 'EIO');
  await new Promise(done => setTimeout(done, 30)); assert.equal(calls, 1); assert.equal(await readFile(join(stage, 'partial'), 'utf8'), 'keep');
});

test('LOCAL-02 an already recovered journal never reacquires the installation lock on restart', async t => {
  const options = await profile(t), id = randomUUID(), control = join(options.root, 'local/plugins');
  await mkdir(join(control, 'transactions'), {recursive: true});
  await writeFile(join(control, 'transactions', id + '.json'), JSON.stringify({id, phase: 'prepared', stage: 'staging/' + id, recovery: {state: 'complete', at: '2026-10-23T00:00:00.000Z'}}));
  let calls = 0;
  const manager = await createPluginManager({...options, withMaintenanceLock: async () => { calls++; throw locked(); }}); t.after(() => manager.close());
  assert.equal(manager.snapshot().service.state, 'ready'); assert.equal(calls, 0);
});

test('LOCAL-02 initialization timeout disposes its child and leaves a manually recoverable facade', async () => {
  const child = new Process(); child.postMessage = value => { child.messages.push(value); };
  const client = await createPluginMaintenanceClient({runnerPath: '/fixture', root: '/fixture-app', dataRoot: '/fixture-data', appVersion: '1.9.2', processFactory: () => child, initializeTimeoutMs: 10, closeTimeoutMs: 20});
  assert.equal(client.snapshot().service.state, 'failed'); assert.equal(client.snapshot().service.lastError.code, 'PLUGIN_REQUEST_TIMEOUT'); assert.equal(child.killed, 1);
  assert.equal(child.listenerCount('message'), 0); assert.equal(child.listenerCount('error'), 0); assert.equal(child.listenerCount('exit'), 0); await client.close();
});
