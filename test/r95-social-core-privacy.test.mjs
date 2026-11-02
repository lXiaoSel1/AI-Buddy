import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {ModelRouter} from '../src/model-router.mjs';
import {createCompanionR95} from '../src/companion-r95.mjs';
import {createCompanionService} from '../src/companion-service.mjs';
import {createCompanionMemory,appendSocialExperience,socialMemoryScope,socialExperienceHash} from '../src/companion-memory.mjs';
import {createBuddyPluginServices,createSocialClient} from '../src/buddy-plugin-services/index.mjs';
import {companionFixture,memoryStore,syntheticEngine,gate} from './support/audit-harness.mjs';

const crypto={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()};
async function fixture(t){
 const dataRoot=mkdtempSync(join(tmpdir(),'r95-social-core-privacy-')),now=1700000000000,store=memoryStore(await companionFixture({now})),requests=[],usages=[],memoryReads=[],contextReads=[],appSpeeches=[],activity=[],metadata=new AsyncLocalStorage(),unblock=[];
 let core,replyMode='text',memoryGate=null;
 const provider=new ModelRouter({dataRoot,crypto,codex:{defaultModel:'fixture',setEnabled(){}},outputLimit:()=>512,onUsage:value=>usages.push(value),searchPolicy:details=>core?.searchPolicy(details)??false,
  fetchImpl:async(url,options)=>{const body=JSON.parse(options.body),input=JSON.parse(body.input.at(-1).content),kind=input.kind;requests.push({url:String(url),body,input});let text;
   if(kind==='social-search')text='The answer text may mention https://invented.example/without-a-tool.';
   else if(kind==='social-chat')text='A reply from the frozen role connection.';
   else if(kind==='mood')text='{"changed":false}';
   else text=JSON.stringify({speak:true,text:'I learned this from real material.',mode:'awake'});
   const content={type:'output_text',text,...(kind==='social-search'&&replyMode==='sources'?{annotations:[{type:'url_citation',url:'https://example.com/actual-source',title:'Actual tool citation',start_index:0,end_index:10}]}:{})};
   return new Response(JSON.stringify({id:'mock-'+requests.length,status:'completed',output:[...(kind==='social-search'&&replyMode==='sources'?[{type:'web_search_call',id:'web-'+requests.length,status:'completed',action:{type:'search',query:'mock query',sources:[{url:'https://example.com/actual-source',title:'Actual tool citation'}]}}]:[]),{type:'message',id:'message-'+requests.length,role:'assistant',content:[content]}],usage:{input_tokens:20,output_tokens:5,total_tokens:25}}),{headers:{'content-type':'application/json'}});
  }});
 await provider.ready;
 const profile=await provider.save({kind:'openai',key:'isolated-test-key-not-a-real-credential',name:'isolated dedicated role',baseUrl:'https://api.openai.com/v1',protocol:'responses',model:'gpt-6.1-sol',reasoningEffort:'xhigh',contextTokens:24000,models:[{id:'gpt-6.1-sol',supportedReasoningEfforts:['xhigh'],maxOutputTokens:8192}]});
 const global=await provider.save({kind:'custom',name:'different global',baseUrl:'http://127.0.0.1:3099/v1',protocol:'responses',model:'global-fixture-model'});await provider.activate(global.id);provider.setEnabled(true);
 await store.mutate(state=>{state.cards.claude.modelBinding={enabled:true,connectionId:profile.id};state.conversations.conversation.messages[0].text='APP private secret stays in APP.';});
 const actualMemory=createCompanionMemory({store,now:()=>now,autoStart:false,getCapacity:()=>({tokens:24000,verified:true}),runModel:async()=>{throw Error('This read-only/small-input fixture must not run a compression model');}});
 const memory={view:async args=>{memoryReads.push(structuredClone(args));return actualMemory.view(args);},context:async args=>{contextReads.push({args:structuredClone(args),metadata:metadata.getStore()});if(memoryGate){memoryGate.entered.resolve();await memoryGate.wait.promise;}return actualMemory.context(args);}};
 core=await createCompanionR95({store,dataRoot,provider,memory,now:()=>now,getContext:()=>({characterId:'claude',personaId:'default',conversationId:'conversation'}),delta:()=>{},getRuntimeState:()=>({sleepPhase:'awake',sleepIntentVersion:1,canPresent:true}),withMemoryContext:(value,fn)=>metadata.run(value,fn),appendSocial:(event,options)=>appendSocialExperience(store,event,options),onSpeech:value=>appSpeeches.push(value),onActivity:value=>activity.push(value)});
 const bridge=createBuddyPluginServices({resolveContext:spec=>core.socialHost.resolveContext(spec),hostServices:core.socialHost.services,now:()=>now});
 t.after(async()=>{for(const fn of unblock)fn();await bridge.close();await core.close();await actualMemory.close();await provider.close();await store.flush();rmSync(dataRoot,{recursive:true,force:true});});
 async function connect({pluginId='community.qq',channel='qq-private',accountBindingId='account',generation=1,personaId='default',conversationId='qq-owner-conversation',nativeMessageId='message-1'}={}){
  await store.mutate(state=>{state.personas[personaId]??={...structuredClone(state.personas.default),id:personaId};});
  const transport=core.socialHost.registerTransport({pluginId,channel,accountBindingId,generation,verify:async raw=>raw.proof==='isolated-native'?{characterId:'claude',personaId,sessionId:'social-session-'+generation,conversationId,actorId:'transport-actor',nativeMessageId:raw.id,text:'Real isolated transport message',stage:'received',status:'received',occurredAt:now,visibilityScope:'conversation'}:null});
  const event=await transport.observe({proof:'isolated-native',id:nativeMessageId});bridge.grants.set({pluginId,declared:core.socialHost.capabilities,granted:core.socialHost.capabilities});const issued=await bridge.issueContext({pluginId,eventRef:event.eventRef,permissionScope:core.socialHost.capabilities});
  const wire=[];const client=createSocialClient({pluginId,contextToken:issued.contextToken,invoke:async(request,options)=>{const serialized=JSON.parse(JSON.stringify(request));wire.push(serialized);return bridge.invoke(serialized,options);}});
  return {client,event,transport,issued,wire,pluginId,channel,accountBindingId,generation};
 }
 return {store,core,provider,profile,global,requests,usages,memoryReads,contextReads,appSpeeches,activity,connect,setReplyMode:value=>replyMode=value,
  blockMemory(){memoryGate={entered:gate(),wait:gate()};unblock.push(()=>memoryGate?.wait.resolve());return memoryGate;}};
}

