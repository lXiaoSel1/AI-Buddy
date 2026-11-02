import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {trustedDshLocation,pluginWindowOpenHandler,pageEventScript} from './dsh-platform/client-host.mjs';
import {applyPluginPageAppearance} from './plugin-page-appearance.mjs';

export const PLUGIN_CLIENT_CHANNEL = 'buddy-plugin-client:invoke';
export const PLUGIN_CLIENT_EVENT = 'buddy-plugin-client:event';
const methods = new Set(['describe', 'selectViewer', 'chooseWorkspace', 'request']);
const actions = new Set(['framework.read','framework.events','framework.resource','projects.list', 'projects.register', 'projects.read', 'projects.binding.set', 'projects.discover', 'history.list', 'history.read', 'history.restore.prepare', 'tasks.create', 'tasks.plan', 'tasks.read', 'tasks.events', 'tasks.message', 'tasks.execute', 'tasks.cancel', 'tasks.continue', 'tasks.present', 'tasks.list', 'plans.read', 'plans.revise', 'plans.approve', 'reviews.submit', 'reviews.revise', 'reviews.reassign', 'reports.read', 'reports.request', 'reports.retry', 'jobs.read', 'native.respond', 'migration.inspect', 'migration.import', 'migration.verify', 'archive.snapshot', 'archive.restore', 'exit.prepare', 'exit.finish', 'exit.stop-save']);
const fail = (message, code = 'WORK_CLIENT_DENIED') => Object.assign(Error(message), {code});
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const redact = value => value.replace(/([?&#][^=\s&]*(?:token|key|secret|credential|auth|signature)[^=\s&]*=)[^\s&]+/gi, '$1[REDACTED]').replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
export function publicPluginClientValue(value) {
  if (Array.isArray(value)) return value.map(publicPluginClientValue);
  if (plain(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:contextToken|accessToken|refreshToken|api[-_]?key|authorization|authURL|rawAuthURL|webOrigin|credentials|credentialSnapshotDir|keyCiphertext|privateKey|clientSecret|secret|password|bearer|jobLease|leaseToken|contextRef|jobService|environment|env|connectionLease|nodePath|sdkEntry|cliEntry|lockPath|runtimeLockPath)$/i.test(key)).map(([key, item]) => [key, publicPluginClientValue(item)]));
  return typeof value === 'string' ? redact(value) : value;
}
function keys(value, allowed) { if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail('Unsupported client request shape'); }
export function validatePluginClientCall(method, payload) {
  if (!methods.has(method)) throw fail('Unsupported work client method');
  if (method === 'describe') { if (payload != null && (!plain(payload) || Object.keys(payload).length)) throw fail('Describe takes no claims'); return null; }
  if (Buffer.byteLength(JSON.stringify(payload ?? null)) > 1024 * 1024) throw fail('Client request exceeds size limit', 'WORK_CLIENT_REQUEST_LIMIT');
  if (method === 'selectViewer') { keys(payload, ['characterId', 'personaId', 'expectedRevision']); if (typeof payload.characterId !== 'string' || !payload.characterId || payload.characterId.length > 300 || payload.personaId != null && (typeof payload.personaId !== 'string' || payload.personaId.length > 300) || !Number.isSafeInteger(payload.expectedRevision)) throw fail('Viewer selection is incomplete'); }
  if (method === 'chooseWorkspace') { keys(payload, ['purpose']); if (payload.purpose !== 'project-root') throw fail('Only a project directory chooser is exposed'); }
  if (method === 'request') { keys(payload, ['requestId', 'action', 'payload', 'expectedViewerRevision']); if (typeof payload.requestId !== 'string' || !payload.requestId || payload.requestId.length > 200 || !actions.has(payload.action) || !plain(payload.payload ?? {}) || !Number.isSafeInteger(payload.expectedViewerRevision)) throw fail('Work action is incomplete or not admitted'); }
  return structuredClone(payload);
}
export function validateWorkClientSender(event, binding, webContents) {
  if (!binding || event.sender !== webContents || event.sender.id !== binding.webContentsId || webContents.isDestroyed?.()) throw fail('This page has no work client admission');
  const frame = event.senderFrame, main = webContents.mainFrame;
  if (!frame || !main || frame !== main || frame.parent) throw fail('Only the admitted main frame may use work actions');
  trustedDshLocation(frame.url, binding.origin);
  return true;
}

/** A work-only WebContents. Community and third-party client windows never use this host.
 * open({...,surface}) shows the page in a host-supplied embedded view instead of its own window; admission,
 * sender checks and the visible/focused test for approvals go through the same row either way. */
export function createWorkClientHost({BrowserWindow, session, ipcMain, preloadPath, onState = () => {}, appearance = () => null, openExternal = async () => {}, audit = () => {}} = {}) {
  if (typeof BrowserWindow !== 'function' || !session?.fromPartition || !ipcMain?.handle || !ipcMain?.removeHandler || !isAbsolute(preloadPath ?? '')) throw TypeError('Scoped work client requires Electron, IPC and an absolute sandboxed preload');
  const windows = new Map(), senders = new Map(), cleanups = new Set(); let closed = false;
  // Same page-level theme and language as the other plugin pages (see plugin-page-appearance.mjs).
  const dress = row => { row.dressing = (row.dressing ?? Promise.resolve()).then(async () => { if (row.window.isDestroyed()) return; const key = await applyPluginPageAppearance(row.window.webContents, appearance({embedded: row.surface === 'embedded'}), row.styleKey ?? null); if (!row.window.isDestroyed()) row.styleKey = key; }).catch(() => {}); return row.dressing; };
  const emitState = (binding, state) => { try { onState({...binding, state}); } catch {} };
  const context = row => ({binding: {...row.binding, visible: row.window.isVisible?.() === true && row.window.isMinimized?.() !== true && row.window.isFocused?.() === true}, window: row.window, webContents: row.window.webContents});
  async function assertCurrent(row) { if (closed || row.window.isDestroyed() || windows.get(row.binding.packageKey) !== row) throw fail('Work client has closed', 'WORK_CLIENT_CLOSED'); if (typeof row.handlers.assertCurrent !== 'function') throw fail('Host lifecycle authority is unavailable'); await row.handlers.assertCurrent(context(row)); }
  ipcMain.handle(PLUGIN_CLIENT_CHANNEL, async (event, input) => {
    try {
      keys(input, ['method', 'payload']); const row = senders.get(event.sender.id); validateWorkClientSender(event, row?.binding, row?.window.webContents); await assertCurrent(row);
      const payload = validatePluginClientCall(input.method, input.payload), handler = row.handlers[input.method]; if (typeof handler !== 'function') throw fail('The work host has not supplied this action', 'WORK_CLIENT_HANDLER_UNAVAILABLE');
      const result = await handler(payload, context(row)); await assertCurrent(row);
      return {ok: true, result: publicPluginClientValue(result)};
    } catch (error) { return {ok: false, error: {code: error.code ?? 'WORK_CLIENT_FAILED', message: redact(String(error.message)).slice(0, 2000)}}; }
  });
  async function open({record, descriptor, handlers, surface = null}) {
    if (closed) throw fail('Work client host is closed', 'WORK_CLIENT_CLOSED');
    if (surface !== null && typeof surface !== 'function') throw fail('Work client surface must be host supplied');
    const mode = surface ? 'embedded' : 'window';
    if (record?.packageName !== '@ai-buddy/work-collaboration' || typeof record.packageKey !== 'string' || !record.pluginId || !Number.isSafeInteger(record.generation) || record.enabled !== true) throw fail('An enabled verified work package is required');
    if (!handlers || typeof handlers.assertCurrent !== 'function') throw fail('Host lifecycle check is mandatory');
    const {runtimeId, profileId, webOrigin, authURL, url} = descriptor ?? {};
    if (!runtimeId || !profileId || !String(profileId).startsWith('buddy-work-ui-')) throw fail('A private work UI runtime/profile is required');
    const target = trustedDshLocation(authURL ?? url, webOrigin);
    // one page per package: moving between the main window and its own window closes the other first
    if (windows.get(record.packageKey) && windows.get(record.packageKey).surface !== mode) { await closePackage(record.packageKey); if (closed) throw fail('Work client host is closed', 'WORK_CLIENT_CLOSED'); }
    const prior = windows.get(record.packageKey);
    if (prior) { if (prior.binding.runtimeId !== runtimeId || prior.binding.profileId !== profileId || prior.binding.origin !== target.origin || prior.binding.generation !== record.generation) throw fail('An older work client must drain before its admission changes', 'WORK_CLIENT_GENERATION_CHANGED'); await assertCurrent(prior); prior.window.show(); prior.window.focus(); return {runtimeId, profileId, state: prior.state, surface: mode}; }
    const partition = 'buddy-work-client-' + createHash('sha256').update([record.packageKey, runtimeId, profileId].join('\0')).digest('hex').slice(0, 24), browserSession = session.fromPartition(partition, {cache: false});
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); browserSession.setPermissionCheckHandler?.(() => false);
    const webPreferences = {session: browserSession, preload: preloadPath, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, devTools: false};
    const window = surface ? surface({webPreferences}) : new BrowserWindow({width: 1320, height: 900, minWidth: 700, minHeight: 520, show: false, title: 'AI Buddy · 工作与协作', webPreferences});
    const binding = Object.freeze({packageKey: record.packageKey, pluginId: record.pluginId, generation: record.generation, runtimeId, profileId, origin: target.origin, webContentsId: window.webContents.id, surface: mode});
    const row = {window, binding, handlers, surface: mode, state: 'loading', unsubscribe: null, closeAdmitted: false, closePending: false}; windows.set(record.packageKey, row); senders.set(window.webContents.id, row);
    const allowed = address => { try { trustedDshLocation(address, webOrigin); return true; } catch { return false; } };
    window.webContents.on('will-navigate', (event, address) => { if (!allowed(address)) event.preventDefault(); }); window.webContents.on('will-redirect', (event, address) => { if (!allowed(address)) event.preventDefault(); }); window.webContents.setWindowOpenHandler(pluginWindowOpenHandler({openExternal, audit, isClosed: () => closed || window.isDestroyed()})); window.webContents.on('will-attach-webview', event => event.preventDefault());
    const denyDownload = event => event.preventDefault(); browserSession.on?.('will-download', denyDownload);
    window.on('close', event => { if (row.closeAdmitted || typeof handlers.beforeClose !== 'function') return; event.preventDefault(); if (row.closePending) return; row.closePending = true; void Promise.resolve(handlers.beforeClose(null, context(row))).then(result => { if (result === true || result?.allowClose === true) { row.closeAdmitted = true; if (!window.isDestroyed()) window.destroy(); } }).catch(() => {}).finally(() => { row.closePending = false; }); });
    window.on('closed', () => { senders.delete(binding.webContentsId); if (windows.get(binding.packageKey) === row) windows.delete(binding.packageKey); row.unsubscribe?.(); browserSession.removeListener?.('will-download', denyDownload); const cleanup = Promise.resolve(browserSession.clearStorageData?.()).catch(() => {}); cleanups.add(cleanup); void cleanup.finally(() => cleanups.delete(cleanup)); emitState(binding, 'closed'); void Promise.resolve().then(() => handlers.onClose?.(null, {binding: {...binding, visible: false}, window, webContents: null})).catch(() => emitState(binding, 'close-callback-failed')); });
    window.webContents.on('render-process-gone', () => { emitState(binding, 'client-failed'); if (!window.isDestroyed()) window.destroy(); });
    if (typeof handlers.subscribe === 'function') row.unsubscribe = await handlers.subscribe(async (event, publication) => { try { await assertCurrent(row); if(publication?.isCurrent&&publication.isCurrent()!==true)return; const value = publicPluginClientValue(event); if (Buffer.byteLength(JSON.stringify(value)) <= 8 * 1024 * 1024 && !window.isDestroyed()) window.webContents.send(PLUGIN_CLIENT_EVENT, {event: value}); } catch {} }, context(row));
    let documentReady;
    const ready = new Promise(resolveReady => { documentReady = resolveReady; });
    const reveal = () => { if (!closed && !window.isDestroyed() && windows.get(record.packageKey) === row) { row.state = 'document-ready'; window.show(); emitState(binding, row.state); documentReady(); } };
    window.once?.('ready-to-show', reveal); window.webContents.once('dom-ready', reveal);
    window.webContents.on('dom-ready', () => { row.styleKey = null; void dress(row); });
    const loading = Promise.resolve().then(() => window.loadURL(target.href)).then(() => { if (closed || window.isDestroyed()) throw fail('Work page closed before loading completed', 'WORK_CLIENT_CLOSED'); row.state = 'page-loaded'; window.show(); emitState(binding, row.state); }).catch(error => { const stale = windows.get(record.packageKey) !== row; if (!window.isDestroyed()) window.destroy(); if (stale || error.code === 'WORK_CLIENT_CLOSED') throw fail('Work page closed before loading completed', 'WORK_CLIENT_CLOSED'); emitState(binding, 'client-failed'); throw fail('Native work page failed to load', 'WORK_CLIENT_LOAD_FAILED'); });
    try { await Promise.race([ready, loading]); void loading.catch(() => {}); return {runtimeId, profileId, state: row.state, surface: mode}; }
    catch (error) { if (!window.isDestroyed()) window.destroy(); throw error; }
  }
  async function closePackage(packageKey) { const row = windows.get(packageKey); if (row && !row.window.isDestroyed()) { row.closeAdmitted = true; row.window.destroy(); } await Promise.allSettled([...cleanups]); }
  async function close() { if (closed) return; closed = true; ipcMain.removeHandler(PLUGIN_CLIENT_CHANNEL); for (const key of [...windows.keys()]) await closePackage(key); await Promise.allSettled([...cleanups]); }
  async function refreshAppearance() { await Promise.all([...windows.values()].map(row => dress(row))); }
  // C-4: the same fixed page events as the other plugin pages
  async function notify(name) { const code = pageEventScript(name); await Promise.allSettled([...windows.values()].filter(row => !row.window.isDestroyed()).map(row => Promise.race([Promise.resolve().then(() => row.window.webContents.executeJavaScript(code, false)), new Promise(resolve => { const timer = setTimeout(resolve, 3000); timer.unref?.(); })]))); }
  return {open, closePackage, close, refreshAppearance, notify, snapshot: () => [...windows.values()].map(row => ({packageKey: row.binding.packageKey, runtimeId: row.binding.runtimeId, profileId: row.binding.profileId, generation: row.binding.generation, state: row.state, surface: row.surface}))};
}
