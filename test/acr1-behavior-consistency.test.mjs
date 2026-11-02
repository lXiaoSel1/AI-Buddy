import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCompanionService} from '../src/companion-service.mjs';
import {createCompanionMemory,appendSocialExperience,socialMemoryScope} from '../src/companion-memory.mjs';
import {createProactiveService} from '../src/companion-proactive.mjs';
import {createCompanionR95} from '../src/companion-r95.mjs';
import {createBuddyPluginServices} from '../src/buddy-plugin-services/index.mjs';
import {CgService} from '../src/cg-service.mjs';
import {openChatRequestStore} from '../src/chat-request-store.mjs';
import {companionFixture,memoryStore,syntheticEngine,gate} from './support/audit-harness.mjs';

const at=Date.parse('2026-11-01T12:00:00Z'),day='2026-10-31';
const capacity=()=>({tokens:1000000,verified:true,source:'fixture'});
async function companionRig(t,{hook,onChatCommitted=()=>{},wrapStore=store=>store,dataRoot=null}={}){
 const store=wrapStore(memoryStore(await companionFixture({now:at}))),inputs=[];
 const {engine}=syntheticEngine({getStore:()=>store,hooks:{call:hook}});
 const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'m'}),resolveContextCapacity:capacity,runTurn:fn=>fn(),async *stream(options){const input=JSON.parse(options.messages[0].text??options.messages[0].content[0].text);inputs.push(input);yield {type:'text-delta',text:JSON.stringify({coverageHash:input.coverageHash,summary:{text:'Synthetic exact-scope summary',eventIds:input.todayEventIds},guide:{text:'',eventIds:[]},core:[],branches:[],growthCandidates:[]})};yield {type:'finish',reason:{kind:'stop'}};}};
 const service=await createCompanionService({store,engine,provider,dataRoot,now:()=>at,onChatCommitted});
 t.after(async()=>{await service.close();await store.flush();});return {store,service,inputs};
}

async function failedSocialJob(r){
 const life=r.store.state.lives.claude,scope={characterId:'claude',personaId:'default',lifeId:life.id,operationId:life.operationId,channel:'bilibili',conversationId:'reading-original'};
 const source={id:'watch-original',eventRef:'watch-original',scope,sourcePluginId:'bilibili',sourceKind:'bilibili-watch',createdAt:at-86400000,text:'Original understood social material',stage:'understood',understandingState:'understood',visibilityScope:'persona',presentationState:'not-presented',deliveryState:'not-sent',evidenceRefs:[{id:'local-material',sha256:'a'.repeat(64)}]};
 await appendSocialExperience(r.store,{eventRef:source.eventRef,scope},{verifyEvent:async()=>source});
 const memory=createCompanionMemory({store:r.store,now:()=>at,autoStart:false,getCapacity:capacity,runModel:async()=>{throw Error('Unexpected fixture model call');}}),key=socialMemoryScope(scope);
 await memory.sync('claude');await memory.close();
 await r.store.mutate(state=>{const memory=state.lives.claude.memory,event=Object.values(memory.events).find(row=>row.source.type==='social');assert.ok(event);memory.jobs[key+'|'+day]={id:'synthetic-failed-social-job',scope:key,day,status:'failed',attempts:3,error:'Synthetic original failure',cutoff:[{id:event.id}]};});
 const visible=await r.service.action('companion-memory-view',{characterId:'claude',personaId:'default',conversationId:'conversation'}),job=visible.memory.jobs.find(row=>row.id==='synthetic-failed-social-job');assert.ok(job,'original failed social job is currently visible');return job;
}

test('ACR1 memory retry carries the visible original social job scope instead of falling back to Persona',async t=>{
 const r=await companionRig(t),job=await failedSocialJob(r);
 const result=await r.service.action('companion-memory-retry',{characterId:'claude',personaId:'default',scope:job.scope,day:job.day});
 assert.equal(result.memoryResult.status,'committed');assert.deepEqual(r.inputs.map(row=>row.scope),[job.scope]);
 assert.equal(r.store.state.lives.claude.memory.jobs[job.scope+'|'+job.day].status,'committed');
 assert.equal(r.store.state.lives.claude.memory.summaries['persona:default|'+day],undefined);
});

