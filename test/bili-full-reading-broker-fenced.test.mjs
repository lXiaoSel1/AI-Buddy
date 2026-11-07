import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createBuddyPluginServices} from '../src/buddy-plugin-services/index.mjs';
import {createSocialHost} from '../src/buddy-plugin-services/social-host.mjs';
import {createSocialPluginBroker} from '../src/buddy-plugin-services/social-plugin-broker.mjs';
import {SOCIAL_CAPABILITIES} from '../src/buddy-plugin-services/social-contract.mjs';
import {socialScopeSnapshot} from '../src/buddy-plugin-services/social-runtime-journal.mjs';
import {createBiliFullReading} from '../src/buddy-plugin-services/bili-full-reading.mjs';
import {createBiliFullReadingStore} from '../src/buddy-plugin-services/bili-full-reading-store.mjs';
import {fullReadingModel} from '../src/buddy-plugin-services/bili-full-reading-authority.mjs';
import {takeHostImages} from '../src/model-images.mjs';
import {runR95Model} from '../src/r95-model-request.mjs';

const png=Buffer.alloc(80);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(1009,16);png.writeUInt32BE(620,20);
async function fixture(t){
 const dataRoot=mkdtempSync(join(tmpdir(),'bili-fenced-broker-')),directory=join(dataRoot,'vision'),readingId='reading',identity={pluginId:'fenced-recovery-fixture',packageName:'@ai-buddy/bilibili-companion'};
 const account={ref:'account',accountId:'42',generation:1,enabled:true},model={id:'model',kind:'custom',protocol:'responses',model:'vision',models:[{id:'vision',inputModalities:['text','image']}]},state={lifeId:'life',calls:0};
 const media=async()=>{};media.fullSampling=async args=>{for(const sheet of args.sheets){args.signal?.throwIfAborted();await args.onSheet({...sheet,frames:sheet.frames.map(f=>({...f,decodedPTS:f.time+.001})),png});if(args.stopAfterSheets)break;}return {audio:'unavailable',transcript:[]};};
 const full=createBiliFullReading({directory,acquireMedia:media}),store=createBiliFullReadingStore({directory:join(directory,'full-v1')});
 const provider={enabled:true,ready:Promise.resolve(),state:{profiles:[model]},captureConnection:()=>structuredClone(model),resolveConnection:()=>({connectionId:'model'}),resolveContextCapacity:()=>({tokens:32768,source:'fixture',verified:true}),currentSelection:()=>({provider:'model',model:'vision'}),selected:()=>model,outputLimit:()=>512,runCaptured:(_profile,fn)=>fn(),async *stream(){state.calls++;state.beforeFinish=store.load(readingId);yield {type:'text-delta',text:state.responseText};yield {type:'finish',reason:{kind:'stop'}};}};
 const host=createSocialHost({dataRoot,resolveLife:scope=>({characterId:scope.characterId,personaId:'persona',lifeId:state.lifeId,operationId:'operation'}),model:async({context,payload,signal,check})=>{const ticket=takeHostImages(payload.hostVisionToken,context);return runR95Model({provider,scope:context,card:{id:'character',modelBinding:{enabled:true,connectionId:'model'}},system:payload.system,input:{kind:'bilibili-vision',messages:payload.messages},hostImages:ticket.parts,beforeModelSubmit:ticket.beforeSubmit,signal,checkCurrent:check,withOrigin:async(_scope,_kind,fn)=>fn('observed-native-request-'+state.calls),parseOutput:({text,parts,requestId})=>({text,parts,requestId})});}});
 const bridge=createBuddyPluginServices({resolveContext:spec=>host.resolveContext(spec),hostServices:host.services});bridge.grants.set({pluginId:identity.pluginId,declared:SOCIAL_CAPABILITIES,granted:SOCIAL_CAPABILITIES});
 const r95={socialHost:host,socialProfile:()=>({characterId:'character',personaId:'persona',lifeId:state.lifeId,operationId:'operation',connectionRef:'model',available:true}),socialCatalog:()=>[]},accounts={forPlugin:()=>structuredClone(account),get:()=>structuredClone(account),secret:()=>({cookie:'synthetic'}),list:()=>[account]};
 const vision={available:true,fullReading:full,...Object.fromEntries(['prepare','read','resolve','claim','finish'].map(key=>[key,()=>{throw Error('legacy vision must not run');}]))};
 const options={dataRoot,accounts,bridge,getR95:()=>r95,getProvider:()=>provider,biliVision:vision,transport:{observation:()=>null},verifyBilibiliAccount:async()=>({connected:true,accountId:'42'})};let broker=createSocialPluginBroker(options);
 t.after(async()=>{await broker.close();await bridge.close();host.close();await full.close();assert.equal(dirname(dataRoot),resolve(tmpdir()));rmSync(dataRoot,{recursive:true,force:true});});
 const read=payload=>broker.handlers['social.context.read']({identity,payload,context:{authority:{kind:'app',action:'reading.get'}},check:async()=>{}});
 const context=await read({purpose:'bilibili-activity',characterId:'character',modelConnectionRef:'model'}),row=await broker.contextProvider({identity,method:'activity.lease',payload:{contextToken:context.contextToken}});
 const scope={...socialScopeSnapshot(row),accountRef:account.ref,accountId:account.accountId,generation:account.generation},owner={pluginId:identity.pluginId,accountRef:account.ref,accountBindingId:account.accountId,readingId};
 const call=(method,payload)=>broker.handlers[method]({identity,context:row,payload,check:async()=>{}}),lease=await call('activity.lease',{activityId:readingId});
 const video={videoId:'BV12345678',cid:123,duration:1,title:'Fixture',url:'https://www.bilibili.com/video/BV12345678'},plan=await full.prepare({scope,readingId,video,parts:[{cid:123,page:1,title:'Part one',duration:1}],config:{sampleSeconds:.5,windowSeconds:6},subtitleTracks:[{cid:123,language:'zh-CN',items:[{id:'subtitle:1',start:0,end:1,text:'Original observed cue'}]}],model:fullReadingModel(model)});
 full.confirmForAccount({...owner,confirmed:true,planHash:plan.planHash});const batch=await full.read({scope,readingId});
 const understanding={summary:'Observed complete result',notes:'Original source-backed note',evidenceRefs:[batch.material.items[0].id],completedMaterial:true,shareWorthy:false,shareText:'',interestTags:[],commentWorthy:false};state.responseText='```json\n'+JSON.stringify(understanding)+'\n```';
 await call('models.request',{...lease,readingMode:'full-v1',readingId,stepId:batch.batchId,stepKind:batch.stepKind,purpose:'bilibili-understanding',system:'synthetic',visualMaterialRefs:batch.visualMaterialRefs,material:batch.material,messages:[{role:'user',content:'Original observed cue'}]});
 await call('activity.finish',{...lease,status:'completed'});
 // Recreate only the legacy mutable checkpoint. The real provider receipt,
 // immutable request and journal stay exactly as the broker wrote them.
 const legacy=store.load(readingId),entry=legacy.batches.at(-1);assert.equal(entry.status,'completed');assert.equal(state.beforeFinish.batches.at(-1).status,'submitted');
 for(const key of ['completedUnitIds','unitCursor','summaryNodes','summaryDepth','finalBatchId','completedAt']){if(Object.hasOwn(state.beforeFinish,key))legacy[key]=structuredClone(state.beforeFinish[key]);else delete legacy[key];}
 entry.processed=false;delete entry.aggregationAccepted;legacy.lastBatch=null;legacy.phase='paused';legacy.modelReason='BILI_FULL_MATERIAL_NOT_COMPLETED';store.save(legacy);
 const journal=()=>{const db=new DatabaseSync(join(dataRoot,'social-core','runtime-v1.sqlite'),{readOnly:true});try{return db.prepare('SELECT m.id,m.digest,m.scope,m.result,m.requestId,i.input FROM models m JOIN model_inputs i ON i.id=m.id ORDER BY m.rowid').all();}finally{db.close();}};
 const immutable=()=>({receipt:readFileSync(join(directory,'full-v1','receipts',entry.receiptHash+'.json'),'utf8'),request:readFileSync(join(directory,'full-v1','requests',entry.requestHash+'.json'),'utf8'),journal:journal()});
 const original=immutable();assert.equal(JSON.parse(original.receipt).result.text,state.responseText);assert.equal(JSON.parse(original.journal[0].result).text,state.responseText);
 const get=async()=>{const management=await read({purpose:'manage-plugin'}),payload={contextToken:management.contextToken,operation:'video.fullReading.get',parameters:{readingId}},context=await broker.contextProvider({identity,method:'connections.request',payload});return broker.handlers['connections.request']({identity,context,payload,check:async()=>{}});};
 return {state,account,full,store,owner,batch,understanding,entry:structuredClone(entry),original,immutable,get,restart:async()=>{await broker.close();broker=createSocialPluginBroker(options);}};
}

