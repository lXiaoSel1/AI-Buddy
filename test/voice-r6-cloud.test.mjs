import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCloudVoiceGateway} from '../src/voice/cloud-host.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';
import {createVoiceCredentials} from '../src/voice/credentials.mjs';
import {createVoiceProfiles} from '../src/voice/voice-profiles.mjs';
import {createVoiceCloud} from '../src/voice/cloud.mjs';
import {fixtureVoiceWav} from './support/voice-wav.mjs';

const packageIds={breeze:'ai-buddy.voice-breeze',gpt:'ai-buddy.voice-gpt-sovits'};

async function fixture(t,{roles=2,provider={},separateReferences=false,noCloudReference=false,referenceMs=10000,makeReference=fixtureVoiceWav,beforeResolveProfile,transport}={}){
  const dataRoot=await mkdtemp(join(tmpdir(),'voice-r6-cloud-'));
  const settings=createVoiceSettings({dataRoot}),profiles=createVoiceProfiles({dataRoot});
  const credentials=createVoiceCredentials({dataRoot,crypto:{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:bytes=>bytes.toString()}});
  const reference=makeReference(referenceMs);
  const path=join(dataRoot,'reference.wav');await writeFile(path,reference);
  const alternate=join(dataRoot,'alternate.wav');const other=Buffer.from(reference);other[100]=1;await writeFile(alternate,other);
  const characters=Array.from({length:roles},(_,i)=>({id:'role'+i,name:'角色'+i}));
  for(const character of characters)for(const engine of ['breeze','gpt']){
    const file=separateReferences&&engine==='gpt'?alternate:path;
    await profiles.importProfile({characterId:character.id,engine,label:'受信参考',references:{calm:{file,text:'这是完整参考。',language:'zh'}},cloudReference:{file,text:'这是完整参考。',language:'zh'}});
  }
  let generation=0;
  const game={viewState:()=>({characters,activePersonaId:'persona'}),pluginScope:(characterId,personaId)=>({characterId,personaId,lifeId:'life',operationId:'op',contextRevision:'revision'})};
  const calls=[],active=new Set(),tasks=new Set();
  const batchProvider={async upload(ctx){calls.push(['upload',ctx.request.characterId,ctx.request.engine]);return {fileId:1};},
    async clone(ctx,{voiceId}){calls.push(['clone',ctx.request.characterId,ctx.request.engine]);return {voiceId};},
    async activate(ctx,{voiceId}){calls.push(['activate',ctx.request.characterId,ctx.request.engine]);active.add(voiceId);return {voiceId};},
    async voices(){calls.push(['voices']);return [...active];},...provider};
  const build=()=>createVoiceCloud({dataRoot,resolveConnection:args=>settings.resolveConnection(args),resolveSecret:ref=>credentials.resolve(ref),resolveProfile:async params=>{await beforeResolveProfile?.(params);const profile=await profiles.resolve(params);return noCloudReference?{...profile,cloudReference:undefined}:profile;},batchProvider,
    resolveRuntime:async()=>({}),transport});
  let cloud=build();
  const makeGateway=()=>createCloudVoiceGateway({settings,profiles,credentials,cloud,getGame:()=>game,
    listPackages:()=>Object.values(packageIds).map(id=>({id,installed:true})),resolvePackage:async()=>({assertCurrent(){}}),assertOpen:()=>generation,
    async stopAll(){generation++;await cloud.stopEngine();},track(task){tasks.add(task);void task.finally(()=>tasks.delete(task)).catch(()=>{});return task;}});
  let gateway=makeGateway();
  t.after(async()=>{await cloud.close();await Promise.allSettled(tasks);await rm(dataRoot,{recursive:true,force:true});});
  await gateway.action('cloud-connection-save',{name:'云',key:'synthetic-r6-key'});
  return {get gateway(){return gateway;},get cloud(){return cloud;},profiles,settings,dataRoot,calls,characters,
    async scope(characterId,engine='breeze'){const profile=await profiles.current({characterId,engine});return {characterId,engine,packageId:packageIds[engine],profileId:profile.id,profileVersion:profile.version};},
    async preview(selectedCharacterIds){return gateway.action('cloud-batch-preview',selectedCharacterIds===undefined?{}:{selectedCharacterIds});},
    async prepare(selectedCharacterIds){const value=await this.preview(selectedCharacterIds);return gateway.action('cloud-batch-prepare',{selectedCharacterIds,planHash:value.plan.planHash,consentUpload:true,consentActivation:true});},
    async reopen(){await cloud.close();cloud=build();gateway=makeGateway();}};
}

