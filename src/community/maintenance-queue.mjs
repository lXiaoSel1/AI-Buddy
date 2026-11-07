import {randomUUID} from 'node:crypto';
import {mkdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {writeAtomicAsync} from '../atomic-write.mjs';
import {assertPluginTreeNoLinks} from '../plugin-archive.mjs';
import {canonicalPluginJson} from '../plugin-manifest.mjs';
import {communityDigest} from './catalog.mjs';

const operations = new Set(['install', 'enable', 'disable', 'rollback', 'uninstall']);
const copy = value => structuredClone(value);
const fault = (message, code) => Object.assign(Error(message), {code});
const MAX_JOBS = 10000;

/** Queue ownership is one host service. Waiting for work never holds the installer lock.
 * An interrupted side effect is never blindly replayed after a crash. */
export async function createMaintenanceQueue({directory, execute, revalidate = async () => true, isBusy = async () => false, canStart = () => true, now = Date.now, onChange = () => {}, write = writeAtomicAsync}) {
  if (typeof execute !== 'function') throw Error('Maintenance executor is required');
  await assertPluginTreeNoLinks(directory); await mkdir(directory, {recursive: true});
  const file = join(directory, 'maintenance-queue-v1.json'); let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; state = {schemaVersion: 1, jobs: []}; }
  if (state.schemaVersion !== 1 || !Array.isArray(state.jobs)) throw fault('Maintenance queue is invalid; evidence retained', 'COMMUNITY_QUEUE_INVALID');
  const ids = new Set();
  for (const job of state.jobs) {
    if (!job?.id || ids.has(job.id) || !operations.has(job.operation) || !job.packageKey || !['queued', 'running', 'completed', 'failed', 'cancelled', 'needs-user', 'interrupted-needs-user'].includes(job.state) || job.intentDigest !== communityDigest(job.intent)) throw fault('Maintenance queue entry is invalid; evidence retained', 'COMMUNITY_QUEUE_INVALID');
    ids.add(job.id);
  }
  let closed = false, executing = false, draining = null, serial = Promise.resolve();
  const recoveryOnly = state.jobs.length > MAX_JOBS;
  const snapshot = () => copy({...state, capacity: {limit: MAX_JOBS, count: state.jobs.length, recoveryOnly}});
  // The previous durable snapshot remains authoritative until the candidate has
  // committed. A failed publication cannot poison memory or an idempotent retry.
  const persist = async next => { await write(file, canonicalPluginJson(next)); state = next; try { onChange(snapshot()); } catch {} };
  const recovered = copy(state); let changed = false;
  for (const job of recovered.jobs) if (!recoveryOnly && job.state === 'running') { job.state = 'interrupted-needs-user'; job.error = {code: 'MAINTENANCE_OUTCOME_UNKNOWN', message: 'Process stopped during maintenance; inspect runtime before planning a retry'}; job.updatedAt = new Date(now()).toISOString(); changed = true; }
  if (changed) await persist(recovered);
  function mutation(run) { const result = serial.then(run); serial = result.catch(() => {}); return result; }
  async function enqueue({operation, packageKey, intent, idempotencyKey}) {
    if (closed) throw fault('Maintenance queue is closed', 'COMMUNITY_CLOSED');
    if (!operations.has(operation) || typeof packageKey !== 'string' || !packageKey || packageKey.length > 800) throw fault('Invalid maintenance request', 'COMMUNITY_QUEUE_INVALID');
    const encoded = canonicalPluginJson(intent); if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw fault('Maintenance intent exceeds limit', 'COMMUNITY_QUEUE_INVALID');
    const intentDigest = communityDigest(intent), dedup = idempotencyKey ?? operation + ':' + packageKey + ':' + intentDigest;
    return mutation(async () => {
      if (closed) throw fault('Maintenance queue is closed', 'COMMUNITY_CLOSED');
      const prior = state.jobs.find(job => job.idempotencyKey === dedup);
      if (prior) { if (prior.intentDigest !== intentDigest || prior.operation !== operation || prior.packageKey !== packageKey) throw fault('Idempotency key conflicts with another operation', 'COMMUNITY_QUEUE_CONFLICT'); return copy(prior); }
      if (state.jobs.length >= MAX_JOBS) throw fault('Maintenance history reached its capacity; existing evidence is retained', 'COMMUNITY_QUEUE_CAPACITY');
      const timestamp = new Date(now()).toISOString();
      const job = {id: randomUUID(), operation, packageKey, intent: JSON.parse(encoded), intentDigest, idempotencyKey: dedup, state: 'queued', createdAt: timestamp, updatedAt: timestamp}, next = copy(state);
      next.jobs.push(job); await persist(next); return copy(job);
    });
  }
  async function cancel(id) { return mutation(async () => {
    if (closed) throw fault('Maintenance queue is closed', 'COMMUNITY_CLOSED');
    if (recoveryOnly) throw fault('Oversized maintenance history is available for read-only recovery', 'COMMUNITY_QUEUE_CAPACITY');
    const next = copy(state), job = next.jobs.find(value => value.id === id);
    if (!job) throw fault('Maintenance request not found', 'COMMUNITY_QUEUE_NOT_FOUND');
    if (job.state === 'running') throw fault('Maintenance is committing; cancellation is unavailable', 'PLUGIN_BUSY');
    if (['queued', 'needs-user'].includes(job.state)) { job.state = 'cancelled'; job.updatedAt = new Date(now()).toISOString(); await persist(next); }
    return copy(job);
  }); }
  const updateJob = (id, expected, change, {allowClosed = false} = {}) => mutation(async () => {
    if (closed && !allowClosed) return null;
    const next = copy(state), job = next.jobs.find(value => value.id === id); if (!job || !expected.includes(job.state)) return null;
    change(job); await persist(next); return copy(job);
  });
  const failed = cause => ({code: typeof cause?.code === 'string' ? cause.code : 'MAINTENANCE_FAILED', message: String(cause?.message ?? cause).slice(0, 2000)});
  async function runDrain() {
    await serial;
    if (closed || recoveryOnly) return snapshot();
    for (let index = 0; index < state.jobs.length; index++) {
      const original = copy(state.jobs[index]), id = original.id;
      if (closed || original.state !== 'queued') continue;
      let busy, decision;
      try { busy = await isBusy(copy(original)); if (!busy) decision = await revalidate(copy(original)); if (!busy && (decision === true || decision?.allowed === true)) busy = await isBusy(copy(original)); }
      catch (cause) { await updateJob(id, ['queued'], job => { job.state = 'failed'; job.error = failed(cause); job.updatedAt = new Date(now()).toISOString(); }); continue; }
      if (busy) { if (state.jobs.find(job => job.id === id)?.waitingReason !== 'active-work') await updateJob(id, ['queued'], job => { job.waitingReason = 'active-work'; }); continue; }
      if (decision !== true && decision?.allowed !== true) { await updateJob(id, ['queued'], job => { job.state = 'needs-user'; job.error = {code: decision?.code ?? 'MAINTENANCE_RECONFIRM_REQUIRED', message: decision?.message ?? 'Source, permissions or data changed; create a new approved maintenance plan'}; }); continue; }
      // Failure to durably claim aborts the drain before any native side effect.
      const claimed = await updateJob(id, ['queued'], job => { job.state = 'running'; job.updatedAt = new Date(now()).toISOString(); delete job.waitingReason; });
      if (!claimed) continue;
      // Publication can yield for a Windows sharing retry. Work may have begun
      // meanwhile, so the earlier busy probes no longer authorize execution.
      let finalBusy = false, finalFailure = null;
      if (!closed) { try { finalBusy = await isBusy(copy(claimed)); } catch (cause) { finalFailure = failed(cause); } }
      if (closed || finalFailure || finalBusy || !canStart()) {
        await updateJob(id, ['running'], job => {
          // Recheck inside the serial lane too: close may have arrived after
          // the probe returned but before this candidate could be committed.
          if (closed) { job.state = 'interrupted-needs-user'; job.error = finalFailure ?? {code: 'MAINTENANCE_OUTCOME_UNKNOWN', message: 'Closed after the durable claim and before native execution; inspect before planning a retry'}; }
          else if (finalFailure) { job.state = 'failed'; job.error = finalFailure; }
          else { job.state = 'queued'; job.waitingReason = 'active-work'; }
          job.updatedAt = new Date(now()).toISOString();
        }, {allowClosed: true});
        continue;
      }
      let result;
      executing = true;
      try { result = await execute(copy(claimed)); }
      catch (cause) { await updateJob(id, ['running'], job => { job.state = 'failed'; job.updatedAt = new Date(now()).toISOString(); job.error = failed(cause); }, {allowClosed: true}); continue; }
      finally { executing = false; }
      // Completion shares the same serial lane as enqueue/cancel. If this write
      // fails, running remains durable and execute is never automatically replayed.
      await updateJob(id, ['running'], job => { job.state = 'completed'; job.result = result ?? null; job.updatedAt = new Date(now()).toISOString(); }, {allowClosed: true});
    }
    return snapshot();
  }
  const drain = () => { if (!draining) draining = runDrain().finally(() => { draining = null; }); return draining; };
  return {snapshot, enqueue, cancel, drain, close: async () => { closed = true; await serial; await draining; }, isRunning: () => !!draining, isExecuting: () => executing};
}
