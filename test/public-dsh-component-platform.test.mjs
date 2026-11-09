import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {createPluginPlatform} from '../src/plugin-platform.mjs';
import {createQqLoginRuntime} from '../src/qq-login-runtime.mjs';
import {defaultPluginSource} from '../src/plugin-sources.mjs';
import {communityPackageKey} from '../src/community/catalog.mjs';
import {DSH_PUBLIC_COMPONENT} from '../src/dsh-platform/component-download.mjs';
import {catalog,publisher,signed,simulatedBackend,sha} from './support/community-fixtures.mjs';
const gate=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const abort=()=>Object.assign(Error('Component installation cancelled'),{code:'ABORT_ERR'});
// Actual platform + maintenance queue composition. Native backend methods are
// data-only stubs; no component worker, engine, browser, network or model starts.
async function fixture(t,{cold=false,componentWorkerFactory,qq=false,qqLoginFactory,getSocialHost,realHostDependencies=false,ffmpegManagerFactory}={}){
  const root=await mkdtemp(join(tmpdir(),'dsh-platform-admission-')),dataRoot=join(root,'data'),pub=publisher(),source=cold?defaultPluginSource():pub.source,calls=[],cleanup=[],legacy={snapshot:()=>({appVersion:'1.9.2',service:{state:'ready',usable:true},installed:{},packages:[]}),action:async()=>({}),resolveTrustedSource:async id=>{assert.equal(id,source.sourceId);return {...source};},close:async()=>{}};let key;
  if(cold){
    const ref={backend:'dsh',sourceId:'official',packageName:qq?'@ai-buddy/qq-connect':'@ai-buddy/bilibili-companion',exactVersion:qq?'2.0.6':'2.0.11',sourceDigest:sha('cold native fixture'),spec:{kind:'tarball',value:'https://github.com/test/native/releases/download/v2.0.11/native.tgz'},compatibility:{app:'^1.9.2',dsh:'^1.0.0',bridge:'^1.0.0'},capabilities:[],dataSchemaVersion:1};key=communityPackageKey(ref);const record={...ref,packageKey:key,pluginId:'dsh.cold-fixture',declaredCapabilities:[],grantedCapabilities:[],generation:1,profileId:'buddy-community-v1',backendPlan:{schemaVersion:1,packageRef:ref,profileId:'buddy-community-v1',planDigest:sha('cold plan fixture')},enabled:true,sourceProof:{sourceFingerprint:source.keyFingerprint,catalogDigest:sha('cold catalog fixture')}};await mkdir(join(root,'local/community'),{recursive:true});await writeFile(join(root,'local/community/dsh-registry-v1.json'),JSON.stringify({schemaVersion:1,packages:{[key]:record},generations:{[key]:1},releaseDigests:{}}));
  }
  if(realHostDependencies){await mkdir(join(root,'build'),{recursive:true});await writeFile(join(root,'build','dsh-component.json'),JSON.stringify(DSH_PUBLIC_COMPONENT));}
  const platform=await createPluginPlatform({root,build:join(root,'build'),ffmpegManagerFactory,dataRoot,legacyManager:legacy,componentWorkerFactory,qqLoginFactory,getSocialHost,BrowserWindow:class{constructor(){throw Error('Native window must not start in this fixture');}},session:{fromPartition(){throw Error('Native browser session must not start in this fixture');}},getGame:()=>null,getProvider:()=>null});
  // These existing B4 tests model already-ready media dependencies; the focused
  // host dependency suite covers real coordinator preparation/admission.
  if(cold&&!qq&&!realHostDependencies){platform.dependencyCoordinator.plan=async()=>({token:'already-ready-fixture',components:[]});platform.dependencyCoordinator.run=async({materialize,enqueue})=>enqueue(await materialize());}
  Object.assign(platform.dshBackend,simulatedBackend(calls));t.after(async()=>{for(const release of cleanup)release();await platform.close();await rm(root,{recursive:true,force:true});});
  if(!cold)await platform.action({action:'community-load-catalog',sourceId:source.sourceId,envelope:signed(catalog(pub),pub)});
  return {root,platform,calls,source,key,cleanup,legacy};
}
function prepare(f){const waiting=gate(),entered=gate();let done=false;const finish=(error)=>{if(done)return;done=true;if(error)waiting.reject(error);else waiting.resolve({state:'ready',runtimeLockPath:join(f.root,'new/runtime-lock.json')});};f.platform.componentManager.install=async()=>{entered.resolve();return waiting.promise;};f.platform.componentManager.cancel=()=>{finish(abort());return {cancelled:true};};const installing=f.platform.action({action:'dsh-component-install',planId:'host-fixture'});return {entered:entered.promise,installing,finish};}
async function queueInstall(f){const plan=await f.platform.action({action:'dsh-plan',sourceId:f.source.sourceId,id:'test.tools'});return f.platform.action({action:'dsh-install',planId:plan.planId,grantedCapabilities:plan.declaredCapabilities});}

