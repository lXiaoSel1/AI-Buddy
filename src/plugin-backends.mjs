/** A backend advertises only methods it actually implements. There is no success stub. */
export function createPluginBackendRegistry() {
  const backends = new Map();
  const requireBackend = name => { const backend = backends.get(name); if (!backend) throw Object.assign(Error('Plugin backend is unavailable: ' + name), {code: 'PLUGIN_BACKEND_UNAVAILABLE'}); return backend; };
  return Object.freeze({
    register(name, backend) { if (!['buddy-v1', 'dsh'].includes(name) || !backend || typeof backend !== 'object' || backends.has(name)) throw Error('Invalid or duplicate plugin backend'); backends.set(name, backend); return () => { if (backends.get(name) === backend) backends.delete(name); }; },
    has: name => backends.has(name),
    supports: (name, method) => typeof backends.get(name)?.[method] === 'function',
    invoke(name, method, ...args) { const backend = requireBackend(name); if (typeof backend[method] !== 'function') throw Object.assign(Error('Plugin backend does not support ' + method), {code: 'PLUGIN_BACKEND_UNSUPPORTED'}); return backend[method](...args); },
    describe: () => [...backends].map(([name, backend]) => ({name, methods: ['probe', 'snapshot', 'planInstall', 'install', 'enable', 'disable', 'rollback', 'uninstall', 'openClient', 'listTools', 'callTool', 'close'].filter(method => typeof backend[method] === 'function')})),
  });
}
