import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildPluginArchive} from '../src/plugin-archive.mjs';
import {createPluginManager} from '../src/plugin-manager.mjs';
import {canonicalPluginJson} from '../src/plugin-manifest.mjs';
import {pluginSourceFingerprint} from '../src/plugin-sources.mjs';
import {createCommunityService} from '../src/community/service.mjs';
import {createVoicePackageAuthority} from '../src/voice/package-authority.mjs';
import {activate as activateBreeze} from '../sdk/plugins/voice-breeze/entry.mjs';
import {activate as activateGpt} from '../sdk/plugins/voice-gpt-sovits/entry.mjs';

const breeze = 'ai-buddy.voice-breeze';
const gpt = 'ai-buddy.voice-gpt-sovits';
const shared = 'ai-buddy.voice-shared-runtime';
const base = 'https://voice.fixture.test';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const {privateKey, publicKey} = generateKeyPairSync('ed25519');
const field = value => {
  const bytes = Buffer.from(value), size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  return Buffer.concat([size, bytes]);
};
const ssh = 'ssh-ed25519 ' + Buffer.concat([field('ssh-ed25519'), field(publicKey.export({type:'spki',format:'der'}).subarray(-32))]).toString('base64');
const fingerprint = pluginSourceFingerprint(ssh);

function fixture(id, version = '1.0.0', {cloudWorker = true} = {}) {
  const runtime = id === shared;
  const engine = id === breeze ? 'breeze' : 'gpt-sovits';
  const files = new Map([['assets.json', Buffer.from('{}')], ...(runtime ? [['asr_worker.py', Buffer.from('# ASR fixture')]] : [['entry.mjs', Buffer.from('export function activate() {}')], [engine === 'breeze' ? 'breeze_worker.py' : 'gpt_worker.py', Buffer.from('# TTS fixture')]])]);
  if(runtime && cloudWorker)files.set('cloud_speech.py',Buffer.from('# Cloud fixture'));
  const manifest = {schemaVersion:1,id,name:id,description:'Voice fixture',version,kind:runtime?'runtime':'plugin',appRange:'2.0.7',apiRange:'^1.0.0',platform:'win32',arch:'x64',entry:runtime?'asr_worker.py':'entry.mjs',activationEvents:runtime?[]:[`onCommand:voice.${engine}`],capabilities:runtime?[]:['commands.register'],dependencies:runtime?{}:{[shared]:version},files:[...files].map(([path,bytes])=>({path,bytes:bytes.length,sha256:hash(bytes)}))};
  const bytes = buildPluginArchive(manifest, files);
  return {bytes, item:{manifest,archive:{url:`${base}/${id}/${version}.zip`,bytes:bytes.length,sha256:hash(bytes)},publishedAt:'2026-11-06T00:00:00Z'}};
}

async function setup(t, {allowTestKey = true, quiesce, cloudWorker = true} = {}) {
  const root = await mkdtemp(join(tmpdir(),'buddy-voice-package-'));
  const dataRoot = join(root,'profile');
  await mkdir(dataRoot);
  const packages = [fixture(breeze), fixture(gpt), fixture(shared,'1.0.0',{cloudWorker}), fixture(breeze,'1.0.1'), fixture(shared,'1.0.1',{cloudWorker})];
  const payload = {schemaVersion:1,id:'voice-fixture',generatedAt:'2026-11-06T00:00:00Z',packages:packages.map(row=>row.item)};
  const descriptor = {schemaVersion:1,id:payload.id,name:'Voice fixture',catalogUrl:`${base}/catalog.json`,publicKey:ssh,keyId:'voice-test'};
  const envelope = {payload,signature:{keyId:'voice-test',algorithm:'ed25519',value:sign(null,Buffer.from(canonicalPluginJson(payload)),privateKey).toString('base64')}};
  const trust = allowTestKey ? fingerprint : undefined;
  const manager = await createPluginManager({root,dataRoot,appVersion:'2.0.7',voiceTestFingerprint:trust,fetchImpl:async url=>{
    if(url===`${base}/source.json`)return Response.json(descriptor);
    if(url===descriptor.catalogUrl)return Response.json(envelope);
    const row=packages.find(row=>row.item.archive.url===url);
    return row?new Response(row.bytes):new Response('',{status:404});
  }});
  const authority = createVoicePackageAuthority({manager,voiceTestFingerprint:trust,quiesce});
  t.after(async()=>{await authority.close();await manager.close();await rm(root,{recursive:true,force:true});});
  const preview = await authority.action({action:'sources-preview',url:`${base}/source.json`});
  await authority.action({action:'sources-add',previewId:preview.previewId,keyFingerprint:preview.source.keyFingerprint});
  const sourceId = preview.source.sourceId;
  async function install(id, version='1.0.0') {
    const plan=await authority.action({action:'plan',sourceId,requests:[{id,version}]});
    return authority.action({action:'install',planId:plan.planId});
  }
  const change = (action,id) => authority.action({action,id,sourceId});
  return {authority,manager,sourceId,install,change,root,dataRoot};
}