test('queued install waits throughout component preparation and executes once after success or cancellation',async t=>{
  for(const cancel of [false,true])await t.test(cancel?'cancel':'success',async t=>{
    const f=await fixture(t);let occupied=true;f.platform.bridge.busy=()=>occupied;await queueInstall(f);await f.platform.drainMaintenance();assert.equal(f.platform.snapshot().maintenance.jobs[0].state,'queued');const before=f.calls.length,preparing=prepare(f),settled=cancel?assert.rejects(preparing.installing,{code:'ABORT_ERR'}):preparing.installing;await preparing.entered;occupied=false;
    await f.platform.drainMaintenance();await f.platform.drainMaintenance();assert.equal(f.platform.snapshot().maintenance.jobs[0].state,'queued');assert.equal(f.calls.length,before);
    if(cancel)assert.equal((await f.platform.action({action:'dsh-component-cancel'})).cancelled,true);else preparing.finish();await settled;await f.platform.drainMaintenance();assert.equal(f.platform.snapshot().maintenance.jobs[0].state,'completed');assert.equal(f.calls.filter(row=>row[0]==='install').length,1);await f.platform.drainMaintenance();assert.equal(f.calls.filter(row=>row[0]==='install').length,1);
  });
});
test('cold official activation stays queued while component changes and retains its approved generation afterward',async t=>{
  for(const cancel of [false,true])await t.test(cancel?'cancel':'success',async t=>{
    const f=await fixture(t,{cold:true});let occupied=true;f.platform.bridge.busy=()=>occupied;const queued=await f.platform.action({action:'dsh-enable',packageKey:f.key});await f.platform.drainMaintenance();const prior=f.platform.snapshot().dsh.installed[0];assert.equal(prior.runtimeVerified,false);assert.equal(f.platform.bridge.grants.get(prior.pluginId)?.enabled===true,false);assert.equal(f.platform.snapshot().maintenance.jobs.find(row=>row.id===queued.job.id).state,'queued');
    const preparing=prepare(f),settled=cancel?assert.rejects(preparing.installing,{code:'ABORT_ERR'}):preparing.installing;await preparing.entered;occupied=false;await f.platform.drainMaintenance();assert.equal(f.platform.snapshot().maintenance.jobs.find(row=>row.id===queued.job.id).state,'queued');assert.equal(f.calls.filter(row=>row[0]==='enable').length,0);
    if(cancel)await f.platform.action({action:'dsh-component-cancel'});else preparing.finish();await settled;assert.equal(f.platform.snapshot().dsh.installed[0].generation,prior.generation);await f.platform.drainMaintenance();const after=f.platform.snapshot().dsh.installed[0];assert.equal(f.platform.snapshot().maintenance.jobs.find(row=>row.id===queued.job.id).state,'completed',JSON.stringify(f.platform.snapshot().maintenance.jobs.find(row=>row.id===queued.job.id)));assert.equal(f.calls.filter(row=>row[0]==='enable').length,1);assert.equal(after.runtimeVerified,true);assert.equal(after.generation,prior.generation);assert.equal(f.platform.bridge.grants.get(after.pluginId).enabled,true);
  });
});
test('verified runtime still loses its grant and generation; stale queued enable and late selection cannot revive it',async t=>{
  const f=await fixture(t,{cold:true});await f.platform.action({action:'dsh-enable',packageKey:f.key});await f.platform.drainMaintenance();assert.equal(f.platform.snapshot().maintenance.jobs.at(-1).state,'completed',JSON.stringify(f.platform.snapshot().maintenance.jobs.at(-1)));const loaded=f.platform.snapshot().dsh.installed[0],grant=f.platform.bridge.grants.get(loaded.pluginId);assert.equal(loaded.runtimeVerified,true);assert.equal(grant.enabled,true);let occupied=true;f.platform.bridge.busy=()=>occupied;const queued=await f.platform.action({action:'dsh-enable',packageKey:f.key});await f.platform.drainMaintenance();const status=gate(),entered=gate();f.platform.componentManager.status=()=>{entered.resolve();return status.promise;};const selecting=f.platform.runtimeDescriptor(),rejected=assert.rejects(selecting,{code:'DSH_COMPONENT_BUSY'});await entered.promise;
  const preparing=prepare(f);await preparing.entered;occupied=false;await f.platform.drainMaintenance();assert.equal(f.platform.snapshot().maintenance.jobs.find(row=>row.id===queued.job.id).state,'queued');preparing.finish();await preparing.installing;status.resolve({state:'ready',runtimeLockPath:join(f.root,'old/runtime-lock.json')});await rejected;await new Promise(resolve=>setImmediate(resolve));
  const invalidated=f.platform.snapshot().dsh.installed[0];assert.ok(invalidated.generation>loaded.generation);assert.equal(invalidated.runtimeVerified,false);assert.equal(f.platform.bridge.grants.get(loaded.pluginId).enabled,false);assert.ok(f.platform.bridge.grants.get(loaded.pluginId).generation>grant.generation);await f.platform.drainMaintenance();const job=f.platform.snapshot().maintenance.jobs.find(row=>row.id===queued.job.id);assert.equal(job.state,'needs-user');assert.equal(job.error.code,'COMMUNITY_INSTALLATION_CHANGED');assert.equal(f.calls.filter(row=>row[0]==='enable').length,1);assert.equal(f.platform.bridge.grants.get(loaded.pluginId).enabled,false);
});
test('held runtime selection rechecks component transition and close before using late status',async t=>{
  for(const boundary of ['during','completed','cancelled','closed'])await t.test(boundary,async t=>{
    const f=await fixture(t),status=gate(),entered=gate();f.platform.componentManager.status=()=>{entered.resolve();return status.promise;};const selecting=f.platform.runtimeDescriptor(),rejected=assert.rejects(selecting,{code:boundary==='closed'?'PLUGIN_CLOSED':'DSH_COMPONENT_BUSY'});await entered.promise;let preparing;
    if(boundary==='closed')await f.platform.close();else{preparing=prepare(f);await preparing.entered;if(boundary==='completed'){preparing.finish();await preparing.installing;}else if(boundary==='cancelled'){const cancelled=assert.rejects(preparing.installing,{code:'ABORT_ERR'});await f.platform.action({action:'dsh-component-cancel'});await cancelled;}}
    status.resolve({state:'ready',runtimeLockPath:join(f.root,'stale/runtime-lock.json')});await rejected;if(boundary==='during'){preparing.finish();await preparing.installing;}assert.equal(f.calls.some(row=>['probe','install','enable'].includes(row[0])),false);
  });
});

