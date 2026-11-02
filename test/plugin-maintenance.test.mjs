import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createPluginMaintenanceClient} from '../src/plugin-maintenance-client.mjs';

class Process extends EventEmitter {
  constructor() { super(); this.messages = []; this.killed = 0; }
  postMessage(value) { this.messages.push(value); if (value.method === 'initialize' || value.method === 'close') setImmediate(() => this.emit('message', {type: 'response', id: value.id, result: value.method === 'initialize' ? {installed: {}, packages: [], operation: null} : true})); }
  kill() { this.killed++; setImmediate(() => this.emit('exit', 0)); }
}
test('maintenance bridge exposes a narrow method surface and caches child snapshots', async () => {
  const child = new Process(), client = await createPluginMaintenanceClient({runnerPath: '/runner', root: '/isolated/app', dataRoot: '/isolated/data', appVersion: '1.9.2', processFactory: () => child});
  assert.deepEqual(Object.keys(client).sort(), ['action', 'close', 'prepareOffline', 'resolveInstalled', 'resolveTrustedSource', 'snapshot'].sort());
  child.emit('message', {type: 'update', value: {installed: {demo: {enabled: false}}, packages: [], operation: null}});
  const copy = client.snapshot(); copy.installed.demo.enabled = true; assert.equal(client.snapshot().installed.demo.enabled, false);
  assert.equal((await client.action({action: 'status'})).installed.demo.enabled, false);
  const sourceRequest=client.resolveTrustedSource('official'),sourceWire=child.messages.at(-1); assert.equal(sourceWire.method,'resolveTrustedSource'); assert.deepEqual(sourceWire.params,{sourceId:'official'}); child.emit('message',{type:'response',id:sourceWire.id,result:{sourceId:'official',keyFingerprint:'pinned'}}); assert.deepEqual(await sourceRequest,{sourceId:'official',keyFingerprint:'pinned'});
  const request = client.action({action: 'plan', requests: []}), wire = child.messages.at(-1); child.emit('message', {type: 'response', id: wire.id, result: {ok: true}}); assert.deepEqual(await request, {ok: true}); await client.close(); assert.equal(child.killed, 1);
});
test('reverse busy errors fail conservatively and process exit rejects pending calls', async () => {
  const child = new Process(), updates = [], client = await createPluginMaintenanceClient({runnerPath: '/runner', root: '/isolated/app', dataRoot: '/isolated/data', appVersion: '1.9.2', processFactory: () => child, busy: () => { throw Error('cannot confirm'); }, onUpdate: value => updates.push(value)});
  child.emit('message', {type: 'busy', id: 52}); await new Promise(done => setImmediate(done)); assert.equal(child.messages.find(row => row.type === 'busy-result' && row.id === 52).value, true);
  const pending = client.resolveInstalled('demo'); child.emit('exit', 5); await assert.rejects(pending, /5/); assert.match(updates.at(-1).service.lastError.message, /5/); assert.equal((await client.action({action: 'status'})).service.state, 'failed'); await assert.rejects(client.resolveInstalled('demo'), {code: 'PLUGIN_SERVICE_NOT_READY'}); await client.close();
});
test('synchronous channel failures clear the pending timeout and leave a recoverable failed facade', async () => {
  const child = new Process(); child.postMessage = () => { throw Error('channel closed'); };
  const client = await createPluginMaintenanceClient({runnerPath: '/runner', root: '/app', dataRoot: '/data', appVersion: '1.9.2', processFactory: () => child}); assert.match(client.snapshot().service.lastError.message, /channel closed/); assert.equal(child.killed, 1); await client.close();
});