test('signed engines use one shared package and require explicit enablement', async t=>{
  const {authority,manager,install,change}=await setup(t);
  await install(breeze);
  await assert.rejects(authority.resolveVoicePackage(breeze),{code:'PLUGIN_DISABLED'});
  await change('enable',breeze);
  const first=await authority.resolveVoicePackage(breeze);
  assert.equal(first.manifest.id,breeze);
  assert.equal(first.shared.manifest.id,shared);
  await install(gpt);
  await change('enable',gpt);
  const second=await authority.resolveVoicePackage(gpt);
  assert.equal(second.shared.directory,first.shared.directory);
  assert.deepEqual(Object.keys(manager.snapshot().installed).sort(),[breeze,gpt,shared].sort());
  await assert.rejects(change('uninstall',shared),{code:'PLUGIN_DEPENDENCY_ERROR'});
});

test('both actual package entries declare local and MiniMax without a third user plugin',async()=>{
  for(const [id,engine,activate] of [[breeze,'breeze',activateBreeze],[gpt,'gpt-sovits',activateGpt]]){
    let registration;
    await activate({commands:{register:async(command,callback)=>{registration={command,callback};}}});
    assert.equal(registration.command.id,`${id}.prepare`);
    const descriptor=await registration.callback();
    assert.equal(descriptor.protocolVersion,1);
    assert.equal(descriptor.engine,engine);
    assert.deepEqual(descriptor.providers,['local','minimax']);
    assert.equal(descriptor.cloudWorker,'cloud_speech.py');
  }
});

test('each installed engine can lease cloud with only its shared runtime, and disable or source revocation fences cloud',async t=>{
  const {authority,manager,install,change,sourceId}=await setup(t);
  for(const id of [breeze,gpt]){
    await install(id);
    await assert.rejects(authority.resolveVoicePackage(id,{provider:'minimax'}),{code:'PLUGIN_DISABLED'});
    await change('enable',id);
  }
  const first=await authority.resolveVoicePackage(breeze,{provider:'minimax'});
  const second=await authority.resolveVoicePackage(gpt,{provider:'minimax'});
  assert.equal(first.provider,'minimax');
  assert.equal(second.shared.directory,first.shared.directory);
  // The fixture has no prepared TTS weights or component directories.
  assert.deepEqual(Object.keys(manager.snapshot().installed).sort(),[breeze,gpt,shared].sort());
  await change('disable',breeze);
  assert.throws(first.assertCurrent,{code:'VOICE_PACKAGE_CHANGED'});
  await assert.rejects(authority.resolveVoicePackage(breeze,{provider:'minimax'}),{code:'PLUGIN_DISABLED'});
  await authority.action({action:'sources-disable',sourceId,disabled:true});
  assert.throws(second.assertCurrent,{code:'VOICE_PACKAGE_CHANGED'});
  await assert.rejects(authority.resolveVoicePackage(gpt,{provider:'minimax'}),{code:'PLUGIN_SOURCE_DISABLED'});
});

test('cloud rejects missing signed shared worker and unknown providers',async t=>{
  const {authority,install,change}=await setup(t,{cloudWorker:false});
  await install(breeze);
  await change('enable',breeze);
  await authority.resolveVoicePackage(breeze);
  await assert.rejects(authority.resolveVoicePackage(breeze,{provider:'minimax'}),{code:'VOICE_CLOUD_UNAVAILABLE'});
  await assert.rejects(authority.resolveVoicePackage(breeze,{provider:'other'}),{code:'VOICE_PROVIDER_INVALID'});
});