test('component manager busy probe excludes its own platform transition flag',async t=>{
  const probes=[],componentWorkerFactory=(_path,{workerData})=>{assert.equal(workerData.kind,'install');const worker=new EventEmitter();worker.postMessage=row=>{if(row.type!=='busy-result')return;probes.push(row.busy);queueMicrotask(()=>{worker.emit('message',row.busy?{type:'error',error:{code:'DSH_COMPONENT_BUSY',message:'unexpected self lock'}}:{type:'result',value:{state:'ready',runtimeLockPath:'/fixture/new-runtime-lock.json'}});worker.emit('exit',0);});};queueMicrotask(()=>worker.emit('message',{type:'busy',id:1}));return worker;};
  const f=await fixture(t,{componentWorkerFactory});await mkdir(join(f.root,'build'),{recursive:true});await writeFile(join(f.root,'build/dsh-component.json'),JSON.stringify(DSH_PUBLIC_COMPONENT));const plan=await f.platform.action({action:'dsh-component-plan'});assert.equal(plan.mode,'online');assert.equal((await f.platform.action({action:'dsh-component-install',planId:plan.planId})).state,'ready');assert.deepEqual(probes,[false]);assert.equal(f.platform.busy(),false);
});

// Stop injection wraps the real QQ runtime; empty owned-run/account state means
// these lifecycle tests never spawn QQ, connect an account or send a request.
async function qqFixture(t){
  const control={stop:null,calls:0,revoked:[]},qqLoginFactory=options=>{const runtime=createQqLoginRuntime(options);return {...runtime,stop:async options=>{control.calls++;return control.stop?control.stop(options):runtime.stop(options);}};};
  const f=await fixture(t,{cold:true,qq:true,qqLoginFactory,getSocialHost:()=>({revokePlugin:id=>{control.revoked.push(id);}})});await f.platform.action({action:'dsh-enable',packageKey:f.key});await f.platform.drainMaintenance();assert.equal(f.platform.snapshot().maintenance.jobs.at(-1).state,'completed',JSON.stringify(f.platform.snapshot().maintenance.jobs.at(-1)));const loaded=f.platform.snapshot().dsh.installed[0];assert.equal(loaded.runtimeVerified,true);assert.equal(f.platform.bridge.grants.get(loaded.pluginId).enabled,true);return {...f,control,loaded};
}
function holdQqStop(f){const entered=gate(),waiting=gate();f.cleanup.push(()=>{f.control.stop=null;waiting.resolve();});f.control.stop=()=>{entered.resolve();return waiting.promise;};return {entered:entered.promise,resolve:waiting.resolve,reject:waiting.reject,reset:()=>{f.control.stop=null;}};}

