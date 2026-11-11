import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {watch} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildPluginArchive} from '../src/plugin-archive.mjs';
import {createPluginManager} from '../src/plugin-manager.mjs';
import {canonicalPluginJson} from '../src/plugin-manifest.mjs';
import {pluginSourceFingerprint} from '../src/plugin-sources.mjs';
import {createVoicePackageAuthority} from '../src/voice/package-authority.mjs';
import {createVoiceHost} from '../src/voice/host.mjs';
import {PET_CHARACTERS} from '../src/pet-characters.mjs';

const temporaryRoot=tmpdir();
const breeze='ai-buddy.voice-breeze',gpt='ai-buddy.voice-gpt-sovits',shared='ai-buddy.voice-shared-runtime';
const origin='https://presets.fixture.test',hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function wav(seconds=4){
  const bytes=Buffer.alloc(44+16000*2*seconds);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);return bytes;
}
function archive(id,{version='1.0.2',mutate=()=>{},presets=true}={}){
  const runtime=id===shared,engine=id===breeze?'breeze':'gpt',bytes=wav(),files=new Map([['assets.json',Buffer.from('{}')],...(runtime?[['asr_worker.py',Buffer.from('# fixture')],['cloud_speech.py',Buffer.from('# fixture')]]:[['entry.mjs',Buffer.from('export function activate(){throw Error("preset import must not activate plugins");}')],[engine==='breeze'?'breeze_worker.py':'gpt_worker.py',Buffer.from('# fixture')]])]);
  if(!runtime&&presets){
    const index={schemaVersion:1,bundleId:'ai-buddy.character-voices-r04',version:1,engine,profiles:PET_CHARACTERS.map(({id:characterId,name})=>{
      const file=`presets/audio/${characterId}-calm.wav`,ref={file,bytes:bytes.length,sha256:hash(bytes),text:'已批准的参考文字。',language:'zh',durationMs:4000};files.set(file,bytes);
      const cloudReference=engine==='gpt'?{...ref,file:`presets/audio/${characterId}-cloud.wav`,bytes:wav(12).length,sha256:hash(wav(12)),durationMs:12000}:ref;
      if(engine==='gpt')files.set(cloudReference.file,wav(12));
      return {characterId,label:name+' · 预制声线',references:{calm:ref},cloudReference};
    })};mutate(index,files);files.set('presets/index.json',Buffer.from(JSON.stringify(index)));
  }
  const manifest={schemaVersion:1,id,name:id,description:'Bundled voice fixture',version,kind:runtime?'runtime':'plugin',appRange:'^2.0.11',apiRange:'^1.0.0',platform:'win32',arch:'x64',entry:runtime?'asr_worker.py':'entry.mjs',activationEvents:runtime?[]:[`onCommand:voice.${engine==='gpt'?'gpt-sovits':engine}`],capabilities:runtime?[]:['commands.register'],dependencies:runtime?{}:{[shared]:version},files:[...files].map(([path,bytes])=>({path,bytes:bytes.length,sha256:hash(bytes)}))};
  const packed=buildPluginArchive(manifest,files);return {bytes:packed,item:{manifest,archive:{url:`${origin}/${id}/${version}.zip`,bytes:packed.length,sha256:hash(packed)},publishedAt:'2026-11-09T00:00:00Z'}};
}
async function fixture(t,options={}){
  await mkdir(temporaryRoot,{recursive:true});const root=await mkdtemp(join(temporaryRoot,'host-')),dataRoot=join(root,'profile');await mkdir(dataRoot);
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),field=value=>{const bytes=Buffer.from(value),length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);return Buffer.concat([length,bytes]);};
  const ssh='ssh-ed25519 '+Buffer.concat([field('ssh-ed25519'),field(publicKey.export({type:'spki',format:'der'}).subarray(-32))]).toString('base64'),voiceTestFingerprint=pluginSourceFingerprint(ssh);
  const packages=(options.versions??[options.version??'1.0.2']).flatMap(version=>[breeze,gpt,shared].map(id=>archive(id,{...options,version,...(options.legacyWithoutPresets&&version==='1.0.1'?{presets:false}:{}),...(options.mutateVersion?{mutate:(index,files)=>options.mutateVersion(version,index,files)}:{})}))),payload={schemaVersion:1,id:'presets-fixture',generatedAt:'2026-11-09T00:00:00Z',packages:packages.map(row=>row.item)},descriptor={schemaVersion:1,id:payload.id,name:'Presets fixture',catalogUrl:origin+'/catalog.json',publicKey:ssh,keyId:'presets-fixture'};
  const envelope={payload,signature:{keyId:descriptor.keyId,algorithm:'ed25519',value:sign(null,Buffer.from(canonicalPluginJson(payload)),privateKey).toString('base64')}};
  let network=0,spawns=0,resolutions=0,host;
  const onUpdate=()=>{if(options.automaticRefresh)void host?.refreshPresetPackages();};
  const config={root,dataRoot,appVersion:'2.0.11',voiceTestFingerprint,onUpdate,fetchImpl:async url=>{network++;if(url===origin+'/source.json')return Response.json(descriptor);if(url===descriptor.catalogUrl)return Response.json(envelope);return new Response(packages.find(row=>row.item.archive.url===url)?.bytes??'',{status:packages.some(row=>row.item.archive.url===url)?200:404});}};
  let manager=await createPluginManager(config),authority=createVoicePackageAuthority({manager,voiceTestFingerprint,onChanged:onUpdate,runnerPath:join(root,'forbidden-runner.cjs'),processFactory:()=>{spawns++;throw Error('Preset import started a plugin');}});
  const createHost=()=>createVoiceHost({dataRoot,build:root,getGame:options.getGame??(()=>({voiceScope:()=>({characterId:'deepseek'})})),
    ...(options.voiceFetch?{network:{fetch:options.voiceFetch},crypto:{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()}}:{}),
    getPlatform:()=>({voicePackageStatus:()=>options.packageStatus?options.packageStatus(authority.status()):authority.status(),resolveVoicePresetPackage:(...args)=>{resolutions++;return authority.resolveVoicePresetPackage(...args);},resolveVoicePackage:(...args)=>authority.resolveVoicePackage(...args)}),components:{supervisor:{async close(){}}}});
  host=createHost();
  t.after(async()=>{await host.close();await authority.close();await manager.close();await rm(root,{recursive:true,force:true});});
  const preview=await authority.action({action:'sources-preview',url:origin+'/source.json'});await authority.action({action:'sources-add',previewId:preview.previewId,keyFingerprint:preview.source.keyFingerprint});const sourceId=preview.source.sourceId;
  const install=async(id,version=options.version??'1.0.2')=>{const plan=await authority.action({action:'plan',sourceId,requests:[{id,version}]});return authority.action({action:'install',planId:plan.planId});};
  return {root,dataRoot,install,sourceId,get host(){return host;},get authority(){return authority;},get manager(){return manager;},network:()=>network,spawns:()=>spawns,resolutions:()=>resolutions,
    async restart(){await host.close();await authority.close();await manager.close();manager=await createPluginManager(config);authority=createVoicePackageAuthority({manager,voiceTestFingerprint});host=createHost();return host;}};
}

