import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {pluginClientResult} from '../src/plugin-client-result.mjs';

test('sandbox preload exposes only finite methods and approval requires current genuine user activation', async () => {
  const contents = await readFile(new URL('../src/plugin-client-preload.mjs', import.meta.url), 'utf8'), compiled = await build({stdin: {contents, loader: 'js'}, bundle: true, format: 'cjs', platform: 'node', external: ['electron'], write: false, logLevel: 'silent'});
  const calls = [], listeners = new Map(), navigator = {userActivation: {isActive: false}}; let api;
  const electron = {contextBridge: {exposeInMainWorld(name, value) { assert.equal(name, 'aiBuddyPluginClient'); api = value; }}, ipcRenderer: {invoke(channel, value) { calls.push({channel, value}); return Promise.resolve({ok: true, result: {}}); }, on(channel, listener) { listeners.set(channel, listener); }, removeListener(channel) { listeners.delete(channel); }}};
  vm.runInNewContext(compiled.outputFiles[0].text, {require: name => { assert.equal(name, 'electron'); return electron; }, navigator});
  assert.deepEqual(Object.keys(api), ['describe', 'selectViewer', 'chooseWorkspace', 'request', 'subscribe']);
  const request = {requestId: 'approval', action: 'plans.approve', payload: {taskId: 'task', planRevision: 1, planHash: 'hash'}, expectedViewerRevision: 0};
  assert.equal((await api.request(request)).error.code, 'WORK_USER_ACTIVATION_REQUIRED'); assert.equal(calls.length, 0);
  assert.equal((await api.request({...request, action: 'native.respond'})).error.code, 'WORK_USER_ACTIVATION_REQUIRED'); assert.equal(calls.length, 0);
  navigator.userActivation.isActive = true; await api.request(request); assert.equal(calls.length, 1); assert.equal(calls[0].channel, 'buddy-plugin-client:invoke');
  navigator.userActivation.isActive = false; await api.request({...request, action: 'tasks.read'}); assert.equal(calls.length, 2);
  let delivered; const unsubscribe = api.subscribe(value => { delivered = value; }); listeners.get('buddy-plugin-client:event')({privateEvent: true}, {event: {type: 'task-state'}}); assert.equal(delivered.event.type, 'task-state'); assert.equal(delivered.privateEvent, undefined); unsubscribe(); assert.equal(listeners.size, 0);
});

test('plain core work-open failure survives cloning and becomes an Error only in the receiving renderer', () => {
  const wire = {__buddyError: true, code: 'WORK_PLUGIN_DISABLED', message: 'Work plugin is disabled', details: {generation: 4}}, cloned = JSON.parse(JSON.stringify(wire));
  assert.throws(() => pluginClientResult(cloned), error => error.code === 'WORK_PLUGIN_DISABLED' && error.details.generation === 4);
  const success = {runtimeId: 'actual-runtime', state: 'document-ready'}; assert.equal(pluginClientResult(success), success);
});
