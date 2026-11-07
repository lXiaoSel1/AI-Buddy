import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEFAULT_PREFERENCES,normalizePreferences,validatePreferencesPatch} from '../src/preferences.mjs';
import {createSnapshotStorage,readJson} from '../src/storage.mjs';
import {ModelRouter} from '../src/model-router.mjs';
import {createChatPreferences} from '../src/chat-preferences.mjs';

const main=await readFile(new URL('../src/main.mjs',import.meta.url),'utf8');
const startup=main.slice(main.indexOf('  const firstPreferences='),main.indexOf('  // Resolve the saved/manual'));
const setters=main.slice(main.indexOf('function setPreferences('),main.indexOf('function applyChrome('));
const shutdown=main.slice(main.indexOf('async function shutdown('),main.indexOf("app.on('before-quit'"));
const saving=main.slice(main.includes('function serializeSettings(')?main.indexOf('function serializeSettings('):main.indexOf('async function saveSettings('),main.indexOf('function settingsView('));
const petVisibility=main.slice(main.indexOf('async function syncPetVisibility('),main.indexOf('function setPreferences('));
const crypto={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()};
async function fixture(t,{preferences={petVisible:false},legacy=true}={}){
 const dataRoot=await mkdtemp(join(tmpdir(),'buddy-chat-startup-')),requests=[],routers=[];
 const codex={defaultModel:'fixture-model',enabled:false,setEnabled(value){this.enabled=value;},async *stream(){requests.push('codex');throw Error('Model calls are forbidden');}};
 const makeRouter=async()=>{const router=new ModelRouter({dataRoot,codex,crypto,legacy,fetchImpl:()=>{requests.push('api');throw Error('API calls are forbidden');}});routers.push(router);await router.ready;return router;};
 t.after(async()=>{for(const router of routers)router.close();await rm(dataRoot,{recursive:true,force:true});});
 const store=createSnapshotStorage(join(dataRoot,'settings.json'));
 await store.writeText(JSON.stringify({preferences,petBounds:{x:10,y:20}}));
 const settings=await readJson(createSnapshotStorage(join(dataRoot,'settings.json')),null),provider=await makeRouter();
 const events=[],persistence={write:preferences=>store.writeText(JSON.stringify({...settings,preferences}))};
 const chatPreferences=createChatPreferences({provider,read:()=>settings.preferences,write:preferences=>persistence.write(preferences),apply:preferences=>{settings.preferences=preferences;},serialize:run=>context.serializeSettings?context.serializeSettings(run):run(),audit:event=>events.push(event)});
 const context={settings,provider,chatPreferences,startupFailure:null,legacyGameSettings:{petEnabled:false},game:null,app:{getLocale:()=> 'en'},normalizePreferences,setLocale(){},saveSettings:()=>store.writeText(JSON.stringify(settings)),DEFAULT_PREFERENCES,validatePreferencesPatch,settingsTail:Promise.resolve(),quitting:false,shuttingDown:false,assertImportIdle(){if(context.importBarrier)throw Error('Import in progress');},effectivePetCharacter:()=> 'deepseek',resources:{require(){}},drag:null,applyChrome(){},applyPetPreferences(){},worker:null,audit:event=>events.push(event),broadcastSettings:()=>({preferences:{...settings.preferences},modelConnections:provider.view()})};
 context.settingsStore=store;context.settingsWriteTail=Promise.resolve();vm.createContext(context);vm.runInContext(saving+petVisibility+setters,context);
 const boot=async()=>vm.runInContext('(async()=>{'+startup+'})()',context);
 return {dataRoot,settings,provider,store,requests,makeRouter,boot,chatPreferences,context,persistence,events};
}

test('legacy preferences restore online chat on startup when the saved connection is usable',async t=>{
 const f=await fixture(t);await f.boot();
 assert.equal(f.provider.status().enabled,true,'startup must restore online chat instead of resetting the runtime switch');
 assert.equal(f.settings.preferences.chatEnabled,true);
 assert.deepEqual(f.requests,[]);
});

test('chatEnabled defaults on, preserves explicit off and rejects non-boolean patches',()=>{
 assert.equal(normalizePreferences().chatEnabled,true);
 assert.equal(normalizePreferences({chatEnabled:false}).chatEnabled,false);
 assert.equal(normalizePreferences({chatEnabled:'false'}).chatEnabled,true);
 for(const value of [null,0,1,'true','false'])assert.throws(()=>validatePreferencesPatch({chatEnabled:value}));
});

test('explicit off survives close and restart; runtime close never changes the saved choice',async t=>{
 const f=await fixture(t);await f.boot();
 await f.context.setPreferences({chatEnabled:false});f.provider.close();
 const saved=await readJson(createSnapshotStorage(join(f.dataRoot,'settings.json')),null),restarted=await f.makeRouter();
 const restored=createChatPreferences({provider:restarted,read:()=>normalizePreferences(saved.preferences)});
 restored.restore();assert.equal(restarted.enabled,false);assert.equal(saved.preferences.chatEnabled,false);
 await f.context.setPreferences({chatEnabled:true});f.provider.close();
 const savedOn=await readJson(createSnapshotStorage(join(f.dataRoot,'settings.json')),null),onRestart=await f.makeRouter();
 createChatPreferences({provider:onRestart,read:()=>normalizePreferences(savedOn.preferences)}).restore();
 assert.equal(onRestart.enabled,true);assert.equal(savedOn.preferences.chatEnabled,true);assert.deepEqual(f.requests,[]);
});