test('serialized SDK model request freezes the dedicated role model/effort/budget and preserves private scope/origin through real ModelRouter',async t=>{
 const f=await fixture(t),c=await f.connect(),lease=await c.client.lease({activityId:'actual-model-attempt'});
 const result=await c.client.model({connectionRef:f.profile.id,leaseId:lease.leaseId,messages:[{role:'user',content:'Please answer in this QQ private conversation.'}]});
 assert.equal(result.text,'A reply from the frozen role connection.');assert.equal(f.requests.length,1);assert.equal(f.requests[0].body.model,'gpt-6.1-sol');assert.equal(f.requests[0].body.reasoning.effort,'xhigh');assert.equal(f.requests[0].body.max_output_tokens,512);assert.equal(result.connection.id,f.profile.id);assert.equal(f.provider.currentSelection().provider,f.global.id,'request must not alter the global selection');
 assert.equal(f.usages.length,1);assert.equal(f.usages[0].usage.total,25);assert.equal(f.usages[0].purpose,'social-chat');assert.equal(f.usages[0].scope.channel,'qq-private');assert.equal(f.usages[0].scope.conversationId,'qq-owner-conversation');assert.equal(f.usages[0].scope.personaId,'default');assert.ok(f.usages[0].activityOriginId);
 assert.equal(f.contextReads.length,1);assert.equal(f.contextReads[0].args.includePersonaContext,false);assert.equal(f.contextReads[0].metadata.connection.id,f.profile.id);assert.equal(f.contextReads[0].metadata.frozenContextCapacity.tokens,24000);assert.equal(f.contextReads[0].metadata.scope.channel,'qq-private');assert.equal(JSON.stringify(f.requests[0].body).includes('APP private secret'),false);assert.ok(c.wire.some(row=>row.method==='models.request'));assert.equal(c.issued.context.taskId,null);assert.equal(c.issued.context.workspace,undefined);
 await assert.rejects(c.client.model({connectionRef:f.global.id,leaseId:lease.leaseId,messages:[{role:'user',content:'Do not replace the role connection with the global one.'}]}),/已绑定连接/);assert.equal(f.requests.length,1,'an unbound connection reference must be rejected before any HTTP submission');
});

