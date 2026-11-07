import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBiliFullReading} from '../src/buddy-plugin-services/bili-full-reading.mjs';
const scope={pluginId:'bili',accountRef:'account',accountBindingId:'binding',accountId:'10001',generation:1,characterId:'character',personaId:'persona',lifeId:'life',operationId:'operation'};
const owner={pluginId:scope.pluginId,accountRef:scope.accountRef,accountBindingId:scope.accountBindingId,readingId:'reading'};
async function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'bili-stop-r3-')),png=Buffer.alloc(80);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(1009,16);png.writeUInt32BE(620,20);
 const media=async()=>{};media.fullSampling=async args=>{for(const sheet of args.sheets){args.signal?.throwIfAborted();await args.onSheet({...sheet,frames:sheet.frames.map(f=>({...f,decodedPTS:f.time})),png});if(args.stopAfterSheets)break;}return {};};
 const service=createBiliFullReading({directory,acquireMedia:media});t.after(async()=>{await service.close();rmSync(directory,{recursive:true,force:true});});
 const plan=await service.prepare({scope,readingId:owner.readingId,video:{videoId:'BV12345678',cid:1,duration:6},parts:[{cid:1,page:1,duration:6}],model:{connectionRef:'model',maxImages:1}});
 return {service,plan};
}
test('conditional replan stop requires the exact current unconfirmed plan revision',async t=>{
 const {service,plan}=await fixture(t),condition={...owner,onlyIfUnconfirmed:true,planHash:plan.planHash,revision:plan.revision};
 assert.throws(()=>service.stopForAccount({...condition,planHash:'different'}),{code:'BILI_CONTROL_STALE'});assert.throws(()=>service.stopForAccount({...condition,revision:plan.revision-1}),{code:'BILI_CONTROL_STALE'});assert.equal(service.getForAccount(owner).phase,'awaiting-confirmation');
 assert.equal(service.stopForAccount(condition).phase,'cancelled');assert.throws(()=>service.stopForAccount(condition),{code:'BILI_CONTROL_STALE'});
});
test('conditional stop cannot cancel a confirmed reading',async t=>{
 const {service,plan}=await fixture(t);service.confirmForAccount({...owner,confirmed:true,planHash:plan.planHash});
 assert.throws(()=>service.stopForAccount({...owner,onlyIfUnconfirmed:true,planHash:plan.planHash,revision:plan.revision}),{code:'BILI_FULL_PLAN_FROZEN'});assert.equal(service.getForAccount(owner).confirmed,true);assert.equal(service.getForAccount(owner).phase,'reading');
});
test('ordinary stop preserves a completed reading and its paid batch receipts',async t=>{
 const {service,plan}=await fixture(t);service.confirmForAccount({...owner,confirmed:true,planHash:plan.planHash});let state;
 for(let n=0;n<10;n++){
  const batch=await service.read({scope,readingId:owner.readingId});service.claim({scope,readingId:owner.readingId,batchId:batch.batchId,inputHash:batch.inputHash});
  state=service.finish({scope,readingId:owner.readingId,batchId:batch.batchId,status:'completed',providerRequestId:'provider-'+n,result:{understanding:{summary:'A visible original frame.',notes:'Only a verified fixture detail.',evidenceRefs:[batch.material.items[0].id],completedMaterial:true,shareWorthy:false,commentWorthy:false,shareText:'',interestTags:[]}}});if(state.phase==='completed')break;
 }
 assert.equal(state.phase,'completed');const stopped=service.stopForAccount(owner);assert.equal(stopped.phase,'completed');assert.deepEqual(stopped.calls,state.calls);assert.equal(stopped.revision,state.revision);
});
