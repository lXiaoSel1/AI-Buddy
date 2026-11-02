import {EventEmitter} from 'node:events';
import {join, resolve} from 'node:path';
import {createPluginApi} from './plugin-api.mjs';
import {parsePluginManifest} from './plugin-manifest.mjs';
import {verifyInstalledPlugin} from './plugin-archive.mjs';

/** Process separation contains crashes, not malicious Node code. Publisher trust
 * and signed package proofs are checked before this host is invoked. Third-party
 * publishers require explicit source trust; that is not an OS sandbox. Disabled plugins never
 * reach activate(), so their entry code is neither imported nor spawned.
 */
export function createPluginHost({runnerPath, processFactory, services = {}, onState = () => {}, timeoutMs = 30000} = {}) {
  const instances = new Map(), starting = new Map(), events = new EventEmitter();
  async function factory() { if (processFactory) return processFactory; const {utilityProcess} = await import('electron'); return path => utilityProcess.fork(path, [], {stdio: 'pipe', serviceName: 'AI Buddy Official Extension'}); }
  async function start({manifest: input, directory, dataDirectory, event, context = {}}) {
    const manifest = parsePluginManifest(input);
    if (manifest.kind !== 'plugin') return {assetOnly: true};
    if (!manifest.activationEvents.includes(event)) throw Error('Plugin activation event is not declared');
    if (instances.has(manifest.id)) return instances.get(manifest.id).ready;
    await verifyInstalledPlugin(directory, manifest);
    if (!runnerPath) throw Error('Plugin runner is not present in this build');
    const child = (await factory())(resolve(runnerPath)), pending = new Map(); let sequence = 0, stopped = false;
    const api = createPluginApi({manifest, dataDirectory, services, sendEvent: value => child.postMessage({type: 'event', value}), invoke: request});
    function request(method, params) {
      if (stopped) return Promise.reject(Error('Plugin process has stopped'));
      const id = ++sequence;
      return new Promise((done, reject) => {
        const limit = method === 'harness.call' && params?.method === 'sendTurn' ? Math.max(timeoutMs, 30 * 60 * 1000) : timeoutMs;
        const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(Error('Plugin request timed out: ' + method), {code: 'HARNESS_TIMEOUT'})); }, limit);
        pending.set(id, {done, reject, timer}); child.postMessage({type: 'request', id, method, params});
      });
    }
    async function dispose(error) {
      if (stopped) return; stopped = true; instances.delete(manifest.id);
      for (const row of pending.values()) { clearTimeout(row.timer); row.reject(error ?? Error('Plugin stopped')); } pending.clear();
      await api.close(); child.removeListener('message', message); child.removeListener('exit', exit); child.removeListener('error', crash);
      onState({id: manifest.id, state: error ? 'failed' : 'stopped', error: error?.message}); events.emit('state', {id: manifest.id, state: 'stopped'});
    }
    const message = raw => {
      const value = raw?.data ?? raw;
      if (value?.type === 'response') { const row = pending.get(value.id); if (row) { pending.delete(value.id); clearTimeout(row.timer); value.error ? row.reject(Object.assign(Error(typeof value.error === 'string' ? value.error : value.error.message), {code: value.error.code})) : row.done(value.result); } }
      else if (value?.type === 'api') void api.dispatch(value.method, value.params).then(result => child.postMessage({type: 'api-result', id: value.id, result: result ?? null}), error => child.postMessage({type: 'api-result', id: value.id, error: {message: error.message, code: error.code}}));
    };
    const exit = code => { void dispose(Object.assign(Error('Plugin exited: ' + code), {code: 'HARNESS_DISCONNECTED'})); }, crash = error => { void dispose(Object.assign(error, {code: 'HARNESS_DISCONNECTED'})); };
    child.on('message', message); child.once('exit', exit); child.once('error', crash);
    const row = {child, api, request, dispose, ready: null}; instances.set(manifest.id, row);
    row.ready = request('activate', {manifest, entry: join(directory, manifest.entry), dataDirectory, context}).then(value => { onState({id: manifest.id, state: 'active'}); return value; }).catch(async error => { await dispose(error); child.kill(); throw error; });
    return row.ready;
  }
  function activate(options) {
    const id = options.manifest.id;
    if (starting.has(id)) return starting.get(id);
    if (instances.has(id)) return instances.get(id).ready;
    const result = start(options); starting.set(id, result);
    void result.finally(() => starting.delete(id)).catch(() => {}); return result;
  }
  async function stop(id) {
    if (starting.has(id)) try { await starting.get(id); } catch {}
    const row = instances.get(id); if (!row) return;
    let timer;
    try { await Promise.race([row.request('deactivate', {}), new Promise(done => { timer = setTimeout(done, Math.min(timeoutMs, 3000)); })]); } catch {} finally { clearTimeout(timer); }
    await row.dispose(); row.child.kill();
  }
  return {activate, stop, stopAll: async () => { for (const id of [...instances.keys()]) await stop(id); }, isActive: id => instances.has(id), active: () => [...instances.keys()], onState: callback => { events.on('state', callback); return () => events.off('state', callback); }};
}