test('serialized context.read calls only read-only memory.view, without a model or compression request',async t=>{
 const f=await fixture(t),c=await f.connect(),result=await c.client.context({query:'What do you remember here?'});
 assert.equal(result.memory.readOnly,true);assert.equal(JSON.stringify(result).includes('APP private secret'),false);assert.equal(result.relationship,undefined);assert.equal(f.requests.length,0);assert.equal(f.usages.length,0);assert.equal(f.contextReads.length,0);assert.equal(f.memoryReads.length,1);assert.equal(f.memoryReads[0].socialContext.channel,'qq-private');assert.equal(f.memoryReads[0].includePersonaContext,false);
});

test('finished lease cannot submit another model/search request, and finishing while memory waits submits zero HTTP',async t=>{
 const f=await fixture(t),c=await f.connect(),lease=await c.client.lease({activityId:'finish-before-submit'}),block=f.blockMemory();
 const pending=c.client.model({connectionRef:f.profile.id,leaseId:lease.leaseId,messages:[{role:'user',content:'queued original'}]});const rejected=assert.rejects(pending,/cancel|lease|失效|取消/i);await block.entered.promise;await c.client.finish({leaseId:lease.leaseId,status:'cancelled'});block.wait.resolve();await rejected;assert.equal(f.requests.length,0);assert.equal(f.usages.length,0);assert.equal(f.core.socialHost.activeCount(),0);
 await assert.rejects(c.client.model({connectionRef:f.profile.id,leaseId:lease.leaseId,messages:[{role:'user',content:'must not submit'}]}),/lease/i);await assert.rejects(c.client.search({leaseId:lease.leaseId,query:'must not search'}),/lease/i);assert.equal(f.requests.length,0);
});

test('native social search returns actual transport citations only, never URLs merely written by the model',async t=>{
 const f=await fixture(t),c=await f.connect(),lease=await c.client.lease({activityId:'actual-search'});await f.core.action('search-settings',{enabled:true});
 let result=await c.client.search({leaseId:lease.leaseId,query:'A mock query'});assert.deepEqual(result.sources,[]);assert.match(result.text,/invented.example/);
 f.setReplyMode('sources');result=await c.client.search({leaseId:lease.leaseId,query:'A mock query with real tool receipts'});assert.ok(result.sources.length>0);assert.ok(result.sources.every(row=>row.url==='https://example.com/actual-source'));assert.equal(result.sources.some(row=>row.url.includes('invented.example')),false);assert.equal(f.usages.at(-1).purpose,'social-search');assert.ok(f.requests.at(-1).body.tools.some(tool=>/web_search/.test(tool.type)));
 const origin=f.usages.at(-1).activityOriginId;assert.equal(f.core.searchPolicy({activityOriginId:origin}),false,'finished request attribution cannot authorize new search');
});