test('installing disabled signed voice packages makes all 22 presets readable without starting any engine',async t=>{
  const f=await fixture(t);await f.install(breeze);await f.install(gpt);const fetched=f.network();
  const rows=[];
  for(const {id:characterId} of PET_CHARACTERS)for(const engine of ['breeze','gpt']){
    const params={characterId,engine},list=await f.host.profiles.list(params);assert.equal(list.length,1);rows.push(list[0]);assert.deepEqual(list[0].bundledPreset,{bundleId:'ai-buddy.character-voices-r04',version:1});
    assert.equal((await f.host.profiles.current(params)).id,list[0].id);
    const reference=await f.host.profiles.resolve(params);assert.equal(reference.durationMs,4000);assert.equal(reference.cloudReference.durationMs,engine==='gpt'?12000:4000);
  }
  assert.equal(new Set(rows.map(row=>row.id)).size,22);assert.equal(f.spawns(),0);assert.equal(f.network(),fetched);
});

test('cloud preparation uses both signed installed profiles without enabling the disabled packages',async t=>{
  const scope={characterId:'deepseek',personaId:'persona',lifeId:'life',operationId:'operation',contextRevision:'revision'};
  const game={voiceScope:()=>scope,viewState:()=>({activePersonaId:scope.personaId,characters:[{id:scope.characterId}]}),pluginScope:()=>scope};
  const active=new Set();let clones=0;
  const f=await fixture(t,{getGame:()=>game,async voiceFetch(url,options){
    const pathname=new URL(url).pathname,base_resp={status_code:0};
    if(pathname==='/v1/files/upload')return Response.json({base_resp,file:{file_id:1}});
    if(pathname==='/v1/voice_clone'){clones++;return Response.json({base_resp});}
    if(pathname==='/v1/t2a_v2'){active.add(JSON.parse(options.body).voice_setting.voice_id);return Response.json({base_resp,data:{status:2,audio:'0000'}});}
    if(pathname==='/v1/get_voice')return Response.json({base_resp,voice_cloning:[...active].map(voice_id=>({voice_id}))});
    throw Error('Unexpected fixture endpoint');
  }});
  await f.install(breeze);await f.install(gpt);await f.host.refreshPresetPackages();
  const file=join(f.root,'reference.wav');await writeFile(file,wav(10));
  await f.host.profiles.importProfile({characterId:scope.characterId,engine:'breeze',label:'合成参考',references:{calm:{file,text:'这是测试参考音。',language:'zh'}}});
  assert.ok(f.authority.status().every(row=>row.installed&&!row.enabled));
  await f.host.action('cloud-connection-save',{name:'测试',key:'synthetic-test-key'});
  const selectedCharacterIds=[scope.characterId];
  const preview=await f.host.action('cloud-batch-preview',{selectedCharacterIds});
  assert.equal(preview.plan.cloneCount,2);assert.equal(preview.plan.pricing.cloneEstimate,19.8);
  const completed=await f.host.action('cloud-batch-prepare',{selectedCharacterIds,planHash:preview.plan.planHash,consentUpload:true,consentActivation:true});
  assert.equal(completed.completed,1);assert.equal(clones,2);assert.equal(f.spawns(),0);
  assert.ok(f.authority.status().every(row=>row.installed&&!row.enabled));
});

