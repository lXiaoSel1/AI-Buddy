export const PLUGIN_MAINTENANCE_BUSY = Symbol('host-only extension maintenance status');
// The facade survives failed starts and process restarts. Consumers (including
// Harness factories) retain one stable identity for the entire app lifetime.
export async function createPluginMaintenanceClient({runnerPath, root, dataRoot, appVersion, busy = () => false, onUpdate = () => {},
  processFactory, timeoutMs = 30 * 60 * 1000, initializeTimeoutMs = 10000, closeTimeoutMs = 5000} = {}) {
  const factory = processFactory ?? (await import('electron')).utilityProcess.fork;
  let current = null, generation = 0, serial = 0, closing = false, closePromise = null, retryPromise = null;
  let cache = {installed: {}, packages: [], operation: null, service: {state: 'initializing', usable: false, retryable: false, lastError: null, attempt: 0, waitingSince: null}};
  const error = (message, code = 'PLUGIN_SERVICE_UNAVAILABLE') => Object.assign(Error(message), {code});
  const snapshot = () => structuredClone(cache);
  function publish(value) { cache = value; try { onUpdate(snapshot()); } catch {} }
  function state(value, lastError = null) {
    publish({...cache, operation: null, service: {...cache.service, state: value, usable: value === 'ready', retryable: value === 'failed' || value === 'waiting-installation', lastError: lastError ? {code: lastError.code ?? 'PLUGIN_MAINTENANCE_FAILED', message: String(lastError.message).slice(0, 2000)} : null}});
  }
  function normalize(value) { return {...value, service: value?.service ?? {state: 'ready', usable: true, retryable: false, lastError: null, attempt: 0, waitingSince: null}}; }
  function rejectPending(holder, cause) { for (const row of holder.pending.values()) { clearTimeout(row.timer); row.reject(cause); } holder.pending.clear(); }
  function request(holder, method, params = {}, limit = timeoutMs, allowClosing = false) {
    if ((!allowClosing && closing) || !holder || holder.exited || holder.disposing) return Promise.reject(error('扩展服务已关闭', 'PLUGIN_CLOSED'));
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { holder.pending.delete(id); reject(error('扩展维护请求超时', 'PLUGIN_REQUEST_TIMEOUT')); }, limit);
      holder.pending.set(id, {resolve, reject, timer});
      try { holder.child.postMessage({type: 'request', id, method, params}); }
      catch (cause) { clearTimeout(timer); holder.pending.delete(id); reject(cause); }
    });
  }
  function dispose(holder, limit = closeTimeoutMs) {
    if (!holder) return Promise.resolve(true);
    holder.disposing = true; rejectPending(holder, error('扩展服务已关闭', 'PLUGIN_CLOSED'));
    holder.child.removeListener('message', holder.onMessage); holder.child.removeListener('error', holder.onError); holder.child.removeListener('exit', holder.onExit);
    if (holder.exited) { holder.cleanup?.(); return Promise.resolve(true); }
    if (holder.disposal) return holder.disposal;
    holder.disposal = new Promise(resolve => {
      let timer, settled = false;
      const ignoreLateError = () => {};
      holder.cleanup = () => { clearTimeout(timer); holder.child.removeListener('exit', exitedListener); holder.child.removeListener('error', ignoreLateError); };
      const finish = exited => { if (exited) { holder.exited = true; holder.cleanup(); } else clearTimeout(timer); if (!settled) { settled = true; resolve(exited); } };
      const exitedListener = () => finish(true);
      // Until exit is confirmed, an error during kill/IPC teardown must not become
      // an unhandled EventEmitter error. The guard is removed on actual exit.
      holder.child.on('error', ignoreLateError);
      holder.child.once('exit', exitedListener);
      timer = setTimeout(() => finish(false), Math.max(1, limit));
      try { holder.child.kill(); } catch { finish(false); }
    });
    return holder.disposal;
  }
  function processFailure(holder, cause) {
    rejectPending(holder, cause);
    if (closing || current !== holder || holder.generation !== generation) return;
    state('failed', cause); void dispose(holder);
  }
  async function start() {
    if (closing) throw error('扩展服务已关闭', 'PLUGIN_CLOSED');
    const previous = current;
    if (previous && !await dispose(previous)) { state('failed', error('旧扩展维护进程尚未退出，请稍后重试。', 'PLUGIN_PROCESS_EXIT_TIMEOUT')); return snapshot(); }
    if (closing) return snapshot();
    state('initializing');
    let holder;
    try {
      const child = factory(runnerPath, [], {stdio: 'pipe', serviceName: 'AI Buddy Extension Maintenance'});
      holder = {child, generation: ++generation, pending: new Map(), exited: false, disposing: false, initialized: false}; current = holder;
      holder.onMessage = raw => {
        if (current !== holder || holder.disposing || holder.exited || holder.generation !== generation) return;
        const value = raw?.data ?? raw;
        if (value?.type === 'response') {
          const row = holder.pending.get(value.id);
          if (row) { holder.pending.delete(value.id); clearTimeout(row.timer); value.error ? row.reject(Object.assign(Error(value.error.message), {code: value.error.code})) : row.resolve(value.result); }
        } else if (closing) return;
        else if (value?.type === 'update') publish(normalize(value.value));
        else if (value?.type === 'busy') void Promise.resolve().then(busy).catch(() => true).then(result => {
          if (!closing && current === holder && !holder.disposing && !holder.exited) holder.child.postMessage({type: 'busy-result', id: value.id, value: !!result});
        }).catch(() => {});
      };
      holder.onError = cause => processFailure(holder, cause);
      holder.onExit = code => { holder.exited = true; processFailure(holder, error('扩展维护进程已结束：' + code, 'PLUGIN_PROCESS_EXIT')); };
      child.on('message', holder.onMessage); child.once('error', holder.onError); child.once('exit', holder.onExit);
      const value = await request(holder, 'initialize', {root, dataRoot, appVersion}, initializeTimeoutMs);
      if (!closing && current === holder && !holder.disposing) { holder.initialized = true; publish(normalize(value)); }
    } catch (cause) {
      if (!closing && (!holder || current === holder)) state('failed', cause);
      if (holder) await dispose(holder);
    }
    return snapshot();
  }
  function retry() {
    if (closing) return Promise.reject(error('扩展服务已关闭', 'PLUGIN_CLOSED'));
    if (retryPromise) return retryPromise;
    if (cache.service.usable) return Promise.resolve(snapshot());
    retryPromise = (async () => {
      const holder = current;
      if (holder?.initialized && !holder.disposing && !holder.exited) {
        const value = await request(holder, 'action', {action: 'retry'});
        if (!closing && current === holder && !holder.disposing) publish(normalize(value));
        return snapshot();
      }
      return start();
    })().finally(() => { retryPromise = null; });
    return retryPromise;
  }
  async function readyRequest(method, params) {
    if (closing) throw error('扩展服务已关闭', 'PLUGIN_CLOSED');
    if (!cache.service.usable) throw error('扩展服务尚未就绪', 'PLUGIN_SERVICE_NOT_READY');
    return request(current, method, params);
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true; state('closing');
    closePromise = (async () => {
      const holder = current, end = Date.now() + closeTimeoutMs;
      if (holder && !holder.disposing && !holder.exited) {
        try { await request(holder, 'close', {}, Math.max(1, Math.floor(closeTimeoutMs / 2)), true); } catch {}
      }
      const exited = await dispose(holder, Math.max(1, end - Date.now())); state('closed', exited ? null : error('扩展维护进程尚未确认退出。', 'PLUGIN_PROCESS_EXIT_TIMEOUT'));
    })();
    return closePromise;
  }
  const facade = {snapshot, [PLUGIN_MAINTENANCE_BUSY]: () => cache.operation !== null, action: value => value?.action === 'status' ? Promise.resolve(snapshot()) : value?.action === 'retry' ? retry() : readyRequest('action', value),
    prepareOffline: (directory, requests) => readyRequest('prepareOffline', {directory, requests}), resolveInstalled: (id, options) => readyRequest('resolveInstalled', {id, options}), resolveTrustedSource: sourceId => readyRequest('resolveTrustedSource', {sourceId}), close};
  await start();
  return facade;
}