async function appendUnderstood(f,c,{id='actual-material',understood=true}={}){
 const material=await f.core.socialHost.observeEvidence({pluginId:c.pluginId,eventRef:c.event.eventRef,sourceKind:c.channel==='bilibili'?'bilibili-watch':'qq-inbound',nativeEvidenceId:id,stage:understood?'understood':'material-read',status:'completed',text:'Actually understood '+id,evidenceRefs:[{id:'material-receipt-'+id,sha256:'a'.repeat(64)}]});await c.client.append({eventRef:material.eventRef});return f.store.state.lives.claude.socialExperiences.find(row=>row.eventRef===material.eventRef);
}

test('Core grants APP-private memory only verified current-life same-Persona understood Bili scopes',async t=>{
 const f=await fixture(t),b=await f.connect({pluginId:'community.bili',channel:'bilibili',accountBindingId:'bili',conversationId:'watch-current'}),good=await appendUnderstood(f,b),qq=await f.connect({accountBindingId:'qq',conversationId:'qq-understood'}),qqSource=await appendUnderstood(f,qq,{id:'qq-source'});
 const partial=await f.connect({pluginId:'community.bili.partial',channel:'bilibili',accountBindingId:'partial',conversationId:'watch-partial'});await appendUnderstood(f,partial,{id:'partial',understood:false});
 const other=await f.connect({pluginId:'community.bili.other',channel:'bilibili',accountBindingId:'other',personaId:'other-persona',conversationId:'watch-other-persona'});await appendUnderstood(f,other,{id:'other-persona'});
 await f.store.mutate(state=>{for(const [id,patch]of [['old-life',{lifeId:'historical-life',conversationId:'watch-old-life'}],['bad-hash',{conversationId:'watch-bad-hash'}]]){const row={...structuredClone(good),id,eventRef:id,...patch};row.sourceHash=id==='bad-hash'?'0'.repeat(64):socialExperienceHash(row);state.lives.claude.socialExperiences.push(row);}});
 const appScope=f.core.activeScope(),allowed=f.core.authorizedAppSocialScopes(appScope);assert.deepEqual(allowed,[socialMemoryScope(good)]);assert.equal(allowed.includes(socialMemoryScope(qqSource)),false);assert.deepEqual(f.core.authorizedAppSocialScopes({...appScope,channel:'app-group'}),[]);
 await f.core.userInteraction({scope:appScope,eventId:'current-app-chat',kind:'chat',text:'Tell me what you actually watched.'});await f.core.mood.evaluate({scope:appScope,eventIds:['current-app-chat']});
 const read=f.contextReads.at(-1);assert.deepEqual(read.args.authorizedSocialScopes,[socialMemoryScope(good)]);assert.equal(JSON.stringify(f.requests.at(-1).body).includes('Actually understood actual-material'),true);assert.equal(JSON.stringify(f.requests.at(-1).body).includes('Actually understood qq-source'),false);assert.equal(JSON.stringify(f.requests.at(-1).body).includes('Actually understood other-persona'),false);
});