test('r6 preview starts with no selected roles and preparation requires a nonempty trusted selection',async t=>{
  const f=await fixture(t,{roles:3});
  const empty=await f.preview();
  assert.equal(empty.total,3);assert.equal(empty.plan.selectedCount,0);assert.equal(empty.plan.cloneCount,0);assert.equal(empty.plan.pricing.cloneEstimate,0);
  assert.deepEqual(empty.plan.selectedCharacterIds,[]);assert.equal(f.calls.length,0);
  for(const selectedCharacterIds of [undefined,[],['role0','role0'],['forged']]){
    await assert.rejects(f.gateway.action('cloud-batch-prepare',{...(selectedCharacterIds===undefined?{}:{selectedCharacterIds}),planHash:empty.plan.planHash,consentUpload:true,consentActivation:true}),{code:'CLOUD_SELECTION_REQUIRED'});
  }
  assert.equal(f.calls.length,0);
});

test('r6 cloud clone preview blocks a 9.999-second local reference before consent or cost',async t=>{
  const f=await fixture(t,{roles:1,referenceMs:9999});
  const local=await f.profiles.resolve(await f.scope('role0'));
  assert.equal(local.durationMs,9999);
  const preview=await f.preview(['role0']);
  assert.equal(preview.plan.blockedCount,1);
  assert.equal(preview.plan.cloneCount,0);
  assert.equal(preview.plan.activationCount,0);
  assert.equal(preview.plan.pricing.cloneEstimate,0);
  assert.deepEqual(preview.plan.actions.map(row=>[row.action,row.code]),[['blocked-reference','CLOUD_REFERENCE_TOO_SHORT']]);
  const rejected=await f.cloud.prepareBatch({profiles:[await f.scope('role0')],consentUpload:true,consentActivation:true});
  assert.equal(rejected.results[0].code,'CLOUD_REFERENCE_TOO_SHORT');
  await assert.rejects(f.prepare(['role0']),{code:'CLOUD_REFERENCE_TOO_SHORT'});
  assert.deepEqual(f.calls,[]);
});

test('r6 cloud clone rejects ambiguous WAV headers before estimating or uploading',async t=>{
  const invalidHeaders={
    'truncated RIFF extent'(bytes){bytes.writeUInt32LE(32036,4);return bytes;},
    'duplicate format'(bytes){return Buffer.concat([bytes.subarray(0,36),bytes.subarray(12,36),bytes.subarray(36)]);},
    'duplicate audio data'(bytes){return Buffer.concat([fixtureVoiceWav(1000),bytes.subarray(36)]);},
  };
  for(const [name,alter] of Object.entries(invalidHeaders))await t.test(name,async t=>{
    const f=await fixture(t,{roles:1,makeReference(ms){
      const bytes=fixtureVoiceWav(ms),malformed=alter(bytes);
      if(malformed!==bytes)malformed.writeUInt32LE(malformed.length-8,4);
      return malformed;
    }});
    const plan=(await f.preview(['role0'])).plan;
    assert.equal(plan.cloneCount,0);
    assert.deepEqual(plan.actions.map(row=>[row.action,row.code]),[['blocked-reference','CLOUD_REFERENCE']]);
    await assert.rejects(f.prepare(['role0']),{code:'CLOUD_REFERENCE'});
    assert.deepEqual(f.calls,[]);
  });
});
test('r6 exactly 10 seconds qualifies for the deduplicated quote and uploads the approved WAV',async t=>{
  let uploaded;
  const f=await fixture(t,{roles:3,provider:{async upload(_ctx,bytes){uploaded=bytes;return {fileId:1};}}});
  const preview=await f.preview(['role1']);
  assert.equal(preview.plan.selectedCount,1);assert.equal(preview.plan.cloneCount,1);assert.equal(preview.plan.activationCount,1);assert.equal(preview.plan.reuseCount,0);assert.equal(preview.plan.blockedCount,0);
  assert.equal(preview.plan.pricing.currency,'CNY');assert.equal(preview.plan.pricing.cloneUnitPrice,9.9);assert.equal(preview.plan.pricing.cloneEstimate,9.9);
  assert.equal(preview.plan.pricing.estimateOnly,true);assert.equal(preview.plan.pricing.checkedOn,'2026-11-07');assert.equal(preview.plan.pricing.sourceUrl,'https://platform.minimax.cn/docs/pricing/overview');
  assert.equal(preview.plan.actions.filter(row=>row.action==='new-clone').length,1);
  const result=await f.gateway.action('cloud-batch-prepare',{selectedCharacterIds:['role1'],planHash:preview.plan.planHash,consentUpload:true,consentActivation:true});
  assert.equal(result.results.every(row=>row.characterId==='role1'),true);
  assert.deepEqual(uploaded,fixtureVoiceWav(10000));
  assert.equal(f.calls.filter(row=>row[0]==='clone').length,1);assert.equal(f.calls.filter(row=>row[0]==='activate').length,1);
  assert.equal(f.calls.filter(row=>row[0]==='clone').every(row=>row[1]==='role1'),true);
});

