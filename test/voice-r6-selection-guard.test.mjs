import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVoiceHost} from '../src/voice/host.mjs';
import {createVoiceCloud} from '../src/voice/cloud.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';
import {createVoiceProfiles} from '../src/voice/voice-profiles.mjs';
import {createVoiceCredentials} from '../src/voice/credentials.mjs';

const packageId='ai-buddy.voice-breeze';
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const rejected=(operation,code)=>assert.rejects(operation,error=>{assert.equal(error.code,code);assert.match(error.message,/切换|改变|刷新|过期/);return true;});

// Real host, settings, encrypted-credential store, profiles and cloud binding store.
// Only the OS encryption/voice hardware and external account transport are inert.
async function fixture(t){
  const dataRoot=await mkdtemp(join(tmpdir(),'voice-r6-selection-'));
  const settings=createVoiceSettings({dataRoot}),profiles=createVoiceProfiles({dataRoot});
  const credentials=createVoiceCredentials({dataRoot,crypto:{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:bytes=>bytes.toString()}});
  const reference=Buffer.alloc(320044);reference.write('RIFF');reference.writeUInt32LE(reference.length-8,4);reference.write('WAVEfmt ',8);reference.writeUInt32LE(16,16);
  reference.writeUInt16LE(1,20);reference.writeUInt16LE(1,22);reference.writeUInt32LE(16000,24);reference.writeUInt32LE(32000,28);reference.writeUInt16LE(2,32);reference.writeUInt16LE(16,34);reference.write('data',36);reference.writeUInt32LE(320000,40);
  const path=join(dataRoot,'reference.wav');await writeFile(path,reference);
  const importProfile=(characterId,label='approved')=>profiles.importProfile({characterId,engine:'breeze',label,references:{calm:{file:path,text:'完整参考。',language:'zh'}}});
  const alice=await importProfile('alice'),bob=await importProfile('bob');
  const firstKey=await credentials.save('synthetic-first-account'),secondKey=await credentials.save('synthetic-second-account');
  const first=await settings.saveConnection({name:'First',credentialRef:firstKey.ref}),second=await settings.saveConnection({name:'Second',credentialRef:secondKey.ref});
  await settings.update({enabled:true,selectedPackageId:packageId,packages:{[packageId]:{ttsProvider:'minimax'}}});
  const originalScope={channel:'app-private',characterId:'alice',personaId:'persona',lifeId:'life-alice',operationId:'operation',conversationId:'private'};
  let scope={...originalScope},nextQuery,nextPackage;
  const requests=[],holds=[];
  const cloud=createVoiceCloud({dataRoot,resolveRuntime:async()=>({}),resolveProfile:params=>profiles.resolve(params),resolveConnection:params=>settings.resolveConnection(params),resolveSecret:ref=>credentials.resolve(ref),
    transport:async(_assets,request,{signal})=>{
      requests.push({op:request.op,account:request.key});
      const hold=nextQuery;nextQuery=null;hold?.entered.resolve();
      return {events:(async function*(){if(hold)await hold.release.promise;signal.throwIfAborted();yield {type:'result',voices:[{voice_id:'system-voice',name:'Available system voice',category:'system'}]};})(),closed:Promise.resolve(),async cancel(){hold?.release.resolve();}};
    }});
  const local={async cancelCapture(){},async stopEngine(){},async close(){}};
  const host=createVoiceHost({dataRoot,build:dataRoot,getGame:()=>({voiceScope:()=>({...scope}),voiceCancel(){}}),getPlatform:()=>({
    voicePackageStatus:()=>[{id:packageId,engine:'breeze',installed:true,enabled:true,usable:true,trusted:true}],
    async resolveVoicePackage(){const hold=nextPackage;nextPackage=null;if(hold){hold.entered.resolve();await hold.release.promise;}return {assertCurrent(){}};}}),
    components:{settings,profiles,credentials,cloud,local,assets:{async close(){}},supervisor:{async close(){}}}});
  t.after(async()=>{for(const hold of holds)hold.release.resolve();await host.close();await rm(dataRoot,{recursive:true,force:true});});
  const hold=kind=>{const value={entered:gate(),release:gate()};holds.push(value);if(kind==='query')nextQuery=value;else nextPackage=value;return value;};
  const params=profile=>({engine:'breeze',packageId,characterId:profile.characterId,profileId:profile.id,profileVersion:profile.version});
  return {host,cloud,settings,profiles,alice,bob,first,second,requests,originalScope,importProfile,params,
    expected:()=>({scope:{...originalScope},profileId:alice.id,profileVersion:alice.version,cloudConnectionId:first.id}),
    setScope:patch=>{scope={...originalScope,...patch};},hold,
    async assertUnbound(...rows){for(const profile of rows.length?rows:[alice,bob])assert.equal((await cloud.status(params(profile))).state,'unbound');}};
}

test('stale role, Persona, life and conversation expectations cannot query or bind a different current scope',async t=>{
  const f=await fixture(t);
  for(const patch of [{characterId:'bob',lifeId:'life-bob'},{personaId:'other-persona'},{lifeId:'new-life'},{operationId:'new-operation'},{conversationId:'new-private'},{channel:'app-group'}]){
    f.setScope(patch);
    for(const op of ['cloud-voices','cloud-bind'])await rejected(f.host.action(op,{voiceId:'system-voice',expectedSelection:f.expected()}),'VOICE_SCOPE_CHANGED');
  }
  assert.equal(f.requests.length,0);await f.assertUnbound();
});