test('chat IPC and General Settings share durable serialized state, including a same-value re-enable',async t=>{
 const f=await fixture(t,{preferences:{chatEnabled:false}});await f.boot();
 const handlers=new Map();f.context.ipcMain={handle:(name,handler)=>handlers.set(name,handler)};f.context.updateGuard=(_,run)=>run();
 vm.runInContext(main.split('\n').find(line=>line.startsWith("ipcMain.handle('chat:enabled'")),f.context);
 const toggle=handlers.get('chat:enabled');
 const values=await Promise.all([toggle(null,true),f.context.setPreferences({chatEnabled:false}),toggle(null,true)]);
 assert.deepEqual(values.map(value=>value.enabled??value.modelConnections.enabled),[true,false,true]);
 f.provider.close();await f.context.setPreferences({chatEnabled:true});
 assert.equal(f.provider.enabled,true,'an explicit enable also repairs saved-on/runtime-off state');
 const saved=await readJson(createSnapshotStorage(join(f.dataRoot,'settings.json')),null);
 assert.equal(saved.preferences.chatEnabled,true);assert.deepEqual(f.requests,[]);
});

test('real storage failure does not enable chat or mutate any prior preferences',async t=>{
 const f=await fixture(t,{preferences:{chatEnabled:false,maxOutputTokens:4096}});await f.boot();
 const before=structuredClone(f.settings.preferences),blocked=join(f.dataRoot,'blocked');await writeFile(blocked,'file blocks a directory');
 const failing=createSnapshotStorage(join(blocked,'settings.json'));
 f.persistence.write=preferences=>failing.writeText(JSON.stringify({...f.settings,preferences}));
 await assert.rejects(f.context.setPreferences({chatEnabled:true,maxOutputTokens:2048}));
 assert.deepEqual(f.settings.preferences,before);assert.equal(f.provider.enabled,false);
 assert.deepEqual((await readJson(createSnapshotStorage(join(f.dataRoot,'settings.json')),null)).preferences,before);
});

test('a position autosave during chat preference publication cannot overwrite the accepted chat choice',async t=>{
 const f=await fixture(t,{preferences:{chatEnabled:false}});await f.boot();
 let release,entered;const held=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;}),write=f.persistence.write;
 f.persistence.write=async next=>{const published=write(next);entered();await held;return published;};
 const changing=f.context.setPreferences({chatEnabled:true});await started;
 f.settings.petBounds.x=99;const positionSave=f.context.saveSettings();
 release();await changing;await positionSave;
 const saved=await readJson(createSnapshotStorage(join(f.dataRoot,'settings.json')),null);
 assert.equal(saved.preferences.chatEnabled,true,'a queued ordinary settings snapshot must observe the committed chat preference');
 assert.equal(saved.petBounds.x,99);assert.equal(f.provider.enabled,true);
});

test('a queued position autosave retains the previous chat choice after a real preference write failure',async t=>{
 const f=await fixture(t,{preferences:{chatEnabled:false,maxOutputTokens:4096}});await f.boot();
 const blocked=join(f.dataRoot,'blocked-concurrent');await writeFile(blocked,'file blocks a directory');const failing=createSnapshotStorage(join(blocked,'settings.json'));
 let release,entered;const held=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 f.persistence.write=async next=>{entered();await held;return failing.writeText(JSON.stringify({...f.settings,preferences:next}));};
 const changing=assert.rejects(f.context.setPreferences({chatEnabled:true,maxOutputTokens:2048}));await started;
 f.settings.petBounds.x=99;const positionSave=f.context.saveSettings();release();await changing;await positionSave;
 const saved=await readJson(createSnapshotStorage(join(f.dataRoot,'settings.json')),null);
 assert.equal(saved.preferences.chatEnabled,false);assert.equal(saved.preferences.maxOutputTokens,4096);
 assert.equal(saved.petBounds.x,99);assert.equal(f.provider.enabled,false);
});

test('a pet visibility update during chat publication retains both accepted preferences',async t=>{
 const f=await fixture(t,{preferences:{chatEnabled:false,petVisible:false}});await f.boot();
 let release,entered;const held=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;}),write=f.persistence.write;
 f.persistence.write=async next=>{const published=write(next);entered();await held;return published;};
 const changing=f.context.setPreferences({chatEnabled:true});await started;
 const visibility=f.context.syncPetVisibility(true);release();await changing;await visibility;
 const saved=await readJson(createSnapshotStorage(join(f.dataRoot,'settings.json')),null);
 assert.equal(saved.preferences.chatEnabled,true);assert.equal(saved.preferences.petVisible,true);
 assert.equal(f.settings.preferences.petVisible,true);assert.equal(f.provider.enabled,true);
});