test('full-reading broker locally recovers a legacy completed fenced receipt without resubmission or rewriting evidence',async t=>{
 const f=await fixture(t),before=f.full.getForAccount(f.owner);assert.equal(before.calls[0].processed,false);assert.equal(before.coverage.complete,false);
 const first=await f.get();assert.equal(first.calls[0].processed,true);assert.equal(first.phase,'paused');assert.equal(first.modelReason,null);assert.equal(first.coverage.complete,true);assert.equal(first.needsReview,false);
 assert.equal(first.recoveredResults.length,1);assert.deepEqual(first.recoveredResults[0].understanding,f.understanding);assert.deepEqual(first.recoveredResults[0].material,f.batch.material);assert.equal(first.recoveredResults[0].inputHash,f.batch.inputHash);assert.equal(first.recoveredResults[0].providerRequestId,f.entry.providerRequestId);assert.equal(first.recoveredResults[0].receiptKind,undefined);assert.equal(first.recoveredResults[0].schemaInvalid,undefined);
 const recovered=f.store.load(f.owner.readingId),entry=recovered.batches[0];assert.equal(recovered.batches.length,1);assert.ok(recovered.summaryNodes.length>0);assert.equal(recovered.unitCursor,recovered.units.length);for(const key of ['receiptHash','requestHash','finishedAt','providerRequestId','inputHash'])assert.equal(entry[key],f.entry[key]);assert.deepEqual(f.immutable(),f.original);assert.equal(f.state.calls,1);
 const second=await f.get();assert.deepEqual(second.recoveredResults,first.recoveredResults);assert.deepEqual(f.store.load(f.owner.readingId),recovered);
 await f.restart();const third=await f.get();assert.deepEqual(third.recoveredResults,first.recoveredResults);assert.deepEqual(f.store.load(f.owner.readingId),recovered);assert.deepEqual(f.immutable(),f.original);assert.equal(f.state.calls,1);
});

for(const change of ['cancelled','life','account'])test('full-reading broker leaves a legacy fenced receipt untouched after '+change+' changed',async t=>{
 const f=await fixture(t);if(change==='cancelled')f.full.stopForAccount(f.owner);if(change==='life')f.state.lifeId='new-life';if(change==='account')f.account.generation++;
 const before=f.store.load(f.owner.readingId),view=await f.get();assert.equal(view.recoveredResults,undefined);assert.equal(view.calls[0].processed,false);assert.equal(view.phase,change==='cancelled'?'cancelled':'paused');assert.deepEqual(f.store.load(f.owner.readingId),before);assert.deepEqual(f.immutable(),f.original);assert.equal(f.state.calls,1);
});