test('ACR1 memory retry by jobId keeps its original scope and rejects missing, invisible or mismatched jobs',async t=>{
 const r=await companionRig(t),job=await failedSocialJob(r);
 for(const args of [{scope:null,day},{scope:'persona:default',day},{scope:'social:'+'f'.repeat(64),day},{jobId:'missing-job'},{jobId:job.id,scope:'persona:default',day}])await assert.rejects(r.service.action('companion-memory-retry',{characterId:'claude',personaId:'default',...args}));
 assert.equal(r.inputs.length,0);
 const result=await r.service.action('companion-memory-retry',{characterId:'claude',personaId:'default',jobId:job.id});assert.equal(result.memoryResult.status,'committed');assert.deepEqual(r.inputs.map(row=>row.scope),[job.scope]);
});

test('ACR1 compatibility: legacy day-end action derives only its authorized Persona or group scope without a prior job',async t=>{
 const r=await companionRig(t),social=await failedSocialJob(r);
 assert.equal(r.store.state.lives.claude.memory.jobs['persona:default|'+day],undefined);
 const personal=await r.service.action('companion-memory-retry',{characterId:'claude',personaId:'default',day});assert.equal(personal.memoryResult.status,'committed');assert.deepEqual(r.inputs.map(row=>row.scope),['persona:default']);assert.equal(r.store.state.lives.claude.memory.jobs[social.scope+'|'+day].status,'failed');
 await r.store.mutate(state=>{state.groups['legacy-group']={id:'legacy-group',name:'Authorized legacy group',personaId:'default',memberIds:['claude'],seq:1,intervals:{claude:[{start:1,end:null}]},messages:[{id:'legacy-group-original',seq:1,role:'user',text:'Original witnessed group statement',createdAt:at-86400000,status:'sent'}]};state.lives.claude.groupIntervals['legacy-group']=[{start:1,end:null}];});
 const grouped=await r.service.action('companion-memory-retry',{characterId:'claude',personaId:'default',groupId:'legacy-group',day});assert.equal(grouped.memoryResult.status,'committed');assert.deepEqual(r.inputs.map(row=>row.scope),['persona:default','group:legacy-group']);
 await assert.rejects(r.service.action('companion-memory-retry',{characterId:'gpt',personaId:'default',groupId:'legacy-group',day}));assert.equal(r.inputs.length,2);
});

test('ACR1 review: one failed view sync cannot authorize a legacy retry of another Persona group',async t=>{
 let failNextSync=false,syncFailures=0;
 const r=await companionRig(t,{wrapStore:base=>({get state(){return base.state;},snapshot:base.snapshot,flush:base.flush,mutate(fn){if(failNextSync){failNextSync=false;syncFailures++;return Promise.reject(Error('Synthetic single memory sync failure'));}return base.mutate(fn);}})});
 await r.store.mutate(state=>{
  state.personas['persona-b']={id:'persona-b',name:'Other Persona',nickname:'B',relationships:{}};
  state.groups['persona-b-group']={id:'persona-b-group',name:'B private group',personaId:'persona-b',memberIds:['claude'],seq:1,intervals:{claude:[{start:1,end:null}]},messages:[{id:'persona-b-original',seq:1,role:'user',text:'Original group evidence belonging only to Persona B',createdAt:at-86400000,status:'sent'}]};
  state.lives.claude.groupIntervals['persona-b-group']=[{start:1,end:null}];
 });
 const selection={characterId:'claude',personaId:'default',conversationId:'conversation',groupId:'persona-b-group'};
 await assert.rejects(r.service.action('companion-memory-view',selection),'the normal selection gate rejects Persona A with Persona B group');
 failNextSync=true;
 await assert.rejects(r.service.action('companion-memory-retry',{...selection,day}));
 assert.equal(syncFailures,1,'only the first view sync fails; consolidation sync would succeed');
 assert.equal(r.inputs.length,0,'a read-only sync-error DTO must not authorize a model request');
 assert.equal(r.store.state.lives.claude.memory?.summaries?.['group:persona-b-group|'+day],undefined);
});

