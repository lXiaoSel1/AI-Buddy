import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createPluginUsageRecorder} from '../src/plugin-usage-recorder.mjs';
import {createSocialAccounts} from '../src/buddy-plugin-services/social-accounts.mjs';
import {createSocialTransport} from '../src/buddy-plugin-services/social-transport.mjs';
import {createFeedingService} from '../src/companion-feeding.mjs';
import {createCompanionService} from '../src/companion-service.mjs';
import {openCompanionStore} from '../src/companion-store.mjs';
import {QuotaService} from '../src/quota-service.mjs';
import {companionFixture,syntheticEngine} from './support/audit-harness.mjs';
const moduleUrl=new URL('../src/plugin-shutdown.mjs',import.meta.url);
async function load(){return import(moduleUrl.href);}
test('failed plugin closure restores a new platform before allowing the app to continue',async()=>{
 const {closePluginServices}=await load(),calls=[],replacement={id:'new'};
 const platform={async close(){calls.push('close');throw Object.assign(Error('close failed'),{code:'PLUGIN_CLOSE_FAILED'});},async restoreAfterCloseFailure(){calls.push('restore');return replacement;}};
 await assert.rejects(closePluginServices({voice:{async quiesce(){calls.push('quiesce');}},platform,attach:async value=>{assert.equal(value,replacement);calls.push('attach');}}),error=>error.code==='PLUGIN_CLOSE_FAILED'&&error.shutdownRecovery==='restored');
 assert.deepEqual(calls,['quiesce','close','restore','attach']);
});
test('unconfirmed old process shutdown remains a failed recovery without reopening admission',async()=>{
 const {closePluginServices}=await load();let attached=false;
 await assert.rejects(closePluginServices({voice:{quiesce:async()=>{}},platform:{close:async()=>{throw Error('close failed');},restoreAfterCloseFailure:async()=>{throw Object.assign(Error('old process still alive'),{code:'PLUGIN_RESTORE_FAILED'});}},attach:()=>{attached=true;}}),error=>error.code==='PLUGIN_SHUTDOWN_RECOVERY_FAILED'&&error.shutdownRecovery==='failed'&&error.errors.length===2);
 assert.equal(attached,false);
});
test('voice quiesce failure never closes the platform and successful shutdown never rebuilds it',async()=>{
 const {closePluginServices}=await load();let closes=0,restores=0;
 const platform={close:async()=>{closes++;},restoreAfterCloseFailure:async()=>{restores++;}};
 await assert.rejects(closePluginServices({voice:{quiesce:async()=>{throw Error('voice stop failed');}},platform}),/voice stop failed/);assert.equal(closes,0);
 await closePluginServices({voice:{quiesce:async()=>{}},platform});assert.equal(closes,1);assert.equal(restores,0);
});
test('main keeps business services alive until recoverable plugin close and rebinds its client',async()=>{
 const main=await readFile(new URL('../src/main.mjs',import.meta.url),'utf8'),fixture=await shutdownFixture();await fixture.shutdown();
 assert.ok(fixture.events.indexOf('plugins')<fixture.events.indexOf('daily-cg'));
 assert.match(main,/attachPluginRuntime\s*=\s*replacement\s*=>/);assert.match(main,/pluginClientStateOff\?\.\(\)/);assert.match(main,/plugins\?\.extensionsReady\?\.\(\)/);
});

test('later shutdown failures are aggregated without skipping saves and completed closes are not repeated',async()=>{
 const {closeAppServices}=await load(),completed=new Set(),calls=[];let first=true;
 const steps=[['voice',async()=>{calls.push('voice');if(first){first=false;throw Error('voice close failed');}}],['save',async()=>{calls.push('save');}],['game',async()=>{calls.push('game');}]];
 await assert.rejects(closeAppServices(steps,completed),error=>error.code==='APP_SHUTDOWN_FAILED'&&error.failedSteps.join(',')==='voice');
 assert.deepEqual(calls,['voice','save','game']);assert.deepEqual([...completed],['save','game']);
 await closeAppServices(steps,completed);assert.deepEqual(calls,['voice','save','game','voice']);
});

