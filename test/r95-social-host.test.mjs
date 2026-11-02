import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSocialHost} from '../src/buddy-plugin-services/social-host.mjs';
import {createBuddyPluginServices} from '../src/buddy-plugin-services/index.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'r95-social-'));let time=1000;
 const live={characterId:'deepseek',personaId:'default',lifeId:'life-1',operationId:'op-1',sessionId:'session-1',contextRevision:1};
 const experiences=[],candidates=[];
 const host=createSocialHost({dataRoot:root,now:()=>time,resolveLife:()=>({...live}),readContext:async scope=>({characterId:scope.characterId,memories:['only this conversation']}),appendExperience:async event=>{if(!experiences.some(e=>e.eventId===event.eventId))experiences.push(event);},offer:async event=>{candidates.push(event);return {offered:true};}});
 const adapter=host.registerTransport({pluginId:'qq',channel:'qq-private',accountBindingId:'account-1',generation:1,verify:async raw=>raw.proof==='verified'?{...live,conversationId:'friend-1',actorId:raw.actorId??'owner-1',nativeMessageId:raw.id,text:raw.text??'hello',status:raw.status??'received',stage:raw.stage??'received',occurredAt:time,visibilityScope:'private'}:null});
 const bridge=createBuddyPluginServices({resolveContext:spec=>host.resolveContext(spec),hostServices:host.services,now:()=>time});
 bridge.grants.set({pluginId:'qq',declared:host.capabilities,granted:host.capabilities});
 t.after(async()=>{await bridge.close();host.close();await rm(root,{recursive:true,force:true});});
 const event=await adapter.observe({proof:'verified',id:'message-1'});
 const token=await bridge.issueContext({pluginId:'qq',eventRef:event.eventRef,permissionScope:host.capabilities});
 const invoke=(method,payload={})=>bridge.invoke({pluginId:'qq',contextToken:token.contextToken,method,payload});
 return {root,host,adapter,bridge,event,token,invoke,live,experiences,candidates,time:()=>time,advance:ms=>time+=ms};
}

test('lease checks require the exact live scope and generation; repeated activity IDs cannot cross conversations',async t=>{
 const f=await fixture(t),lease=await f.invoke('activity.lease',{activityId:'checked'});
 assert.equal((await f.invoke('activity.check',{leaseId:lease.leaseId,generation:lease.generation})).valid,true);
 await assert.rejects(f.invoke('activity.check',{leaseId:lease.leaseId,generation:lease.generation+1}),/generation/i);
 const event=await f.adapter.observe({proof:'verified',id:'message-other',actorId:'another'});
 const token=await f.bridge.issueContext({pluginId:'qq',eventRef:event.eventRef,permissionScope:f.host.capabilities});
 await assert.rejects(f.bridge.invoke({pluginId:'qq',contextToken:token.contextToken,method:'activity.lease',payload:{activityId:'checked'}}),/scope/i);
 await f.invoke('activity.finish',{leaseId:lease.leaseId,status:'completed'});
 await assert.rejects(f.invoke('activity.check',{leaseId:lease.leaseId,generation:lease.generation}),/lease/i);
});
test('serialized social service dispatch resolves scoped context without fabricated workspace or task',async t=>{
 const f=await fixture(t),result=await f.invoke('social.context.read');
 assert.equal(result.characterId,'deepseek');assert.equal(f.token.context.contextKind,'social');assert.equal(f.token.context.taskId,null);assert.equal(f.token.context.workspace,undefined);
 assert.deepEqual(result.memories,['only this conversation']);
 await assert.rejects(f.invoke('social.context.read',{characterId:'claude'}),/change trusted|identity/i);
});