test('component transition revokes QQ authority before held stop and waits before admitting a new generation',async t=>{
  const f=await qqFixture(t),original=f.platform.bridge.grants.get(f.loaded.pluginId),stop=holdQqStop(f),preparing=prepare(f);let settled=false;const receipt=preparing.installing.then(value=>{settled=true;return {value};},cause=>{settled=true;return {cause};});await preparing.entered;preparing.finish();await stop.entered;
  assert.equal(f.platform.bridge.grants.get(f.loaded.pluginId).enabled,false);assert.throws(()=>f.platform.bridge.grants.assertGeneration(f.loaded.pluginId,original.generation),{code:'BUDDY_PLUGIN_DISABLED'});assert.ok(f.control.revoked.includes(f.loaded.pluginId));assert.equal(settled,false);assert.equal(f.platform.busy(),true);
  const queued=await f.platform.action({action:'dsh-enable',packageKey:f.key});await f.platform.drainMaintenance();assert.equal(f.platform.snapshot().maintenance.jobs.find(row=>row.id===queued.job.id).state,'queued');assert.equal(f.calls.filter(row=>row[0]==='enable').length,1);assert.equal(settled,false);
  stop.resolve();const done=await receipt;assert.equal(done.cause,undefined);assert.equal(done.value.state,'ready');assert.equal(f.platform.busy(),false);await f.platform.drainMaintenance();assert.equal(f.platform.snapshot().maintenance.jobs.find(row=>row.id===queued.job.id).state,'completed');const current=f.platform.bridge.grants.get(f.loaded.pluginId);assert.equal(current.enabled,true);assert.ok(current.generation>original.generation);stop.resolve();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.platform.bridge.grants.get(f.loaded.pluginId),current);stop.reset();
});
test('rejected QQ cleanup leaves authority revoked, fails component completion and requires cleanup recovery before grant',async t=>{
  const f=await qqFixture(t),original=f.platform.bridge.grants.get(f.loaded.pluginId),stop=holdQqStop(f),preparing=prepare(f);let settled=false;const receipt=preparing.installing.then(value=>{settled=true;return {value};},cause=>{settled=true;return {cause};});await preparing.entered;preparing.finish();await stop.entered;assert.equal(settled,false);assert.equal(f.platform.busy(),true);assert.equal(f.platform.bridge.grants.get(f.loaded.pluginId).enabled,false);assert.throws(()=>f.platform.bridge.grants.assertGeneration(f.loaded.pluginId,original.generation),{code:'BUDDY_PLUGIN_DISABLED'});
  stop.reject(Object.assign(Error('Controlled QQ stop failure'),{code:'QQ_STOP_TEST_FAILURE'}));const done=await receipt;assert.equal(done.value,undefined);assert.equal(done.cause.code,'QQ_STOP_TEST_FAILURE');assert.equal(f.platform.snapshot().dsh.state.state,'failed');assert.equal(f.platform.snapshot().dsh.state.error.code,'QQ_STOP_TEST_FAILURE');assert.equal(f.platform.busy(),false);assert.equal(f.platform.bridge.grants.get(f.loaded.pluginId).enabled,false);
  stop.reset();await f.platform.invalidateRuntime({phase:'cleanup-retry'});await f.platform.action({action:'dsh-enable',packageKey:f.key});await f.platform.drainMaintenance();assert.equal(f.platform.snapshot().maintenance.jobs.at(-1).state,'completed',JSON.stringify(f.platform.snapshot().maintenance.jobs.at(-1)));const current=f.platform.bridge.grants.get(f.loaded.pluginId);assert.equal(current.enabled,true);assert.ok(current.generation>original.generation);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.platform.bridge.grants.get(f.loaded.pluginId),current);
});
test('actual package publication serializes a newer enable behind older held QQ cleanup',async t=>{
  const f=await qqFixture(t),stop=holdQqStop(f),invalidating=f.platform.invalidateRuntime({phase:'late-runtime-exit'});await stop.entered;assert.equal(f.platform.bridge.grants.get(f.loaded.pluginId).enabled,false);const enableEntered=gate(),enable=f.platform.dshBackend.enable;f.platform.dshBackend.enable=async(...args)=>{enableEntered.resolve();return enable(...args);};const queued=await f.platform.action({action:'dsh-enable',packageKey:f.key}),draining=f.platform.drainMaintenance();await enableEntered.promise;assert.equal(f.platform.snapshot().maintenance.jobs.find(row=>row.id===queued.job.id).state,'running');assert.equal(f.platform.bridge.grants.get(f.loaded.pluginId).enabled,false);
  stop.resolve();await Promise.all([invalidating,draining]);assert.equal(f.platform.snapshot().maintenance.jobs.find(row=>row.id===queued.job.id).state,'completed',JSON.stringify(f.platform.snapshot().maintenance.jobs.find(row=>row.id===queued.job.id)));const current=f.platform.bridge.grants.get(f.loaded.pluginId);assert.equal(current.enabled,true);stop.resolve();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.platform.bridge.grants.get(f.loaded.pluginId),current);stop.reset();
});
test('platform shutdown awaits its pending QQ invalidation cleanup before closing',async t=>{
  const f=await qqFixture(t),stop=holdQqStop(f),invalidating=f.platform.invalidateRuntime({phase:'shutdown-pending'});await stop.entered;let closed=false;const closing=f.platform.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);assert.equal(f.platform.bridge.grants.get(f.loaded.pluginId).enabled,false);stop.resolve();await Promise.all([invalidating,closing]);assert.equal(closed,true);stop.reset();
});