test('ACR1 memory retry rejects an original-life ABA while consolidation preparation waits',async t=>{
 const entered=gate(),release=gate();let armed=false,mutations=0,baseStore;
 const r=await companionRig(t,{wrapStore:base=>{baseStore=base;return {get state(){return base.state;},snapshot:base.snapshot,flush:base.flush,mutate(fn){if(armed&&++mutations===2){entered.resolve();return release.promise.then(()=>base.mutate(fn));}return base.mutate(fn);}};}}),job=await failedSocialJob(r);
 armed=true;const pending=r.service.action('companion-memory-retry',{characterId:'claude',personaId:'default',jobId:job.id}).then(value=>({value}),error=>({error}));await entered.promise;
 await baseStore.mutate(state=>{const original=state.lives.claude.id;state.lives.claude.id='temporary-other-life';state.lives.claude.id=original;state.lives.claude.operationId='new-operation-after-restore';});release.resolve();const result=await pending;
 assert.ok(result.error);assert.equal(r.inputs.length,0);assert.equal(r.store.state.lives.claude.memory.jobs[job.scope+'|'+day].status,'failed');
});

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=','base64');
async function cgRig(t,extra={}){
 const root=mkdtempSync(join(tmpdir(),'acr1-cg-')),calls=[];
 const cg=new CgService({dataRoot:root,codex:{defaultModel:'fixture',close(){}},crypto:{encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()},imageCodec:bytes=>({png:bytes,thumbnail:bytes,width:1,height:1}),fetchImpl:async(_url,request)=>{calls.push(JSON.parse(request.body));return Response.json({data:[{b64_json:png.toString('base64')}]});},...extra});
 await cg.ready;const profile=await cg.save({kind:'custom',name:'fixture',baseUrl:'http://127.0.0.1:3',protocol:'openai-images',model:'fixture-image',options:{references:true}});await cg.activate(profile.id);await cg.setEnabled(true);
 t.after(async()=>{await cg.close();rmSync(root,{recursive:true,force:true});});return {cg,calls};
}
const daily={logicalDay:day,slot:'10:00',timeZone:'UTC',triggeredAt:at-86400000,fictional:true};
const dailyScope={characterId:'deepseek',personaId:'p',lifeId:'life',operationId:'op'};
const dailyOptions=id=>({id,sourceEventId:id,kind:'daily',automatic:true,daily,rewardScope:dailyScope,prompt:'A fictional quiet garden',characters:[{id:'deepseek'}],themeBrief:{kind:'daily',charId:'deepseek',profile:{displayName:'DeepSeek'},visual:'Confirmed portrait',daily,materials:[]}});

test('ACR1 automatic CG off-on revokes a reference preparation from the old permission generation',async t=>{
 const entered=gate(),release=gate();let first=true;const {cg,calls}=await cgRig(t,{referenceResolver:async()=>{if(first){first=false;entered.resolve();await release.promise;}return [];}});
 t.after(()=>release.resolve());const old=cg.enqueue(dailyOptions('old-preparation'));await entered.promise;
 await cg.setEnabled(false);await cg.setEnabled(true);release.resolve();const oldResult=await old;
 assert.ok(oldResult.skipped||oldResult.status==='cancelled');
 await cg.enqueue(dailyOptions('new-preparation'));cg.start();await cg.pumping;
 assert.equal(calls.length,1);assert.equal(cg.job('new-preparation').status,'ready');assert.notEqual(cg.jobs.find(row=>row.id==='old-preparation')?.status,'ready');
});

test('ACR1 automatic CG off-on cannot submit an old queue attempt; a submitted result remains retained',async t=>{
 const entered=gate(),release=gate();const {cg}=await cgRig(t);let submissions=0;
 cg.imageTransport.generate=async(_profile,options)=>{entered.resolve();await release.promise;await options.onSubmit();submissions++;return {buffer:png};};
 await cg.enqueue(dailyOptions('before-submit'));cg.start();await entered.promise;await cg.setEnabled(false);await cg.setEnabled(true);release.resolve();await cg.pumping;
 assert.equal(submissions,0);assert.equal(cg.job('before-submit').status,'cancelled');
 const submitted=gate(),completed=gate();cg.imageTransport.generate=async(_profile,options)=>{await options.onSubmit();submissions++;submitted.resolve();await completed.promise;return {buffer:png};};
 await cg.enqueue(dailyOptions('already-submitted'));await submitted.promise;await cg.setEnabled(false);await cg.setEnabled(true);completed.resolve();await cg.pumping;
 assert.equal(submissions,1);assert.equal(cg.job('already-submitted').status,'ready');assert.ok(cg.job('already-submitted').assetRef);
});

