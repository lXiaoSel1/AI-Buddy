import {mkdir, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {writeAtomic} from './atomic-write.mjs';
import {canonicalPluginJson, parsePluginManifest, pluginRelativePath} from './plugin-manifest.mjs';
import {assertPluginTreeNoLinks} from './plugin-archive.mjs';

/** Capability checks live in the host, not in the plugin's helper object. */
export function createPluginApi({manifest: input, dataDirectory, services = {}, sendEvent = () => {}, invoke = async () => { throw Error('Plugin callback unavailable'); }} = {}) {
  const manifest = parsePluginManifest(input), capabilities = new Set(manifest.capabilities), disposers = new Map();
  let closed = false, storageQueue = Promise.resolve();
  function requireCapability(value) { if (closed) throw Error('Plugin API is closed'); if (!capabilities.has(value)) throw Error('Plugin capability not granted: ' + value); }
  const safeValue = value => { const json = canonicalPluginJson(value); if (Buffer.byteLength(json) > 1024 * 1024) throw Error('Plugin message exceeds size limit'); return JSON.parse(json); };
  const keyPath = key => { if (typeof key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(key) || ['constructor', 'prototype'].includes(key)) throw Error('Invalid plugin storage key'); pluginRelativePath(key + '.json'); return join(dataDirectory, key + '.json'); };
  async function service(name, method, ...args) { if (typeof services[name]?.[method] !== 'function') throw Error('Host feature is unavailable: ' + name + '.' + method); return services[name][method](...args); }
  async function register(kind, params, extra) {
    if (typeof params?.id !== 'string' || !params.id.startsWith(manifest.id + '.') || params.id.length > 200) throw Error('Plugin registration must use its own namespace');
    const key = kind + ':' + params.id; if (disposers.has(key)) throw Error('Duplicate plugin registration');
    const dispose = await service(kind, 'register', safeValue(params), extra);
    if (closed) { await dispose?.(); throw Error('Plugin API closed during registration'); }
    disposers.set(key, typeof dispose === 'function' ? dispose : () => {}); return {id: params.id};
  }
  async function dispatch(method, raw = {}) {
    const params = safeValue(raw);
    switch (method) {
      case 'storage.get': case 'storage.set': case 'storage.remove': {
        requireCapability('storage'); const path = keyPath(params.key);
        const run = async () => {
          await assertPluginTreeNoLinks(path); await mkdir(dataDirectory, {recursive: true});
          if (method === 'storage.set') { const encoded = canonicalPluginJson(params.value); if (Buffer.byteLength(encoded) > 256 * 1024) throw Error('Plugin setting exceeds size limit'); writeAtomic(path, encoded); return true; }
          if (method === 'storage.remove') { await rm(path, {force: true}); return true; }
          try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        };
        const result = storageQueue.then(run); storageQueue = result.catch(() => {}); return result;
      }
      case 'commands.register': requireCapability('commands.register'); return register('commands', params, (...args) => invoke('command', {id: params.id, args}));
      case 'settings.register': requireCapability('settings.register'); return register('settings', params);
      case 'ui.registerPanel': {
        requireCapability('ui.registerPanel'); pluginRelativePath(params.path);
        if (!manifest.files.some(file => file.path === params.path) || !/\.html$/.test(params.path)) throw Error('Plugin panel must be indexed HTML');
        return register('panels', params);
      }
      case 'events.subscribe': {
        requireCapability('events.subscribe'); if (typeof params.name !== 'string' || !/^[a-z][a-z0-9:.-]{0,99}$/.test(params.name)) throw Error('Invalid event name');
        const id = 'event:' + params.name; if (disposers.has(id)) throw Error('Duplicate event subscription');
        const dispose = await service('events', 'subscribe', params.name, payload => { if (!closed) sendEvent({type: 'event', name: params.name, payload: safeValue(payload)}); });
        if (closed) { await dispose?.(); throw Error('Plugin API is closed'); }
        disposers.set(id, dispose); return true;
      }
      case 'harness.register': requireCapability('harness.register'); return register('harness', params, (method, args) => invoke('harness.call', {id: params.id, method, args}));
      case 'harness.emit': requireCapability('harness.register'); return service('harness', 'event', manifest.id, params);
      case 'assets.resolve': requireCapability('assets.resolve'); pluginRelativePath(params.path); return service('assets', 'resolve', manifest.id, params.path);
      case 'models.request': requireCapability('models.request'); return service('models', 'request', manifest.id, params);
      case 'characters.getContext': requireCapability('characters.getContext'); return service('characters', 'getContext', manifest.id, params);
      default: throw Error('Unknown plugin API method');
    }
  }
  async function close() { if (closed) return; closed = true; await storageQueue; const callbacks = [...disposers.values()].reverse(); disposers.clear(); for (const dispose of callbacks) try { await dispose?.(); } catch {} }
  return {dispatch, close, registered: () => disposers.size};
}