test('private activity admission is not an experience and remains revocable through the real bridge',async t=>{
 const f=await fixture(t);let enabled=true;
 const anchor=f.host.registerContext({pluginId:'qq',scope:{...f.token.context,sessionId:'new-activity',conversationId:'activity-1'},check:()=>enabled});
 const token=await f.bridge.issueContext({pluginId:'qq',contextRef:anchor.contextRef,permissionScope:f.host.capabilities});
 const invoke=(method,payload)=>f.bridge.invoke({pluginId:'qq',contextToken:token.contextToken,method,payload});
 const lease=await invoke('activity.lease',{activityId:'app-activity'});
 assert.equal(f.experiences.length,0);assert.equal(f.host.allowsScope(token.context),true);
 await assert.rejects(invoke('experience.append',{eventRef:anchor.contextRef}),/evidence/i);
 const observed=f.host.recordContextEvidence({pluginId:'qq',contextRef:anchor.contextRef,nativeEvidenceId:'http-1',sourceKind:'video-material',stage:'material-read',status:'completed',text:'actual HTTP response'});
 await invoke('experience.append',{eventRef:observed.eventRef});assert.equal(f.experiences.length,1);
 enabled=false;await assert.rejects(invoke('activity.check',{leaseId:lease.leaseId,generation:lease.generation}),/revoked|expired/i);
 assert.equal(f.host.allowsScope(token.context),false);
});
test('social context cannot grant work.host or accept caller-supplied owner/transport identities',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.bridge.issueContext({pluginId:'qq',eventRef:f.event.eventRef,permissionScope:['work.host']}),/work|capability/i);
 await assert.rejects(f.invoke('social.context.read',{actorId:'attacker'}),/change trusted|identity/i);
 await assert.rejects(f.adapter.observe({proof:'not-verified',id:'bad'}),/transport|verified|evidence/i);
});
test('private understood viewing is an experience without pretending the user saw it',async t=>{
 const f=await fixture(t);
 const video=await f.host.observeEvidence({pluginId:'qq',eventRef:f.event.eventRef,sourceKind:'video-material',nativeEvidenceId:'video-1',stage:'understood',status:'completed',text:'Actually read material',evidenceRefs:['sha256:source'],presentationState:'not-presented',deliveryState:'not-sent'});
 const result=await f.invoke('experience.append',{eventRef:video.eventRef});
 assert.equal(result.recorded,true);assert.equal(f.experiences.length,1);assert.equal(f.experiences[0].presentationState,'not-presented');assert.equal(f.experiences[0].kind,'social');
 await f.invoke('experience.append',{eventRef:video.eventRef});assert.equal(f.experiences.length,1);
});
test('draft and failed social materials remain facts but never claim completed understanding',async t=>{
 const f=await fixture(t),result=await f.invoke('experience.append',{eventRef:f.event.eventRef});
 assert.equal(result.recorded,true);assert.equal(f.experiences[0].stage,'received');assert.notEqual(f.experiences[0].stage,'understood');
 await assert.rejects(f.host.observeEvidence({pluginId:'qq',eventRef:f.event.eventRef,sourceKind:'video-material',nativeEvidenceId:'bad',stage:'understood',status:'failed',text:'false success',evidenceRefs:[]}),/evidence|completed|stage/i);
});
test('event references persist and duplicate native messages do not create a second experience',async t=>{
 const f=await fixture(t);await f.invoke('experience.append',{eventRef:f.event.eventRef});
 const repeated=await f.adapter.observe({proof:'verified',id:'message-1'});assert.equal(repeated.eventRef,f.event.eventRef);
 assert.throws(()=>f.host.readEvidence('other-plugin',f.event.eventRef),/plugin|evidence/i);
});
test('activity lease is scoped, finish idempotent, and expired/life-changed admissions reject',async t=>{
 const f=await fixture(t),lease=await f.invoke('activity.lease',{activityId:'activity-1'});
 assert.equal(lease.scope.lifeId,'life-1');assert.equal(f.host.activeCount(),1);
 assert.equal((await f.invoke('activity.finish',{leaseId:lease.leaseId,status:'completed'})).finished,true);
 assert.equal((await f.invoke('activity.finish',{leaseId:lease.leaseId,status:'completed'})).duplicate,true);
 f.live.operationId='op-2';await assert.rejects(f.invoke('social.context.read'),/life|context|identity/i);
});
test('generation revocation cancels a social lease and rejects stale transport messages',async t=>{
 const f=await fixture(t);await f.invoke('activity.lease',{activityId:'activity-1'});f.host.revokePlugin('qq');
 assert.equal(f.host.activeCount(),0);await assert.rejects(f.invoke('social.context.read'),/expired|disabled|transport|revoked/i);
 await assert.rejects(f.adapter.observe({proof:'verified',id:'message-2'}),/revoked|generation|transport/i);
});
test('proactive offers require an actual scoped evidence reference',async t=>{
 const f=await fixture(t);await assert.rejects(f.invoke('proactive.offer',{eventRef:'invented',text:'hi'}),/evidence/i);
 await f.invoke('proactive.offer',{eventRef:f.event.eventRef,text:'hi'});assert.equal(f.candidates.length,1);
});
test('social SDK does not make work-style memory.appendEvent permissive',async t=>{
 const f=await fixture(t);await assert.rejects(f.invoke('memory.appendEvent',{evidenceId:'fake'}),/capability|evidence/i);
});

 test('replacing one native transport generation immediately cancels its active lease',async t=>{const f=await fixture(t);await f.invoke('activity.lease',{activityId:'old-binding-lease'});assert.equal(f.host.activeCount(),1);f.host.registerTransport({pluginId:'qq',channel:'qq-private',accountBindingId:'account-1',generation:2,verify:async()=>null});assert.equal(f.host.activeCount(),0);await assert.rejects(f.invoke('social.context.read'),/generation|expired|revoked/i);});