test('upgrading automatically imports after maintenance even when cold recovery already finished',async t=>{
  const f=await fixture(t,{automaticRefresh:true,versions:['1.0.1','1.0.2'],legacyWithoutPresets:true});await f.install(breeze,'1.0.1');
  assert.deepEqual(await f.host.profiles.list({characterId:'deepseek',engine:'breeze'}),[]);await f.install(breeze);
  assert.equal((await f.host.profiles.list({characterId:'deepseek',engine:'breeze'})).length,1);
});

test('restart and repeated package/state refresh reuse receipts and preserve a custom selection and audio',async t=>{
  const f=await fixture(t),file=join(f.root,'custom.wav');await writeFile(file,wav());
  const custom=await f.host.profiles.importProfile({characterId:'deepseek',engine:'breeze',label:'我的声音',references:{calm:{file,text:'我的参考文字',language:'zh'}}});
  const expected=await f.host.profiles.resolve({characterId:'deepseek',engine:'breeze'});
  await f.install(breeze);await f.install(gpt);await Promise.all([f.host.refreshPresetPackages(),f.host.refreshPresetPackages()]);
  assert.equal((await f.host.profiles.current({characterId:'deepseek',engine:'breeze'})).id,custom.id);
  assert.equal((await f.host.profiles.list({characterId:'deepseek',engine:'breeze'})).length,2);
  const presets=await f.host.profiles.list({characterId:'deepseek',engine:'gpt'}),before=f.resolutions();
  for(let i=0;i<4;i++){await f.host.refreshPresetPackages();await f.host.action('state');}
  assert.equal(f.resolutions(),before);
  await f.restart();await f.host.refreshPresetPackages();
  assert.equal(f.resolutions(),before,'a persistent receipt avoids signed-package scans after restart');
  assert.equal((await f.host.profiles.current({characterId:'deepseek',engine:'breeze'})).id,custom.id);
  assert.deepEqual(await f.host.profiles.list({characterId:'deepseek',engine:'gpt'}),presets);
  assert.equal((await f.host.profiles.resolve({characterId:'deepseek',engine:'breeze'})).sha256,expected.sha256);
});

