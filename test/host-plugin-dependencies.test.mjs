import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostDependencyCoordinator} from '../src/plugin-platform.mjs';
import {setupCommunity,catalog} from './support/community-fixtures.mjs';
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const components=[{id:'dsh',ready:false,downloadBytes:198580207},{id:'ffmpeg',ready:false,downloadBytes:266085149}];
test('one confirmed workflow prepares dependencies outside native queue, then creates a real plan and admits once',async()=>{
 const events=[],entered=gate(),finish=gate();let blocked=true,coordinator;
 coordinator=createHostDependencyCoordinator({describe:async()=>({components}),busy:()=>blocked,prepare:async(_value,{signal,phase,check})=>{phase('preparing-dsh');events.push('dsh');entered.resolve();await finish.promise;signal.throwIfAborted();await check();phase('preparing-ffmpeg');events.push('ffmpeg');}});
 const plan=await coordinator.plan({}),callbacks={token:plan.token,planId:'frozen',confirmation:'same-grants',assertCurrent:async()=>{},materialize:async()=>{events.push('native-plan');return {backendPlan:{real:true}};},enqueue:async actual=>{assert.equal(coordinator.preparing(),false);assert.equal(actual.backendPlan.real,true);events.push('enqueue');return {job:{id:'one',state:'queued'}};},cancelJob:async()=>({id:'one',state:'cancelled'})};
 const a=coordinator.run(callbacks),b=coordinator.run(callbacks);assert.equal(a,b);await tick();assert.deepEqual(events,[]);blocked=false;await entered.promise;assert.equal(coordinator.preparing(),true);finish.resolve();const result=await a;assert.equal(result.job.id,'one');assert.deepEqual(events,['dsh','ffmpeg','native-plan','enqueue']);await coordinator.run(callbacks);assert.equal(events.length,4);await coordinator.close();
});
test('cancellation while waiting owns the intent and never starts preparation or native admission',async()=>{
 let prepared=0,queued=0;const coordinator=createHostDependencyCoordinator({describe:async()=>({components}),busy:()=>true,prepare:async()=>prepared++}),plan=await coordinator.plan({});
 const running=coordinator.run({token:plan.token,planId:'waiting',confirmation:'g',assertCurrent:async()=>{},materialize:async()=>({}),enqueue:async()=>{queued++;return {job:{id:'never'}};}}),rejected=assert.rejects(running,{code:'ABORT_ERR'});await tick();assert.equal((await coordinator.cancel({operationId:coordinator.snapshot().operationId})).cancelled,true);await rejected;assert.equal(prepared,0);assert.equal(queued,0);await coordinator.close();
});
test('source generation change during a component wait aborts the owned preparation without enqueue',async()=>{
 const entered=gate();let current=true,queued=0;const changed=()=>Object.assign(Error('source changed'),{code:'PLUGIN_SOURCE_CHANGED'}),coordinator=createHostDependencyCoordinator({describe:async()=>({components}),prepare:async(_p,{signal})=>{entered.resolve();await new Promise((yes,no)=>{signal.addEventListener('abort',()=>no(signal.reason),{once:true});if(signal.aborted)no(signal.reason);});}}),plan=await coordinator.plan({});
 const running=coordinator.run({token:plan.token,planId:'source',confirmation:'g',assertCurrent:async()=>{if(!current)throw changed();},materialize:async()=>({}),enqueue:async()=>{queued++;}}),rejected=assert.rejects(running,{code:'PLUGIN_SOURCE_CHANGED'});await entered.promise;current=false;await rejected;assert.equal(queued,0);await coordinator.close();
});
test('close during preparation waits for its cancellation and cannot start a delayed native job',async()=>{
 const entered=gate(),exited=gate();let queued=0;const coordinator=createHostDependencyCoordinator({describe:async()=>({components}),prepare:async(_p,{signal})=>{entered.resolve();await new Promise((yes,no)=>signal.addEventListener('abort',()=>{exited.resolve();no(signal.reason);},{once:true}));}}),plan=await coordinator.plan({});
 const running=coordinator.run({token:plan.token,planId:'closing',confirmation:'g',assertCurrent:async()=>{},materialize:async()=>({}),enqueue:async()=>queued++}),rejected=assert.rejects(running,{code:'ABORT_ERR'});await entered.promise;await coordinator.close();await exited.promise;await rejected;assert.equal(queued,0);
});
test('cancellation after handoff reports the actual native queue cancellation result',async()=>{
 const admitted=gate(),reply=gate();let cancelled=0;const coordinator=createHostDependencyCoordinator({describe:async()=>({components:[]}),prepare:async()=>{}}),plan=await coordinator.plan({}),running=coordinator.run({token:plan.token,planId:'handoff',confirmation:'g',assertCurrent:async()=>{},materialize:async()=>({}),enqueue:async()=>{admitted.resolve();return reply.promise;},cancelJob:async()=>{cancelled++;return {id:'native',state:'completed'};}});
 await admitted.promise;const result=await coordinator.cancel();assert.equal(result.cancelled,false);reply.resolve({job:{id:'native',state:'queued'}});assert.equal((await running).job.state,'completed');assert.equal(cancelled,1);assert.equal(coordinator.snapshot().state,'queued');await coordinator.close();
});
test('actual community service freezes signed Bili input without a fake native plan and uses one confirmed handoff',async t=>{
 const trusted=new Set();let ready=false,coordinator;
 const f=await setupCommunity(t,{officialFingerprints:trusted,hostDependencies:{plan:value=>coordinator.plan(value),run:value=>coordinator.run(value)},busy:()=>coordinator?.preparing()??false});trusted.add(f.pub.source.keyFingerprint);
 coordinator=createHostDependencyCoordinator({describe:async()=>({components}),prepare:async(_p,{check})=>{await check();ready=true;}});t.after(()=>coordinator.close());
 const probe=f.backend.probe;f.backend.probe=async()=>{assert.equal(ready,true,'No native backend plan/probe before dependencies are ready');return probe();};
 const input=catalog(f.pub);input.works[0].packageName='@ai-buddy/bilibili-companion';input.works[0].releases[0].package.packageName='@ai-buddy/bilibili-companion';await f.load(input);
 const plan=await f.service.action({action:'dsh-plan',sourceId:f.pub.source.sourceId,id:'test.tools'});assert.equal(plan.hostPlanKind,'plugin-with-host-components');assert.equal(Object.hasOwn(plan,'backendPlan'),false);assert.equal(f.calls.length,0);assert.equal(plan.hostComponents[1].downloadBytes,266085149);
 const request={action:'dsh-install',planId:plan.planId,grantedCapabilities:plan.declaredCapabilities};const a=await f.service.action(request);await f.service.action(request);await f.service.drainMaintenance();assert.equal(a.job.operation,'install');assert.equal(f.calls.filter(row=>row[0]==='plan').length,1);assert.equal(f.calls.filter(row=>row[0]==='install').length,1);const installed=f.service.snapshot().dsh.installed[0];assert.equal(installed.enabled,false);assert.deepEqual(installed.grantedCapabilities,plan.declaredCapabilities);
});

