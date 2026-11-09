import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCloudVoiceGateway} from '../src/voice/cloud-host.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';
import {createVoiceCredentials} from '../src/voice/credentials.mjs';
import {createVoiceProfiles} from '../src/voice/voice-profiles.mjs';
import {createVoiceCloud} from '../src/voice/cloud.mjs';

const packageId='ai-buddy.voice-breeze';
async function fixture(t,{roles=2,provider={},missing=[]}={}){
  const dataRoot=await mkdtemp(join(tmpdir(),'voice-r5-gateway-'));
  const settings=createVoiceSettings({dataRoot}),profiles=createVoiceProfiles({dataRoot});
  const credentials=createVoiceCredentials({dataRoot,crypto:{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:bytes=>bytes.toString()}});
  const reference=Buffer.alloc(320044);reference.write('RIFF');reference.writeUInt32LE(reference.length-8,4);reference.write('WAVEfmt ',8);reference.writeUInt32LE(16,16);
  reference.writeUInt16LE(1,20);reference.writeUInt16LE(1,22);reference.writeUInt32LE(16000,24);reference.writeUInt32LE(32000,28);reference.writeUInt16LE(2,32);reference.writeUInt16LE(16,34);reference.write('data',36);reference.writeUInt32LE(320000,40);
  const path=join(dataRoot,'reference.wav');await writeFile(path,reference);
  const characters=Array.from({length:roles},(_,i)=>({id:'role'+i,name:'角色'+i})),life=new Map(characters.map(row=>[row.id,1]));
  for(const character of characters)for(const engine of ['breeze','gpt'])if(!missing.includes(character.id+':'+engine))await profiles.importProfile({characterId:character.id,engine,label:'受信参考',
    references:{calm:{file:path,text:'这是完整参考。',language:'zh'}},cloudReference:{file:path,text:'这是完整参考。',language:'zh'}});
  let selected=characters[0].id,persona='persona',generation=0,clones=0;
  const game={viewState:()=>({characters,activePersonaId:persona}),pluginScope:(characterId,personaId)=>({characterId,personaId,lifeId:'life'+life.get(characterId),operationId:'op'+life.get(characterId),contextRevision:'revision'}),
    voiceScope:()=>({characterId:selected,personaId:persona})};
  const active=new Set(),cloud=createVoiceCloud({dataRoot,resolveConnection:args=>settings.resolveConnection(args),resolveSecret:ref=>credentials.resolve(ref),resolveProfile:params=>profiles.resolve(params),
    batchProvider:{async upload(){return {fileId:1};},async clone(ctx,{voiceId}){clones++;return {voiceId};},async activate(ctx,{voiceId}){active.add(voiceId);return {voiceId};},async voices(){return [...active];},...provider}});
  const events=[],tasks=new Set();
  const gateway=createCloudVoiceGateway({settings,profiles,credentials,cloud,getGame:()=>game,resolvePackage:async()=>({assertCurrent(){}}),publish:value=>events.push(value),assertOpen:()=>generation,
    async stopAll(){generation++;await cloud.stopEngine();},track(task){tasks.add(task);void task.finally(()=>tasks.delete(task)).catch(()=>{});return task;}});
  t.after(async()=>{await cloud.close();await Promise.allSettled(tasks);await rm(dataRoot,{recursive:true,force:true});});
  return {gateway,settings,cloud,profiles,events,characterIds:characters.map(row=>row.id),clones:()=>clones,switchChat:()=>selected=characters.at(-1).id,changeLife:()=>life.set(characters[0].id,2),changePersona:()=>persona='other'};
}

async function prepare(f){
  const selectedCharacterIds=f.characterIds,preview=await f.gateway.action('cloud-batch-preview',{selectedCharacterIds});
  return f.gateway.action('cloud-batch-prepare',{selectedCharacterIds,planHash:preview.plan.planHash,consentUpload:true,consentActivation:true});
}

test('gateway manages encrypted cloud configurations without exposing credentials or starting remote work',async t=>{
  const f=await fixture(t);
  const saved=await f.gateway.action('cloud-connection-save',{name:'我的云声音',provider:'minimax',model:'speech-2.8-turbo',key:'synthetic-secret-key'});
  const state=await f.gateway.state();assert.equal(state.cloudConnections.items.length,1);assert.equal(state.cloudConnections.items[0].configured,true);
  assert.equal(JSON.stringify(state).includes('synthetic-secret-key'),false);assert.equal(JSON.stringify(state).includes('credentialRef'),false);assert.equal(f.clones(),0);
  await assert.rejects(f.gateway.action('cloud-batch-prepare',{consentUpload:true,consentActivation:true,characterId:'forged'}),{code:'VOICE_SCOPE_FORGED'});
  await assert.rejects(f.gateway.action('cloud-batch-prepare',{consentUpload:true}),{code:'CLOUD_ACTIVATION_CONSENT'});
});

test('trusted roles with missing engine profiles remain visible and cannot make the batch appear complete',async t=>{
  const f=await fixture(t,{roles:3,missing:['role1:breeze','role1:gpt','role2:gpt']});
  await f.gateway.action('cloud-connection-save',{name:'云',key:'synthetic-secret-key'});
  const preview=await f.gateway.action('cloud-batch-preview');assert.equal(preview.total,3);assert.equal(preview.items.length,3);
  assert.equal(preview.items.find(row=>row.characterId==='role1').status,'profile-missing');
  assert.deepEqual(preview.items.find(row=>row.characterId==='role2').missingEngines,['gpt']);
  const prepared=await prepare(f);
  assert.equal(prepared.total,3);assert.equal(prepared.completed,1);assert.equal(prepared.items.length,3);
  assert.equal(prepared.items.find(row=>row.characterId==='role2').status,'profile-incomplete');
});

