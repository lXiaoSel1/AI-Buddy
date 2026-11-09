import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVoiceBatch} from '../src/voice/batch-voices.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';
import {createVoiceCredentials} from '../src/voice/credentials.mjs';
import {createCloudVoiceGateway} from '../src/voice/cloud-host.mjs';

async function batchFixture(){
 const dataRoot=await mkdtemp(join(tmpdir(),'audit213-cloud-'));let at=1700000000000,binding=null,clones=0;const active=new Set();
 const request={characterId:'fixture',engine:'breeze',packageId:'ai-buddy.voice-breeze',profileId:'fixture-profile',profileVersion:1};
 const ctx={request,connection:{accountScope:'a'.repeat(64),provider:'minimax',model:'speech-2.8-turbo',keyRef:'fixture-key'},profile:{cloudReference:{sha256:'b'.repeat(64),language:'zh'}}};
 const provider={async upload(){return {fileId:1};},async clone(_ctx,{voiceId}){clones++;return {voiceId};},async activate(_ctx,{voiceId}){active.add(voiceId);return {voiceId};},async voices(){return [...active];}};
 const batch=createVoiceBatch({dataRoot,now:()=>at,resolveContext:async()=>ctx,readReference:async()=>({bytes:Buffer.from('fixture'),reference:{text:'Fixture'}}),findBinding:async()=>binding,saveBinding:async(_ctx,row)=>{binding=row;},provider});
 return {batch,request,dataRoot,provider,get clones(){return clones;},advance:ms=>at+=ms};
}
test('C13: confirmed expired voice has a priced new-clone plan and creates a new id while preserving the old receipt',async()=>{
 const f=await batchFixture(),before=await f.batch.prepare([f.request],{consentUpload:true});assert.equal(before.results[0].status,'prepared-awaiting-activation');const oldId=before.results[0].voiceId;f.advance(8*86400000);
 const preview=await f.batch.preview([f.request],['fixture']);assert.equal(preview.actions[0].action,'new-clone');assert.equal(preview.pricing.cloneEstimate,9.9);
 const renewed=await f.batch.prepare([f.request],{consentUpload:true,consentActivation:true});assert.notEqual(renewed.results[0].voiceId,oldId);assert.equal(f.clones,2);
 const receipts=JSON.parse(await readFile(join(f.dataRoot,'voice/cloud/preparation.json'),'utf8')),row=Object.values(receipts.rows)[0],archived=JSON.parse(await readFile(join(f.dataRoot,'voice/cloud/preparation-archive',row.previousAttemptRef),'utf8'));assert.equal(archived.voiceId,oldId);assert.equal(archived.status,'expired');
});
test('C13: unknown submitted clone remains blocked and a missing remote voice does not authorize another clone',async()=>{
 const f=await batchFixture();let submitted=0;f.provider.clone=async()=>{submitted++;throw Object.assign(Error('Fixture uncertain response'),{code:'CLOUD_NETWORK'});};
 await f.batch.prepare([f.request],{consentUpload:true});f.advance(8*86400000);await f.batch.reconcile(f.request);
 const plan=await f.batch.preview([f.request],['fixture']);assert.equal(plan.actions[0].action,'blocked-unknown');await f.batch.prepare([f.request],{consentUpload:true,consentActivation:true});assert.equal(submitted,1);
});
test('C13: uncertain replacement does not fall back to the retired binding or submit another clone',async()=>{
 const f=await batchFixture();await f.batch.prepare([f.request],{consentUpload:true});f.advance(8*86400000);let submitted=0;f.provider.clone=async()=>{submitted++;throw Object.assign(Error('Fixture uncertain renewal'),{code:'CLOUD_NETWORK'});};
 const result=await f.batch.prepare([f.request],{consentUpload:true,consentActivation:true});assert.equal(result.results[0].status,'unknown');
 const status=await f.batch.status([f.request]);assert.equal(status.results[0].status,'unknown');assert.equal((await f.batch.preview([f.request],['fixture'])).blockedCount,1);
 await f.batch.prepare([f.request],{consentUpload:true,consentActivation:true});assert.equal(submitted,1);
});
async function gatewayFixture(language='zh-CN'){
 const dataRoot=await mkdtemp(join(tmpdir(),'audit213-cloud-settings-')),settings=createVoiceSettings({dataRoot});
 const credentials=createVoiceCredentials({dataRoot,crypto:{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()}});
 const gateway=createCloudVoiceGateway({settings,credentials,getLocale:()=>language,profiles:{},cloud:{},getGame:()=>null,resolvePackage:async()=>({})});return {dataRoot,settings,credentials,gateway};
}
test('C15: replacing and removing a connection deletes only encrypted keys with no remaining configuration reference',async()=>{
 const f=await gatewayFixture();await f.gateway.action('cloud-connection-save',{name:'Fixture',key:'fixture-old-key'});let list=await f.settings.listConnections();const id=list.items[0].id,old=list.items[0].credentialRef;
 await f.settings.saveConnection({name:'Shared fixture',provider:'minimax',model:'speech-2.8-turbo',credentialRef:old});
 await f.gateway.action('cloud-connection-save',{id,key:'fixture-new-key'});assert.equal(await f.credentials.resolve(old),'fixture-old-key');
 const shared=(await f.settings.listConnections()).items.find(row=>row.id!==id);await f.gateway.action('cloud-connection-remove',{id:shared.id});await assert.rejects(f.credentials.resolve(old),{code:'VOICE_CREDENTIAL_MISSING'});
 const current=(await f.settings.listConnections()).items[0].credentialRef;await f.gateway.action('cloud-connection-remove',{id});await assert.rejects(f.credentials.resolve(current),{code:'VOICE_CREDENTIAL_MISSING'});
});
test('B6: new English cloud connection selects international region; existing domestic configuration cannot reuse a key across regions',async()=>{
 const f=await gatewayFixture('en');await f.gateway.action('cloud-connection-save',{name:'Global fixture',key:'fixture-global-key'});assert.equal((await f.settings.listConnections()).items[0].provider,'minimax-global');
 await f.gateway.action('cloud-connection-save',{name:'Domestic fixture',provider:'minimax',key:'fixture-domestic-key'});const domestic=(await f.settings.listConnections()).items.find(row=>row.provider==='minimax');
 await f.gateway.action('cloud-connection-save',{id:domestic.id,name:'Still domestic'});assert.equal((await f.settings.listConnections()).items.find(row=>row.id===domestic.id).provider,'minimax');
 await assert.rejects(f.gateway.action('cloud-connection-save',{id:domestic.id,provider:'minimax-global'}),{code:'CLOUD_REGION_KEY_REQUIRED'});
 await f.gateway.action('cloud-connection-save',{id:domestic.id,provider:'minimax-global',key:'fixture-new-global-key'});assert.equal((await f.settings.listConnections()).items.find(row=>row.id===domestic.id).provider,'minimax-global');
});
test('C15: cleanup failure reports the pending removal and retains the encrypted recovery record',async()=>{
 const f=await gatewayFixture();await f.gateway.action('cloud-connection-save',{name:'Fixture',key:'fixture-recovery-key'});const row=(await f.settings.listConnections()).items[0];
 f.credentials.removeIfUnused=async()=>{throw Object.assign(Error('Fixture credential-store write failure'),{code:'VOICE_CREDENTIAL_CLEANUP_PENDING'});};
 const result=await f.gateway.action('cloud-connection-remove',{id:row.id});assert.equal(result.warningCode,'VOICE_CREDENTIAL_CLEANUP_PENDING');assert.equal((await f.settings.listConnections()).items.length,0);assert.equal(await f.credentials.resolve(row.credentialRef),'fixture-recovery-key');
});