test('a custom import and explicit selection concurrent with installation retain user ownership',async t=>{
  const f=await fixture(t),file=join(f.root,'custom.wav');await writeFile(file,wav());
  const first=await f.host.profiles.importProfile({characterId:'deepseek',engine:'breeze',label:'第一份',references:{calm:{file,text:'第一份文字',language:'zh'}}});
  await f.install(breeze);
  const [,second]=await Promise.all([f.host.refreshPresetPackages(),f.host.profiles.importProfile({characterId:'deepseek',engine:'breeze',label:'第二份',references:{calm:{file,text:'第二份文字',language:'zh'}}})]);
  assert.equal((await f.host.profiles.current({characterId:'deepseek',engine:'breeze'})).id,second.id);
  await Promise.all([f.host.refreshPresetPackages(),f.host.profiles.select({characterId:'deepseek',engine:'breeze',profileId:first.id})]);
  assert.equal((await f.host.profiles.current({characterId:'deepseek',engine:'breeze'})).id,first.id);
  assert.equal((await f.host.profiles.list({characterId:'deepseek',engine:'breeze'})).length,3);
});

for(const [name,mutate] of [
  ['bad hash',index=>{index.profiles.at(-1).references.calm.sha256='0'.repeat(64);}],
  ['escaping path',index=>{index.profiles.at(-1).references.calm.file='../outside.wav';}],
  ['wrong engine',index=>{index.engine='gpt';}],
  ['duplicate character',index=>{index.profiles.at(-1).characterId='deepseek';}],
  ['unknown character',index=>{index.profiles.at(-1).characterId='unexpected';}],
  ['last WAV malformed',(index,files)=>{const ref=index.profiles.at(-1).references.calm,bytes=Buffer.from('not a wave');ref.bytes=bytes.length;ref.sha256=hash(bytes);files.set(ref.file,bytes);}],
])test(`rejecting ${name} leaves zero visible profiles and no receipt`,async t=>{
  let unavailable=false;const f=await fixture(t,{mutate,packageStatus:rows=>rows.map(row=>unavailable?{...row,state:'unavailable'}:row)});await f.install(breeze);await f.host.refreshPresetPackages();
  for(const {id:characterId} of PET_CHARACTERS)assert.deepEqual(await f.host.profiles.list({characterId,engine:'breeze'}),[]);
  await assert.rejects(readFile(join(f.dataRoot,'voice','profiles','index.json')),{code:'ENOENT'});
  const before=f.resolutions();for(let i=0;i<4;i++){await f.host.refreshPresetPackages();await f.host.action('state');}assert.equal(f.resolutions(),before,'failed packages do not auto-retry in a tight loop');
  unavailable=true;await f.host.refreshPresetPackages();unavailable=false;await f.host.refreshPresetPackages();
  assert.equal(f.resolutions(),before,'a temporary unavailable state in the same generation does not retry a failed package');
});

test('old 1.0.1 packages without an index remain compatible and produce no preset error',async t=>{
  const f=await fixture(t,{version:'1.0.1',presets:false});await f.install(breeze);await f.host.refreshPresetPackages();
  assert.deepEqual(await f.host.profiles.list({characterId:'deepseek',engine:'breeze'}),[]);
  assert.equal((await f.host.action('state')).presetPackages[breeze].state,'not-provided');assert.equal(f.spawns(),0);
});

test('uninstall fences a preset lease while imported profiles remain usable after package removal',async t=>{
  const f=await fixture(t);await f.install(breeze);const lease=await f.authority.resolveVoicePresetPackage(breeze);
  await f.host.refreshPresetPackages();const params={characterId:'deepseek',engine:'breeze'},before=await f.host.profiles.resolve(params);
  await f.authority.action({action:'uninstall',id:breeze,sourceId:f.sourceId});
  assert.throws(lease.assertCurrent,{code:'VOICE_PACKAGE_CHANGED'});
  assert.equal((await f.host.profiles.resolve(params)).sha256,before.sha256);assert.equal(f.spawns(),0);
});