// Run the production main-process shutdown wiring with only its service/Electron
// boundaries supplied by the fixture. No app startup, account or model is used.
async function shutdownFixture({failures={},responses=[0],forUpdate=false}={}){
 const main=await readFile(new URL('../src/main.mjs',import.meta.url),'utf8'),source=main.slice(main.indexOf('let shuttingDown=false;'),main.indexOf('function flushSessionEndSync()')),events=[],dialogs=[],attempts={},hooks={};
 const run=name=>async()=>{events.push(name);attempts[name]=(attempts[name]??0)+1;if(attempts[name]<=(failures[name]??0))throw Object.assign(Error('Sensitive account/prompt details must stay out of the dialog'),{code:'FIXTURE_CLOSE_FAILED'});};
 const context={...await load(),quitting:false,shutdownRecoveryFailed:false,dataRoot:'isolated-shutdown-fixture',panel:null,pet:null,t:value=>value,audit:()=>{},
  deferredSaves:{flushAll:run('save'),stop:()=>events.push('deferred-stop')},agents:{busy:()=>false,close:run('agents')},
  updateReservation:{committed:()=>forUpdate,reopenAfterFailedShutdown:()=>events.push('update-reopen')},monitorProfile:{cancel:()=>{}},mainProfile:{cancel:()=>{}},closePetFullscreen:()=>{},applyPetVisibility:()=>{},syncPetFullscreenObserver:()=>{},
  voiceHost:{quiesce:run('quiesce'),close:run('voice')},plugins:{close:run('plugins')},attachPluginRuntime:()=>{},dailyCgScheduler:{stopAndDrain:run('daily-cg')},rewardTail:Promise.resolve(),
  pluginClientStateOff:null,pluginEmbed:{close:run('plugin-pages')},pluginUsage:{close:run('plugin-usage')},petDiagnostics:{dispose:()=>{}},dataImport:{close:()=>{}},buttonObserver:{close:run('buttons')},trajectoryWindow:null,quotas:{close:()=>{}},
  settingsTail:Promise.resolve(),settingsWriteTail:Promise.resolve(),provider:{close:()=>{}},cg:{close:run('cg')},game:{flushWorkLedger:run('work-ledger'),close:run('game')},workSourceRegistry:{flush:run('work-sources')},worker:null,
  appUpdates:{close:()=>events.push('app-updates')},network:{close:run('network')},control:{close:()=>events.push('control-close')},
  app:{on:(name,hook)=>{hooks[name]=hook;},relaunch:(...args)=>{assert.deepEqual(args,[],'Electron keeps the original executable, cwd and arguments');events.push('relaunch');},exit:code=>{assert.equal(code,0);events.push('exit');}},
  dialog:{showMessageBox:async(_window,options)=>{dialogs.push(options);return {response:responses.shift()??1};}},
 };
 const lifecycle=Function('context','with(context){'+source+';return {shutdown,state:()=>({quitting,shuttingDown,shutdownRecoveryFailed})};}')(context);
 return {...lifecycle,events,dialogs,attempts,beforeQuit:()=>hooks['before-quit']({preventDefault:()=>events.push('prevent-quit')})};
}

test('exit and reopen retries the failed step once and preserves successful shutdown steps',async()=>{
 const fixture=await shutdownFixture({failures:{buttons:1}});await fixture.shutdown();
 assert.equal(fixture.attempts.buttons,2,'the primary dialog action retries the failed close');
 assert.equal(fixture.dialogs[0].message,'部分服务已经停止。重新打开后就能继续用。');
 assert.deepEqual(fixture.dialogs[0].buttons,['退出并重新打开','稍后']);
 assert.equal(fixture.attempts.buttons,2);for(const name of ['save','quiesce','plugins','agents','voice','plugin-usage','cg','work-ledger','game','work-sources','network'])assert.equal(fixture.attempts[name],1,name);
 assert.deepEqual(fixture.events.slice(-4),['control-close','deferred-stop','relaunch','exit']);
});

test('a repeated non-saving cleanup failure offers reopen only after every save completed',async()=>{
 const fixture=await shutdownFixture({failures:{buttons:Infinity},responses:[0,0]});await fixture.shutdown();
 assert.equal(fixture.attempts.buttons,2);assert.equal(fixture.dialogs.length,2);
 assert.deepEqual(fixture.dialogs[1].buttons,['仍然重新打开','稍后']);assert.match(fixture.dialogs[1].detail,/桌宠按键 \(FIXTURE_CLOSE_FAILED\)/);
 assert.doesNotMatch(JSON.stringify(fixture.dialogs),/Sensitive account|prompt details/);
 assert.deepEqual(fixture.events.slice(-4),['control-close','deferred-stop','relaunch','exit']);
 assert.equal(fixture.attempts.game,1);assert.equal(fixture.attempts.network,1);
});