test('serialized SDK and APP action cannot supply raw authorized scopes to read QQ memory',async t=>{
 const f=await fixture(t),c=await f.connect(),source=await appendUnderstood(f,c,{id:'private-qq-source'}),wanted=socialMemoryScope(source),before=f.requests.length;
 await assert.rejects(c.client.context({authorizedSocialScopes:[wanted]}),/unknown|allowed/i);await assert.rejects(c.client.calls('social.context.read',{socialContext:{channel:'qq-private'},includePersonaContext:true}),/unknown|allowed/i);assert.equal(JSON.stringify(await f.core.action('view',{authorizedSocialScopes:[wanted]})).includes(source.text),false);assert.equal(f.requests.length,before);
 const root=mkdtempSync(join(tmpdir(),'r95-ui-private-memory-')),state=memoryStore(await companionFixture()),engine=syntheticEngine({getStore:()=>state}).engine;let app;
 try{const scope={characterId:'claude',personaId:'default',...{lifeId:state.state.lives.claude.id,operationId:state.state.lives.claude.operationId},channel:'qq-private',conversationId:'private-qq'};const fact={id:'ui-private-source',eventRef:'ui-private-source',scope,sourceVersion:1,sourcePluginId:'qq',sourceKind:'qq-inbound',createdAt:Date.now(),text:'QQ private source unavailable from raw APP grant.',stage:'understood',understandingState:'understood',presentationState:'not-presented',deliveryState:'not-sent',visibilityScope:'conversation',evidenceRefs:[{id:'real-message',sha256:'b'.repeat(64)}]};await appendSocialExperience(state,{eventRef:fact.eventRef,scope},{verifyEvent:async()=>fact});app=await createCompanionService({store:state,engine,provider:{enabled:false,listProviders:()=>[],listModels:()=>[]},dataRoot:root});
  for(const raw of [{authorizedSocialScopes:[socialMemoryScope(scope)]},{socialContext:scope},{authorizedSocialScopes:[socialMemoryScope(scope)],socialContext:scope,includePersonaContext:true},{workspaceId:'external-workspace'},{authorizedWorkspaceIds:['external-workspace']}]){
   await assert.rejects(app.action('companion-memory-view',{characterId:'claude',personaId:'default',...raw}),/授权|范围|字段|不允许|invalid|allowed/i,'raw APP authorization/context claims must fail before a local pending-original view is returned');
   await assert.rejects(app.action('companion-memory-retry',{characterId:'claude',personaId:'default',...raw}),/授权|范围|字段|不允许|invalid|allowed/i);
  }
  const local=await app.action('companion-memory-view',{characterId:'claude',personaId:'default'});assert.ok(local.memory.pendingAttribution.some(row=>row.text===fact.text),'the explicit local original-view contract remains available without private grant claims');assert.equal(state.state.lives.claude.socialExperiences.find(row=>row.id===fact.id).text,fact.text);
 }finally{await app?.close();await state.flush();rmSync(root,{recursive:true,force:true});}
});

test('external proactive generation requires a real sender, and transport-generation replacement revokes old lease admission',async t=>{
 const f=await fixture(t),c=await f.connect(),lease=await c.client.lease({activityId:'external-no-sender'});await c.client.append({eventRef:c.event.eventRef});await f.core.action('social-settings',{proactive:true});const offered=await c.client.offer({eventRef:c.event.eventRef,kind:'share'});
 const result=await f.core.proactive.tick({candidateId:offered.candidate.id});assert.equal(result.skipped,'presentation-barrier');assert.equal(f.requests.length,0);assert.equal(f.appSpeeches.length,0);assert.equal(f.core.socialHost.allowsScope(lease.scope),true);
 await f.connect({generation:2,nativeMessageId:'generation-2-message'});assert.equal(f.core.socialHost.allowsScope(lease.scope),false);await assert.rejects(c.client.model({leaseId:lease.leaseId,connectionRef:f.profile.id,messages:[{role:'user',content:'old generation'}]}),/revoked|generation|expired|context/i);assert.equal(f.requests.length,0);
});

