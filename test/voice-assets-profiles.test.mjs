import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm,rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVoiceAssets } from '../src/voice/runtime-assets.mjs';
import { createVoiceProfiles } from '../src/voice/voice-profiles.mjs';

async function temp(t) {
  const path = await mkdtemp(join(tmpdir(), 'buddy-voice-data-'));
  t.after(() => rm(path, { recursive:true, force:true }));
  return path;
}

function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF',0); bytes.writeUInt32LE(40,4); bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16); bytes.writeUInt16LE(1,20); bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(16000,24); bytes.writeUInt32LE(32000,28); bytes.writeUInt16LE(2,32);
  bytes.writeUInt16LE(16,34); bytes.write('data',36); bytes.writeUInt32LE(4,40);
  bytes.writeInt16LE(123,44);
  return bytes;
}

test('voice profiles use only the selected character reference and detect changed bytes', async t => {
  const root = await temp(t);
  const file = join(root, 'speaker.wav');
  await writeFile(file,wav());
  const profile = createVoiceProfiles({dataRoot:root});
  const values = {characterId:'first',engine:'gpt',label:'声线 A',references:{calm:{file,text:'声线文本',language:'zh'}}};
  const selected = await profile.importProfile(values);
  const ref = await profile.resolve({characterId:'first',engine:'gpt',profileId:selected.id,performance:{emotion:'happy',source:'model'}});
  assert.equal(ref.referenceSource,'neutral-fallback');
  assert.notEqual(ref.path,file);
  await assert.rejects(profile.resolve({characterId:'second',engine:'gpt',profileId:selected.id}),{code:'VOICE_PROFILE_SCOPE'});
  await writeFile(ref.path,Buffer.alloc(48));
  await assert.rejects(profile.resolve({characterId:'first',engine:'gpt',profileId:selected.id}),{code:'VOICE_REFERENCE_CHANGED'});
});

test('shared components publish after hash validation and can be reused by either installed engine', async t => {
  const root = await temp(t);
  const seed = join(root,'seed');
  const packageDirectory = join(root,'shared');
  await mkdir(seed); await mkdir(packageDirectory);
  const good = Buffer.from('verified');
  const manifest = {schemaVersion:1,platform:'win32',arch:'x64',kind:'asr',version:'1',
    python:'python.exe',files:[{path:'python.exe',bytes:good.length,sha256:createHash('sha256').update(good).digest('hex')}]};
  await writeFile(join(packageDirectory,'assets.json'),JSON.stringify(manifest));
  await writeFile(join(seed,'python.exe'),'tampered');
  const assets = createVoiceAssets({dataRoot:root,resolveVoicePackage:async id=>({
    sourceId:'voice',archiveSha256:id,directory:packageDirectory,
    shared:{sourceId:'voice',archiveSha256:'shared',directory:packageDirectory},
  })});
  await assert.rejects(assets.prepare('asr',{engineId:'breeze',localRoot:seed}),{code:'VOICE_ASSET_HASH'});
  assert.equal((await assets.status('asr','gpt')).state,'missing');
  await writeFile(join(seed,'python.exe'),good);
  assert.deepEqual(await assets.prepare('asr',{engineId:'breeze',localRoot:seed}),{state:'ready',reused:false});
  assert.deepEqual(await assets.prepare('asr',{engineId:'gpt',localRoot:seed}),{state:'ready',reused:true});
  const prepared = await assets.resolve('asr','gpt');
  await writeFile(prepared.python,'tampered');
  await assert.rejects(assets.resolve('asr','gpt'),{code:'VOICE_ASSET_HASH'});
});

test('GPT keeps its short local reference and an independently verified full cloud reference',async t=>{
  const root=await temp(t),local=join(root,'short.wav'),full=join(root,'full.wav');
  const short=wav(),complete=wav();complete.writeInt16LE(456,44);
  await writeFile(local,short);await writeFile(full,complete);
  const profiles=createVoiceProfiles({dataRoot:root});
  const row=await profiles.importProfile({characterId:'deepseek',engine:'gpt',label:'accepted',references:{calm:{file:local,text:'short',language:'zh'}},cloudReference:{file:full,text:'full',language:'zh'}});
  const ref=await profiles.resolve({characterId:'deepseek',engine:'gpt',profileId:row.id,profileVersion:row.version});
  assert.equal(ref.id,row.id);assert.equal(ref.version,1);assert.equal(ref.characterId,'deepseek');
  assert.equal(ref.text,'short');assert.equal(ref.cloudReference.text,'full');
  assert.notEqual(ref.sha256,ref.cloudReference.sha256);
  await writeFile(ref.cloudReference.path,short);
  await assert.rejects(profiles.resolve({characterId:'deepseek',engine:'gpt',profileId:row.id}),{code:'VOICE_REFERENCE_CHANGED'});
});

test('a denied final directory switch preserves verified files and resumes without recopying',async t=>{
  const root=await temp(t),seed=join(root,'seed'),pkg=join(root,'shared');await mkdir(seed);await mkdir(pkg);
  const bytes=Buffer.from('component');await writeFile(join(seed,'python.exe'),bytes);
  await writeFile(join(pkg,'assets.json'),JSON.stringify({schemaVersion:1,platform:'win32',arch:'x64',kind:'asr',version:'1',python:'python.exe',files:[{path:'python.exe',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]}));
  let attempts=0;
  const assets=createVoiceAssets({dataRoot:root,resolveVoicePackage:async()=>({sourceId:'voice',archiveSha256:'archive',directory:pkg,shared:{sourceId:'voice',archiveSha256:'shared',directory:pkg}}),
    promote:async(from,to,options)=>{assert.equal(options.retryBudgetMs,10000);if(++attempts===1)throw Object.assign(Error('Windows rename denied'),{code:'EPERM'});return rename(from,to);}});
  await assert.rejects(assets.prepare('asr',{engineId:'breeze',localRoot:seed}),{code:'EPERM'});
  assert.notEqual((await assets.status('asr','breeze')).state,'ready');
  await rm(seed,{recursive:true,force:true});
  assert.deepEqual(await assets.prepare('asr',{engineId:'breeze',localRoot:seed}),{state:'ready',reused:true,resumed:true});
  assert.equal((await assets.resolve('asr','breeze')).python.endsWith('python.exe'),true);
});
