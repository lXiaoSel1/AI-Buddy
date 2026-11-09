import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPluginMaintenanceClient} from '../src/plugin-maintenance-client.mjs';
import {createMaintenanceQueue} from '../src/community/maintenance-queue.mjs';
import {communityDigest} from '../src/community/catalog.mjs';

class Child extends EventEmitter {
  postMessage(row){if(row.method==='initialize'||row.method==='close')queueMicrotask(()=>this.emit('message',{type:'response',id:row.id,result:row.method==='initialize'?{installed:{},packages:[],operation:null}:true}));}
  kill(){queueMicrotask(()=>this.emit('exit',0));}
}
test('C14 closed maintenance facade reopens by creating a new verified utility child',async()=>{
 const children=[],client=await createPluginMaintenanceClient({runnerPath:'fixture',root:'fixture',dataRoot:'fixture',appVersion:'2.0.13',processFactory:()=>{const child=new Child();children.push(child);return child;}});
 await client.close();await client.reopen();assert.equal(children.length,2);assert.equal(client.snapshot().service.usable,true);await client.close();
});
test('C14 completed maintenance history is bounded while archived idempotency survives restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'audit213-maintenance-')),jobs=[];for(let n=0;n<230;n++){const intent={n};jobs.push({id:'job-'+n,operation:'install',packageKey:'test',intent,intentDigest:communityDigest(intent),idempotencyKey:'request-'+n,state:'completed',createdAt:'2026-11-09T00:00:00Z',updatedAt:'2026-11-09T00:00:00Z',result:{n}});}
 await writeFile(join(directory,'maintenance-queue-v1.json'),JSON.stringify({schemaVersion:1,jobs}));let executions=0;
 let queue=await createMaintenanceQueue({directory,execute:async()=>{executions++;}});assert.ok(queue.snapshot().jobs.length<=200);await queue.close();queue=await createMaintenanceQueue({directory,execute:async()=>{executions++;}});
 const prior=await queue.enqueue({operation:'install',packageKey:'test',intent:{n:0},idempotencyKey:'request-0'});assert.equal(prior.id,'job-0');await queue.drain();assert.equal(executions,0);await assert.rejects(queue.enqueue({operation:'install',packageKey:'test',intent:{n:999},idempotencyKey:'request-0'}),{code:'COMMUNITY_QUEUE_CONFLICT'});await queue.close();
 assert.ok(JSON.parse(await readFile(join(directory,'maintenance-queue-v1.json'),'utf8')).jobs.length<=200);
});

test('C14 quarantine restores files when registration publication fails and recovers crash staging',async()=>{
 const {mkdir,stat}=await import('node:fs/promises'),{quarantinePluginDirectories,recoverPluginTrash}=await import('../src/plugin-quarantine.mjs');
 const control=await mkdtemp(join(tmpdir(),'audit213-quarantine-')),directory='packages/test/1.0.0';await mkdir(join(control,directory),{recursive:true});await writeFile(join(control,directory,'keep'),'original code');const record={schemaVersion:1,packages:{test:{versions:{'1.0.0':{directory}}}}};await writeFile(join(control,'registry.json'),JSON.stringify(record));
 await assert.rejects(quarantinePluginDirectories(control,[directory],async()=>{await assert.rejects(stat(join(control,directory)),{code:'ENOENT'});throw Error('publish failed');}),/publish failed/);assert.equal(await readFile(join(control,directory,'keep'),'utf8'),'original code');
 await quarantinePluginDirectories(control,[directory],async()=>writeFile(join(control,'registry.json'),JSON.stringify({schemaVersion:1,packages:{}})));await assert.rejects(stat(join(control,directory)),{code:'ENOENT'});await recoverPluginTrash(control);
});
test('C14 owner birth identity rejects a reused PID while retaining the current owner',async()=>{
 const {processLockOwner,processLockAlive}=await import('../src/process-lock-owner.mjs');const owner=await processLockOwner();assert.equal(owner.pid,process.pid);assert.ok(owner.sessionId);assert.ok(owner.creationTime);assert.equal(await processLockAlive(owner),true);assert.equal(await processLockAlive({...owner,creationTime:'0'}),false);
});

test('B8 official retry reuses only the failed approved maintenance intent and stays idempotent',async t=>{
 const {setupCommunity}=await import('./support/community-fixtures.mjs');const f=await setupCommunity(t);await f.load();let attempts=0;
 f.backend.install=async(plan,options)=>{attempts++;if(!options.official)throw Object.assign(Error('mirror bytes differ'),{code:'NETWORK_MIRROR_MISMATCH',retryOfficial:true});return {installed:true,enabled:false,profileId:plan.profileId};};
 const initial=await f.install(),job=f.service.snapshot().maintenance.jobs.find(row=>row.id===initial.job.id);assert.equal(job.state,'failed');assert.equal(job.error.retryOfficial,true);assert.equal(job.error.originKnownMirror,false);assert.equal(Object.hasOwn(job.error,'host'),false);assert.equal(Object.hasOwn(job.error,'technicalCode'),false);
 const request={action:'community-retry-maintenance',jobId:job.id,official:true},retry=await f.service.action(request);await f.service.drainMaintenance();assert.equal(f.service.snapshot().maintenance.jobs.find(row=>row.id===retry.job.id).state,'completed');await f.service.action(request);await f.service.drainMaintenance();assert.equal(attempts,2);
 await assert.rejects(f.service.action({...request,jobId:retry.job.id}),{code:'COMMUNITY_RETRY_INVALID'});
});