test('ACR1 compatibility: starting a disabled legacy automatic remote task cancels it while retaining its remote identity',async t=>{
 const {cg,calls}=await cgRig(t);await cg.enqueue({id:'legacy-remote-auto',sourceEventId:'legacy-remote-auto',automatic:true,prompt:'Legacy automatic CG'});
 const remoteTask={id:'remote-original-without-submitted-at'};await cg.jobsMutate(()=>{cg.job('legacy-remote-auto').remoteTask=remoteTask;});await cg.setEnabled(false);
 assert.equal(cg.job('legacy-remote-auto').status,'queued');assert.deepEqual(cg.job('legacy-remote-auto').remoteTask,remoteTask);assert.equal(cg.job('legacy-remote-auto').submittedAt,undefined);
 cg.start();await cg.pumping;assert.equal(cg.job('legacy-remote-auto').status,'cancelled');assert.deepEqual(cg.job('legacy-remote-auto').remoteTask,remoteTask);assert.equal(calls.length,0);assert.equal(cg.status().busy,false);
});

const externalScope={characterId:'a',lifeId:'life-a',operationId:'op-a',personaId:'p',channel:'qq-private',conversationId:'conv',accountBindingId:'account',actorId:'actor'};
async function proactiveRig(extra={}){
 const store=memoryStore({lives:{a:{id:'life-a',operationId:'op-a'}},personas:{p:{}}});
 const service=createProactiveService({store,now:()=>at,getActiveContext:()=>externalScope,getRuntimeState:()=>({activityAllowed:true}),getEvidence:async()=>[{eventId:'actual-event'}],generate:async({mode})=>({speak:true,mode,text:'Synthetic original proactive line'}),...extra});
 await service.setSettings({proactive:true});const {candidate}=await service.offer({scope:externalScope,kind:'share',eventIds:['actual-event'],sourceKey:'actual-event'});return {store,service,candidate};
}
test('ACR1 proactive cancellation remains effective while the delivery adapter awaits its final send boundary',async()=>{
 const entered=gate(),release=gate();let sent=0,r;
 r=await proactiveRig({emit:async(value,delivery)=>{entered.resolve();await release.promise;await delivery?.beforeSubmit();sent++;await r.service.presented({candidateId:value.candidateId,messageId:'native-original'});}});
 const attempt=r.service.tick({candidateId:r.candidate.id});attempt.catch(()=>{});await entered.promise;
 const cancelled=await r.service.cancel({candidateId:r.candidate.id});release.resolve();await attempt.catch(()=>{});
 assert.equal(cancelled.cancelled,true);assert.equal(sent,0);assert.equal(r.service.view({scope:externalScope}).candidates[0].status,'cancelled');await r.service.close();
});

test('ACR1 proactive cancel after submit requests cancellation without discarding its exact confirmed receipt',async()=>{
 const submitted=gate(),release=gate();let sent=0,r;
 r=await proactiveRig({emit:async(value,delivery)=>{await delivery.beforeSubmit({messageId:'submitted-original'});sent++;submitted.resolve();await release.promise;await r.service.presented({candidateId:value.candidateId,messageId:'submitted-original'});}});
 const attempt=r.service.tick({candidateId:r.candidate.id});await submitted.promise;const result=await r.service.cancel({candidateId:r.candidate.id});
 assert.equal(result.cancelled,false);assert.equal(result.cancelRequested,true);assert.equal(result.awaitingReceipt,true);release.resolve();assert.equal((await attempt).delivered,true);
 const candidate=r.service.view({scope:externalScope}).candidates[0];assert.equal(candidate.status,'presented');assert.equal(candidate.messageId,'submitted-original');assert.equal(sent,1);assert.equal((await r.service.tick({candidateId:r.candidate.id})).skipped,'presented');await r.service.close();
});