for(const outcome of ['sent','unknown'])test(`external sender ${outcome} records actual delivery, never claims the human read it or spills into APP`,async t=>{
 const f=await fixture(t),c=await f.connect(),lease=await c.client.lease({activityId:'external-delivery-'+outcome});await c.client.append({eventRef:c.event.eventRef});await f.core.action('social-settings',{proactive:true});const offered=await c.client.offer({eventRef:c.event.eventRef,kind:'share'}),sent=[],checks=[];
 const sender=f.core.registerSocialDelivery({channel:c.channel,accountBindingId:c.accountBindingId,generation:c.generation,check:scope=>{checks.push(structuredClone(scope));assert.equal(scope.conversationId,c.issued.context.conversationId);},send:value=>{sent.push(value);return outcome==='sent'?{status:'sent',nativeMessageId:'actual-platform-delivery-1'}:{status:'unknown'};}});
 if(outcome==='sent')assert.equal((await f.core.proactive.tick({candidateId:offered.candidate.id})).delivered,true);else await assert.rejects(f.core.proactive.tick({candidateId:offered.candidate.id}),/结果尚未确认/);
 const line=f.store.state.lives.claude.r95.lines.find(row=>row.candidateId===offered.candidate.id);assert.equal(sent.length,1);assert.ok(checks.length>=2);assert.equal(line.status,outcome==='sent'?'sent':'delivery-unknown');assert.equal(line.deliveryState,outcome);assert.notEqual(line.presentationState,'presented');assert.equal(f.appSpeeches.length,0);assert.equal(f.core.view().lines.length,0);
 assert.equal((await f.core.proactive.tick({candidateId:offered.candidate.id})).skipped,outcome==='sent'?'presented':'delivery-unknown');assert.equal(sent.length,1);sender.revoke();await c.client.finish({leaseId:lease.leaseId,status:outcome==='sent'?'completed':'unknown'});
});

test('Bili share requires appended understood source, projects to matching private life and never fabricates work authority',async t=>{
 const f=await fixture(t),c=await f.connect({pluginId:'community.bili',channel:'bilibili',accountBindingId:'bili',conversationId:'actual-watch'});await c.client.lease({activityId:'bili-share'});await f.core.action('social-settings',{proactive:true});
 await assert.rejects(c.client.offer({eventRef:c.event.eventRef,kind:'share'}),/真实理解/);assert.equal(f.requests.length,0);const source=await appendUnderstood(f,c),offered=await c.client.offer({eventRef:source.eventRef,kind:'share'});assert.equal(offered.candidate.scope.channel,'app-private');assert.equal(offered.candidate.scope.personaId,'default');assert.equal(offered.candidate.scope.conversationId,'conversation');assert.equal(offered.candidate.scope.lifeId,source.lifeId);
 const evidence=f.store.state.lives.claude.r95.evidence[offered.candidate.eventIds[0]];assert.equal(evidence.sourceRef.eventRef,source.eventRef);assert.equal(evidence.sourceRef.sourceHash,source.sourceHash);assert.equal(evidence.sourceRef.scope.channel,'bilibili');assert.equal(evidence.sourceKind,'bilibili-watch');assert.equal(evidence.taskId,undefined);assert.equal(evidence.workspace,undefined);assert.equal(f.store.state.lives.claude.workExperiences?.length??0,0);assert.equal((await f.core.proactive.tick({candidateId:offered.candidate.id})).delivered,true);assert.equal(f.appSpeeches.length,1);assert.equal(f.appSpeeches[0].scope.channel,'app-private');
});

 test('only a verified direct bound-owner inbound social message counts as user attention, once',async t=>{const f=await fixture(t),c=await f.connect();f.core.owner.bindOwner({accountBindingId:c.accountBindingId,actorId:'transport-actor',personaId:'default',version:1});assert.equal(f.core.attention.view({scope:c.issued.context}).lastAttentionAt,null);await c.client.append({eventRef:c.event.eventRef});assert.equal(f.core.attention.view({scope:c.issued.context}).lastAttentionAt,1700000000000);const before=Object.keys(f.store.state.lives.claude.r95.attention.events).length;await c.client.append({eventRef:c.event.eventRef});assert.equal(Object.keys(f.store.state.lives.claude.r95.attention.events).length,before);assert.equal(f.store.state.lives.claude.r95.pendingMoodEventIds.length,1);});
 test('an unbound external friend is not counted as owner attention',async t=>{const f=await fixture(t),c=await f.connect();await c.client.append({eventRef:c.event.eventRef});assert.equal(f.core.attention.view({scope:c.issued.context}).lastAttentionAt,null);});