test('explicit gateway reconciliation repairs lost activation response using queries without clone or activation replay',async t=>{
  let activate=0,queries=0;const activated=new Set();
  const f=await fixture(t,{roles:1,provider:{async activate(ctx,{voiceId}){activate++;activated.add(voiceId);throw Object.assign(Error('lost response'),{code:'CLOUD_CONNECTION'});},
    async voices(){queries++;return [...activated];}}});
  await f.gateway.action('cloud-connection-save',{name:'云',key:'synthetic-secret-key'});
  const prepared=await prepare(f);assert.equal(prepared.items[0].status,'unknown');
  const before={activate,queries,clones:f.clones()};
  await f.gateway.action('cloud-batch-preview');await f.gateway.state();assert.equal(queries,before.queries,'preview and state never query the account');
  assert.equal(f.gateway.handles('cloud-batch-reconcile'),true);
  const reconciled=await f.gateway.action('cloud-batch-reconcile');assert.equal(reconciled.completed,1);assert.equal(reconciled.items[0].status,'activated');
  assert.equal(activate,before.activate);assert.equal(f.clones(),before.clones);assert.ok(queries>before.queries);
});

test('explicit reconciliation confirms the first-query-pending voice without another activation',async t=>{
  let activations=0,queries=0;const activated=new Set();
  const f=await fixture(t,{roles:1,provider:{async activate(ctx,{voiceId}){activations++;activated.add(voiceId);return {voiceId};},
    async voices(){if(++queries===1)throw Object.assign(Error('first query failed'),{code:'CLOUD_CONNECTION'});return [...activated];}}});
  await f.gateway.action('cloud-connection-save',{name:'云',key:'synthetic-secret-key'});
  const first=await prepare(f);assert.equal(first.items[0].status,'activation-confirmed-query-pending');
  const before=f.clones();const checked=await f.gateway.action('cloud-batch-reconcile');assert.equal(checked.items[0].status,'activated');
  assert.equal(activations,1);assert.equal(f.clones(),before);
});

test('explicit reconciliation is cancellable while its account query is pending',async t=>{
  let block=false,queries=0;const started=gate(),activated=new Set();
  const f=await fixture(t,{roles:1,provider:{async activate(ctx,{voiceId}){activated.add(voiceId);return {voiceId};},
    async voices(ctx,{signal}){queries++;if(block){started.resolve();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));signal.throwIfAborted();}return [...activated];}}});
  await f.gateway.action('cloud-connection-save',{name:'云',key:'synthetic-secret-key'});
  await prepare(f);const before=f.clones();block=true;
  const pending=f.gateway.action('cloud-batch-reconcile'),rejected=assert.rejects(pending,{name:'AbortError'});
  await started.promise;const stopped=await f.gateway.action('cloud-batch-cancel');await rejected;
  assert.equal(stopped.state,'cancelled');assert.equal(f.clones(),before);assert.equal(queries,2);
});

const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
test('gateway prepares trusted eleven-role profiles once and switching current chat does not revoke the batch',async t=>{
  const started=gate(),release=gate();let paused=false;
  const f=await fixture(t,{roles:11,provider:{async upload(ctx,bytes,{signal}){if(!paused){paused=true;started.resolve();await release.promise;}signal.throwIfAborted();return {fileId:1};}}});
  await f.gateway.action('cloud-connection-save',{name:'云',key:'synthetic-secret-key'});
  const preview=await f.gateway.action('cloud-batch-preview');assert.equal(preview.total,11);assert.equal(preview.profileCount,22);assert.equal(f.clones(),0);
  const first=prepare(f);
  const second=prepare(f);
  await started.promise;f.switchChat();release.resolve();
  const [a,b]=await Promise.all([first,second]);assert.equal(a.completed,11);assert.equal(b.completed,11);assert.equal(a.items.length,11);assert.equal(f.clones(),11);
  assert.equal((await f.gateway.state()).cloudBatch.running,false);
});

test('gateway life change fences the next cloud submission and retains the uploaded receipt',async t=>{
  const started=gate(),release=gate();
  const f=await fixture(t,{provider:{async upload(){started.resolve();await release.promise;return {fileId:1};}}});
  await f.gateway.action('cloud-connection-save',{name:'云',key:'synthetic-secret-key'});
  const pending=prepare(f);
  const rejected=assert.rejects(pending,{code:'CLOUD_CONFIGURATION_CHANGED'});await started.promise;f.changeLife();release.resolve();await rejected;
  assert.equal(f.clones(),0);assert.equal((await f.gateway.state()).cloudBatch.state,'cancelled');
});

test('gateway cancel aborts the HTTP batch and preserves unknown state without retry',async t=>{
  const started=gate();
  const f=await fixture(t,{provider:{async upload(ctx,bytes,{signal}){started.resolve();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));signal.throwIfAborted();}}});
  await f.gateway.action('cloud-connection-save',{name:'云',key:'synthetic-secret-key'});
  const pending=prepare(f);const rejected=assert.rejects(pending,{name:'AbortError'});
  await started.promise;const cancelled=await f.gateway.action('cloud-batch-cancel');await rejected;
  assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.counts.unknown,1);assert.equal(f.clones(),0);
});
