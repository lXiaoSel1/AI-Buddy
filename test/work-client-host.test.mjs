import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {resolve} from 'node:path';
import {createWorkClientHost, PLUGIN_CLIENT_CHANNEL, PLUGIN_CLIENT_EVENT, publicPluginClientValue, validatePluginClientCall} from '../src/work-client-host.mjs';

// Simulated Electron objects: these establish the IPC contract, not real UI/runtime acceptance.
function fixture(t) {
  const made = [], handlers = new Map(), states = [], delivered = [];
  class Window extends EventEmitter { constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); this.webContents.id = 100 + made.length; this.webContents.mainFrame = {url: 'http://127.0.0.1:54321/', parent: null}; this.webContents.setWindowOpenHandler = value => { this.openHandler = value; }; this.webContents.send = (channel, value) => delivered.push({channel, value}); this.webContents.isDestroyed = () => this.dead; made.push(this); } async loadURL(url) { this.loadedURL = url; } isDestroyed() { return !!this.dead; } show() { this.visible = true; } focus() {} destroy() { this.dead = true; this.emit('closed'); } }
  const session = {fromPartition() { return Object.assign(new EventEmitter(), {setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, clearStorageData: async () => {}}); }}, ipcMain = {handle(channel, handler) { assert.equal(handlers.has(channel), false); handlers.set(channel, handler); }, removeHandler(channel) { handlers.delete(channel); }};
  const host = createWorkClientHost({BrowserWindow: Window, session, ipcMain, preloadPath: resolve('build/plugin-client-preload.cjs'), onState: event => states.push(event)}); t.after(() => host.close());
  const record = {backend: 'dsh', packageName: '@ai-buddy/work-collaboration', packageKey: 'dsh:trusted:@ai-buddy/work-collaboration', pluginId: 'dsh.work', enabled: true, generation: 4};
  const descriptor = {runtimeId: 'actual-runtime-contract', profileId: 'buddy-work-ui-trusted', webOrigin: 'http://127.0.0.1:54321', authURL: 'http://127.0.0.1:54321/?token=PRIVATE-LAUNCH'};
  const invoke = (window, method, payload, frame = window.webContents.mainFrame) => handlers.get(PLUGIN_CLIENT_CHANNEL)({sender: window.webContents, senderFrame: frame}, {method, payload});
  return {host, made, states, delivered, handlers, record, descriptor, invoke};
}
test('closed callback uses stable binding after Electron methods are destroyed and closePackage does not await it',async t=>{const f=fixture(t);let deliver;const delivered=new Promise(resolve=>{deliver=resolve;});await f.host.open({record:f.record,descriptor:f.descriptor,handlers:{assertCurrent:async()=>{},onClose:(_payload,context)=>{deliver(context);return new Promise(()=>{});}}});const window=f.made[0];for(const name of ['isVisible','isMinimized','isFocused'])window[name]=()=>{throw Error('Electron object destroyed');};Object.defineProperty(window,'webContents',{get(){throw Error('WebContents destroyed');}});await f.host.closePackage(f.record.packageKey);const context=await delivered;assert.equal(context.binding.runtimeId,f.descriptor.runtimeId);assert.equal(context.binding.visible,false);assert.equal(context.webContents,null);assert.equal(context.window,window);assert.equal(f.host.snapshot().length,0);});
test('unit/sim: isolated work window gets only sandboxed minimal preload and keeps launch URL private', async t => {
  const f = fixture(t), seen = []; const result = await f.host.open({record: f.record, descriptor: f.descriptor, handlers: {assertCurrent: async ({binding}) => { seen.push(binding); }, describe: async () => ({viewer: {revision: 1}, authURL: f.descriptor.authURL, contextToken: 'private', nested: {bearer: 'private'}})}});
  const window = f.made[0], preferences = window.options.webPreferences; assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true); assert.equal(preferences.preload.endsWith('plugin-client-preload.cjs'), true); assert.deepEqual(window.openHandler(), {action: 'deny'});
  const value = await f.invoke(window, 'describe'); assert.equal(value.ok, true); assert.equal(value.result.authURL, undefined); assert.equal(value.result.contextToken, undefined); assert.equal(JSON.stringify(result).includes('PRIVATE-LAUNCH'), false); assert.equal(JSON.stringify(f.host.snapshot()).includes('127.0.0.1'), false); assert.equal(seen[0].generation, 4);
});
test('unit/sim: unrelated WebContents, subframes, foreign origins and stale generations cannot dispatch work', async t => {
  const f = fixture(t); let allowed = true, calls = 0; await f.host.open({record: f.record, descriptor: f.descriptor, handlers: {assertCurrent: async () => { if (!allowed) throw Object.assign(Error('changed'), {code: 'WORK_GENERATION_CHANGED'}); }, request: async () => { calls++; return {}; }}});
  const window = f.made[0], payload = {requestId: 'r', action: 'tasks.create', payload: {}, expectedViewerRevision: 1};
  assert.equal((await f.invoke(window, 'request', payload, {url: f.descriptor.webOrigin, parent: window.webContents.mainFrame})).ok, false);
  const original = window.webContents.mainFrame.url; window.webContents.mainFrame.url = 'https://evil.invalid'; assert.equal((await f.invoke(window, 'request', payload)).ok, false); window.webContents.mainFrame.url = original;
  const stranger = {id: 999}; assert.equal((await f.handlers.get(PLUGIN_CLIENT_CHANNEL)({sender: stranger, senderFrame: {}}, {method: 'request', payload})).ok, false);
  allowed = false; assert.equal((await f.invoke(window, 'request', payload)).error.code, 'WORK_GENERATION_CHANGED'); assert.equal(calls, 0);
});
test('unit/sim: events are scoped to the admitted work page and close removes the IPC handler', async t => {
  const f = fixture(t); let emit, unsubscribed = false; await f.host.open({record: f.record, descriptor: f.descriptor, handlers: {assertCurrent: async () => {}, subscribe(listener) { emit = listener; return () => { unsubscribed = true; }; }}});
  await emit({type: 'task-state', contextToken: 'private', payload: {text: 'Real contract event'}}); assert.equal(f.delivered[0].channel, PLUGIN_CLIENT_EVENT); assert.equal(JSON.stringify(f.delivered).includes('private'), false);
  await f.host.close(); assert.equal(unsubscribed, true); assert.equal(f.handlers.has(PLUGIN_CLIENT_CHANNEL), false); assert.equal(f.made[0].dead, true);
});