async function coreDeliveryRig(t,{check=async()=>{},send}={}){
 const root=mkdtempSync(join(tmpdir(),'acr1-proactive-core-')),store=memoryStore(await companionFixture({now:at}));let authorized=true;
 const core=await createCompanionR95({store,dataRoot:root,provider:{enabled:false},memory:{context:async()=>({text:''})},now:()=>at,getContext:()=>({characterId:'claude',personaId:'default',conversationId:'conversation'}),delta:()=>{},getRuntimeState:()=>({sleepPhase:'awake',canPresent:true})});
 const life=store.state.lives.claude,scope={characterId:'claude',personaId:'default',lifeId:life.id,operationId:life.operationId,sessionId:'synthetic-session',channel:'qq-private',conversationId:'synthetic-peer',accountBindingId:'synthetic-account',actorId:'synthetic-actor',bindingGeneration:1,activityGeneration:1,visibilityScope:'conversation'},pluginId='synthetic.qq';
 const anchor=core.socialHost.registerContext({pluginId,scope,check:()=>authorized}),bridge=createBuddyPluginServices({resolveContext:args=>core.socialHost.resolveContext(args),hostServices:core.socialHost.services,now:()=>at});
 bridge.grants.set({pluginId,declared:core.socialHost.capabilities,granted:core.socialHost.capabilities});const issued=await bridge.issueContext({pluginId,contextRef:anchor.contextRef,permissionScope:core.socialHost.capabilities});
 await bridge.invoke({pluginId,contextToken:issued.contextToken,method:'activity.lease',payload:{activityId:'synthetic-delivery'}});
 core.registerSocialDelivery({channel:scope.channel,accountBindingId:scope.accountBindingId,generation:1,check,send});
 await store.mutate(state=>{state.lives.claude.r95??={};state.lives.claude.r95.evidence??={};state.lives.claude.r95.evidence['synthetic-source']={eventId:'synthetic-source',scope:structuredClone(scope),sourceKind:'qq-inbound',text:'Synthetic actual source'};});
 await core.proactive.setSettings({proactive:true});const {candidate}=await core.proactive.offer({scope,kind:'share',eventIds:['synthetic-source'],sourceKey:'synthetic-source'});
 await store.mutate(state=>{const row=state.lives.claude.r95.proactive.candidates[candidate.id];row.status='ready';row.output={text:'Synthetic already generated original line',sourceRefs:['synthetic-source']};row.outputMode='awake';});
 t.after(async()=>{await bridge.close();await core.close();await store.flush();rmSync(root,{recursive:true,force:true});});return {core,store,scope,candidate,revoke:()=>{authorized=false;}};
}

test('ACR1 Core sender final guard prevents delivery after cancel returns during adapter check',async t=>{
 const entered=gate(),release=gate();let sends=0;const r=await coreDeliveryRig(t,{check:async()=>{entered.resolve();await release.promise;},send:async()=>{sends++;return {status:'sent',nativeMessageId:'must-not-send'};}});
 const pending=r.core.proactive.tick({candidateId:r.candidate.id});pending.catch(()=>{});await entered.promise;assert.equal((await r.core.proactive.cancel({candidateId:r.candidate.id})).cancelled,true);release.resolve();await pending.catch(()=>{});
 assert.equal(sends,0);const row=r.store.state.lives.claude.r95.lines.find(row=>row.candidateId===r.candidate.id);assert.equal(row.status,'cancelled');assert.equal(row.deliveryState,'not-sent');
});

test('ACR1 Core retains exact sent receipt after permission and life revoke without projecting into the replacement life',async t=>{
 const entered=gate(),release=gate();let sends=0,checks=0;const r=await coreDeliveryRig(t,{check:async()=>{if(++checks>1)throw Error('Synthetic activity revoked after send');},send:async()=>{sends++;entered.resolve();await release.promise;return {status:'sent',nativeMessageId:'original-native-receipt'};}});
 const pending=r.core.proactive.tick({candidateId:r.candidate.id});await entered.promise;assert.equal((await r.core.proactive.cancel({candidateId:r.candidate.id})).awaitingReceipt,true);r.revoke();
 await r.store.mutate(state=>{state.lives.claude={...state.lives.claude,id:'replacement-life',operationId:'replacement-operation',r95:{lines:[]}};});release.resolve();assert.equal((await pending).delivered,true);
 const receipts=Object.values(r.store.state.r95.proactiveDeliveryReceipts);assert.equal(receipts.length,1);assert.equal(receipts[0].scope.lifeId,r.scope.lifeId);assert.equal(receipts[0].receipt.nativeMessageId,'original-native-receipt');assert.equal(r.store.state.lives.claude.r95.lines.length,0);assert.equal(sends,1);
});

