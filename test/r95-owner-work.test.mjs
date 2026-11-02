import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOwnerWorkAuthority} from '../src/buddy-plugin-services/owner-work.mjs';
const scope={characterId:'deepseek',personaId:'default',lifeId:'life',operationId:'op'};
async function fixture(t){const dataRoot=await mkdtemp(join(tmpdir(),'r95-owner-'));let now=1000,calls=0,creates=0,cancels=0,revision=1;
 const events=new Map(),plan=()=>({taskId:'task-1',planVersion:revision,planHash:'a'.repeat(64),workspace:'workspace-1',scope});
 const authority=createOwnerWorkAuthority({dataRoot,now:()=>now,readEvidence:(_plugin,id)=>events.get(id),assertScope:s=>assert.deepEqual(s,scope),getPlan:async()=>plan(),propose:async request=>{creates++;return {taskId:request.taskId};},approve:async request=>{calls++;assert.ok(authority.verifyProof(request.authority,'plans.approve',{taskId:'task-1',planVersion:revision}));return {approved:true};},cancel:async request=>{cancels++;authority.verifyProof(request.authority,'tasks.cancel',{taskId:request.taskId,planVersion:request.planVersion});return {cancelled:true,taskId:request.taskId};}});
 authority.bindOwner({accountBindingId:'account',actorId:'owner',personaId:'default',version:1});
 const add=(id,extra={})=>{const event={eventRef:id,pluginId:'qq',accountBindingId:'account',actorId:'owner',channel:'qq-private',conversationId:'owner-private',nativeMessageId:id,stage:'received',text:'Fix the project',...scope,...extra};events.set(id,event);return event;};
 t.after(async()=>{authority.close();await rm(dataRoot,{recursive:true,force:true});});return {authority,add,plan,advance:ms=>now+=ms,revision:()=>revision++,calls:()=>calls,creates:()=>creates,cancels:()=>cancels};}
test('only actual bound-owner private event can propose; JSON owner claims and group events cannot',async t=>{const f=await fixture(t);
 for(const extra of [{actorId:'admin'},{channel:'qq-group'},{accountBindingId:'other'},{forwarded:true},{quoted:true},{sourceKind:'webpage'}])await assert.rejects(f.authority.proposeWork({pluginId:'qq',eventRef:f.add('bad'+JSON.stringify(extra),extra).eventRef,projectId:'workspace-1'}),/owner|private|direct/i);
 const request={pluginId:'qq',eventRef:f.add('real').eventRef,projectId:'workspace-1'};await f.authority.proposeWork(request);await f.authority.proposeWork(request);assert.equal(f.creates(),1);
});
test('same plan approval is private-authority based, idempotent, and never relies on a fake focused window',async t=>{const f=await fixture(t),owner=f.add('request');
 const challenge=await f.authority.issueApproval({pluginId:'qq',eventRef:owner.eventRef,taskId:'task-1'});
 const confirm=f.add('approve',{text:`批准 ${challenge.challengeId}`});
 const result=await f.authority.approveWork({pluginId:'qq',eventRef:confirm.eventRef,challengeId:challenge.challengeId});assert.equal(result.approved,true);
 await f.authority.approveWork({pluginId:'qq',eventRef:confirm.eventRef,challengeId:challenge.challengeId});assert.equal(f.calls(),1);
 assert.throws(()=>f.authority.verifyProof({owner:true},'plans.approve',{taskId:'task-1'}),/authority/i);
});
test('model cannot use an ordinary owner message as approval',async t=>{const f=await fixture(t),owner=f.add('request'),challenge=await f.authority.issueApproval({pluginId:'qq',eventRef:owner.eventRef,taskId:'task-1'});
 await assert.rejects(f.authority.approveWork({pluginId:'qq',eventRef:owner.eventRef,challengeId:challenge.challengeId}),/explicit|approve|批准/i);assert.equal(f.calls(),0);
});
test('plan revision changes, expiry and owner rebind invalidate pending approvals',async t=>{const f=await fixture(t),owner=f.add('request');
 let challenge=await f.authority.issueApproval({pluginId:'qq',eventRef:owner.eventRef,taskId:'task-1'});f.revision();
 await assert.rejects(f.authority.approveWork({pluginId:'qq',eventRef:f.add('changed',{text:`批准 ${challenge.challengeId}`}).eventRef,challengeId:challenge.challengeId}),/plan|revision/i);
 challenge=await f.authority.issueApproval({pluginId:'qq',eventRef:owner.eventRef,taskId:'task-1'});f.advance(300001);
 await assert.rejects(f.authority.approveWork({pluginId:'qq',eventRef:f.add('expired',{text:`批准 ${challenge.challengeId}`}).eventRef,challengeId:challenge.challengeId}),/expir/i);
 challenge=await f.authority.issueApproval({pluginId:'qq',eventRef:owner.eventRef,taskId:'task-1'});f.authority.bindOwner({accountBindingId:'account',actorId:'new-owner',personaId:'default',version:2});
 await assert.rejects(f.authority.approveWork({pluginId:'qq',eventRef:f.add('old-owner',{text:`批准 ${challenge.challengeId}`}).eventRef,challengeId:challenge.challengeId}),/owner|binding/i);assert.equal(f.calls(),0);
});

