import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMaintenanceQueue} from '../src/community/maintenance-queue.mjs';
import {communityDigest} from '../src/community/catalog.mjs';

async function setup(t, options = {}) { const directory = await mkdtemp(join(tmpdir(), 'buddy-maintenance-simulation-')), executions = []; const config = {directory, execute: async job => { executions.push(job.id); return {ok: true}; }, ...options}; let queue = await createMaintenanceQueue(config); t.after(async () => { await queue.close(); await rm(directory, {recursive: true, force: true}); }); return {directory, executions, get queue() { return queue; }, async restart() { await queue.close(); queue = await createMaintenanceQueue(config); return queue; }}; }
const intent = {packageRef: {packageName: 'test'}, approvedDigest: 'fixed'};
test('simulation: busy maintenance persists without running and starts after work releases', async t => {
  let busy = true; const f = await setup(t, {isBusy: async () => busy}); const job = await f.queue.enqueue({operation: 'disable', packageKey: 'dsh:source:test', intent});
  await f.queue.drain(); assert.deepEqual(f.executions, []); assert.equal(f.queue.snapshot().jobs[0].state, 'queued');
  await f.restart(); busy = false; await Promise.all([f.queue.drain(), f.queue.drain()]); assert.deepEqual(f.executions, [job.id]); assert.equal(f.queue.snapshot().jobs[0].state, 'completed');
});
test('simulation: idempotent enqueue and duplicate drains invoke native operation once', async t => {
  const f = await setup(t); const one = await f.queue.enqueue({operation: 'install', packageKey: 'same', intent, idempotencyKey: 'request'}), two = await f.queue.enqueue({operation: 'install', packageKey: 'same', intent, idempotencyKey: 'request'});
  assert.equal(one.id, two.id); await assert.rejects(f.queue.enqueue({operation: 'install', packageKey: 'same', intent: {changed: true}, idempotencyKey: 'request'}), {code: 'COMMUNITY_QUEUE_CONFLICT'});
  await Promise.all([f.queue.drain(), f.queue.drain()]); assert.equal(f.executions.length, 1);
});
test('simulation: source/grant drift requires a new plan and does not execute', async t => {
  const f = await setup(t, {revalidate: async () => ({allowed: false, code: 'SOURCE_CHANGED', message: 'new source'})});
  await f.queue.enqueue({operation: 'install', packageKey: 'same', intent}); await f.queue.drain(); assert.deepEqual(f.executions, []); assert.equal(f.queue.snapshot().jobs[0].state, 'needs-user');
});
test('simulation: crash-interrupted native side effects are not replayed', async t => {
  const f = await setup(t); const job = await f.queue.enqueue({operation: 'install', packageKey: 'same', intent}); await f.queue.close();
  const path = join(f.directory, 'maintenance-queue-v1.json'), state = JSON.parse(await readFile(path, 'utf8')); state.jobs[0].state = 'running'; await writeFile(path, JSON.stringify(state));
  await f.restart(); await f.queue.drain(); assert.equal(f.queue.snapshot().jobs[0].state, 'interrupted-needs-user'); assert.deepEqual(f.executions, []); assert.equal(f.queue.snapshot().jobs[0].id, job.id);
});
test('simulation: tampered persisted intent fails closed and remains on disk', async t => {
  const f = await setup(t); await f.queue.enqueue({operation: 'install', packageKey: 'same', intent}); await f.queue.close();
  const path = join(f.directory, 'maintenance-queue-v1.json'), state = JSON.parse(await readFile(path, 'utf8')); state.jobs[0].intent = {changed: true}; await writeFile(path, JSON.stringify(state));
  await assert.rejects(f.restart(), {code: 'COMMUNITY_QUEUE_INVALID'}); assert.equal(JSON.parse(await readFile(path, 'utf8')).jobs[0].intentDigest, communityDigest(intent));
});
test('simulation: cancellation before execution is durable; failures retain native stage', async t => {
  const f = await setup(t, {execute: async () => { throw Object.assign(Error('activation failed after download'), {code: 'DSH_ACTIVATION_FAILED'}); }});
  const one = await f.queue.enqueue({operation: 'install', packageKey: 'one', intent}); await f.queue.cancel(one.id); await f.queue.enqueue({operation: 'enable', packageKey: 'two', intent}); await f.queue.drain();
  assert.equal(f.queue.snapshot().jobs[0].state, 'cancelled'); assert.equal(f.queue.snapshot().jobs[1].error.code, 'DSH_ACTIVATION_FAILED'); await f.restart(); assert.equal(f.queue.snapshot().jobs[0].state, 'cancelled');
});