// H2: real host dependency preparation, with verify-only data stubs and no worker/network.
function ffmpegReadinessFixture(){let state='ready',preparations=0;const value=()=>({state,verified:state==='ready',version:'8.1.2',bytes:266085149,downloadBytes:state==='ready'?0:266085149});return {set:next=>{state=next;},get preparations(){return preparations;},manager:{status:async()=>value(),snapshot:value,prepare:async()=>{preparations++;state='ready';return value();},resolveVerifiedExecutable:async()=>({executable:'fixture-verified',localSpeechRecognition:false}),cancel:()=>({cancelled:false}),close:async()=>{}}};}
test('a frozen ready plan never authorizes a new FFmpeg or DSH download after cache loss',async t=>{
 for(const component of ['ffmpeg','dsh'])for(const lostState of ['missing','repair-required'])await t.test(component+' '+lostState,async t=>{
  const ff=ffmpegReadinessFixture(),f=await fixture(t,{cold:true,realHostDependencies:true,ffmpegManagerFactory:()=>ff.manager});let dshState='ready',dshInstalls=0;f.platform.componentManager.status=async()=>({state:dshState});f.platform.componentManager.plan=async()=>({planId:'pinned-dsh-fixture'});f.platform.componentManager.install=async()=>{dshInstalls++;return {state:'ready'};};
  const plan=await f.platform.action({action:'dsh-plan-enable',packageKey:f.key});assert.equal(plan.hostComponents.every(row=>row.ready&&row.downloadBytes===0),true);
  if(component==='ffmpeg')ff.set(lostState);else dshState=lostState;
  await assert.rejects(f.platform.action({action:'dsh-install',planId:plan.planId,grantedCapabilities:plan.priorGrantedCapabilities}),{code:'HOST_DEPENDENCY_PLAN_CHANGED'});
  assert.equal(ff.preparations,0);assert.equal(dshInstalls,0);assert.equal(f.calls.length,0);assert.equal(f.platform.snapshot().maintenance.jobs.length,0);
 });
});
test('explicitly confirmed missing FFmpeg bytes still prepare once and admit the native enable once',async t=>{
 const ff=ffmpegReadinessFixture();ff.set('missing');const f=await fixture(t,{cold:true,realHostDependencies:true,ffmpegManagerFactory:()=>ff.manager});f.platform.componentManager.status=async()=>({state:'ready'});f.platform.componentManager.plan=async()=>({planId:'pinned-dsh-fixture'});
 const plan=await f.platform.action({action:'dsh-plan-enable',packageKey:f.key});assert.equal(plan.hostComponents.find(row=>row.id==='ffmpeg').downloadBytes,266085149);
 const request={action:'dsh-install',planId:plan.planId,grantedCapabilities:plan.priorGrantedCapabilities};await f.platform.action(request);await f.platform.action(request);await f.platform.drainMaintenance();assert.equal(ff.preparations,1);assert.equal(f.calls.filter(row=>row[0]==='enable').length,1);assert.equal(f.platform.snapshot().maintenance.jobs.length,1);
});