test('a repeated save failure lists every failed step and never offers or performs forced reopen',async()=>{
 const fixture=await shutdownFixture({failures:{game:Infinity,buttons:Infinity},responses:[0,0]});await fixture.shutdown();
 assert.deepEqual(fixture.dialogs[1].buttons,['稍后']);assert.match(fixture.dialogs[1].detail,/陪伴存档 \(FIXTURE_CLOSE_FAILED\)/);assert.match(fixture.dialogs[1].detail,/桌宠按键 \(FIXTURE_CLOSE_FAILED\)/);
 assert.equal(fixture.attempts.game,2);assert.equal(fixture.attempts.buttons,2);assert.equal(fixture.attempts['work-sources'],1);assert.equal(fixture.attempts.network,1);
 assert.ok(!fixture.events.includes('relaunch'));assert.ok(!fixture.events.includes('exit'));assert.ok(!fixture.events.includes('control-close'));
 assert.deepEqual(fixture.state(),{quitting:false,shuttingDown:false,shutdownRecoveryFailed:true});
});

test('later retains blocked admission and a subsequent quit still retries only unfinished work',async()=>{
 const fixture=await shutdownFixture({failures:{buttons:1},responses:[1]});await fixture.shutdown();
 assert.equal(fixture.attempts.buttons,1);assert.ok(!fixture.events.includes('exit'));assert.equal(fixture.state().shutdownRecoveryFailed,true);
 await fixture.shutdown();assert.equal(fixture.attempts.buttons,2);assert.equal(fixture.attempts.game,1);assert.equal(fixture.attempts.save,1);
 assert.equal(fixture.events.at(-1),'exit');assert.ok(!fixture.events.includes('relaunch'));
});

test('maintenance shutdown has no restart actions and a successful retry exits without relaunching',async()=>{
 const fixture=await shutdownFixture({failures:{buttons:1},forUpdate:true,responses:[0]});await fixture.shutdown();
 assert.equal(fixture.dialogs.length,1);assert.deepEqual(fixture.dialogs[0].buttons,['返回']);assert.ok(!fixture.events.includes('relaunch'));assert.ok(!fixture.events.includes('exit'));
 await fixture.shutdown();assert.equal(fixture.events.at(-1),'exit');assert.equal(fixture.attempts.game,1);assert.ok(!fixture.events.includes('relaunch'));
});

test('the Electron before-quit guard runs shutdown once and relaunch is scheduled after final cleanup',async()=>{
 const fixture=await shutdownFixture({failures:{buttons:1},responses:[0]});fixture.beforeQuit();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(fixture.events.filter(name=>name==='prevent-quit').length,1);assert.equal(fixture.events.filter(name=>name==='relaunch').length,1);assert.equal(fixture.events.filter(name=>name==='exit').length,1);
 assert.deepEqual(fixture.events.slice(-4),['control-close','deferred-stop','relaunch','exit']);
});

test('an ordinary successful quit never schedules a relaunch',async()=>{
 const fixture=await shutdownFixture();await fixture.shutdown();assert.equal(fixture.dialogs.length,0);assert.ok(!fixture.events.includes('relaunch'));assert.equal(fixture.events.at(-1),'exit');
});

async function persistenceFixture(t){
 const dataRoot=await mkdtemp(join(tmpdir(),'audit213-shutdown-')),closers=[],failed=new Set(),originalClose=DatabaseSync.prototype.close;
 t.after(async()=>{t.mock.restoreAll();for(const close of closers.reverse())await Promise.resolve().then(close).catch(()=>{});for(const db of failed)try{originalClose.call(db);}catch{}assert.ok(resolve(dataRoot).startsWith(resolve(tmpdir())+sep));await rm(dataRoot,{recursive:true,force:true});});
 return {dataRoot,close:fn=>closers.push(fn),fail(method,predicate=()=>true){const original=DatabaseSync.prototype[method];let injected=false;const failure=Object.assign(Error('Injected isolated persistence failure'),{code:'FIXTURE_SAVE_FAILED'});t.mock.method(DatabaseSync.prototype,method,function(...args){if(!injected&&predicate(...args)){injected=true;failed.add(this);throw failure;}return original.apply(this,args);});return failure;}};
}

