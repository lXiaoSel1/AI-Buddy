import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createBuddyPluginServices} from '../src/buddy-plugin-services/index.mjs';
import {createSocialHost} from '../src/buddy-plugin-services/social-host.mjs';
import {createSocialPluginBroker} from '../src/buddy-plugin-services/social-plugin-broker.mjs';
import {SOCIAL_CAPABILITIES} from '../src/buddy-plugin-services/social-contract.mjs';
import {fullReadingModel} from '../src/buddy-plugin-services/bili-full-reading-authority.mjs';
import {validFullReadingUnderstanding} from '../src/buddy-plugin-services/bili-full-reading.mjs';
import {takeHostImages} from '../src/model-images.mjs';
import {runR95Model} from '../src/r95-model-request.mjs';

async function fixture(t){
 const dataRoot=await mkdtemp(join(tmpdir(),'acr-full-recovery-')),identity={pluginId:'recovery-fixture',packageName:'@ai-buddy/bilibili-companion'};
 const account={ref:'account',accountId:'42',generation:1,enabled:true},model={id:'model',kind:'custom',protocol:'responses',model:'vision',models:[{id:'vision',inputModalities:['text','image']}]};
 const understanding={summary:'observed summary',notes:'observed notes',evidenceRefs:['cue'],completedMaterial:true,shareWorthy:false,shareText:'',interestTags:[],commentWorthy:false};
 const material={items:[{id:'cue',text:'original host cue'}],readRange:{planHash:'plan'}};
 const state={lifeId:'life',calls:0,claims:0,reconciles:0,blockDelivery:false,blockAtFinish:true,phase:'reading',batchStatus:'prepared',processed:false,model,receipt:null};
 const dto=()=>({readingId:'reading',readingMode:'full-v1',planHash:'plan',model:fullReadingModel(model),phase:state.phase,confirmed:true,needsReview:['submitted','unknown'].includes(state.batchStatus),calls:[{stepId:'batch',stepKind:'summary',status:state.batchStatus,processed:state.processed,providerRequestId:state.receipt?.requestId??null}]});
 let expectedScope;
 const own=scope=>{assert.deepEqual(scope,expectedScope);};
 const proof=args=>{own(args.scope);assert.equal(args.readingId,'reading');assert.equal(args.batchId,'batch');assert.deepEqual(args.material,material);assert.deepEqual(args.visualMaterialRefs,[]);return {inputHash:'immutable-input',stepKind:'summary',finalSummary:true};};
 const full={get:args=>{own(args.scope);return dto();},getForAccount:args=>{assert.equal(args.accountRef,account.ref);assert.equal(args.accountBindingId,account.accountId);return dto();},verifyMaterial:proof,verifyRecoveryMaterial:proof,resolve:()=>[],claim:args=>{own(args.scope);assert.equal(args.inputHash,'immutable-input');state.claims++;state.batchStatus='submitted';return {claimed:true};},finish(args){own(args.scope);state.batchStatus=args.status;if(args.status==='unknown')state.phase='paused';else{state.receipt=structuredClone(args.result);let value;try{value=JSON.parse(args.result.text);}catch{}state.processed=validFullReadingUnderstanding(value,new Set(['cue']))&&value.completedMaterial===true;state.phase=state.processed?'completed':'paused';}return dto();},reconcile(args){state.reconciles++;own(args.scope);assert.equal(args.inputHash,'immutable-input');assert.notEqual(state.phase,'cancelled');if(state.batchStatus==='completed'){assert.deepEqual(args.result,state.receipt);return dto();}assert.ok(['submitted','unknown'].includes(state.batchStatus));return this.finish({...args,status:'completed'});},cancelScope:async()=>{},close(){}};
 const vision={available:true,fullReading:full,...Object.fromEntries(['prepare','read','resolve','claim','finish'].map(key=>[key,()=>{throw Error('legacy vision must not run');}]))};
 const provider={enabled:true,ready:Promise.resolve(),state:{profiles:[model]},captureConnection:()=>structuredClone(state.model),resolveConnection:()=>({connectionId:'model'}),resolveContextCapacity:()=>({tokens:32768,source:'fixture',verified:true}),currentSelection:()=>({provider:'model',model:'vision'}),selected:()=>model,outputLimit:()=>512,runCaptured:(_profile,fn)=>fn(),async *stream(){state.calls++;yield {type:'text-delta',text:state.responseText??JSON.stringify(understanding)};state.blockDelivery=state.blockAtFinish;yield {type:'finish',reason:{kind:'stop'}};}};
 const host=createSocialHost({dataRoot,resolveLife:scope=>({characterId:scope.characterId,personaId:'persona',lifeId:state.lifeId,operationId:'operation'}),model:async({context,payload,signal,check})=>{const ticket=takeHostImages(payload.hostVisionToken,context);return runR95Model({provider,scope:context,card:{id:'character',modelBinding:{enabled:true,connectionId:'model'}},system:payload.system,input:{kind:'bilibili-vision',messages:payload.messages},hostImages:ticket.parts,beforeModelSubmit:ticket.beforeSubmit,signal,checkCurrent:async()=>{await check();if(state.blockDelivery)throw Object.assign(Error('synthetic delivery revoked'),{code:'SYNTHETIC_DELIVERY_REVOKED'});},withOrigin:async(_scope,_kind,fn)=>fn('observed-native-request'),parseOutput:({text,parts,requestId})=>({text,parts,requestId})});}});
 const bridge=createBuddyPluginServices({resolveContext:spec=>host.resolveContext(spec),hostServices:host.services});bridge.grants.set({pluginId:identity.pluginId,declared:SOCIAL_CAPABILITIES,granted:SOCIAL_CAPABILITIES});
 const r95={socialHost:host,socialProfile:()=>({characterId:'character',personaId:'persona',lifeId:state.lifeId,operationId:'operation',connectionRef:'model',available:true}),socialCatalog:()=>[]},accounts={forPlugin:()=>structuredClone(account),get:()=>structuredClone(account),secret:()=>({cookie:'synthetic'}),list:()=>[account]};
 const options={dataRoot,accounts,bridge,getR95:()=>r95,getProvider:()=>provider,biliVision:vision,transport:{observation:()=>null},verifyBilibiliAccount:async()=>({connected:true,accountId:'42'})};let broker=createSocialPluginBroker(options);
 t.after(async()=>{await broker.close();await bridge.close();host.close();await rm(dataRoot,{recursive:true,force:true});});
 const read=payload=>broker.handlers['social.context.read']({identity,payload,context:{authority:{kind:'app',action:'reading.get'}},check:async()=>{}});
 const context=await read({purpose:'bilibili-activity',characterId:'character',modelConnectionRef:'model'}),row=await broker.contextProvider({identity,method:'activity.lease',payload:{contextToken:context.contextToken}});
 expectedScope={...Object.fromEntries(['pluginId','packageName','characterId','personaId','lifeId','operationId','channel','conversationId','actorId','sessionId','accountBindingId','bindingGeneration','activityGeneration','visibilityScope','connectionRef','modelConnectionRef'].filter(key=>row[key]!==undefined).map(key=>[key,row[key]])),accountRef:account.ref,accountId:account.accountId,generation:account.generation};
 const call=(method,payload)=>broker.handlers[method]({identity,context:row,payload,check:async()=>{}}),lease=await call('activity.lease',{activityId:'attempt'});
 const request=()=>call('models.request',{...lease,readingMode:'full-v1',readingId:'reading',stepId:'batch',stepKind:'summary',purpose:'bilibili-understanding',system:'synthetic',visualMaterialRefs:[],material,messages:[{role:'user',content:'original host cue'}]});
 const get=async()=>{const m=await read({purpose:'manage-plugin'}),payload={contextToken:m.contextToken,operation:'video.fullReading.get',parameters:{readingId:'reading'}},context=await broker.contextProvider({identity,method:'connections.request',payload});return broker.handlers['connections.request']({identity,context,payload,check:async()=>{}});};
 return {dataRoot,state,account,bridge,request,get,understanding,material,finish:()=>call('activity.finish',{...lease,status:'unknown'}),restart:async()=>{await broker.close();broker=createSocialPluginBroker(options);}};
}