test('disable fences the current lease before runtime release and rejects a fresh lease while draining', async t=>{
  let draining, release;
  const quiesced=new Promise(resolve=>{draining=resolve;});
  const hold=new Promise(resolve=>{release=resolve;});
  const {authority,install,change}=await setup(t,{quiesce:async target=>{if(target.id===breeze){draining();await hold;}}});
  await install(breeze);
  await change('enable',breeze);
  const old=await authority.resolveVoicePackage(breeze);
  const stopped=change('disable',breeze);
  await quiesced;
  try {
    assert.throws(old.assertCurrent,{code:'VOICE_PACKAGE_CHANGED'});
    await assert.rejects(authority.resolveVoicePackage(breeze),{code:'VOICE_PACKAGE_CHANGED'});
  } finally {release();await stopped;}
  await assert.rejects(authority.resolveVoicePackage(breeze),{code:'PLUGIN_DISABLED'});
});

test('code generation update and coordinated rollback preserve profile files, revocation rejects new leases', async t=>{
  const {authority,sourceId,install,change}=await setup(t);
  await install(breeze);
  await change('enable',breeze);
  const first=await authority.resolveVoicePackage(breeze);
  const profile=join(first.dataDirectory,'reference.json');
  await writeFile(profile,'{"keep":true}');
  await install(breeze,'1.0.1');
  assert.throws(first.assertCurrent,{code:'VOICE_PACKAGE_CHANGED'});
  assert.equal((await authority.resolveVoicePackage(breeze)).version,'1.0.1');
  // A single-package rollback must not split the exact engine/shared generation.
  await assert.rejects(change('rollback',breeze),{code:'PLUGIN_DEPENDENCY_ERROR'});
  assert.equal((await authority.resolveVoicePackage(breeze)).version,'1.0.1');
  await install(breeze,'1.0.0');
  assert.equal((await authority.resolveVoicePackage(breeze)).version,'1.0.0');
  await authority.action({action:'sources-disable',sourceId,disabled:true});
  await assert.rejects(authority.resolveVoicePackage(breeze),{code:'PLUGIN_SOURCE_DISABLED'});
  await change('uninstall',breeze);
  assert.equal(await readFile(profile,'utf8'),'{"keep":true}');
});

test('a manually trusted catalog cannot activate an engine with a reserved voice identity', async t=>{
  const {authority,install,change}=await setup(t,{allowTestKey:false});
  await install(breeze);
  await assert.rejects(change('enable',breeze),{code:'PLUGIN_ACTIVATION_UNSUPPORTED'});
  await assert.rejects(authority.resolveVoicePackage(breeze),{code:'VOICE_SOURCE_UNAUTHORIZED'});
});

test('community exposes the supported signed voice package and keeps unrelated voice listings unavailable',async t=>{
  const {authority,manager,sourceId,root,dataRoot}=await setup(t);
  const community=await createCommunityService({root,dataRoot,legacyManager:{...manager,action:authority.action},voiceEnabled:true,voiceTestFingerprint:fingerprint,pollMs:0});
  t.after(()=>community.close());
  const payload={schemaVersion:1,type:'ai-buddy-community-catalog',id:'voice-fixture',generatedAt:'2026-11-06T00:00:00Z',source:{descriptorId:'voice-fixture',keyFingerprint:fingerprint},
    authors:[{id:'voice-author',name:'Voice author',githubLogin:'fixture'}],works:[breeze,'other.voice'].map(id=>({id,packageName:id,backend:'buddy-v1',name:id,description:'Voice sample',authorId:'voice-author',category:'voice',releases:[{version:'1.0.0',publishedAt:'2026-11-06T00:00:00Z'}]}))};
  const envelope={payload,signature:{keyId:'voice-test',algorithm:'ed25519',value:sign(null,Buffer.from(canonicalPluginJson(payload)),privateKey).toString('base64')}};
  await community.action({action:'community-load-catalog',sourceId,envelope});
  const view=await community.action({action:'community-search',category:'voice'});
  assert.equal(view.items.find(row=>row.id===breeze).installable,true);
  assert.equal(view.items.find(row=>row.id==='other.voice').installable,false);
  await assert.rejects(community.action({action:'dsh-plan',sourceId,id:'other.voice'}),{code:'COMMUNITY_INSTALL_UNAVAILABLE'});
  const plan=await community.action({action:'dsh-plan',sourceId,id:breeze});
  await community.action({action:'install',planId:plan.planId});
  await community.action({action:'enable',sourceId,id:breeze});
  assert.equal((await authority.resolveVoicePackage(breeze)).manifest.id,breeze);
});