test('a real usage recorder keeps a checkpoint failure rejected instead of treating its closed flag as a saved receipt',async t=>{
 const f=await persistenceFixture(t),recorder=createPluginUsageRecorder({dataRoot:f.dataRoot});f.close(()=>recorder.close());
 await recorder.record({pluginId:'shutdown.fixture',sessionId:'session',nativeRequestId:'request',engine:'fixture',nativeSessionId:'native',usageMode:'request',origin:'managed-receipt',accounting:'independent',usage:{totalTokens:1}});
 const failure=f.fail('exec',sql=>sql==='PRAGMA wal_checkpoint(TRUNCATE)');await assert.rejects(recorder.close(),error=>error===failure);await assert.rejects(recorder.close(),error=>error===failure);
});

test('a real social transport repeats a failed database close as failure',async t=>{
 const f=await persistenceFixture(t),accounts=createSocialAccounts({dataRoot:f.dataRoot}),transport=createSocialTransport({dataRoot:f.dataRoot,accounts});f.close(()=>accounts.close());f.close(()=>transport.close());
 const failure=f.fail('close');await assert.rejects(transport.close(),error=>error===failure);await assert.rejects(transport.close(),error=>error===failure);
});

test('a real account store retains a synchronous database close failure',async t=>{
 const f=await persistenceFixture(t),accounts=createSocialAccounts({dataRoot:f.dataRoot});f.close(()=>accounts.close());const failure=f.fail('close');
 assert.throws(()=>accounts.close(),error=>error===failure);assert.throws(()=>accounts.close(),error=>error===failure);
});

test('real feeding close never converts a failed economy checkpoint into a successful second close',async t=>{
 const f=await persistenceFixture(t),feeding=createFeedingService({dataRoot:f.dataRoot});f.close(()=>feeding.close());const failure=f.fail('exec',sql=>sql==='PRAGMA wal_checkpoint(TRUNCATE)');
 await assert.rejects(feeding.close(),error=>error===failure);await assert.rejects(feeding.close(),error=>error===failure);
});

async function companionPersistenceFixture(t){
 const f=await persistenceFixture(t),store=await openCompanionStore(f.dataRoot),seed=await companionFixture();await store.mutate(state=>Object.assign(state,seed));
 const {engine}=syntheticEngine({getStore:()=>store}),service=await createCompanionService({store,engine,provider:{enabled:false},dataRoot:f.dataRoot,automaticWorkAllowed:()=>false});
 f.close(()=>store.flush());f.close(()=>service.close());return {...f,service,store};
}

const containsFailure=(error,failure)=>error===failure||error?.errors?.some(child=>containsFailure(child,failure))===true;
test('real R95 close propagates feeding persistence failure and retains the rejected close',async t=>{
 const f=await companionPersistenceFixture(t),failure=f.fail('exec',sql=>sql==='PRAGMA wal_checkpoint(TRUNCATE)');
 await assert.rejects(f.service.r95.close(),error=>containsFailure(error,failure));await assert.rejects(f.service.r95.close(),error=>containsFailure(error,failure));
});

test('the real companion service propagates component save failures on every retry',async t=>{
 const f=await companionPersistenceFixture(t),failure=f.fail('exec',sql=>sql==='PRAGMA wal_checkpoint(TRUNCATE)'),flush= t.mock.method(f.store,'flush',f.store.flush.bind(f.store));
 await assert.rejects(f.service.close(),error=>containsFailure(error,failure));const saved=flush.mock.callCount();await assert.rejects(f.service.close(),error=>containsFailure(error,failure));assert.equal(flush.mock.callCount(),saved,'failed components must not repeat successful journal/store saves');
});

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
test('quota shutdown waits for the actual queued configuration write',async t=>{
 const f=await persistenceFixture(t),quota=new QuotaService({dataRoot:f.dataRoot});await quota.ready;f.close(()=>quota.close());const entered=deferred(),release=deferred(),write=quota.store.writeText.bind(quota.store);
 t.mock.method(quota.store,'writeText',async value=>{entered.resolve();await release.promise;return write(value);});
 const saving=quota.save({kind:'codex',name:'isolated pending quota',enabled:false});await entered.promise;let settled=false;const closing=Promise.resolve(quota.close()).then(()=>{settled=true;});await new Promise(resolve=>setImmediate(resolve));const early=settled;
 release.resolve();await saving;await closing;assert.equal(early,false);const reopened=new QuotaService({dataRoot:f.dataRoot});await reopened.ready;f.close(()=>reopened.close());assert.equal(reopened.view().profiles[0].name,'isolated pending quota');
});