test('chat preference merges the latest visibility when both writes wait behind an earlier snapshot',async t=>{
 const f=await fixture(t,{preferences:{chatEnabled:false,petVisible:false}});await f.boot();
 let release;f.context.settingsWriteTail=new Promise(resolve=>{release=resolve;});
 const visibility=f.context.syncPetVisibility(true),changing=f.context.setPreferences({chatEnabled:true});
 await new Promise(resolve=>setImmediate(resolve));release();await visibility;await changing;
 const saved=await readJson(createSnapshotStorage(join(f.dataRoot,'settings.json')),null);
 assert.equal(saved.preferences.chatEnabled,true);assert.equal(saved.preferences.petVisible,true);
 assert.equal(f.settings.preferences.petVisible,true);assert.equal(f.provider.enabled,true);
});

test('startup and default reset tolerate missing models; explicit enable reports the configuration error',async t=>{
 const f=await fixture(t,{legacy:false});await f.boot();
 assert.equal(f.settings.preferences.chatEnabled,true);assert.equal(f.provider.enabled,false);
 assert.equal(f.events.at(-1).type,'chat-restore-unavailable');
 await f.context.settingsAction('defaults');assert.equal(f.provider.enabled,false);
 await assert.rejects(f.context.setPreferences({chatEnabled:true}),/模型 ID/);
 assert.equal(f.provider.enabled,false);assert.deepEqual(f.requests,[]);
});

test('an invalid selected model and companion safe mode cannot auto-enable startup chat',async t=>{
 const f=await fixture(t);await f.provider.save({id:'codex',kind:'codex',name:'Invalid fixture',model:''});await f.boot();
 assert.equal(f.provider.enabled,false);assert.equal(f.settings.preferences.chatEnabled,true);
 const safe=await fixture(t);safe.context.startupFailure={scope:'companion'};await safe.boot();
 assert.equal(safe.provider.enabled,false);assert.equal(safe.settings.preferences.chatEnabled,true);assert.deepEqual(safe.requests,[]);
});

test('a configuration changed during the write rolls back the entire preference snapshot',async t=>{
 const f=await fixture(t,{preferences:{chatEnabled:false,maxOutputTokens:4096}});await f.boot();const before=structuredClone(f.settings.preferences),write=f.persistence.write;
 let changed=false;f.persistence.write=async next=>{await write(next);if(!changed){changed=true;await f.provider.remove('codex');}};
 await assert.rejects(f.context.setPreferences({chatEnabled:true,maxOutputTokens:2048}),/模型 ID/);
 assert.deepEqual(f.settings.preferences,before);assert.equal(f.provider.enabled,false);
 assert.deepEqual((await readJson(createSnapshotStorage(join(f.dataRoot,'settings.json')),null)).preferences,before);
});

test('queued chat saves recheck the import barrier and reject new writes during shutdown',async t=>{
 const f=await fixture(t,{preferences:{chatEnabled:false}});await f.boot();
 let release;f.context.settingsTail=new Promise(resolve=>{release=resolve;});
 const pending=f.context.setPreferences({chatEnabled:true});f.context.importBarrier=true;release();
 await assert.rejects(pending,/Import in progress/);assert.equal(f.provider.enabled,false);
 f.context.importBarrier=false;f.context.shuttingDown=true;
 await assert.rejects(f.context.setPreferences({chatEnabled:true}),/正在退出/);assert.equal(f.provider.enabled,false);
});

test('shutdown drains an accepted setting before closing the runtime and retains its durable choice',async t=>{
 const f=await fixture(t,{preferences:{chatEnabled:false}});await f.boot();
 let release,entered;const held=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;}),write=f.persistence.write;
 f.persistence.write=async next=>{entered();await held;return write(next);};
 const noop=()=>{};Object.assign(f.context,{updateReservation:{committed:()=>false},dailyCgScheduler:null,rewardTail:Promise.resolve(),agents:null,pluginEmbed:null,plugins:null,pluginUsage:null,petDiagnostics:null,dataImport:null,buttonObserver:null,trajectoryWindow:null,quotas:null,cg:null,game:null,workSourceRegistry:null,appUpdates:null,control:{close:noop},closePetFullscreen:noop,applyPetVisibility:noop,syncPetFullscreenObserver:noop,dialog:{showMessageBox:async()=>({response:2})}});
 let exited=false;f.context.app.exit=()=>{exited=true;};vm.runInContext(shutdown,f.context);
 const saving=f.context.setPreferences({chatEnabled:true});await started;const closing=f.context.shutdown();
 await new Promise(resolve=>setImmediate(resolve));assert.equal(exited,false);
 release();await saving;await closing;
 assert.equal(exited,true);assert.equal(f.provider.enabled,false);
 assert.equal((await readJson(createSnapshotStorage(join(f.dataRoot,'settings.json')),null)).preferences.chatEnabled,true);
 assert.deepEqual(f.requests,[]);
});
