import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBiliFullReading} from '../src/buddy-plugin-services/bili-full-reading.mjs';
import {createBiliFullReadingStore} from '../src/buddy-plugin-services/bili-full-reading-store.mjs';

const scope={pluginId:'bili',packageName:'@ai-buddy/bilibili-companion',accountBindingId:'binding',accountRef:'account',accountId:'10001',generation:1,characterId:'deepseek',personaId:'default',lifeId:'life',operationId:'operation'};
const readingId='fenced-reading',owner={pluginId:scope.pluginId,accountRef:scope.accountRef,accountBindingId:scope.accountBindingId,readingId};
const png=Buffer.alloc(80);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(1009,16);png.writeUInt32BE(620,20);
const valueFor=batch=>({summary:'A visible source-backed scene.',notes:'A concrete visible detail.',evidenceRefs:batch.material.items.map(item=>item.id),completedMaterial:true,shareWorthy:false,commentWorthy:false,shareText:'',interestTags:[]});
async function fixture(t,{duration=6,maxImages=4}={}){
 const directory=mkdtempSync(join(tmpdir(),'bili-full-fenced-')),media=async()=>{},calls=[];media.fullSampling=async args=>{calls.push(args.stopAfterSheets===1?'preview':'full');let n=0;for(const sheet of args.sheets){args.signal?.throwIfAborted();await args.onSheet({...sheet,frames:sheet.frames.map(frame=>({...frame,decodedPTS:frame.time+.001})),png});if(args.stopAfterSheets&&++n>=args.stopAfterSheets)break;}return {audio:'unavailable',transcript:[]};};
 let service=createBiliFullReading({directory,acquireMedia:media,now:()=>1760000000000});
 t.after(async()=>{await service.close();rmSync(directory,{recursive:true,force:true});});
 const plan=await service.prepare({scope,readingId,video:{videoId:'BV12345678',cid:123,duration},parts:[{cid:123,page:1,duration}],config:{sampleSeconds:.5,windowSeconds:6},subtitleTracks:[],model:{connectionRef:'fixture-model',modelFingerprint:'fixture-fingerprint',modelId:'fixture-only',protocol:'responses',maxImages,contextTokens:32000,maxTextChars:10000,maxInputBytes:9*1024*1024}});
 service.confirmForAccount({...owner,confirmed:true,planHash:plan.planHash});
 return {directory,calls,get service(){return service;},store:()=>createBiliFullReadingStore({directory:join(directory,'full-v1')}),restart:async()=>{await service.close();service=createBiliFullReading({directory,acquireMedia:media,now:()=>1760000001000});},next:async()=>{const batch=await service.read({scope,readingId});assert.equal(service.claim({scope,readingId,batchId:batch.batchId,inputHash:batch.inputHash}).claimed,true);return batch;},finish:(batch,text)=>service.finish({scope,readingId,batchId:batch.batchId,status:'completed',providerRequestId:'provider-'+batch.batchId,result:{text}})};
}

test('a fenced fifth batch preserves twenty-sheet coverage and advances to summary without replay',async t=>{
 const f=await fixture(t,{duration:120});
 for(let i=0;i<5;i++){const batch=await f.next(),text=JSON.stringify(valueFor(batch)),state=f.finish(batch,i===4?'```json\n'+text+'\n```':text);assert.equal(state.calls.at(-1).processed,true);assert.equal(state.progress.completed,(i+1)*4);}
 const state=f.service.get({scope,readingId});assert.equal(state.coverage.complete,true);assert.equal(state.calls.length,5);assert.equal(state.modelReason,null);
 const next=await f.service.read({scope,readingId});assert.equal(next.stepKind,'summary');assert.equal(next.finalSummary,true);
});