test('r6 explicit provider 1008 rejection stops the entire batch and remains failed after refresh and restart',async t=>{
  let clones=0;
  const f=await fixture(t,{roles:3,provider:{async clone(){clones++;throw Object.assign(Error('余额不足'),{code:'CLOUD_REMOTE_1008'});}}});
  const result=await f.prepare(['role0','role1','role2']);
  assert.equal(clones,1);assert.equal(result.results[0].status,'failed');assert.equal(result.results[0].code,'CLOUD_REMOTE_1008');
  assert.equal(result.results[0].outcome,'rejected');assert.equal(f.calls.filter(row=>row[0]==='upload').length,1);
  const receipt=JSON.parse(await readFile(join(f.dataRoot,'voice','cloud','preparation.json'),'utf8'));
  assert.equal(Object.keys(receipt.rows).length,1);
  await f.reopen();
  const refreshed=await f.preview(['role0']);assert.equal(refreshed.items.find(row=>row.characterId==='role0').status,'failed');
  assert.equal(refreshed.plan.cloneCount,1);assert.equal(clones,1);
});

test('r6 lost clone response stays unknown and explicit preparation cannot silently resend it',async t=>{
  let clones=0;
  const f=await fixture(t,{roles:1,provider:{async clone(){clones++;throw Object.assign(Error('response lost'),{code:'CLOUD_CONNECTION'});}}});
  const result=await f.prepare(['role0']);assert.equal(result.results[0].status,'unknown');assert.equal(clones,1);
  await f.reopen();
  const preview=await f.preview(['role0']);assert.equal(preview.plan.blockedCount,1);assert.equal(preview.plan.cloneCount,0);
  assert.equal(preview.items[0].status,'unknown');
  await f.prepare(['role0']);assert.equal(clones,1);
});

test('r6 a selected role with two different references is quoted and cloned twice',async t=>{
  const f=await fixture(t,{roles:2,separateReferences:true});
  const preview=await f.preview(['role0']);assert.equal(preview.plan.selectedCount,1);assert.equal(preview.plan.cloneCount,2);assert.equal(preview.plan.activationCount,2);
  assert.equal(preview.plan.pricing.cloneEstimate,19.8);
  await f.prepare(['role0']);assert.equal(f.calls.filter(row=>row[0]==='clone').length,2);
  assert.equal(f.calls.filter(row=>row[0]==='clone').every(row=>row[1]==='role0'),true);
});

const catalogTransport=voices=>async(assets,request,{signal})=>({events:(async function*(){signal.throwIfAborted();assert.equal(request.op,'voices');yield {type:'result',voices};})(),closed:Promise.resolve(),cancel:async()=>{}});

