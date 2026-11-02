import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TokenMonitor} from '../src/token-monitor.mjs';
import {WorkUsageAttribution} from '../src/work-usage-attribution.mjs';

const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const turns=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'managed-registration-')),dataRoot=join(root,'data'),project=join(root,'project');await mkdir(project);
 const audits=[],monitor=new TokenMonitor({dataRoot,roots:[],home:root,persistentHistory:false,onAudit:v=>audits.push(v)});await monitor.start();clearInterval(monitor.timer);
 const events=[];monitor.restartLegacy=async()=>{events.push('restart');};monitor.scan=async()=>{events.push('scan');};
 t.after(async()=>{await monitor.close();await rm(root,{recursive:true,force:true});});
 const source=async id=>{const path=join(root,id+'.jsonl');await writeFile(path,'');return {id:'managed-'+id,tool:'codex',path,enabled:true,name:'Controlled source',format:'auto',mode:'request',workAttribution:{schemaVersion:1,origin:'work-host-v1',pluginId:'test.plugin',jobId:'job',taskId:'task',runId:id,memberId:'member',nativeSessionId:id,nativeParentId:null,projectId:'project',projectPath:project,ownerScope:{characterId:'character',personaId:'persona',lifeId:'life',operationId:'operation'}}};};
 return {monitor,events,audits,source,dataRoot};
}

test('durable registration is acknowledged before a slow full-history refresh finishes',async t=>{
 const f=await fixture(t),hold=gate(),entered=gate(),value=await f.source('slow');let acknowledged=false;
 f.monitor.restartLegacy=async()=>{f.events.push('restart');entered.resolve();await hold.promise;};
 const request=f.monitor.registerManagedWorkSource(value).then(v=>{acknowledged=true;return v;});
 try{await entered.promise;await turns();assert.equal(acknowledged,true,'a full reindex must not block the durable registration receipt');const receipt=await request;assert.equal(receipt.sourceId,value.id);assert.equal(receipt.registered,true);assert.equal(receipt.indexed,false);assert.equal(receipt.indexing,'pending');const disk=new WorkUsageAttribution(f.dataRoot);await disk.ready;assert.equal(disk.records.get(value.id).workAttribution.nativeSessionId,'slow');}
 finally{hold.resolve();await request;await f.monitor.flushManagedWorkSources?.();}
});

test('same-id registration is idempotent and concurrent source additions share one refresh',async t=>{
 const f=await fixture(t),one=await f.source('one'),two=await f.source('two');
 const receipts=await Promise.all([f.monitor.registerManagedWorkSource(one),f.monitor.registerManagedWorkSource(two),f.monitor.registerManagedWorkSource(one)]);assert.ok(receipts.every(r=>r.registered));
 await f.monitor.flushManagedWorkSources();assert.equal(f.events.filter(v=>v==='restart').length,1);assert.equal(f.events.filter(v=>v==='scan').length,1);
 const before=f.monitor.workUsage.key,receipt=await f.monitor.registerManagedWorkSource(one);assert.equal(receipt.indexed,true);assert.equal(f.monitor.workUsage.key,before);await f.monitor.flushManagedWorkSources();assert.equal(f.events.filter(v=>v==='restart').length,1);
});

test('a conflicting captured identity is rejected before rewriting source settings',async t=>{
 const f=await fixture(t),value=await f.source('conflict');await f.monitor.registerManagedWorkSource(value);const before=structuredClone(f.monitor.sources.state);
 await assert.rejects(f.monitor.registerManagedWorkSource({...value,name:'Must not be saved',workAttribution:{...value.workAttribution,projectId:'another-project'}}),{code:'WORK_USAGE_ATTRIBUTION_CONFLICT'});
 assert.deepEqual(f.monitor.sources.state,before);assert.equal(f.monitor.workUsage.records.get(value.id).workAttribution.projectId,'project');
});

test('normal close waits for its accepted background refresh and refuses new registrations',async t=>{
 const f=await fixture(t),hold=gate(),entered=gate(),value=await f.source('close');let closed=false;
 f.monitor.restartLegacy=async()=>{entered.resolve();await hold.promise;};const request=f.monitor.registerManagedWorkSource(value);await entered.promise;
 const closing=f.monitor.close().then(()=>{closed=true;});
 try{await turns();assert.equal(closed,false);await assert.rejects(f.monitor.registerManagedWorkSource(await f.source('late')),{code:'MONITOR_CLOSING'});}
 finally{hold.resolve();await request;await closing;}
 assert.equal(closed,true);
});

test('background index failure is visible and flush or close cannot report it as indexed',async t=>{
 const f=await fixture(t),value=await f.source('failure');f.monitor.restartLegacy=async()=>{throw Object.assign(Error('Controlled index lock'),{code:'EBUSY'});};
 const receipt=await f.monitor.registerManagedWorkSource(value);assert.equal(receipt.registered,true);assert.equal(receipt.indexed,false);
 await assert.rejects(f.monitor.flushManagedWorkSources(),/Controlled index lock/);assert.match(f.monitor.errors.get('managed-work-index'),/Controlled index lock/);assert.ok(f.audits.some(v=>v.type==='managed-work-index-error'&&v.code==='EBUSY'));
 await assert.rejects(f.monitor.close(),/Controlled index lock/);f.monitor.restartLegacy=async()=>{f.events.push('recovered');};await f.monitor.close();assert.equal(f.monitor.errors.has('managed-work-index'),false);
});

test('managed source admission never waits for the settings page to inspect other paths',async t=>{const f=await fixture(t),v=await f.source('independent');const original=f.monitor.sources.view.bind(f.monitor.sources);f.monitor.sources.view=async()=>{throw Error('unrelated settings view must not run during admission')};try{assert.equal((await f.monitor.registerManagedWorkSource(v)).registered,true)}finally{f.monitor.sources.view=original}});

test('host admission stays durable across a stalled analytics projection and refuses identity changes after reopen',async t=>{
 const f=await fixture(t),source=await f.source('registry-isolation'),projection=[],stages=[];const {createWorkSourceRegistry}=await import('../src/work-source-registry.mjs');
 const root=await mkdtemp(join(tmpdir(),'buddy-registry-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const options={dataRoot:root,home:root,roots:[]},registry=createWorkSourceRegistry(options,v=>projection.push(v),event=>stages.push(event.stage));
 const [a,b]=await Promise.all([registry.register(source),registry.register(source)]);assert.equal(a.sourceId,b.sourceId);assert.deepEqual(stages.slice(0,4),['checking','source-settings','attribution','committed']);assert.equal(projection.length,1);
 let monitor=f.monitor;monitor.applyWorkSourceProjection(projection[0]);assert.ok(monitor.workUsage.records.has(source.id));assert.equal(monitor.sources.list().some(s=>s.id===source.id),true);await monitor.flushManagedWorkSources();
 const reopened=createWorkSourceRegistry(options,()=>{});await assert.rejects(reopened.register({...source,workAttribution:{...source.workAttribution,memberId:'different'}}),{code:'WORK_USAGE_ATTRIBUTION_CONFLICT'});await assert.rejects(reopened.edit('save',source),{code:'WORK_USAGE_ATTRIBUTION_HOST_ONLY'});assert.equal((await reopened.register(source)).registered,true);
});