function seedLegacy(f,batch,result){
 const disk=f.store(),row=disk.load(readingId),entry=row.batches.find(b=>b.batchId===batch.batchId);entry.status='completed';entry.processed=false;entry.providerRequestId='original-paid-request';entry.finishedAt=1750000000000;
 entry.receiptHash=disk.put('receipt',{readingId,batchId:batch.batchId,requestHash:entry.requestHash,providerRequestId:entry.providerRequestId,result,finishedAt:entry.finishedAt});row.phase='paused';row.modelReason='BILI_FULL_MATERIAL_NOT_COMPLETED';row.lastBatch=null;disk.save(row);
 return {scope,readingId,batchId:batch.batchId,inputHash:batch.inputHash,providerRequestId:entry.providerRequestId,result};
}

test('restart locally reprocesses an exact legacy completed receipt once and preserves its original identity',async t=>{
 const f=await fixture(t),batch=await f.next(),result={text:'```json\n'+JSON.stringify(valueFor(batch))+'\n```'},args=seedLegacy(f,batch,result),before=f.store().load(readingId).batches[0],receiptBefore=f.store().get('receipt',before.receiptHash);
 await f.restart();await assert.rejects(f.service.read({scope,readingId}),{code:'BILI_FULL_MATERIAL_NOT_COMPLETED'});const mediaBefore=[...f.calls];
 const state=f.service.reconcile(args);assert.equal(state.calls[0].processed,true);assert.equal(state.progress.completed,1);assert.equal(state.phase,'paused');assert.equal(state.modelReason,null);assert.deepEqual(f.calls,mediaBefore);
 const after=f.store().load(readingId).batches[0];for(const key of ['batchId','inputHash','requestHash','receiptHash','providerRequestId','finishedAt'])assert.equal(after[key],before[key],key);assert.deepEqual(f.store().get('receipt',after.receiptHash),receiptBefore);
 assert.equal(f.service.reconcile(args).revision,state.revision);await f.restart();assert.equal(f.service.reconcile(args).revision,state.revision);
 const next=await f.service.read({scope,readingId});assert.equal(next.stepKind,'summary');assert.equal(next.material.items.length,2);assert.equal(new Set(next.material.items.map(item=>item.id)).size,2);
});

for(const [name,wrap]of [['raw',text=>text],['plain fence',text=>'```\n'+text+'\n```'],['JSON fence and surrounding whitespace',text=>' \r\n```JSON\r\n'+text+'\r\n```\r\n ']])test(name+' segment and final summary complete through the same public service',async t=>{
 const f=await fixture(t),segment=await f.next();assert.equal(f.finish(segment,wrap(JSON.stringify(valueFor(segment)))).calls[0].processed,true);
 const summary=await f.next();assert.equal(summary.finalSummary,true);const state=f.finish(summary,wrap(JSON.stringify(valueFor(summary))));assert.equal(state.phase,'completed');assert.equal(state.finalProcessed,true);assert.equal(state.finalBatchId,summary.batchId);assert.equal(state.calls.length,2);
});

for(const [name,change]of [
 ['leading prose',(text)=>'Here is the result:\n'+text],['trailing prose',(text)=>text+'\nDone.'],['array',(text)=>'['+text+']'],['multiple fences',(text)=>'```json\n'+text+'\n```\n```json\n'+text+'\n```'],['incomplete fence',(text)=>'```json\n'+text],['unsupported fence tag',(text)=>'```javascript\n'+text+'\n```'],['invalid schema',(_text,value)=>JSON.stringify({...value,shareWorthy:'false'})],['external evidence',(_text,value)=>JSON.stringify({...value,evidenceRefs:['another-batch-sheet']})],['unfinished material',(_text,value)=>JSON.stringify({...value,completedMaterial:false})]
])test(name+' stays a known rejected receipt without replay or repeated local changes',async t=>{
 const f=await fixture(t),batch=await f.next(),value=valueFor(batch),text=change(JSON.stringify(value),value),state=f.finish(batch,text);assert.equal(state.calls[0].status,'completed');assert.equal(state.calls[0].processed,false);assert.equal(state.progress.completed,0);assert.equal(state.needsReview,false);assert.equal(f.service.claim({scope,readingId,batchId:batch.batchId,inputHash:batch.inputHash}).claimed,false);
 const args={scope,readingId,batchId:batch.batchId,inputHash:batch.inputHash,providerRequestId:'provider-'+batch.batchId,result:{text}},reprocessed=f.service.reconcile(args);assert.equal(reprocessed.calls[0].processed,false);assert.equal(reprocessed.modelReason,'BILI_FULL_MATERIAL_NOT_COMPLETED');assert.equal(f.service.reconcile(args).revision,reprocessed.revision);await assert.rejects(f.service.read({scope,readingId}),{code:'BILI_FULL_MATERIAL_NOT_COMPLETED'});
});

