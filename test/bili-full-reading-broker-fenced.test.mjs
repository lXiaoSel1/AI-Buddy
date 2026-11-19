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
import {createModelSubmission} from '../src/model-submission.mjs';
import {runR95Model} from '../src/r95-model-request.mjs';

const png=Buffer.alloc(80);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(1009,16);png.writeUInt32BE(620,20);
async function fixture(t,{summaryWithEarlierEvidence=false,ordinaryFinal=false,aggregateRejected=false,official=false,notSent=false,unknown=false}={}){
 const dataRoot=mkdtempSync(join(tmpdir(),'bili-fenced-broker-')),directory=join(dataRoot,'vision'),readingId='reading',identity={pluginId:'fenced-recovery-fixture',packageName:'@ai-buddy/bilibili-companion',exactVersion:'2.0.0',sourceDigest:'a'.repeat(64)};
 const account={ref:'account',accountId:'42',generation:1,enabled:true},model={id:'model',kind:'custom',protocol:'responses',model:'vision',models:[{id:'vision',inputModalities:['text','image']}]},state={lifeId:'life',calls:0};
 const media=async()=>{};media.fullSampling=async args=>{for(const sheet of args.sheets){args.signal?.throwIfAborted();await args.onSheet({...sheet,frames:sheet.frames.map(f=>({...f,decodedPTS:f.time+.001})),png});if(args.stopAfterSheets)break;}return {audio:'unavailable',transcript:[]};};
 const full=createBiliFullReading({directory,acquireMedia:media}),store=createBiliFullReadingStore({directory:join(directory,'full-v1')});
 const provider={enabled:true,supportsSubmissionLifecycle:notSent||unknown,ready:Promise.resolve(),state:{profiles:[model]},captureConnection:()=>structuredClone(model),resolveConnection:()=>({connectionId:'model'}),resolveContextCapacity:()=>({tokens:32768,source:'fixture',verified:true}),currentSelection:()=>({provider:'model',model:'vision'}),selected:()=>model,outputLimit:()=>512,runCaptured:(_profile,fn)=>fn(),async *stream(options){
 const submission=notSent||unknown?createModelSubmission(options,'codex',{requestId:42,threadId:'synthetic-thread'}):null;
 if(submission){await submission.prepare();await submission.beforeSend();if(notSent)throw await submission.failure(Object.assign(Error('transport not written'),{code:'CODEX_PROCESS_CHANGED'}));submission.attempt();await submission.confirm({turnId:'synthetic-turn',correlation:'ack'});}
 state.calls++;if(unknown)throw await submission.failure(Error('provider outcome unknown'));state.beforeFinish=store.load(readingId);yield {type:'text-delta',text:state.responseText};yield {type:'finish',reason:{kind:'stop'}};}};
 const host=createSocialHost({dataRoot,appendExperience:async event=>{state.experience=event;},resolveLife:scope=>({characterId:scope.characterId,personaId:'persona',lifeId:state.lifeId,operationId:'operation'}),model:async({context,payload,signal,check})=>{const ticket=takeHostImages(payload.hostVisionToken,context);return runR95Model({provider,scope:context,card:{id:'character',modelBinding:{enabled:true,connectionId:'model'}},system:payload.system,input:{kind:'bilibili-vision',messages:payload.messages},hostImages:ticket.parts,beforeModelSubmit:ticket.beforeSubmit,signal,checkCurrent:check,withOrigin:async(_scope,_kind,fn)=>fn('observed-native-request-'+state.calls),parseOutput:({text,parts,requestId})=>({text,parts,requestId})});}});
 const bridge=createBuddyPluginServices({resolveContext:async spec=>{const context=await host.resolveContext(spec);await state.afterBridgeContext?.();return context;},hostServices:host.services});bridge.grants.set({pluginId:identity.pluginId,declared:SOCIAL_CAPABILITIES,granted:SOCIAL_CAPABILITIES,generation:379});
 const activation={...identity,enabled:true,official},audit=[];
 const r95={socialHost:host,socialProfile:characterId=>({characterId,personaId:'persona',lifeId:state.lifeId,operationId:'operation',connectionRef:'model',available:true}),socialCatalog:()=>[]},accounts={forPlugin:()=>structuredClone(account),get:()=>structuredClone(account),secret:()=>({cookie:'synthetic'}),list:()=>[account]};
 const vision={available:true,fullReading:full,...Object.fromEntries(['prepare','read','resolve','claim','finish'].map(key=>[key,()=>{throw Error('legacy vision must not run');}]))};
 const options={dataRoot,accounts,bridge,resolveBiliRecoveryActivation:()=>activation,onBiliRecoveryAudit:value=>audit.push(value),getR95:()=>r95,getProvider:()=>provider,biliVision:vision,transport:{observation:()=>null},verifyBilibiliAccount:async()=>({connected:true,accountId:'42'})};let broker=createSocialPluginBroker(options);
 t.after(async()=>{await broker.close();await bridge.close();host.close();await full.close();assert.equal(dirname(dataRoot),resolve(tmpdir()));rmSync(dataRoot,{recursive:true,force:true});});
 const read=payload=>broker.handlers['social.context.read']({identity,payload,context:{authority:{kind:'app',action:'reading.get'}},check:async()=>{}});
 const context=await read({purpose:'bilibili-activity',characterId:'character',modelConnectionRef:'model'}),row=await broker.contextProvider({identity,method:'activity.lease',payload:{contextToken:context.contextToken}});
 const scope={...socialScopeSnapshot(row),accountRef:account.ref,accountId:account.accountId,generation:account.generation},owner={pluginId:identity.pluginId,accountRef:account.ref,accountBindingId:account.accountId,readingId};
 const call=(method,payload)=>broker.handlers[method]({identity,context:row,payload,check:async()=>{}}),lease=await call('activity.lease',{activityId:readingId});
 const video={videoId:'BV12345678',cid:123,duration:1,title:'Fixture',url:'https://www.bilibili.com/video/BV12345678'},plan=await full.prepare({scope,readingId,video,parts:[{cid:123,page:1,title:'Part one',duration:1}],config:{sampleSeconds:.5,windowSeconds:6},subtitleTracks:[{cid:123,language:'zh-CN',items:[{id:'subtitle:1',start:0,end:1,text:'Original observed cue'}]}],model:fullReadingModel(model)});
 full.confirmForAccount({...owner,confirmed:true,planHash:plan.planHash});let batch=await full.read({scope,readingId});
 const understanding={summary:'Observed complete result',notes:'Original source-backed note',evidenceRefs:[batch.material.items[0].id],completedMaterial:true,shareWorthy:false,shareText:'',interestTags:[],commentWorthy:false};
 const request=()=>{
  state.responseText='```json\n'+JSON.stringify(understanding)+'\n```';
  return call('models.request',{...lease,readingMode:'full-v1',readingId,stepId:batch.batchId,stepKind:batch.stepKind,purpose:'bilibili-understanding',system:'synthetic',visualMaterialRefs:batch.visualMaterialRefs,material:batch.material,messages:[{role:'user',content:'Original observed cue'}]});
 };
 let ignored;
 if(summaryWithEarlierEvidence||ordinaryFinal){
  ignored=understanding.evidenceRefs[0];await request();batch=await full.read({scope,readingId});assert.equal(batch.finalSummary,true);
  understanding.evidenceRefs=batch.material.items.map(item=>item.id);
  if(summaryWithEarlierEvidence)understanding.evidenceRefs.push(ignored);
  if(aggregateRejected)understanding.notes='Observed detail. '.repeat(600);
 }
 let fresh;
 if(notSent)await assert.rejects(request(),{code:'SOCIAL_MODEL_NOT_SUBMITTED'});
 else if(unknown)await assert.rejects(request(),/provider outcome unknown/);
 else fresh=await request();
 await call('activity.finish',{...lease,status:'completed'});
 // Recreate only the legacy mutable checkpoint. The real provider receipt,
 // immutable request and journal stay exactly as the broker wrote them.
 const legacy=store.load(readingId),entry=legacy.batches.at(-1);assert.equal(entry.status,notSent?'not-sent':unknown?'unknown':'completed');
 if(!aggregateRejected&&!ordinaryFinal&&!notSent&&!unknown){
  for(const key of ['completedUnitIds','unitCursor','summaryNodes','summaryDepth','finalBatchId','completedAt']){if(Object.hasOwn(state.beforeFinish,key))legacy[key]=structuredClone(state.beforeFinish[key]);else delete legacy[key];}
  entry.processed=false;delete entry.aggregationAccepted;delete entry.validationHash;
  if(summaryWithEarlierEvidence)entry.localReprocess={priorProcessed:false,priorPhase:'paused',priorModelReason:'BILI_FULL_MATERIAL_NOT_COMPLETED',attemptedAt:entry.finishedAt};
  legacy.lastBatch=null;legacy.phase='paused';legacy.modelReason='BILI_FULL_MATERIAL_NOT_COMPLETED';store.save(legacy);
 }
 const journal=()=>{const db=new DatabaseSync(join(dataRoot,'social-core','runtime-v1.sqlite'),{readOnly:true});try{return db.prepare('SELECT m.id,m.digest,m.scope,m.result,m.requestId,i.input FROM models m JOIN model_inputs i ON i.id=m.id ORDER BY m.rowid').all();}finally{db.close();}};
 const immutable=()=>({receipt:readFileSync(join(directory,'full-v1','receipts',entry.receiptHash+'.json'),'utf8'),request:readFileSync(join(directory,'full-v1','requests',entry.requestHash+'.json'),'utf8'),journal:journal()});
 const original=notSent||unknown?null:immutable();if(original){assert.equal(state.beforeFinish.batches.at(-1).status,'submitted');assert.equal(JSON.parse(original.receipt).result.text,state.responseText);assert.equal(JSON.parse(original.journal.at(-1).result).text,state.responseText);}
 const manage=async(op,parameters={})=>{const management=await broker.handlers['social.context.read']({identity,payload:{purpose:'manage-plugin'},context:{authority:{kind:'app',action:'reading.'+op}},check:async()=>{}}),payload={contextToken:management.contextToken,operation:'video.fullReading.'+op,parameters:{readingId,...parameters}},context=await broker.contextProvider({identity,method:'connections.request',payload});return broker.handlers['connections.request']({identity,context,payload,check:async()=>{}});};
 const get=()=>manage('get');
 const continueReading=async()=>{
  await manage('continue',{confirmed:true,planHash:plan.planHash});
  const next=await broker.handlers['social.context.read']({identity,payload:{purpose:'bilibili-activity',characterId:'character',modelConnectionRef:'model'},context:{authority:{kind:'app',action:'reading.continue'}},check:async()=>{}});
  const nextCall=async(method,p)=>{const payload={...p,contextToken:next.contextToken},context=await broker.contextProvider({identity,method,payload});return broker.handlers[method]({identity,context,payload,check:async()=>{}});};
  const nextLease=await nextCall('activity.lease',{activityId:'continue:'+readingId});
  try{return await nextCall('connections.request',{...nextLease,operation:'video.fullReading.read',parameters:{readingId}});}
  finally{await nextCall('activity.finish',{...nextLease,status:'completed'});}
 };
 const append=summary=>{row.models.clear();return call('experience.append',{activityId:readingId,providerRequestId:entry.providerRequestId,summaryCandidate:summary});};
 const appendWithOriginalToken=async (summary,token=context.contextToken)=>{
  const payload={contextToken:token,activityId:readingId,providerRequestId:entry.providerRequestId,summaryCandidate:summary};
  const original=await broker.contextProvider({identity,method:'experience.append',payload});
  return broker.handlers['experience.append']({identity,context:original,payload,check:async()=>{}});
 };
 const appendResumed=async (summary,{characterId='character'}={})=>{
  const fresh=await broker.handlers['social.context.read']({identity,payload:{purpose:'bilibili-activity',characterId,modelConnectionRef:'model'},context:{authority:{kind:'app',action:'reading.continue'}},check:async()=>{}});
  state.lastContinueToken=fresh.contextToken;
  const payload={contextToken:fresh.contextToken,activityId:readingId,providerRequestId:entry.providerRequestId,summaryCandidate:summary};
  const resumed=await broker.contextProvider({identity,method:'experience.append',payload});
  assert.notEqual(resumed.sessionId,row.sessionId);
  assert.notEqual(resumed.conversationId,row.conversationId);
  return broker.handlers['experience.append']({identity,context:resumed,payload,check:async()=>{state.afterBridgeContext=state.onAppendBridgeContext;}});
 };
 const changeGrant=({enabled=true,granted=SOCIAL_CAPABILITIES,generation=385}={})=>bridge.grants.set({pluginId:identity.pluginId,declared:SOCIAL_CAPABILITIES,granted,enabled,generation});
 const dropOriginalGrant=()=>{
  const db=new DatabaseSync(join(dataRoot,'social-core','runtime-v1.sqlite'));
  try{assert.equal(db.prepare("UPDATE contexts SET body=json_remove(body,'$.grantGeneration') WHERE token=?").run(context.contextToken).changes,1);}
  finally{db.close();}
 };
 const onAppendBridgeContext=fn=>{state.onAppendBridgeContext=fn;};
 return {state,account,activation,audit,changeGrant,dropOriginalGrant,onAppendBridgeContext,continueReading,full,store,owner,batch,understanding,fresh,ignored,append,appendWithOriginalToken,appendResumed,entry:structuredClone(entry),original,immutable,get,restart:async()=>{await broker.close();broker=createSocialPluginBroker(options);}};
}

