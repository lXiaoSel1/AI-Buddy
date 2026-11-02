import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createCompanionR95} from '../src/companion-r95.mjs';
import {runR95Model} from '../src/r95-model-request.mjs';
import {createBuddyPluginServices,createSocialClient} from '../src/buddy-plugin-services/index.mjs';
import {buildQqMessageEnvelope} from '../src/buddy-plugin-services/qq-message-envelope.mjs';
import {appendSocialExperience,createCompanionMemory,socialIdentityHash,socialExperienceEvidenceHash} from '../src/companion-memory.mjs';
import {companionFixture,memoryStore} from './support/audit-harness.mjs';

async function fixture(t){
 const dataRoot=mkdtempSync(join(tmpdir(),'qq-style-context-')),now=1700000000000,store=memoryStore(await companionFixture({now})),calls=[];let globalStyle='brief',block=null,core;
 const profile={id:'role',kind:'custom',protocol:'responses',model:'fake-model',contextTokens:24000};
 const provider={enabled:true,ready:Promise.resolve(),captureConnection:()=>structuredClone(profile),resolveConnection:()=>({connectionId:'role',model:'fake-model'}),resolveContextCapacity:()=>({tokens:24000,source:'test'}),outputLimit:()=>512,selected:()=>profile,currentSelection:()=>({provider:'role',model:'fake-model'}),runCaptured:async(_p,fn)=>fn(),withFrozenBudget:(_value,fn)=>fn(),async *stream(options){calls.push(options);yield {type:'text-delta',text:'synthetic text'};yield {type:'finish',reason:{kind:'stop'}};}};
 await store.mutate(state=>{state.cards.claude.modelBinding={enabled:true,connectionId:'role'};});
 core=await createCompanionR95({store,dataRoot,provider,now:()=>now,getReplyStyle:()=>globalStyle,getContext:()=>({characterId:'claude',personaId:'default',conversationId:'conversation'}),delta:()=>{},getRuntimeState:()=>({sleepPhase:'awake',canPresent:true}),memory:{view:async()=>({events:[]}),context:async()=>{if(block)await block;return {text:'MEMORY_END',messages:[],capacity:{tokens:24000}};}}});
 const bridge=createBuddyPluginServices({resolveContext:spec=>core.socialHost.resolveContext(spec),hostServices:core.socialHost.services,now:()=>now});
 t.after(async()=>{await bridge.close();await core.close();await store.flush();rmSync(dataRoot,{recursive:true,force:true});});
 async function connect(channel='qq-group',accountBindingId='10001',generation=1){
  const pluginId=channel==='bilibili'?'fixture.bili':'fixture.qq',transport=core.socialHost.registerTransport({pluginId,channel,accountBindingId,generation,verify:async()=>({characterId:'claude',personaId:'default',sessionId:'s',conversationId:'group:30001',actorId:'20001',nativeMessageId:'m1',text:'synthetic',stage:'received',status:'received',occurredAt:now,visibilityScope:channel==='bilibili'?'public':'group'})});
  const event=await transport.observe({});bridge.grants.set({pluginId,declared:core.socialHost.capabilities,granted:core.socialHost.capabilities});const issued=await bridge.issueContext({pluginId,eventRef:event.eventRef,permissionScope:core.socialHost.capabilities});
  const client=createSocialClient({pluginId,contextToken:issued.contextToken,invoke:(r,o)=>bridge.invoke(r,o)}),lease=await client.lease({activityId:['test',channel,accountBindingId,generation].join(':')});return {client,lease,event,pluginId};
 }
 return {core,store,calls,connect,setGlobal:v=>globalStyle=v,block:()=>{let release;block=new Promise(resolve=>release=resolve);return ()=>{block=null;release();};}};
}
test('QQ text style resolves conversation/default/global and is last after memory; receipts retain provenance',async t=>{
 const f=await fixture(t),c=await f.connect(),envelope=buildQqMessageEnvelope({raw:{message_type:'group',self_id:'10001',user_id:'20001',sender:{user_id:'20001',nickname:'same name'},group_id:'30001',message_id:'m1',message:[{type:'at',data:{qq:'10001'}},{type:'text',data:{text:'synthetic current text'}}]},accountId:'10001',conversationId:'group:30001'}),request={connectionRef:'role',leaseId:c.lease.leaseId,purpose:'qq-reply',messages:[{role:'user',content:JSON.stringify(envelope)}]};
 const global=await c.client.model(request);assert.equal(global.replyStyle,'brief');assert.equal(global.replyStyleSource,'global');assert.ok(f.calls.at(-1).system.indexOf('MEMORY_END')<f.calls.at(-1).system.indexOf('回复风格'));
 const finalInput=JSON.parse(f.calls.at(-1).messages.at(-1).content[0].text),visible=JSON.parse(finalInput.messages[0].content);assert.equal(visible.sender.id,'20001');assert.equal(visible.sender.displayName,'same name');assert.equal(visible.mentions[0].isSelf,true);assert.equal(visible.account.selfId,'10001');
 const def=await c.client.model({...request,replyStylePolicy:{defaultStyle:'natural',conversationStyle:'inherit'}});assert.equal(def.replyStyle,'natural');assert.equal(def.replyStyleSource,'qq-default');
 const local=await c.client.model({...request,replyStylePolicy:{defaultStyle:'brief',conversationStyle:'detailed'}});assert.equal(local.replyStyle,'detailed');assert.equal(local.replyStyleSource,'conversation');
 await assert.rejects(c.client.model({...request,replyStylePolicy:{defaultStyle:'invalid'}}));
});
test('QQ global style is frozen before memory awaits and Bili never receives QQ presentation metadata',async t=>{
 const f=await fixture(t),c=await f.connect(),release=f.block(),pending=c.client.model({connectionRef:'role',leaseId:c.lease.leaseId,purpose:'qq-reply',messages:[{role:'user',content:'synthetic'}]});
 await new Promise(setImmediate);f.setGlobal('detailed');release();const result=await pending;assert.equal(result.replyStyle,'brief');assert.match(f.calls.at(-1).system,/简短/);
 const b=await f.connect('bilibili'),value=await b.client.model({connectionRef:'role',leaseId:b.lease.leaseId,messages:[{role:'user',content:'JSON or Bili'}]});assert.equal(value.replyStyle,undefined);assert.doesNotMatch(f.calls.at(-1).system,/回复风格/);
});
test('private presentation instructions count toward memory reservation and final capacity',async()=>{
 let budget,submitted=0;const scope={characterId:'claude',personaId:'default',lifeId:'life',operationId:'op',channel:'qq-group',conversationId:'group:1',accountBindingId:'10001'};
 const profile={id:'role',kind:'custom',protocol:'responses',model:'fake',contextTokens:8000},provider={enabled:true,ready:Promise.resolve(),captureConnection:()=>profile,resolveConnection:()=>({connectionId:'role'}),resolveContextCapacity:()=>({tokens:8000}),outputLimit:()=>512,selected:()=>profile,runCaptured:async(_p,fn)=>fn(),async *stream(){submitted++;yield {type:'text-delta',text:'ok'};}};
 await runR95Model({provider,card:{id:'claude',modelBinding:{enabled:true,connectionId:'role'}},scope,system:'base',presentationInstructions:'PRESENTATION_SENTINEL '.repeat(80),input:{kind:'social-chat'},memory:{context:async args=>{budget=args.systemTokens;return {text:'memory',messages:[],capacity:{tokens:8000}};}},withOrigin:async(_s,_k,fn)=>fn('origin'),parseOutput:({text})=>text});assert.ok(budget>1000);assert.equal(submitted,1);
});
test('real R95 legacy attribution reads original host evidence and rejects wrong hash/plugin/scope',async t=>{
 const f=await fixture(t),c=await f.connect(),original=f.core.socialHost.readEvidence(c.pluginId,c.event.eventRef),args={...Object.fromEntries(['characterId','lifeId','personaId','channel','conversationId'].map(key=>[key,original[key]])),eventRef:c.event.eventRef,sourcePluginId:c.pluginId,sourceVersion:original.sourceVersion??1,sourceEvidenceHash:original.sourceHash,companionSourceHash:socialExperienceEvidenceHash({...original,id:c.event.eventRef,scope:original,sourcePluginId:c.pluginId,sourceKind:'qq-inbound',createdAt:original.occurredAt,evidenceRefs:[{id:c.event.eventRef,sha256:original.sourceHash}],sourceVersion:original.sourceVersion??1},c.event.eventRef,original)};
 const proof=f.core.resolveLegacySocialIdentity(args);assert.equal(proof.accountBindingId,'10001');assert.equal(proof.actorId,'20001');assert.equal(proof.sourceEvidenceHash,original.sourceHash);
 for(const key of ['characterId','lifeId','personaId','channel','conversationId','sourcePluginId','eventRef','sourceEvidenceHash','companionSourceHash'])assert.equal(f.core.resolveLegacySocialIdentity({...args,[key]:'wrong-'+args[key]}),null,key);assert.equal(f.core.resolveLegacySocialIdentity({...args,sourceVersion:2}),null);
 await c.client.finish({leaseId:c.lease.leaseId,status:'completed'});
 const other=await f.connect('qq-group','10002',2),otherOriginal=f.core.socialHost.readEvidence(other.pluginId,other.event.eventRef);assert.equal(f.core.resolveLegacySocialIdentity({...args,sourceEvidenceHash:otherOriginal.sourceHash}),null);assert.equal(f.core.resolveLegacySocialIdentity(args).accountBindingId,'10001','new active transport cannot reattribute the old event to account B');await other.client.finish({leaseId:other.lease.leaseId,status:'completed'});
});
test('a legitimate new QQ source is usable only through the real R95 host-evidence resolver',async t=>{
 const f=await fixture(t),c=await f.connect(),original=f.core.socialHost.readEvidence(c.pluginId,c.event.eventRef),scope=Object.fromEntries(['characterId','lifeId','operationId','personaId','channel','conversationId','accountBindingId','actorId'].map(key=>[key,original[key]]));
 await appendSocialExperience(f.store,{eventRef:c.event.eventRef,scope},{verifyEvent:async()=>({...original,id:c.event.eventRef,scope,sourcePluginId:c.pluginId,sourceKind:'qq-inbound',createdAt:original.occurredAt,evidenceRefs:[{id:c.event.eventRef,sha256:original.sourceHash}],sourceVersion:original.sourceVersion??1})});
 const memory=createCompanionMemory({store:f.store,now:()=>1700000000000,autoStart:false,getCapacity:()=>({tokens:24000,verified:true}),runModel:async()=>{throw Error('No compression model is allowed');},resolveLegacySocialIdentity:args=>f.core.resolveLegacySocialIdentity(args)});t.after(()=>memory.close());
 const args={characterId:scope.characterId,personaId:scope.personaId,conversationId:scope.conversationId,socialContext:scope},visible=await memory.context(args);assert.match(JSON.stringify(visible),/synthetic/);const row=f.store.state.lives[scope.characterId].socialExperiences.find(r=>r.eventRef===c.event.eventRef);assert.equal(row.identityEvidenceHash,original.sourceHash);
 await f.store.mutate(state=>{const raw=state.lives[scope.characterId].socialExperiences.find(r=>r.eventRef===c.event.eventRef);raw.accountBindingId='10002';raw.identityHash=socialIdentityHash(raw);});assert.doesNotMatch(JSON.stringify(await memory.context({...args,socialContext:{...scope,accountBindingId:'10002'}})),/synthetic/,'a recomputed public hash cannot replace the original host account');await c.client.finish({leaseId:c.lease.leaseId,status:'completed'});
});
test('QQ expression resolver requires an original sent receipt and exact core projection, including first-introduction wire text',async t=>{
 const f=await fixture(t),c=await f.connect(),source=f.core.socialHost.readEvidence(c.pluginId,c.event.eventRef),scope=Object.fromEntries(['characterId','lifeId','operationId','personaId','channel','conversationId','accountBindingId','actorId','sessionId','bindingGeneration','activityGeneration','visibilityScope'].map(key=>[key,source[key]])),anchor=f.core.socialHost.registerContext({pluginId:c.pluginId,scope,check:()=>true}),text='actual core expression',messageId='social-line-test',candidateId='candidate-test',nativeMessageId='native-sent-test';
 const result=f.core.socialHost.recordContextEvidence({pluginId:c.pluginId,contextRef:anchor.contextRef,nativeEvidenceId:nativeMessageId,sourceKind:'qq-outbound',stage:'sent',status:'completed',text:'现在由GPT陪你聊天。\n'+text,deliveryState:'sent',evidenceRefs:[{id:messageId,kind:'qq-expression-projection',sha256:createHash('sha256').update(JSON.stringify(text)).digest('hex'),candidateId}]}),receipt=f.core.socialHost.readEvidence(c.pluginId,result.eventRef),args={...Object.fromEntries(['characterId','lifeId','personaId','channel','conversationId'].map(key=>[key,source[key]])),messageId,candidateId,nativeMessageId,text,eventRef:result.eventRef,sourcePluginId:c.pluginId,sourceEvidenceHash:receipt.sourceHash,sourceVersion:1};
 const proof=f.core.resolveSocialExpressionIdentity(args);assert.equal(proof.accountBindingId,'10001');assert.equal(proof.actorId,'20001');assert.equal(proof.messageId,messageId);assert.equal(proof.nativeMessageId,nativeMessageId);
 for(const key of ['text','messageId','candidateId','nativeMessageId','sourceEvidenceHash','sourcePluginId','characterId','lifeId','personaId','channel','conversationId'])assert.equal(f.core.resolveSocialExpressionIdentity({...args,[key]:'wrong-'+args[key]}),null,key);assert.equal(f.core.resolveSocialExpressionIdentity({...args,eventRef:c.event.eventRef,sourceEvidenceHash:source.sourceHash}),null,'an inbound source reference cannot prove an outbound expression');await c.client.finish({leaseId:c.lease.leaseId,status:'completed'});anchor.revoke();
});