test('quota shutdown waits for an aborted query to persist its terminal state',async t=>{
 const f=await persistenceFixture(t),fetching=deferred(),entered=deferred(),release=deferred(),quota=new QuotaService({dataRoot:f.dataRoot,fetcher:async(_profile,{signal})=>{fetching.resolve();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('isolated abort')),{once:true}));}});await quota.ready;f.close(()=>quota.close());
 const {id}=await quota.save({kind:'codex',name:'isolated query',enabled:true}),write=quota.store.writeText.bind(quota.store);t.mock.method(quota.store,'writeText',async value=>{entered.resolve();await release.promise;return write(value);});
 const refreshing=quota.refresh(id,true);await fetching.promise;let settled=false;const closing=Promise.resolve(quota.close()).then(()=>{settled=true;});await entered.promise;await new Promise(resolve=>setImmediate(resolve));const early=settled;
 release.resolve();await refreshing;await closing;assert.equal(early,false);const reopened=new QuotaService({dataRoot:f.dataRoot});await reopened.ready;f.close(()=>reopened.close());assert.equal(reopened.view().profiles[0].status,'stale');
});

test('quota shutdown propagates an actual pending save rejection and retains it on retry',async t=>{
 const f=await persistenceFixture(t),quota=new QuotaService({dataRoot:f.dataRoot});await quota.ready;f.close(()=>quota.close());const entered=deferred(),release=deferred(),failure=Object.assign(Error('isolated quota store failure'),{code:'FIXTURE_SAVE_FAILED'});
 t.mock.method(quota.store,'writeText',async()=>{entered.resolve();await release.promise;throw failure;});
 const saving=quota.save({kind:'codex',enabled:false}),saved=assert.rejects(saving,error=>error===failure);await entered.promise;const closing=Promise.resolve(quota.close()).then(()=>null,error=>error);
 release.resolve();await saved;assert.ok(containsFailure(await closing,failure));await assert.rejects(Promise.resolve().then(()=>quota.close()),error=>containsFailure(error,failure));
});

test('an actual R95 child reporting unsettled work is not accepted as saved',async t=>{
 const f=await companionPersistenceFixture(t);t.mock.method(f.service.r95.mood,'close',async()=>({settled:false,pending:1}));
 await assert.rejects(f.service.close(),error=>error.code==='COMPANION_COMPONENT_CLOSE_FAILED');await assert.rejects(f.service.close(),error=>error.code==='COMPANION_COMPONENT_CLOSE_FAILED');
});

test('quota close rejects new public writes and queries while allowing a read-only view',async t=>{
 const f=await persistenceFixture(t),quota=new QuotaService({dataRoot:f.dataRoot});await quota.ready;f.close(()=>quota.close());const closing=quota.close();
 await assert.rejects(quota.save({kind:'codex'}),{code:'QUOTA_CLOSING'});await assert.rejects(quota.refresh('unused'),{code:'QUOTA_CLOSING'});await assert.rejects(quota.action('visible',{visible:true}),{code:'QUOTA_CLOSING'});assert.deepEqual((await quota.action('get')).profiles,[]);await closing;
});

test('both host quota entry points share storage admission while get remains readable after shutdown failure',async()=>{
 const main=await readFile(new URL('../src/main.mjs',import.meta.url),'utf8'),source=main.split('\n').find(line=>line.startsWith('function quotaAction(')),calls=[];
 const quotaAction=Function('quotas','updateGuard',source+';return quotaAction;')({action:async action=>{calls.push(action);return action;}},(capability)=>{assert.equal(capability,'storage');return Promise.reject(Object.assign(Error('blocked'),{code:'SHUTDOWN_RECOVERY_REQUIRED'}));});
 assert.equal(await quotaAction('get'),'get');await assert.rejects(quotaAction('refresh',{id:'unused'}),{code:'SHUTDOWN_RECOVERY_REQUIRED'});assert.deepEqual(calls,['get']);
 assert.match(main,/ipcMain\.handle\('quotas:action',\(_,action,args\)=>quotaAction\(action,args\)\)/);assert.match(main,/request\.command==='quota-action'\)result=await quotaAction\(request\.action,request\.args\)/);
});