test('B2 broker recovers a paid final summary through reading.get and uses only current evidence',async t=>{
 const f=await fixture(t,{summaryWithEarlierEvidence:true}),callsBefore=f.state.calls;
 const first=await f.get();
 assert.equal(first.phase,'completed');
 assert.equal(first.calls.at(-1).processed,true);
 const validation={rule:'bili-full-summary-evidence-v2',ignoredEvidenceRefs:[f.ignored]},recovered=first.recoveredResults[0];
 assert.deepEqual(f.fresh.fullReadingValidation,validation);
 assert.deepEqual(recovered.fullReadingValidation,validation);
 assert.deepEqual(recovered.understanding.evidenceRefs,f.batch.material.items.map(item=>item.id));
 assert.equal(recovered.result.text,f.state.responseText);
 assert.deepEqual((await f.get()).recoveredResults,first.recoveredResults);
 await f.append(f.understanding.summary);
 assert.deepEqual(f.state.experience.evidenceRefs,f.batch.material.items.map(item=>item.id));
 await f.restart();assert.deepEqual((await f.get()).recoveredResults,first.recoveredResults);
 assert.deepEqual(f.immutable(),f.original);
 assert.equal(f.state.calls,callsBefore);
});

test('B2 final experience is committed once after Continue issues a fresh context',async t=>{
 const f=await fixture(t,{summaryWithEarlierEvidence:true}),callsBefore=f.state.calls;
 const ready=await f.get();assert.equal(ready.phase,'completed');
 await assert.rejects(f.appendResumed(f.understanding.summary,{characterId:'different-character'}),{code:'BUDDY_EVIDENCE_MISSING'});
 await f.restart();
 const first=await f.appendResumed(f.understanding.summary);
 assert.equal(first.recorded,true);
 await f.restart();
 const second=await f.appendResumed(f.understanding.summary);
 assert.equal(second.recorded,true);assert.equal(second.duplicate,true);assert.equal(second.eventId,first.eventId);
 assert.deepEqual(f.state.experience.evidenceRefs,f.batch.material.items.map(item=>item.id));
 assert.equal(f.state.calls,callsBefore);
});