test('an explicit structured understanding retains precedence over valid fenced text',async t=>{
 const f=await fixture(t),batch=await f.next(),state=f.service.finish({scope,readingId,batchId:batch.batchId,status:'completed',providerRequestId:'structured',result:{understanding:{...valueFor(batch),completedMaterial:false},text:'```json\n'+JSON.stringify(valueFor(batch))+'\n```'}});assert.equal(state.calls[0].processed,false);assert.equal(state.progress.completed,0);
});

test('raw legacy recovery preserves prior failure evidence and an explicit pause',async t=>{
 const f=await fixture(t),batch=await f.next(),args=seedLegacy(f,batch,{text:JSON.stringify(valueFor(batch))});f.service.pauseForAccount(owner);const paused=f.service.get({scope,readingId}),state=f.service.reconcile(args);assert.equal(state.calls[0].processed,true);assert.equal(state.phase,'paused');assert.equal(state.modelReason,'BILI_FULL_PAUSED');assert.equal(state.calls.length,paused.calls.length);const marker=f.store().load(readingId).batches[0].localReprocess;assert.equal(marker.priorProcessed,false);assert.equal(marker.priorPhase,'paused');assert.equal(marker.priorModelReason,'BILI_FULL_PAUSED');
});

test('legacy recovery refuses changed scope, input, provider and result before mutating the reading',async t=>{
 const f=await fixture(t),batch=await f.next(),args=seedLegacy(f,batch,{text:'```json\n'+JSON.stringify(valueFor(batch))+'\n```'}),before=f.service.get({scope,readingId});
 for(const [change,code]of [[{scope:{...scope,lifeId:'other-life'}},'BILI_VISION_SCOPE_DENIED'],[{inputHash:'wrong-input'},'BILI_FULL_BATCH_MISMATCH'],[{providerRequestId:'another-provider'},'BILI_VISION_STEP_CONFLICT'],[{result:{text:JSON.stringify(valueFor(batch))}},'BILI_VISION_STEP_CONFLICT']]){assert.throws(()=>f.service.reconcile({...args,...change}),{code});assert.equal(f.service.get({scope,readingId}).revision,before.revision);}
 const state=f.service.reconcile(args);assert.equal(state.calls[0].processed,true);const marker=f.store().load(readingId).batches[0].localReprocess;assert.equal(marker.priorModelReason,'BILI_FULL_MATERIAL_NOT_COMPLETED');
});

test('an explicitly stopped legacy receipt cannot reopen or advance coverage',async t=>{
 const f=await fixture(t),batch=await f.next(),args=seedLegacy(f,batch,{text:'```json\n'+JSON.stringify(valueFor(batch))+'\n```'});f.service.stopForAccount(owner);const before=f.service.get({scope,readingId});assert.throws(()=>f.service.reconcile(args),{code:'BILI_FULL_BATCH_MISMATCH'});const state=f.service.get({scope,readingId});assert.equal(state.phase,'cancelled');assert.equal(state.progress.completed,0);assert.equal(state.revision,before.revision);
});

