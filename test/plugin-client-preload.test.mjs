import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {pluginClientResult} from '../src/plugin-client-result.mjs';

test('sandbox preload exposes only finite methods and approval requires current genuine user activation', async () => {
  const contents = await readFile(new URL('../src/plugin-client-preload.mjs', import.meta.url), 'utf8'), compiled = await build({stdin: {contents, loader: 'js'}, bundle: true, format: 'cjs', platform: 'node', external: ['electron'], write: false, logLevel: 'silent'});
  const calls = [], listeners = new Map(), navigator = {userActivation: {isActive: false}}; let api;
  const electron = {contextBridge: {exposeInMainWorld(name, value) { assert.equal(name, 'aiBuddyPluginClient'); api = value; }}, ipcRenderer: {invoke(channel, value) { calls.push({channel, value}); return Promise.resolve({ok: true, result: {}}); }, on(channel, listener) { listeners.set(channel, listener); }, removeListener(channel) { listeners.delete(channel); }}};
  vm.runInNewContext(compiled.outputFiles[0].text, {require: name => { assert.equal(name, 'electron'); return electron; }, navigator});
  assert.deepEqual(Object.keys(api), ['describe', 'selectViewer', 'chooseWorkspace', 'request', 'subscribe']);
  const request = {requestId: 'approval', action: 'plans.approve', payload: {taskId: 'task', planRevision: 1, planHash: 'hash'}, expectedViewerRevision: 0};
  assert.equal((await api.request(request)).error.code, 'WORK_USER_ACTIVATION_REQUIRED'); assert.equal(calls.length, 0);
  assert.equal((await api.request({...request, action: 'native.respond'})).error.code, 'WORK_USER_ACTIVATION_REQUIRED'); assert.equal(calls.length, 0);
  navigator.userActivation.isActive = true; await api.request(request); assert.equal(calls.length, 1); assert.equal(calls[0].channel, 'buddy-plugin-client:invoke');
  navigator.userActivation.isActive = false; await api.request({...request, action: 'tasks.read'}); assert.equal(calls.length, 2);
  let delivered; const unsubscribe = api.subscribe(value => { delivered = value; }); listeners.get('buddy-plugin-client:event')({privateEvent: true}, {event: {type: 'task-state'}}); assert.equal(delivered.event.type, 'task-state'); assert.equal(delivered.privateEvent, undefined); unsubscribe(); assert.equal(listeners.size, 0);
});

test('plain core work-open failure survives cloning and becomes an Error only in the receiving renderer', () => {
  const wire = {__buddyError: true, code: 'WORK_PLUGIN_DISABLED', message: 'Work plugin is disabled', details: {generation: 4}}, cloned = JSON.parse(JSON.stringify(wire));
  assert.throws(() => pluginClientResult(cloned), error => error.code === 'WORK_PLUGIN_DISABLED' && error.details.generation === 4);
  const success = {runtimeId: 'actual-runtime', state: 'document-ready'}; assert.equal(pluginClientResult(success), success);
});

test('voice failures remain plain across the preload bridge and retain their code in the receiving renderer',async()=>{
 const contents=await readFile(new URL('../src/preload.mjs',import.meta.url),'utf8'),compiled=await build({stdin:{contents,loader:'js'},bundle:true,format:'cjs',platform:'node',external:['electron'],write:false,logLevel:'silent'});
 let api,transport=false;const wire={__buddyError:true,code:'VOICE_PACKAGE_UNAVAILABLE',message:'Selected voice package is unavailable'};
 const electron={contextBridge:{exposeInMainWorld(_name,value){api=value;}},ipcRenderer:{invoke:async channel=>{assert.equal(channel,'voice:action');if(transport)throw Error('Error invoking remote method \'voice:action\': Error: channel closed');return wire;}}};
 vm.runInNewContext(compiled.outputFiles[0].text,{require:name=>{assert.equal(name,'electron');return electron;}});
 const received=JSON.parse(JSON.stringify(await api.voice.action('profiles',{})));
 assert.equal(received.__buddyError,true);assert.throws(()=>pluginClientResult(received),{code:'VOICE_PACKAGE_UNAVAILABLE'});
 transport=true;const failed=JSON.parse(JSON.stringify(await api.voice.action('state')));assert.equal(failed.__buddyError,true);assert.equal(failed.code,'VOICE_TRANSPORT_FAILED');assert.equal(failed.message,'channel closed');
});