test('r6 server catalog system voices retain real names, share across roles and remain existing bindings during prepare',async t=>{
  const f=await fixture(t,{roles:2,referenceMs:9999,transport:catalogTransport([{voice_id:'official-system',voice_name:'真实官方名称',category:'system_voice'},{voice_id:'private-clone',voice_name:'我的音色',category:'voice_cloning'}])});
  const catalog=await f.cloud.listVoices(await f.scope('role0'));
  assert.deepEqual(catalog[0],{voiceId:'official-system',name:'真实官方名称',category:'system_voice'});
  for(const characterId of ['role0','role1'])for(const engine of ['breeze','gpt']){
    const binding=await f.cloud.bindVoice({...await f.scope(characterId,engine),voiceId:'official-system',category:'voice_cloning'});
    assert.equal(binding.category,'system_voice');assert.equal(binding.provenance,'catalog-system-voice');
  }
  const preview=await f.preview(['role0','role1']);assert.equal(preview.plan.cloneCount,0);assert.equal(preview.plan.activationCount,0);assert.equal(preview.plan.reuseCount,2);
  await f.prepare(['role0','role1']);assert.equal(f.calls.length,0);
  for(const characterId of ['role0','role1'])assert.equal((await f.cloud.status(await f.scope(characterId))).voiceId,'official-system');
});

test('r6 changing the WAV bytes after the fee preview invalidates consent before any provider call',async t=>{
  const f=await fixture(t,{roles:1});
  const selection=['role0'];
  const preview=await f.preview(selection);
  const {cloudReference}=await f.profiles.resolve(await f.scope('role0'));
  const bytes=await readFile(cloudReference.path);
  bytes[44]=1;
  await writeFile(cloudReference.path,bytes);
  await assert.rejects(f.gateway.action('cloud-batch-prepare',{selectedCharacterIds:selection,planHash:preview.plan.planHash,consentUpload:true,consentActivation:true}),{code:'CLOUD_PLAN_CHANGED'});
  assert.deepEqual(f.calls,[]);
});

test('r6 a binding or model change invalidates the confirmed fee plan before any upload',async t=>{
  const f=await fixture(t,{roles:1,transport:catalogTransport([{voice_id:'official-system',category:'system_voice'}])});
  const before=await f.preview(['role0']);
  await f.cloud.bindVoice({...await f.scope('role0'),voiceId:'official-system'});
  await assert.rejects(f.gateway.action('cloud-batch-prepare',{selectedCharacterIds:['role0'],planHash:before.plan.planHash,consentUpload:true,consentActivation:true}),{code:'CLOUD_PLAN_CHANGED'});
  const next=await f.preview(['role0']),connections=await f.settings.listConnections();
  await f.settings.saveConnection({...connections.items[0],model:'speech-2.8-hd'});
  await assert.rejects(f.gateway.action('cloud-batch-prepare',{selectedCharacterIds:['role0'],planHash:next.plan.planHash,consentUpload:true,consentActivation:true}),{code:'CLOUD_PLAN_CHANGED'});
  assert.equal(f.calls.length,0);
});

test('r6 an old explicitly rejected clone cannot overwrite the later selected system voice',async t=>{
  let reject=true,clones=0;
  const f=await fixture(t,{roles:1,provider:{async clone(ctx,{voiceId}){clones++;if(reject)throw Object.assign(Error('余额不足'),{code:'CLOUD_REMOTE_1008'});return {voiceId};}},
    transport:catalogTransport([{voice_id:'official-system',category:'system_voice'}])});
  await f.prepare(['role0']);assert.equal(clones,1);reject=false;
  for(const engine of ['breeze','gpt'])await f.cloud.bindVoice({...await f.scope('role0',engine),voiceId:'official-system'});
  await f.reopen();
  const preview=await f.preview(['role0']);assert.equal(preview.plan.cloneCount,0);assert.equal(preview.plan.reuseCount,1);
  await f.prepare(['role0']);assert.equal(clones,1);
  assert.equal((await f.cloud.status(await f.scope('role0'))).voiceId,'official-system');
  const state=JSON.parse(await readFile(join(f.dataRoot,'voice','cloud','bindings.json'),'utf8'));
  assert.equal(Object.values(Object.values(state.scopes)[0]).every(row=>row.voiceId==='official-system'&&row.provenance==='catalog-system-voice'),true);
});