test('ACR host: management reconciles an exact complete observation once and returns the same minimal result after journal restart',async t=>{
 const f=await fixture(t);await assert.rejects(f.request(),{code:'SYNTHETIC_DELIVERY_REVOKED'});assert.equal(f.state.batchStatus,'unknown');assert.equal(f.state.calls,1);await f.finish();f.state.blockDelivery=false;
 const first=await f.get();assert.equal(first.needsReview,false);assert.equal(first.recoveredResults.length,1);assert.deepEqual(first.recoveredResults[0].understanding,f.understanding);assert.deepEqual(first.recoveredResults[0].material,f.material);assert.deepEqual(Object.keys(first.recoveredResults[0]).sort(),['inputHash','material','planHash','providerRequestId','readingId','stepId','stepKind','understanding'].sort());
 await f.restart();const second=await f.get();assert.deepEqual(second.recoveredResults,first.recoveredResults);assert.equal(f.state.calls,1);assert.equal(f.state.claims,1);
});

test('ACR host: a lost outer response can recover a completed latest receipt without another reconcile or provider call',async t=>{
 const f=await fixture(t);f.state.blockAtFinish=false;await f.request();await f.finish();const reconciles=f.state.reconciles;
 const first=await f.get();assert.equal(first.recoveredResults[0].providerRequestId,'observed-native-request');assert.deepEqual(first.recoveredResults[0].understanding,f.understanding);assert.equal(f.state.reconciles,reconciles);
 await f.restart();assert.deepEqual((await f.get()).recoveredResults,first.recoveredResults);assert.equal(f.state.calls,1);assert.equal(f.state.claims,1);assert.equal(f.state.reconciles,reconciles);
});