test('malformed or incomplete expectations reject locally instead of authorizing their embedded identity',async t=>{
  const f=await fixture(t),expected=f.expected();
  for(const value of [null,[],{}, {...expected,scope:{characterId:'alice'}},{...expected,profileId:''},{...expected,profileVersion:0}]){
    await rejected(f.host.action('cloud-bind',{voiceId:'system-voice',expectedSelection:value}),'VOICE_SCOPE_CHANGED');
  }
  for(const value of [{...expected,cloudConnectionId:''},{scope:expected.scope,profileId:expected.profileId,profileVersion:expected.profileVersion}]){
    await rejected(f.host.action('cloud-voices',{expectedSelection:value}),'CLOUD_CONFIGURATION_CHANGED');
  }
  await assert.rejects(f.host.action('cloud-bind',{characterId:'bob',voiceId:'system-voice',expectedSelection:expected}),{code:'VOICE_SCOPE_FORGED'});
  assert.equal(f.requests.length,0);await f.assertUnbound();
});

test('changed selected profile and cloud configuration reject old list and binding before any account query',async t=>{
  const f=await fixture(t),replacement=await f.importProfile('alice','replacement');
  for(const op of ['cloud-voices','cloud-bind'])await rejected(f.host.action(op,{voiceId:'system-voice',expectedSelection:f.expected()}),'VOICE_SCOPE_CHANGED');
  await f.profiles.select({...f.params(f.alice)});await f.settings.selectConnection(f.second.id);
  for(const op of ['cloud-voices','cloud-bind'])await rejected(f.host.action(op,{voiceId:'system-voice',expectedSelection:f.expected()}),'CLOUD_CONFIGURATION_CHANGED');
  assert.equal(f.requests.length,0);await f.assertUnbound(f.alice,f.bob,replacement);
});

test('matching expectations use the host current role and account and preserve legacy calls without expectations',async t=>{
  const f=await fixture(t);
  assert.equal((await f.host.action('cloud-voices',{expectedSelection:f.expected()}))[0].voiceId,'system-voice');
  const bound=await f.host.action('cloud-bind',{voiceId:'system-voice',expectedSelection:f.expected()});
  assert.equal(bound.characterId,'alice');assert.equal(bound.profileId,f.alice.id);
  assert.equal((await f.cloud.status(f.params(f.alice))).voiceId,'system-voice');await f.assertUnbound(f.bob);
  await f.settings.selectConnection(f.second.id);f.setScope({characterId:'bob',lifeId:'life-bob'});
  assert.equal((await f.host.action('cloud-voices'))[0].voiceId,'system-voice');
  assert.equal((await f.host.action('cloud-bind',{voiceId:'system-voice'})).characterId,'bob');
  assert.equal((await f.cloud.status(f.params(f.bob))).voiceId,'system-voice');
  assert.deepEqual(f.requests.map(row=>row.account),['synthetic-first-account','synthetic-first-account','synthetic-second-account','synthetic-second-account']);
});

test('a cloud configuration selected while host context awaits a package lease is checked before querying',async t=>{
  const f=await fixture(t),held=f.hold('package');
  const pending=f.host.action('cloud-voices',{expectedSelection:f.expected()}),verdict=rejected(pending,'CLOUD_CONFIGURATION_CHANGED');
  await held.entered.promise;await f.settings.selectConnection(f.second.id);held.release.resolve();await verdict;
  assert.equal(f.requests.length,0);await f.assertUnbound();
});

for(const change of ['scope','profile','configuration'])test('inflight '+change+' change rejects a stale binding before it is persisted',{timeout:5000},async t=>{
  const f=await fixture(t),held=f.hold('query');
  const pending=f.host.action('cloud-bind',{voiceId:'system-voice',expectedSelection:f.expected()}),verdict=rejected(pending,change==='configuration'?'CLOUD_CONFIGURATION_CHANGED':'VOICE_SCOPE_CHANGED');
  await held.entered.promise;
  let replacement;
  if(change==='scope')f.setScope({characterId:'bob',lifeId:'life-bob'});
  else if(change==='profile')replacement=await f.importProfile('alice','replacement');
  else await f.settings.selectConnection(f.second.id);
  held.release.resolve();await verdict;
  if(change==='configuration')await f.settings.selectConnection(f.first.id);
  await f.assertUnbound(...(replacement?[f.alice,f.bob,replacement]:[f.alice,f.bob]));
  assert.equal(f.requests.length,1);
});

test('a delayed account list is rejected after the current cloud configuration changes',{timeout:5000},async t=>{
  const f=await fixture(t),held=f.hold('query');
  const pending=f.host.action('cloud-voices',{expectedSelection:f.expected()}),verdict=rejected(pending,'CLOUD_CONFIGURATION_CHANGED');
  await held.entered.promise;await f.settings.selectConnection(f.second.id);held.release.resolve();await verdict;
  assert.equal(f.requests.length,1);await f.assertUnbound();
});
