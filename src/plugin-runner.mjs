import {pathToFileURL} from 'node:url';

// Separate build entry. No plugin import happens until the manager has verified,
// enabled, and explicitly activated a package.
const port = process.parentPort;
if (!port) throw Error('Plugin runner requires an Electron utility process');
const pending = new Map(), callbacks = new Map(), subscriptions = new Map(); let sequence = 0, instance = null, closed = false;
function call(method, params = {}) {
  if (closed) return Promise.reject(Error('Plugin runner is closed'));
  const id = ++sequence;
  return new Promise((done, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error('Plugin host call timed out')); }, 30000); pending.set(id, {done, reject, timer}); port.postMessage({type: 'api', id, method, params}); });
}
const api = Object.freeze({
  storage: Object.freeze({get: key => call('storage.get', {key}), set: (key, value) => call('storage.set', {key, value}), remove: key => call('storage.remove', {key})}),
  commands: Object.freeze({register: async (descriptor, callback) => { callbacks.set('command:' + descriptor.id, callback); return call('commands.register', descriptor); }}),
  settings: Object.freeze({register: descriptor => call('settings.register', descriptor)}),
  ui: Object.freeze({registerPanel: descriptor => call('ui.registerPanel', descriptor)}),
  harness: Object.freeze({register: async (descriptor, handlers) => { callbacks.set('harness:' + descriptor.id, handlers); return call('harness.register', descriptor); }, emit: event => call('harness.emit', event)}),
  events: Object.freeze({subscribe: async (name, callback) => { subscriptions.set(name, callback); return call('events.subscribe', {name}); }}),
  assets: Object.freeze({resolve: path => call('assets.resolve', {path})}), models: Object.freeze({request: options => call('models.request', options)}),
  characters: Object.freeze({getContext: scope => call('characters.getContext', scope)}),
});
async function request(method, params) {
  if (method === 'activate') { if (instance) throw Error('Plugin is already active'); instance = await import(pathToFileURL(params.entry).href); if (typeof instance.activate !== 'function') throw Error('Plugin has no activate()'); await instance.activate(api, Object.freeze(params.context)); return {active: true}; }
  if (method === 'deactivate') { await instance?.deactivate?.(); closed = true; callbacks.clear(); subscriptions.clear(); for (const row of pending.values()) { clearTimeout(row.timer); row.reject(Error('Plugin deactivated')); } pending.clear(); return {stopped: true}; }
  if (method === 'command') { const callback = callbacks.get('command:' + params.id); if (typeof callback !== 'function') throw Error('Plugin command unavailable'); return callback(...params.args); }
  if (method === 'harness.call') { const handlers = callbacks.get('harness:' + params.id); if (!Object.hasOwn(handlers ?? {}, params.method) || typeof handlers[params.method] !== 'function') throw Error('Plugin harness method unavailable'); return handlers[params.method](params.args); }
  throw Error('Unknown plugin runner request');
}
port.on('message', ({data}) => {
  if (data?.type === 'api-result') { const row = pending.get(data.id); if (row) { clearTimeout(row.timer); pending.delete(data.id); data.error ? row.reject(Object.assign(Error(typeof data.error === 'string' ? data.error : data.error.message), {code: data.error.code})) : row.done(data.result); } }
  else if (data?.type === 'request') void request(data.method, data.params).then(result => port.postMessage({type: 'response', id: data.id, result: result ?? null}), error => port.postMessage({type: 'response', id: data.id, error: {message: error.message, code: error.code}}));
  else if (data?.type === 'event' && data.value?.type === 'event') void Promise.resolve(subscriptions.get(data.value.name)?.(data.value.payload)).catch(() => {});
});