test('B2 receipt projection survives the final aggregation budget guard without accepting the summary',async t=>{
 const f=await fixture(t,{summaryWithEarlierEvidence:true,aggregateRejected:true}),state=await f.get();
 assert.equal(state.phase,'paused');assert.equal(state.modelReason,'BILI_FULL_SUMMARY_NO_PROGRESS');
 assert.equal(state.finalProcessed,false);
 const validation={rule:'bili-full-summary-evidence-v2',ignoredEvidenceRefs:[f.ignored]};
 assert.deepEqual(f.fresh.fullReadingValidation,validation);
 assert.deepEqual(state.recoveredResults[0].fullReadingValidation,validation);
 assert.equal(state.recoveredResults[0].result.text,f.state.responseText);
 assert.equal(f.state.calls,2);
});

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


test('B3 an official paid reading batch survives grant 379 to 385 and Continue prepares its final summary',async t=>{
 const f=await fixture(t,{official:true}),callsBefore=f.state.calls;
 f.changeGrant();
 await f.restart();
 const view=await f.get();
 assert.equal(view.calls.at(-1).processed,true);
 assert.equal(view.recoveredResults[0].providerRequestId,f.entry.providerRequestId);
 assert.deepEqual((await f.get()).recoveredResults,view.recoveredResults);
 const prepared=await f.continueReading();
 assert.equal(prepared.finalSummary,true);
 assert.notEqual(prepared.batchId,f.batch.batchId);
 assert.equal(f.state.calls,callsBefore);
 assert.deepEqual(f.immutable(),f.original);
 assert.deepEqual(f.audit,[{originalGeneration:379,currentGeneration:385,result:'receipt-projected'}]);
});