test('r6 an explicit retry after historical 1008 preserves the upload receipt and refresh never retries',async t=>{
  let reject=true,clones=0;
  const f=await fixture(t,{roles:1,provider:{async clone(ctx,{voiceId}){clones++;if(reject)throw Object.assign(Error('余额不足'),{code:'CLOUD_REMOTE_1008'});return {voiceId};}}});
  await f.prepare(['role0']);
  const path=join(f.dataRoot,'voice','cloud','preparation.json'),state=JSON.parse(await readFile(path,'utf8'));
  const row=Object.values(state.rows)[0];row.status='unknown';delete row.outcome;await writeFile(path,JSON.stringify(state));
  await f.reopen();
  const preview=await f.preview(['role0']);assert.equal(preview.items[0].status,'failed');assert.equal(preview.items[0].outcome,'rejected');assert.equal(clones,1);
  reject=false;await f.prepare(['role0']);assert.equal(clones,2);assert.equal(f.calls.filter(row=>row[0]==='upload').length,1);
});

test('r6 a catalog custom clone remains independent even when a renderer claims it is system',async t=>{
  const f=await fixture(t,{roles:2,transport:catalogTransport([{voice_id:'private-clone',category:'voice_cloning'}])});
  await f.cloud.bindVoice({...await f.scope('role0'),voiceId:'private-clone'});
  await assert.rejects(f.cloud.bindVoice({...await f.scope('role1'),voiceId:'private-clone',category:'system_voice'}),{code:'CLOUD_VOICE_SCOPE'});
});

test('r6 repeated local previews do not rewrite an already classified rejection receipt',async t=>{
  const f=await fixture(t,{roles:1,provider:{async clone(){throw Object.assign(Error('余额不足'),{code:'CLOUD_REMOTE_1008'});}}});
  await f.prepare(['role0']);await f.preview(['role0']);
  const path=join(f.dataRoot,'voice','cloud','preparation.json'),before=await stat(path,{bigint:true});
  await f.preview(['role0']);await f.preview(['role0']);
  const after=await stat(path,{bigint:true});assert.equal(after.mtimeNs,before.mtimeNs);assert.equal(after.size,before.size);
});

test('r6 an existing unactivated clone still includes the first-use voice fee in the estimate',async t=>{
  const f=await fixture(t,{roles:1});
  await f.cloud.prepareBatch({profiles:[await f.scope('role0'),await f.scope('role0','gpt')],consentUpload:true,consentActivation:false});
  const preview=await f.preview(['role0']);assert.equal(preview.plan.cloneCount,0);assert.equal(preview.plan.activationCount,1);
  assert.equal(preview.plan.firstUseCount,1);assert.equal(preview.plan.pricing.cloneEstimate,9.9);
  await f.prepare(['role0']);const ready=await f.preview(['role0']);assert.equal(ready.plan.firstUseCount,0);assert.equal(ready.plan.pricing.cloneEstimate,0);
});

test('r6 an existing catalog system binding does not require a cloud cloning reference',async t=>{
  const f=await fixture(t,{roles:1,noCloudReference:true,transport:catalogTransport([{voice_id:'official-system',category:'system_voice'}])});
  for(const engine of ['breeze','gpt'])await f.cloud.bindVoice({...await f.scope('role0',engine),voiceId:'official-system'});
  const preview=await f.preview(['role0']);assert.equal(preview.items[0].status,'activated');assert.equal(preview.plan.reuseCount,1);assert.equal(preview.plan.blockedCount,0);
  assert.equal(preview.plan.pricing.cloneEstimate,0);
  const prepared=await f.prepare(['role0']);assert.equal(prepared.items[0].status,'activated');assert.equal(f.calls.length,0);
});