test('unit/sim: publication viewer guard is checked after asynchronous lifecycle check immediately before IPC send',async t=>{const f=fixture(t);let emit,entered,release,allowed=true;const started=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});await f.host.open({record:f.record,descriptor:f.descriptor,handlers:{assertCurrent:async()=>{entered();await held;},subscribe(listener){emit=listener;return()=>{};}}});const pending=emit({type:'text',payload:{text:'PRIVATE-OLD-VIEW'}},{isCurrent:()=>allowed});await started;allowed=false;release();await pending;assert.deepEqual(f.delivered,[]);allowed=true;await emit({type:'task-state',payload:{state:'planning'}},{isCurrent:()=>allowed});assert.equal(f.delivered.length,1);});
test('unit/sim: generation change requires old window drain; normal community profiles are rejected', async t => {
  const f = fixture(t), handlers = {assertCurrent: async () => {}}; await assert.rejects(f.host.open({record: f.record, descriptor: {...f.descriptor, profileId: 'buddy-community-v1'}, handlers}), {code: 'WORK_CLIENT_DENIED'});
  await f.host.open({record: f.record, descriptor: f.descriptor, handlers}); await assert.rejects(f.host.open({record: {...f.record, generation: 5}, descriptor: f.descriptor, handlers}), {code: 'WORK_CLIENT_GENERATION_CHANGED'}); assert.equal(f.made.length, 1);
});
test('minimal client schema rejects arbitrary channels, tool names and identity claims at the outer boundary', () => {
  assert.throws(() => validatePluginClientCall('shell', {})); assert.throws(() => validatePluginClientCall('request', {requestId: 'r', action: 'management.install', payload: {}, expectedViewerRevision: 1})); assert.throws(() => validatePluginClientCall('request', {requestId: 'r', action: 'tasks.create', payload: {}, expectedViewerRevision: 1, pluginId: 'forged'})); assert.throws(() => validatePluginClientCall('chooseWorkspace', {purpose: 'read-any-file'}));
  assert.equal(publicPluginClientValue({inputTokens: 7, contextToken: 'secret', url: 'http://127.0.0.1:1234/?token=secret'}).inputTokens, 7); assert.equal(JSON.stringify(publicPluginClientValue({url: 'http://127.0.0.1:1234/?token=secret'})).includes('token=secret'), false);
});

test('report UI admits only the finite report actions and strips any private service data', () => {
  for(const action of ['reports.read','reports.request','reports.retry'])assert.equal(validatePluginClientCall('request',{requestId:'report-ui',action,payload:{taskId:'task-one',reportId:'report-one'},expectedViewerRevision:1}).action,action);
  assert.throws(()=>validatePluginClientCall('request',{requestId:'report-ui',action:'reports.executeRawModel',payload:{},expectedViewerRevision:1}));
  const value=publicPluginClientValue({reports:[{id:'report-one',state:'failed',actualModelCalled:false,sourceProof:{eventId:'actual-event'},jobService:{bearer:'private'},environment:{API_KEY:'private'}}]});
  assert.equal(value.reports[0].sourceProof.eventId,'actual-event');assert.equal(value.reports[0].actualModelCalled,false);assert.equal(JSON.stringify(value).includes('private'),false);
});