// H1/H2 regressions authored before product repair. Root alone executes RED/GREEN.
async function materializationFixture(t,{prepare=async()=>{}}={}){
 const trusted=new Set();let coordinator;
 const f=await setupCommunity(t,{officialFingerprints:trusted,hostDependencies:{plan:value=>coordinator.plan(value),run:value=>coordinator.run(value)},busy:()=>coordinator?.preparing()??false});trusted.add(f.pub.source.keyFingerprint);
 coordinator=createHostDependencyCoordinator({describe:async()=>({components:[{id:'dsh',ready:true,downloadBytes:0},{id:'ffmpeg',ready:true,downloadBytes:0}]}),prepare});t.after(()=>coordinator.close());
 const input=catalog(f.pub);input.works[0].packageName=input.works[0].releases[0].package.packageName='@ai-buddy/bilibili-companion';await f.load(input);
 const plan=await f.service.action({action:'dsh-plan',sourceId:f.pub.source.sourceId,id:'test.tools'});
 return {...f,coordinator,plan,request:{action:'dsh-install',planId:plan.planId,grantedCapabilities:plan.declaredCapabilities}};
}
test('held native probe cannot start package inspection after cancel, close, source revoke or generation change',async t=>{
 for(const boundary of ['cancel','close','source-revoke','source-generation'])await t.test(boundary,async t=>{
  const f=await materializationFixture(t),entered=gate(),release=gate();f.backend.probe=async()=>{entered.resolve();await release.promise;return {ready:true,version:'1.0.0'};};
  const running=f.service.action(f.request),rejected=assert.rejects(running);await entered.promise;let closing;
  if(boundary==='cancel')assert.equal((await f.coordinator.cancel()).cancelled,true);else if(boundary==='close')closing=f.coordinator.close();else if(boundary==='source-revoke')f.pub.source.enabled=false;else f.pub.source.generation++;
  release.resolve();await rejected;await closing;assert.equal(f.calls.filter(row=>row[0]==='plan').length,0);assert.equal(f.calls.filter(row=>row[0]==='install').length,0);assert.equal(f.service.snapshot().maintenance.jobs.length,0);
 });
});
test('native package inspection receives operation signal; cancel waits its cleanup and cannot enqueue',async t=>{
 const f=await materializationFixture(t),entered=gate(),release=gate(),original=f.backend.planInstall;let received,settled=false;
 f.backend.planInstall=async request=>{received=request;entered.resolve();await release.promise;request.signal?.throwIfAborted();return original(request);};
 const running=f.service.action(f.request),rejected=assert.rejects(running,{code:'ABORT_ERR'});running.then(()=>{settled=true;},()=>{settled=true;});
 try{await entered.promise;assert.ok(received.signal instanceof AbortSignal);await f.coordinator.cancel();assert.equal(received.signal.aborted,true);await tick();assert.equal(settled,false);assert.equal(f.service.snapshot().maintenance.jobs.length,0);}finally{release.resolve();await rejected;}
 assert.equal(f.calls.filter(row=>row[0]==='install').length,0);assert.equal(f.service.snapshot().maintenance.jobs.length,0);
});
test('automatic update turns lost reuse allowance into needs-user without native inspection or enqueue',async t=>{
 let reuseLost=false;const f=await materializationFixture(t,{prepare:async()=>{if(reuseLost)throw Object.assign(Error('Component readiness changed; review download bytes'),{code:'HOST_DEPENDENCY_PLAN_CHANGED'});}});
 await f.service.action(f.request);await f.service.drainMaintenance();const record=f.service.snapshot().dsh.installed[0];await f.service.action({action:'community-set-update-policy',packageKey:record.packageKey,policy:'auto'});
 const next=catalog(f.pub,{generatedAt:'2026-10-24T23:00:00Z'});next.works[0].packageName=next.works[0].releases[0].package.packageName='@ai-buddy/bilibili-companion';const release=structuredClone(next.works[0].releases[0]);release.version=release.package.exactVersion='1.0.1';next.works[0].releases.push(release);await f.load(next);reuseLost=true;
 const before=f.calls.length,result=await f.service.runAutomaticUpdates({refresh:false});assert.equal(result.updates[0].state,'needs-user');assert.equal(result.updates[0].error.code,'HOST_DEPENDENCY_PLAN_CHANGED');assert.equal(f.calls.length,before);assert.equal(f.service.snapshot().maintenance.jobs.length,1);
});