test('B3 an official final receipt projects after grant change and commits experience once',async t=>{
 const f=await fixture(t,{official:true,summaryWithEarlierEvidence:true}),callsBefore=f.state.calls;
 f.changeGrant();
 const ready=await f.get();
 assert.equal(ready.phase,'completed');
 assert.equal(ready.recoveredResults[0].providerRequestId,f.entry.providerRequestId);
 const first=await f.appendResumed(f.understanding.summary);
 const second=await f.appendResumed(f.understanding.summary);
 assert.equal(first.recorded,true);
 assert.equal(second.duplicate,true);
 assert.equal(second.eventId,first.eventId);
 assert.equal(f.state.calls,callsBefore);
 assert.deepEqual(f.audit,[
  {originalGeneration:379,currentGeneration:385,result:'receipt-projected'},
  {originalGeneration:379,currentGeneration:385,result:'experience-committed'}
 ]);
});

test('B3 an exact not-sent proof requires the original grant generation',async t=>{
 const f=await fixture(t,{official:true,notSent:true});
 const sameGrant=await f.get();
 assert.equal(sameGrant.notSentResults[0].inputHash,f.batch.inputHash);
 f.changeGrant();
 const view=await f.get();
 assert.equal(view.notSentResults,undefined);
 assert.equal(view.recoveredResults,undefined);
 assert.deepEqual(f.audit,[]);
 assert.equal(f.state.calls,0);
});