test('ACR host: failure after the checkpoint commit retains the exact recovery result for the next management read',async t=>{
 const f=await fixture(t);await assert.rejects(f.request());await f.finish();f.state.blockDelivery=false;
 const db=new DatabaseSync(join(f.dataRoot,'social-core','runtime-v1.sqlite'));
 try{db.exec("CREATE TRIGGER refuse_recovery_ack BEFORE UPDATE ON model_inputs WHEN NEW.reconciled=1 BEGIN SELECT RAISE(ABORT,'synthetic recovery ack failure');END");await assert.rejects(f.get(),/synthetic recovery ack failure/);assert.equal(f.state.batchStatus,'completed');assert.equal(f.state.calls,1);db.exec('DROP TRIGGER refuse_recovery_ack');const recovered=await f.get();assert.equal(recovered.recoveredResults[0].providerRequestId,'observed-native-request');await f.restart();assert.deepEqual((await f.get()).recoveredResults,recovered.recoveredResults);assert.equal(f.state.calls,1);}finally{db.exec('DROP TRIGGER IF EXISTS refuse_recovery_ack');db.close();}
});

test('ACR host: failure of the final completed journal write preserves the already observed provider response',async t=>{
 const f=await fixture(t);f.state.blockAtFinish=false;const db=new DatabaseSync(join(f.dataRoot,'social-core','runtime-v1.sqlite'));
 try{db.exec("CREATE TRIGGER refuse_completed BEFORE UPDATE ON models WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'synthetic completed write failure');END");await assert.rejects(f.request(),/synthetic completed write failure/);assert.equal(f.state.batchStatus,'completed');assert.equal(db.prepare('SELECT state FROM models').get().state,'observed');await f.finish();db.exec('DROP TRIGGER refuse_completed');const recovered=await f.get();assert.equal(recovered.recoveredResults[0].providerRequestId,'observed-native-request');assert.equal(f.state.calls,1);assert.equal(f.state.claims,1);}finally{db.exec('DROP TRIGGER IF EXISTS refuse_completed');db.close();}
});

for(const change of ['life','account','model','grant','cancelled'])test('ACR host: management cannot consume an observed receipt after '+change+' changed',async t=>{
 const f=await fixture(t);await assert.rejects(f.request());await f.finish();f.state.blockDelivery=false;
 if(change==='life')f.state.lifeId='new-life';if(change==='account')f.account.generation++;if(change==='model')f.state.model={...f.state.model,model:'other-model'};if(change==='grant')f.bridge.grants.revoke('recovery-fixture');if(change==='cancelled')f.state.phase='cancelled';
 const reading=await f.get();assert.equal(reading.recoveredResults,undefined);assert.equal(f.state.batchStatus,'unknown');assert.equal(f.state.calls,1);
});


for(const invalid of ['malformed','missing-schema','incomplete-material'])for(const lostDelivery of [false,true])test('ACR host: repeatable known-invalid recovery preserves '+invalid+' after '+(lostDelivery?'lost delivery':'completed outer response'),async t=>{
 const f=await fixture(t);f.state.blockAtFinish=lostDelivery;
 if(invalid==='malformed')f.state.responseText='{malformed';else if(invalid==='missing-schema')delete f.understanding.notes;else f.understanding.completedMaterial=false;
 if(lostDelivery)await assert.rejects(f.request());else await f.request();await f.finish();f.state.blockDelivery=false;
 const first=await f.get();assert.equal(first.needsReview,false);assert.equal(first.calls[0].processed,false);assert.equal(first.phase,'paused');assert.equal(first.recoveredResults.length,1);const receipt=first.recoveredResults[0];assert.equal(receipt.receiptKind,'invalid');assert.equal(receipt.schemaInvalid,invalid!=='incomplete-material');assert.equal(receipt.providerRequestId,'observed-native-request');assert.equal(receipt.result.text,f.state.responseText??JSON.stringify(f.understanding));assert.deepEqual(receipt.material,f.material);
 await f.restart();assert.deepEqual((await f.get()).recoveredResults,first.recoveredResults);assert.equal(f.state.calls,1);assert.equal(f.state.claims,1);
});