test('owner task reads and cancellation preserve direct-owner, exact plan and idempotency checks',async t=>{
 const f=await fixture(t),read=f.add('read',{text:'/计划 task-1'});
 assert.equal((await f.authority.readWork({pluginId:'qq',eventRef:read.eventRef,taskId:'task-1'})).planVersion,1);
 for(const extra of [{channel:'qq-group'},{quoted:true},{actorId:'other'}]){
  const bad=f.add('bad-cancel-'+JSON.stringify(extra),{text:'/取消 task-1 1',...extra});
  await assert.rejects(f.authority.cancelWork({pluginId:'qq',eventRef:bad.eventRef,taskId:'task-1',planVersion:1}),/owner|private/i);
 }
 const event=f.add('cancel',{text:'/取消 task-1 1'}),request={pluginId:'qq',eventRef:event.eventRef,taskId:'task-1',planVersion:1};
 await assert.rejects(f.authority.cancelWork({...request,planVersion:2}),/exact/i);
 assert.equal((await f.authority.cancelWork(request)).cancelled,true);await f.authority.cancelWork(request);assert.equal(f.cancels(),1);
 const old=f.add('stale-cancel',{text:'/取消 task-1 1'});f.revision();
 await assert.rejects(f.authority.cancelWork({...request,eventRef:old.eventRef}),/revision|scope/i);
});

test('version command requires a prior read of the same plan and retains private proof checks',async t=>{
 const f=await fixture(t),read=f.add('plan-read',{text:'/计划 task-1'}),confirm=f.add('version-approve',{text:'/批准 task-1 1'});
 const request={pluginId:'qq',eventRef:confirm.eventRef,taskId:'task-1',planVersion:1};
 await assert.rejects(f.authority.approveVersion(request),{code:'BUDDY_PLAN_STALE'});
 await f.authority.readWork({pluginId:'qq',eventRef:read.eventRef,taskId:'task-1'});
 await f.authority.approveVersion(request);await f.authority.approveVersion(request);assert.equal(f.calls(),1);
 const group=f.add('group-version',{text:'/批准 task-1 1',channel:'qq-group'});
 await assert.rejects(f.authority.approveVersion({...request,eventRef:group.eventRef}),{code:'BUDDY_OWNER_DENIED'});
});
test('version commands cannot approve a plan changed after the owner read it',async t=>{
 const f=await fixture(t);await f.authority.readWork({pluginId:'qq',eventRef:f.add('view').eventRef,taskId:'task-1'});f.revision();
 await assert.rejects(f.authority.approveVersion({pluginId:'qq',eventRef:f.add('confirm',{text:'/批准 task-1 1'}).eventRef,taskId:'task-1',planVersion:1}),{code:'BUDDY_PLAN_STALE'});assert.equal(f.calls(),0);
});