test('C14 platform close aggregates failure and rebuilds every closed service before recovery',async t=>{
 const f=await fixture(t),original=f.platform.ffmpegManager.close;let first=true;
 f.platform.ffmpegManager.close=async()=>{if(first){first=false;throw Object.assign(Error('injected ffmpeg close failure'),{code:'FIXTURE_CLOSE'});}return original();};
 await assert.rejects(f.platform.close(),error=>error.code==='PLUGIN_CLOSE_FAILED'&&error.failedSteps.includes('ffmpeg'));
 // The stable production facade performs a real utility restart (covered separately).
 // This composition fixture has no child process and exposes the same host-only port.
 const optionsLegacy=f.platform.restoreAfterCloseFailure;
 assert.equal(typeof optionsLegacy,'function');
 // This fixture's legacy manager intentionally has no recreation port: fail explicitly.
 await assert.rejects(f.platform.restoreAfterCloseFailure(),{code:'PLUGIN_RESTORE_UNSUPPORTED'});
 let reopened=0;f.legacy.reopen=async()=>{reopened++;};const restored=await f.platform.restoreAfterCloseFailure();
 assert.notEqual(restored,f.platform);assert.notEqual(restored.componentManager,f.platform.componentManager);assert.notEqual(restored.clientHost,f.platform.clientHost);assert.equal(restored.snapshot().service.usable,true);assert.equal(reopened,1);await restored.close();
 f.platform.close=async()=>{};
});