test('a paused legacy final receipt completes locally and cannot create another paid summary batch',async t=>{
 const f=await fixture(t),segment=await f.next();f.finish(segment,JSON.stringify(valueFor(segment)));const final=await f.next(),args=seedLegacy(f,final,{text:'```json\n'+JSON.stringify(valueFor(final))+'\n```'});f.service.pauseForAccount(owner);await f.restart();const mediaBefore=[...f.calls],state=f.service.reconcile(args);assert.equal(state.phase,'completed');assert.equal(state.modelReason,null);assert.equal(state.finalBatchId,final.batchId);assert.equal(state.finalProcessed,true);assert.equal(state.calls.length,2);assert.deepEqual(f.calls,mediaBefore);await assert.rejects(f.service.read({scope,readingId}),{code:'BILI_FULL_ALREADY_COMPLETED'});assert.equal(f.service.reconcile(args).revision,state.revision);
});

for(const kind of ['receipt reading identity','receipt finished time','original request material'])test('legacy recovery rejects changed '+kind+' without adding coverage or a reprocess attempt',async t=>{
 const f=await fixture(t),batch=await f.next(),args=seedLegacy(f,batch,{text:'```json\n'+JSON.stringify(valueFor(batch))+'\n```'}),disk=f.store(),row=disk.load(readingId),entry=row.batches[0],receipt=disk.get('receipt',entry.receiptHash);
 if(kind==='receipt reading identity')receipt.readingId='foreign-reading';else if(kind==='receipt finished time')receipt.finishedAt++;else{const request=disk.get('request',entry.requestHash);request.batch.material.items[0].start=99;entry.requestHash=disk.put('request',request);receipt.requestHash=entry.requestHash;}
 entry.receiptHash=disk.put('receipt',receipt);disk.save(row);const before=f.service.get({scope,readingId});assert.throws(()=>f.service.reconcile(args),{code:'BILI_FULL_SOURCE_MISMATCH'});const state=f.service.get({scope,readingId});assert.equal(state.revision,before.revision);assert.equal(state.progress.completed,0);assert.equal(disk.load(readingId).batches[0].localReprocess,undefined);
});

for(const [name,change,code]of [['changed summary graph',row=>{row.summaryGraphVersion=1;},'BILI_FULL_SUMMARY_GRAPH_CHANGED'],['oversized final summary',()=>{},'BILI_FULL_SUMMARY_NO_PROGRESS']])test('legacy fenced reprocessing retains the '+name+' gate',async t=>{
 const f=await fixture(t),segment=await f.next();f.finish(segment,JSON.stringify(valueFor(segment)));const batch=await f.next(),value=valueFor(batch);assert.equal(batch.finalSummary,true);if(name==='oversized final summary')value.notes='Source-backed detail. '.repeat(400);const args=seedLegacy(f,batch,{text:'```json\n'+JSON.stringify(value)+'\n```'}),disk=f.store(),row=disk.load(readingId);change(row);disk.save(row);
 const state=f.service.reconcile(args);assert.equal(state.phase,'paused');assert.equal(state.modelReason,code);assert.equal(state.finalProcessed,false);assert.equal(state.finalBatchId,null);assert.equal(f.service.reconcile(args).revision,state.revision);await assert.rejects(f.service.read({scope,readingId}),{code:'BILI_FULL_SUMMARY_NO_PROGRESS'});
});

test('legacy summary graph upgrade reads the original fenced segment receipt',async t=>{
 const f=await fixture(t),segment=await f.next();f.finish(segment,'```json\n'+JSON.stringify(valueFor(segment))+'\n```');const disk=f.store(),row=disk.load(readingId);row.summaryGraphVersion=1;row.summaryNodes=[];disk.save(row);await f.restart();const summary=await f.service.read({scope,readingId});assert.equal(summary.stepKind,'summary');assert.equal(summary.material.items.length,2);assert.ok(summary.material.items.some(item=>item.text.includes('A visible source-backed scene.')));assert.ok(summary.material.items.some(item=>item.text.includes('A concrete visible detail.')));
});