test('B3 grant change cannot replay an uncertain submitted request',async t=>{
 const f=await fixture(t,{official:true,unknown:true});
 f.changeGrant();
 const view=await f.get();
 assert.equal(view.recoveredResults,undefined);
 assert.equal(view.notSentResults,undefined);
 assert.equal(view.needsReview,true);
 assert.equal(f.state.calls,1);
});

for(const change of ['disabled','uninstalled','replaced','version mismatch','digest mismatch','nonofficial','grant denied','account ref','account binding','account generation'])for(const notSent of [false,true])test('B3 refuses '+(notSent?'not-sent proof':'paid result')+' after '+change+' changes',async t=>{
 const f=await fixture(t,{official:change!=='nonofficial',notSent});
 f.changeGrant({enabled:change!=='disabled',granted:change==='grant denied'?SOCIAL_CAPABILITIES.filter(value=>value!=='models.request'):SOCIAL_CAPABILITIES});
 if(change==='uninstalled')f.activation.enabled=false;
 if(change==='replaced')f.activation.pluginId='other';
 if(change==='version mismatch')f.activation.exactVersion='2.1.0';
 if(change==='digest mismatch')f.activation.sourceDigest='b'.repeat(64);
 if(change==='account ref')f.account.ref='other';
 if(change==='account binding')f.account.accountId='43';
 if(change==='account generation')f.account.generation++;
 const before=f.store.load(f.owner.readingId);
 if(change==='account ref'||change==='account binding')await assert.rejects(f.get(),{code:'BILI_VISION_SCOPE_DENIED'});
 else {
  const view=await f.get();
  assert.equal(view.recoveredResults,undefined);
  assert.equal(view.notSentResults,undefined);
 }
 assert.deepEqual(f.store.load(f.owner.readingId),before);
 assert.equal(f.state.calls,notSent?0:1);
});