test('r6 preparing selected roles keeps the existing status of unselected roles',async t=>{
  const f=await fixture(t,{roles:2});await f.prepare(['role0']);
  const result=await f.prepare(['role1']);
  assert.equal(result.items.find(row=>row.characterId==='role0').status,'activated');
  assert.equal(result.items.find(row=>row.characterId==='role1').status,'activated');assert.equal(result.completed,2);
  assert.equal(result.results.every(row=>row.characterId==='role1'),true);assert.equal(f.calls.filter(row=>row[0]==='clone').length,2);
});

test('r6 review a catalog-confirmed system voice can share a legacy binding without stored category',async t=>{
  const f=await fixture(t,{roles:2,transport:catalogTransport([{voice_id:'official-system',category:'system_voice'}])});
  await f.cloud.bindVoice({...await f.scope('role0'),voiceId:'official-system'});
  const path=join(f.dataRoot,'voice','cloud','bindings.json'),state=JSON.parse(await readFile(path,'utf8'));
  for(const row of Object.values(Object.values(state.scopes)[0])){delete row.category;row.provenance='account-voice-pending-audition';}
  await writeFile(path,JSON.stringify(state));await f.reopen();
  await f.cloud.bindVoice({...await f.scope('role1'),voiceId:'official-system'});
  assert.equal((await f.cloud.status(await f.scope('role0'))).state,'ready');
  assert.equal((await f.cloud.status(await f.scope('role1'))).state,'ready');
  assert.equal(f.calls.length,0);
});

const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};

test('r6 review a slow status migration cannot erase a newer unknown preparation receipt',async t=>{
  const started=gate(),release=gate();let pause=false;
  const f=await fixture(t,{roles:2,beforeResolveProfile:async()=>{if(pause){pause=false;started.resolve();await release.promise;}},
    provider:{async clone(ctx){throw Object.assign(Error('controlled refusal or lost response'),{code:ctx.request.characterId==='role0'?'CLOUD_REMOTE_1008':'CLOUD_CONNECTION'});}}});
  await f.cloud.prepareBatch({profiles:[await f.scope('role0')],consentUpload:true,consentActivation:true});
  const path=join(f.dataRoot,'voice','cloud','preparation.json'),state=JSON.parse(await readFile(path,'utf8'));
  const historical=Object.values(state.rows)[0];historical.status='unknown';delete historical.outcome;await writeFile(path,JSON.stringify(state));
  const first=await f.scope('role0'),second=await f.scope('role1');pause=true;
  const inspecting=f.cloud.batchStatus({profiles:[first]});
  try{
    await started.promise;
    const prepared=await f.cloud.prepareBatch({profiles:[second],consentUpload:true,consentActivation:true});assert.equal(prepared.items[0].status,'unknown');
  }finally{release.resolve();}
  await inspecting;
  assert.equal((await f.cloud.batchStatus({profiles:[second]})).items[0].status,'unknown');
});

test('r6 review a legacy preflight account refusal stops before remaining roles can clone',async t=>{
  let queries=0;
  const f=await fixture(t,{roles:2,provider:{async voices(){queries++;throw Object.assign(Error('余额不足'),{code:'CLOUD_REMOTE_1008'});}}});
  const first=await f.scope('role0');await f.cloud.prepareBatch({profiles:[first],consentUpload:true,consentActivation:false});
  const path=join(f.dataRoot,'voice','cloud','preparation.json'),state=JSON.parse(await readFile(path,'utf8'));state.rows={};await writeFile(path,JSON.stringify(state));
  await f.reopen();const previousClones=f.calls.filter(row=>row[0]==='clone').length;
  const result=await f.prepare(['role0','role1']);
  assert.equal(result.results[0].code,'CLOUD_REMOTE_1008');assert.equal(queries,1);
  assert.equal(f.calls.filter(row=>row[0]==='clone').length,previousClones);
  assert.equal(result.items.find(row=>row.characterId==='role0').status,'failed');
  assert.equal(result.items.find(row=>row.characterId==='role0').code,'CLOUD_REMOTE_1008');
  assert.equal(result.items.find(row=>row.characterId==='role1').status,'not-prepared');
});
