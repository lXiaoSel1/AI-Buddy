import {EventEmitter} from 'node:events';
import {join} from 'node:path';
import {createPluginHost} from './plugin-host.mjs';

/** The core imports this generic bridge, never the Kimi ACP/profile code. Each
 * task gets its own host and the selected connection only, not all API secrets.
 */
export function createPluginKimiFactory({manager, runnerPath, dataRoot, processFactory, hostFactory = createPluginHost, onState = () => {}} = {}) {
  const active = new Map(), creating = new Set();
  async function factory({task, binding = task?.binding, connection, context = {}, profileOptions = {dataRoot}} = {}) {
    if (!task?.id || active.has(task.id) || creating.has(task.id)) throw Object.assign(Error('Task plugin is missing an identity or already active'), {code: 'HARNESS_BUSY'});
    creating.add(task.id);
    let engine, runtime;
    try { engine = await manager.resolveInstalled('ai-buddy.kimi-engine', {requireEnabled: true}); runtime = await manager.resolveInstalled('ai-buddy.kimi-runtime', {requireEnabled: false, sourceId: engine.sourceId}); }
    catch (cause) { creating.delete(task.id); throw Object.assign(Error('Kimi 工作引擎或运行包尚未安装、启用或通过校验：' + cause.message), {code: 'HARNESS_UNAVAILABLE', cause}); }
    const runtimeFile = runtime.manifest.files.find(file => file.path === runtime.manifest.entry);
    if (!runtimeFile) { creating.delete(task.id); throw Object.assign(Error('Kimi runtime executable is not indexed'), {code: 'HARNESS_UNAVAILABLE'}); }
    let invoke = null, disposed = false, disposing = null; const adapter = new EventEmitter();
    const host = hostFactory({runnerPath, processFactory, onState: value => { onState(value); if (value.state === 'failed' && !disposed) adapter.emit('event', {type: 'status', payload: {status: 'disconnected', error: value.error}}); }, services: {harness: {
      register: (descriptor, callback) => {
        if (descriptor.id !== 'ai-buddy.kimi-engine.acp' || invoke) throw Error('Unexpected or duplicate Kimi Harness registration');
        invoke = callback; return () => { invoke = null; };
      },
      event: (pluginId, value) => { if (pluginId !== 'ai-buddy.kimi-engine' || value.harnessId !== 'ai-buddy.kimi-engine.acp') throw Error('Harness event source mismatch'); if (!disposed) adapter.emit('event', value.event); return true; },
    }}});
    async function call(method, params = {}) { if (disposed || !invoke) throw Error('Kimi plugin task is stopped'); return invoke(method, params); }
    adapter.busy = false;
    adapter.probe = () => call('probe'); adapter.startSession = options => call('startSession', options); adapter.resumeSession = options => call('resumeSession', options);
    adapter.sendTurn = async options => {
      const {signal, ...wire} = options;
      if (signal?.aborted) throw Object.assign(Error('Work task cancelled'), {code: 'ABORT_ERR'});
      const cancel = () => { void call('cancelTurn', {sessionId: wire.sessionId, turnId: wire.clientMessageId}).catch(error => adapter.emit('event', {type: 'status', payload: {status: 'cancel-unconfirmed', error: error.message}})); };
      adapter.busy = true; signal?.addEventListener('abort', cancel, {once: true});
      try { return await call('sendTurn', wire); } finally { adapter.busy = false; signal?.removeEventListener('abort', cancel); }
    };
    adapter.cancelTurn = options => call('cancelTurn', options); adapter.respondToRequest = options => call('respondToRequest', options);
    adapter.dispose = () => { if (disposing) return disposing; disposed = true; disposing = host.stopAll().finally(() => active.delete(task.id)); return disposing; };
    active.set(task.id, {adapter, host});
    creating.delete(task.id);
    try {
      await host.activate({manifest: engine.manifest, directory: engine.directory, dataDirectory: engine.dataDirectory, event: 'onHarness:kimi', context: {
        task, binding, connection, characterContext: context, profileOptions: {dataRoot, ...profileOptions},
        runtimeBinary: join(runtime.directory, runtime.manifest.entry), version: runtime.manifest.nativeVersion ?? null, sha256: runtimeFile.sha256,
      }});
      if (!invoke) throw Error('Kimi plugin did not register a Harness');
      adapter.profileReceipt = await call('profileReceipt'); return adapter;
    } catch (error) { await adapter.dispose(); throw error; }
  }
  factory.disposeAll = async () => { await Promise.all([...active.values()].map(value => value.adapter.dispose())); };
  factory.activeTasks = () => [...active.keys()];
  return factory;
}