test('ACR1 private cancel after model return blocks a queued assistant transaction and speech notification',async t=>{
 const entered=gate(),release=gate();let returned=false,intercepted=false,requestId;const committed=[];
 const r=await companionRig(t,{onChatCommitted:value=>committed.push(value),wrapStore:base=>({get state(){return base.state;},snapshot:base.snapshot,flush:base.flush,mutate(fn){if(returned&&!intercepted){intercepted=true;entered.resolve();return release.promise.then(()=>base.mutate(fn));}return base.mutate(fn);}}),hook:async(action,args)=>{if(action==='chat'){requestId=args.companionContext.requestId;returned=true;return {ok:true,companionCommit:{text:'Synthetic late completed output',delta:1,emotion:'normal',choices:[],choicesDeferred:false,connectionId:'fixture',model:'m',inputVersions:[]}};}}});
 t.after(()=>release.resolve());const pending=r.service.chat({text:'Cancel at the commit boundary'}).then(value=>({value}),error=>({error}));await entered.promise;
 await r.service.action('companion-chat-cancel',{conversationId:'conversation'});assert.equal(r.service.signalFor(requestId).aborted,true);release.resolve();const result=await pending;
 assert.ok(result.error);assert.equal(r.store.state.conversations.conversation.messages.filter(row=>row.requestId===requestId&&row.role==='assistant').length,0);assert.equal(committed.length,0);
});

test('ACR1 cancelled private commit retains the complete observed result under its original request and life',async t=>{
 const root=mkdtempSync(join(tmpdir(),'acr1-private-receipt-')),entered=gate(),release=gate();let returned=false,intercepted=false,requestId;
 const r=await companionRig(t,{dataRoot:root,wrapStore:base=>({get state(){return base.state;},snapshot:base.snapshot,flush:base.flush,mutate(fn){if(returned&&!intercepted){intercepted=true;entered.resolve();return release.promise.then(()=>base.mutate(fn));}return base.mutate(fn);}}),hook:async(action,args)=>{if(action==='chat'){requestId=args.companionContext.requestId;returned=true;return {ok:true,companionCommit:{text:'Complete original paid output',delta:1,emotion:'normal',choices:[],choicesDeferred:false,connectionId:'fixture',model:'m',inputVersions:[]}};}}});
 t.after(()=>rmSync(root,{recursive:true,force:true}));const originalLife=r.store.state.lives.claude.id,pending=r.service.chat({text:'Preserve this result'}).catch(error=>error);await entered.promise;
 await r.service.action('companion-chat-cancel',{conversationId:'conversation'});release.resolve();await pending;
 const rows=readdirSync(join(root,'chat-requests')).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(readFileSync(join(root,'chat-requests',name),'utf8'))),receipt=rows.find(row=>row.requestId===requestId);
 assert.equal(receipt.status,'cancelled');assert.equal(receipt.lifeId,originalLife);assert.equal(receipt.observedResult.text,'Complete original paid output');assert.equal(receipt.observedResult.connectionId,'fixture');assert.equal(r.store.state.conversations.conversation.messages.some(row=>row.id===requestId+':reply'),false);
});