test('B3 an old evidence token cannot submit final experience after the grant advances',async t=>{
 const f=await fixture(t,{official:true,summaryWithEarlierEvidence:true});
 assert.equal((await f.get()).phase,'completed');
 f.changeGrant({granted:SOCIAL_CAPABILITIES.filter(value=>value!=='models.request')});
 await assert.rejects(f.append(f.understanding.summary),{code:'BUDDY_CAPABILITY_DENIED'});
 await f.restart();
 await assert.rejects(f.appendWithOriginalToken(f.understanding.summary),{code:'BUDDY_CAPABILITY_DENIED'});
 assert.equal(f.state.experience,undefined);
 assert.deepEqual(f.audit,[]);
});


test('B3 a restored final evidence token with a missing original grant generation fails closed',async t=>{
 const f=await fixture(t,{official:true,summaryWithEarlierEvidence:true});
 assert.equal((await f.get()).phase,'completed');
 await f.restart();
 f.dropOriginalGrant();
 f.changeGrant({granted:SOCIAL_CAPABILITIES.filter(value=>value!=='models.request')});
 await assert.rejects(f.appendWithOriginalToken(f.understanding.summary),{code:'BUDDY_PLUGIN_DISABLED'});
 assert.equal(f.state.experience,undefined);
});

test('B3 final write rejects a model grant change inside asynchronous bridge authorization',async t=>{
 const f=await fixture(t,{official:true,summaryWithEarlierEvidence:true});
 f.changeGrant();
 assert.equal((await f.get()).phase,'completed');
 let changed=false;
 f.onAppendBridgeContext(async()=>{
  if(changed)return;
  await Promise.resolve();
  changed=true;
  f.changeGrant({granted:SOCIAL_CAPABILITIES.filter(value=>value!=='models.request'),generation:386});
 });
 await assert.rejects(f.appendResumed(f.understanding.summary),{code:'BUDDY_PLUGIN_DISABLED'});
 assert.equal(changed,true);
 assert.equal(f.state.experience,undefined);
});


for(const locator of ['original','continue'])test('B3 a durable final outbox can use its '+locator+' token after grant change and restart',async t=>{
 const f=await fixture(t,{official:true,summaryWithEarlierEvidence:true});
 assert.equal((await f.get()).phase,'completed');
 if(locator==='continue')await assert.rejects(f.appendResumed('incorrect summary'),{code:'BUDDY_EVIDENCE_CONFLICT'});
 const token=locator==='continue'?f.state.lastContinueToken:undefined;
 const callsBefore=f.state.calls;
 f.changeGrant();
 await f.restart();
 const first=await f.appendWithOriginalToken(f.understanding.summary,token);
 await f.restart();
 const second=await f.appendWithOriginalToken(f.understanding.summary,token);
 assert.equal(first.recorded,true);
 assert.equal(second.duplicate,true);
 assert.equal(second.eventId,first.eventId);
 assert.equal(f.state.calls,callsBefore);
 assert.deepEqual(f.audit,[{originalGeneration:379,currentGeneration:385,result:'experience-committed'}]);
});


test('B3 a regular paid final without an evidence projection can commit across grant change',async t=>{
 const f=await fixture(t,{official:true,ordinaryFinal:true}),callsBefore=f.state.calls;
 f.changeGrant();
 await f.restart();
 const view=await f.get();assert.equal(view.phase,'completed');
 assert.equal(view.recoveredResults[0].fullReadingValidation,undefined);
 const first=await f.appendResumed(f.understanding.summary);
 const second=await f.appendWithOriginalToken(f.understanding.summary);
 assert.equal(first.recorded,true);
 assert.equal(second.duplicate,true);
 assert.equal(second.eventId,first.eventId);
 assert.equal(f.state.calls,callsBefore);
});