for(const action of ['uninstall','sources-disable'])test(`${action} during real staging cancels import and the same package recovers after maintenance`,async t=>{
  const f=await fixture(t);await f.install(breeze);const root=join(f.dataRoot,'voice','profiles');await mkdir(root,{recursive:true});
  const original=f.authority.status().find(row=>row.id===breeze).archiveSha256;
  let maintenance;const staged=Promise.withResolvers();
  const watcher=watch(root,(_,name)=>{if(String(name).startsWith('.presets-')&&!maintenance){maintenance=f.authority.action({action,id:breeze,sourceId:f.sourceId,disabled:true});staged.resolve();}});
  t.after(()=>watcher.close());
  const timeout=setTimeout(()=>staged.reject(Error('Preset staging was not observed')),5000);t.after(()=>clearTimeout(timeout));
  const importing=f.host.refreshPresetPackages();await staged.promise;await Promise.all([importing,maintenance]);watcher.close();clearTimeout(timeout);
  const params={characterId:'deepseek',engine:'breeze'};
  assert.deepEqual(await f.host.profiles.list(params),[]);
  await assert.rejects(readFile(join(root,'index.json')),{code:'ENOENT'});
  if(action==='uninstall')await f.install(breeze);else await f.authority.action({action:'sources-disable',sourceId:f.sourceId,disabled:false});
  assert.equal(f.authority.status().find(row=>row.id===breeze).archiveSha256,original,'recovery uses the same signed package');
  await f.host.refreshPresetPackages();assert.equal((await f.host.profiles.list(params)).length,1);
  assert.equal((await f.host.profiles.resolve(params)).durationMs,4000);
});

test('upgrading the signed package reuses the same bundle profiles without changing selection',async t=>{
  const f=await fixture(t,{versions:['1.0.1','1.0.2']});await f.install(breeze,'1.0.1');await f.host.refreshPresetPackages();
  const params={characterId:'deepseek',engine:'breeze'},before=await f.host.profiles.current(params);
  await f.install(breeze);await f.host.refreshPresetPackages();assert.deepEqual(await f.host.profiles.list(params),[before]);assert.deepEqual(await f.host.profiles.current(params),before);
});

test('a changed bundle revision with the same stable identity cannot replace imported audio or create a receipt',async t=>{
  const f=await fixture(t,{versions:['1.0.1','1.0.2'],mutateVersion:(version,index)=>{if(version==='1.0.2')index.profiles.at(-1).label='内容改变 · 预制声线';}});await f.install(breeze,'1.0.1');await f.host.refreshPresetPackages();
  const indexPath=join(f.dataRoot,'voice','profiles','index.json'),before=await readFile(indexPath,'utf8');await f.install(breeze);await f.host.refreshPresetPackages();
  assert.equal(await readFile(indexPath,'utf8'),before);
});

test('historical missing and invalid selections are preserved when a scope already has custom profiles',async t=>{
  const f=await fixture(t),file=join(f.root,'custom.wav');await writeFile(file,wav());
  for(const characterId of ['deepseek','claude'])await f.host.profiles.importProfile({characterId,engine:'breeze',label:'已有声音',references:{calm:{file,text:'已有文字',language:'zh'}}});
  const indexPath=join(f.dataRoot,'voice','profiles','index.json'),saved=JSON.parse(await readFile(indexPath,'utf8'));delete saved.selections['deepseek:breeze'];saved.selections['claude:breeze']='missing-profile';await writeFile(indexPath,JSON.stringify(saved));
  await f.install(breeze);await f.host.refreshPresetPackages();
  for(const characterId of ['deepseek','claude'])assert.equal(await f.host.profiles.current({characterId,engine:'breeze'}),null);
  const after=JSON.parse(await readFile(indexPath,'utf8'));assert.equal(Object.hasOwn(after.selections,'deepseek:breeze'),false);assert.equal(after.selections['claude:breeze'],'missing-profile');
});
