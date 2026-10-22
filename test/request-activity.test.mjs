import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRouter} from '../src/model-router.mjs';
import {CgService} from '../src/cg-service.mjs';
import {mockModelServer,fakeCrypto,stubCodex} from './support/mock-model-server.mjs';
const consume=async stream=>{for await(const part of stream){};};
test('role-bound routing freezes its connection without changing global selection; queued cancellation never starts activity',async t=>{
  const server=await mockModelServer();t.after(()=>server.close());const events=[];
  const router=new ModelRouter({dataRoot:await mkdtemp(join(tmpdir(),'buddy-routing-')),codex:stubCodex(),crypto:fakeCrypto,onActivity:e=>events.push(e)});await router.ready;t.after(()=>router.close());
  const first=await router.save({kind:'custom',baseUrl:server.url+'/responses',protocol:'responses',model:'global-model'}),second=await router.save({kind:'custom',baseUrl:server.url+'/responses',protocol:'responses',model:'role-model'});await router.activate(first.id);router.setEnabled(true);
  await router.runProfile(second.id,()=>consume(router.stream({messages:[{role:'user',content:'hello'}]})));assert.equal(server.requests[0].body.model,'role-model');assert.equal(router.currentSelection().provider,first.id);assert.equal(events.length,2);assert.deepEqual(events.map(e=>e.active),[true,false]);assert.equal(events[0].id,events[1].id);
  let release;const gate=new Promise(r=>release=r),current=router.runTurn(()=>gate);const abort=new AbortController();const queued=router.runProfile(second.id,()=>{throw Error('cancelled work executed');},abort.signal);abort.abort();release();await current;await assert.rejects(queued,/取消/);assert.equal(events.length,2);
});
test('listing and status do not keep pets awake; failed streamed requests always release guards',async t=>{
  const server=await mockModelServer();t.after(()=>server.close());const events=[],router=new ModelRouter({dataRoot:await mkdtemp(join(tmpdir(),'buddy-activity-')),codex:stubCodex(),crypto:fakeCrypto,onActivity:e=>events.push(e)});await router.ready;t.after(()=>router.close());
  const p=await router.save({kind:'custom',baseUrl:server.url+'/responses',protocol:'responses',model:'model'});await router.activate(p.id);router.setEnabled(true);await router.fetchModels(p);router.status();assert.equal(events.length,0);
  server.setFailure({status:401});await assert.rejects(consume(router.stream({messages:[{role:'user',content:'hi'}]})));assert.deepEqual(events.map(e=>e.active),[true,false]);assert.equal(router.controllers.size,0);
});
test('image jobs with no returned token usage keep a guard until success or failure, not during model-list checks',async t=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=','base64'),events=[];let bad=false;
  const cg=new CgService({dataRoot:await mkdtemp(join(tmpdir(),'buddy-cg-activity-')),codex:{...stubCodex(),close(){}},crypto:fakeCrypto,onActivity:e=>events.push(e),referenceResolver:async()=>[],imageCodec:bytes=>({png:bytes,thumbnail:bytes,width:1,height:1}),fetchImpl:async url=>new Response(JSON.stringify(String(url).endsWith('/models')?{data:[]} :bad?{error:{message:'failed'}}:{data:[{b64_json:png.toString('base64')}]}),{status:bad?500:200,headers:{'content-type':'application/json'}})});await cg.ready;t.after(()=>cg.close());
  const p=await cg.save({kind:'custom',baseUrl:'http://127.0.0.1:123/v1',protocol:'openai-images',model:'image',options:{references:false}});await cg.activate(p.id);await cg.fetchModels(p);assert.equal(events.length,0);
  cg.start();for(const failure of [false,true]){bad=failure;const job=await cg.enqueue({sourceEventId:'activity-'+failure,prompt:'test'});for(let i=0;i<100&&!['ready','failed'].includes(cg.job(job.id).status);i++)await new Promise(r=>setTimeout(r,10));assert.equal(cg.job(job.id).status,failure?'failed':'ready');}
  assert.deepEqual(events.map(e=>e.active),[true,false,true,false]);assert.equal(events[0].id,events[1].id);assert.equal(events[2].id,events[3].id);
});