test('ACR1 review: a delayed generating timer cannot erase a complete private receipt before commit or restart',async t=>{
 const root=mkdtempSync(join(tmpdir(),'acr1-private-timer-')),entered=gate(),release=gate();let returned=false,intercepted=false,requestId,r;
 r=await companionRig(t,{dataRoot:root,wrapStore:base=>({get state(){return base.state;},snapshot:base.snapshot,flush:base.flush,mutate(fn){if(returned&&!intercepted){intercepted=true;entered.resolve();return release.promise.then(()=>base.mutate(fn));}return base.mutate(fn);}}),hook:async(action,args)=>{if(action==='chat'){requestId=args.companionContext.requestId;r.service.captureDelta({requestId,text:'Streamed prefix',turnId:'timer-turn',itemId:'timer-item'});returned=true;return {ok:true,companionCommit:{text:'Complete original result before queued commit',delta:1,emotion:'normal',choices:[],choicesDeferred:false,connectionId:'fixture',model:'m',inputVersions:[]}};}}});
 t.after(()=>rmSync(root,{recursive:true,force:true}));const originalLife=r.store.state.lives.claude.id,pending=r.service.chat({text:'Retain the complete timer receipt'}).catch(error=>error);
 try{await entered.promise;r.service.captureDelta({requestId,text:'A stale delta arriving after the complete result'});await new Promise(resolve=>setTimeout(resolve,220));const row=JSON.parse(readFileSync(join(root,'chat-requests',requestId+'.json'),'utf8'));
  assert.equal(row.observedResult?.text,'Complete original result before queued commit');assert.equal(row.lifeId,originalLife);assert.equal(row.status,'completed-unpresented');
  const reopened=await openChatRequestStore(root);assert.equal(reopened.get(requestId).observedResult.text,'Complete original result before queued commit');assert.equal(reopened.get(requestId).lifeId,originalLife);await reopened.flush();
 }finally{release.resolve();await pending;}
});

test('ACR1 review: journal keeps complete observations monotonically across queued stale writes and cancellation',async t=>{
 const root=mkdtempSync(join(tmpdir(),'acr1-journal-monotonic-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const store=await openChatRequestStore(root),scope={requestId:'observed-original',characterId:'claude',personaId:'default',conversationId:'conversation',lifeId:'original-life',operationId:'original-operation'},observedResult={text:'Exact complete original output',connectionId:'fixture',model:'m',delta:1};
 const complete=store.put({...scope,status:'completed-unpresented',text:observedResult.text,observedResult,observedAt:at}),stale=store.put({...scope,status:'generating',text:'old partial'});await Promise.all([complete,stale]);
 assert.deepEqual(store.get(scope.requestId).observedResult,observedResult);assert.equal(store.get(scope.requestId).status,'completed-unpresented');
 await store.put({...scope,status:'cancelled',text:'old partial'});assert.deepEqual(store.get(scope.requestId).observedResult,observedResult);assert.equal(store.get(scope.requestId).status,'cancelled');
 const before=readFileSync(join(root,'chat-requests',scope.requestId+'.json'));await assert.rejects(store.put({...scope,status:'completed-unpresented',observedResult:{...observedResult,text:'Conflicting replacement'}}));await assert.rejects(store.put({...scope,lifeId:'replacement-life',status:'cancelled',observedResult}));assert.deepEqual(readFileSync(join(root,'chat-requests',scope.requestId+'.json')),before);
 const reopened=await openChatRequestStore(root);assert.deepEqual(reopened.get(scope.requestId).observedResult,observedResult);assert.equal(reopened.get(scope.requestId).status,'cancelled');await reopened.flush();
});

test('ACR1 review: automatic CG admission closes immediately while the off configuration write is queued',async t=>{
 const {cg,calls}=await cgRig(t),entered=gate(),release=gate();const held=cg.mutate(async()=>{entered.resolve();await release.promise;});await entered.promise;const off=cg.setEnabled(false);
 try{await cg.enqueue(dailyOptions('during-queued-off'));cg.start();await cg.pumping;assert.equal(calls.length,0);assert.notEqual(cg.jobs.find(row=>row.id==='during-queued-off')?.status,'ready');}
 finally{release.resolve();await held;await off;}
});

test('ACR1 review: automatic CG admission opens only after a successful current enable write',async t=>{
 const {cg,calls}=await cgRig(t);await cg.setEnabled(false);const entered=gate(),release=gate(),held=cg.mutate(async()=>{entered.resolve();await release.promise;});await entered.promise;const on=cg.setEnabled(true);
 try{assert.equal((await cg.enqueue(dailyOptions('during-queued-on'))).skipped,true);assert.equal(calls.length,0);}finally{release.resolve();await held;await on;}
 await cg.enqueue(dailyOptions('after-successful-on'));cg.start();await cg.pumping;assert.equal(calls.length,1);assert.equal(cg.job('after-successful-on').status,'ready');
});
