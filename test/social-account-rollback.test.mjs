import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {openCompanionStore} from '../src/companion-store.mjs';
import {createCompanionMemory,appendSocialExperience,socialMemoryScope,socialExperienceHash,socialIdentityHash} from '../src/companion-memory.mjs';
import {fixtureReceiptHash,fixtureReceiptResolver,rememberFixtureReceipt} from './support/social-receipt-fixture.mjs';

const at=Date.parse('2026-10-31T12:00:00Z');
const scope={characterId:'a',lifeId:'la',operationId:'oa',personaId:'p',channel:'qq-group',conversationId:'same-group',accountBindingId:'account-A',actorId:'member-A'};
const initial=()=>({cards:{a:{id:'a',name:'A',fields:{},defaults:{},revision:1}},personas:{p:{id:'p'}},activePersonaId:'p',memorySettings:{timeZone:'UTC'},lives:{a:{id:'la',operationId:'oa',mode:'normal',memory:{},growth:{},groupIntervals:{},personalEvents:[]}},groups:{},conversations:{}});
const source=(id,accountBindingId='account-A')=>({id,eventRef:'ref-'+id,scope:{...scope,accountBindingId},sourceHash:fixtureReceiptHash({id,accountBindingId}),sourceKind:'qq-inbound',sourcePluginId:'qq',sourceVersion:1,createdAt:at,text:'secret-'+id,stage:'understood',understandingState:'understood',presentationState:'not-presented',deliveryState:'not-sent',visibilityScope:'conversation',evidenceRefs:['receipt-'+id],participants:['a']});
const append=(store,row)=>{rememberFixtureReceipt(store.fixtureReceipts,row);return appendSocialExperience(store,{eventRef:row.eventRef,scope:row.scope},{verifyEvent:async()=>row});};
const engine=(store,create=createCompanionMemory)=>create({store,resolveLegacySocialIdentity:fixtureReceiptResolver(store.fixtureReceipts),now:()=>at,autoStart:false,getCapacity:()=>({tokens:64000,verified:true}),runModel:async()=>{throw Error('unexpected model request');}});

test('changing account, actor or identity digest cannot retain trusted identity with an unchanged v1 original hash',async()=>{
 for(const field of ['accountBindingId','actorId','identityHash']){
  let state=initial();const store={fixtureReceipts:new Map(),get state(){return state;},snapshot:()=>structuredClone(state),async mutate(fn){const next=structuredClone(state),result=await fn(next);state=next;return result;}};await append(store,source('A'));const originalHash=store.state.lives.a.socialExperiences[0].sourceHash;
  await store.mutate(next=>{next.lives.a.socialExperiences[0][field]='changed';});assert.equal(socialExperienceHash(store.state.lives.a.socialExperiences[0]),originalHash);
  const memory=engine(store),context=await memory.context({characterId:'a',personaId:'p',socialContext:scope,query:'继续'});assert.doesNotMatch(JSON.stringify(context),/secret-A/);assert.equal((await memory.view({characterId:'a',personaId:'p'})).pendingAttributionTotal,1);assert.equal(store.state.lives.a.socialExperiences[0].text,'secret-A');await memory.close();
 }
});
