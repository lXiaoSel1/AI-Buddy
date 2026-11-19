import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PET_CHARACTERS} from '../src/pet-characters.mjs';
import {createBuiltinVoiceReferences} from '../src/voice/builtin-references.mjs';
import {createBuiltinCloudVoice} from '../src/voice/builtin-cloud.mjs';
import {defaultVoiceSettings} from '../src/voice/settings.mjs';

const ids={breeze:'ai-buddy.voice-breeze',gpt:'ai-buddy.voice-gpt-sovits'};
const roles=PET_CHARACTERS.map(({id})=>id);
const target='deepseek',model='speech-2.8-turbo',providerId='minimax-cn';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const action=(cloud,name,options={})=>cloud.action('builtin-cloud-'+name,options);
const json=(data={})=>Response.json({base_resp:{status_code:0},...data});

function wave(marker){
  const bytes=Buffer.alloc(44+16000*2*12);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);
  bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);
  bytes.writeInt16LE(marker,44);
  return bytes;
}

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'builtin-ref-'));
  const packages=new Map(),calls=[],keys=new Map();
  let resolves=0,cloud;
  t.after(async()=>{await cloud?.close();await rm(root,{recursive:true,force:true});});
  const platform=()=>({
    voicePackageStatus:()=>[...packages.values()].map(row=>({...row.status})),
    async resolveVoicePresetPackage(id){
      resolves++;
      const row=packages.get(id);
      if(!row||row.status.state==='source-untrusted')throw Error('synthetic trusted authority rejected package');
      return {...row.lease,assertCurrent(){
        if(packages.get(id)!==row)throw Error('synthetic package generation changed');
      }};
    },
    async resolveVoicePackage(){assert.fail('Reference resolution cannot activate a worker');},
  });
  const references=()=>createBuiltinVoiceReferences({platform});
  async function install(engine,mutate=()=>{}){
    const id=ids[engine],directory=join(root,engine),files=new Map();
    const profiles=roles.map((characterId,i)=>{
      const bytes=wave(i+1),file='presets/audio/'+characterId+(engine==='breeze'?'-calm.wav':'-cloud.wav');
      files.set(file,bytes);
      return {characterId,cloudReference:{file,bytes:bytes.length,sha256:digest(bytes),text:'Synthetic reference transcript '+i+'.',language:'zh',durationMs:12000}};
    });
    const index={schemaVersion:1,bundleId:'ai-buddy.character-voices-r04',version:1,engine,profiles};
    mutate(index,files);
    files.set('presets/index.json',Buffer.from(JSON.stringify(index)));
    await mkdir(join(directory,'presets','audio'),{recursive:true});
    for(const [file,bytes] of files)await writeFile(join(directory,file),bytes);
    const version='1.0.3',sourceId='fixture-official-source',archiveSha256=digest(JSON.stringify([id,index]));
    const manifest={id,files:[...files].map(([path,bytes])=>({path,bytes:bytes.length,sha256:digest(bytes)}))};
    const status={id,sourceId,version,archiveSha256,installed:true,state:'disabled',generation:0};
    packages.set(id,{status,lease:{manifest,directory,version,sourceId,archiveSha256}});
    const pathFor=characterId=>join(directory,'presets','audio',characterId+(engine==='breeze'?'-calm.wav':'-cloud.wav'));
    return {pathFor,status};
  }
  async function open(){
    const resolver=references();
    cloud=createBuiltinCloudVoice({
      dataRoot:join(root,'data'),characters:()=>roles,readReference:resolver.read,referenceInfo:resolver.info,
      settings:{get:async()=>defaultVoiceSettings()},
      credentials:{async save(value){const ref='synthetic-key-ref-'+keys.size;keys.set(ref,value);return {ref};},async resolve(ref){return keys.get(ref);}},
      asr:{status:async()=>({state:'missing'}),auto:async()=>{},close:async()=>{}},
      fetchImpl:async(url,{body})=>{
        const path=new URL(url).pathname;calls.push({path,body});
        if(path==='/v1/files/upload')return json({file:{file_id:12345678}});
        if(path==='/v1/voice_clone')return json();
        if(path==='/v1/t2a_v2'){
          if(!JSON.parse(body).stream)return json({data:{status:2,audio:'0100'}});
          return new Response('data: {"data":{"status":1,"audio":"0100"}}\n\ndata: {"data":{"status":2}}\n\n');
        }
        throw Error('Unexpected external endpoint');
      },
    });
    return cloud;
  }
  return {root,calls,install,open,references,resolves:()=>resolves,remove:engine=>packages.delete(ids[engine])};
}

async function connect(cloud){
  const key='synthetic-cloud-key';
  const probe=await action(cloud,'probe',{providerId,model,key});
  await action(cloud,'save',{providerId,model,key,proof:probe.proof});
  await action(cloud,'route',{route:'cloud:'+providerId});
}

const consent={targetCharacterId:target,consentUpload:true,consentActivation:true};

test('a reference copied into the app tree cannot substitute for an installed plugin',async t=>{
  const f=await fixture(t);
  const assets=join(f.root,'assets','voice-reference');
  await mkdir(assets,{recursive:true});
  await writeFile(join(assets,'index.json'),JSON.stringify({schemaVersion:1,characters:{[target]:{version:1,durationMs:12000}}}));
  assert.equal(await createBuiltinVoiceReferences(f.root).info(target),null);
});

test('without an installed reference plugin the host sends no upload',async t=>{
  const f=await fixture(t),cloud=await f.open();
  assert.equal((await cloud.snapshot()).characters.find(row=>row.characterId===target).referenceAvailable,false);
  await assert.rejects(action(cloud,'reference-preview',{targetCharacterId:target}),{code:'CLOUD_REFERENCE'});
  await connect(cloud);
  await assert.rejects(action(cloud,'clone',consent),{code:'CLOUD_REFERENCE'});
  assert.ok(!f.calls.some(row=>row.path==='/v1/files/upload'));
});

test('a disabled official package serves eleven references and permits a verified preview and clone',async t=>{
  const f=await fixture(t);
  await f.install('breeze');
  const resolver=f.references();
  const metadata=await Promise.all(roles.map(id=>resolver.info(id)));
  assert.deepEqual(metadata,roles.map((_,i)=>({durationMs:12000,version:1,source:'breeze',sha256:digest(wave(i+1)),language:'zh'})));
  assert.equal(f.resolves(),1,'concurrent roster lookups share one authority resolution');
  const expected=wave(roles.indexOf(target)+1);
  const cloud=await f.open();
  assert.deepEqual(await action(cloud,'reference-preview',{targetCharacterId:target}),{pcmWav:Uint8Array.from(expected)});
  assert.equal(f.calls.length,0);
  await connect(cloud);
  const clone=await action(cloud,'clone',consent);
  assert.equal(clone.state,'ready');
  const upload=f.calls.find(row=>row.path==='/v1/files/upload');
  assert.equal(digest(Buffer.from(await upload.body.get('file').arrayBuffer())),digest(expected));
});

for(const nextEngine of ['breeze','gpt'])test('identical signed bytes reuse a clone after switching to '+nextEngine+' preset version 2',async t=>{
  const f=await fixture(t);
  await f.install('breeze');
  const cloud=await f.open();
  await connect(cloud);
  const initial=await action(cloud,'clone',consent);
  f.remove('breeze');
  await f.install(nextEngine,index=>{index.version=2;});
  assert.equal((await cloud.snapshot()).characters.find(row=>row.characterId===target).referenceVersion,2);
  const before=f.calls.length;
  assert.deepEqual(await action(cloud,'clone',consent),initial);
  assert.equal(f.calls.length,before,'an existing clone needs no provider request');
});

test('uninstall stops new reference reads while an already activated clone keeps speaking',async t=>{
  const f=await fixture(t);
  await f.install('breeze');
  const reference=await f.references().read(target);
  const cloud=await f.open();
  await connect(cloud);
  const active=await action(cloud,'clone',consent);
  f.remove('breeze');
  await assert.rejects(reference.assertCurrent(),{code:'CLOUD_REFERENCE'});
  const role=(await cloud.snapshot()).characters.find(row=>row.characterId===target);
  assert.equal(role.referenceAvailable,false);
  assert.equal(role.voiceId,active.voiceId);
  await assert.rejects(action(cloud,'reference-preview',{targetCharacterId:target}),{code:'CLOUD_REFERENCE'});
  assert.equal((await Array.fromAsync(cloud.speak({characterId:target,text:'Synthetic speech.'}))).at(-1).type,'done');
  assert.equal(f.calls.filter(row=>row.path==='/v1/files/upload').length,1);
});

test('tampered WAV falls back to the other verified package and never supplies changed bytes',async t=>{
  const f=await fixture(t);
  const breeze=await f.install('breeze');
  await f.install('gpt');
  const resolver=f.references();
  const original=await resolver.read(target);
  assert.equal(original.source,'breeze');
  await writeFile(breeze.pathFor(target),wave(30000));
  await assert.rejects(original.assertCurrent(),{code:'CLOUD_REFERENCE'});
  assert.equal((await resolver.read(target)).source,'gpt');
  f.remove('gpt');
  await assert.rejects(resolver.read(target),{code:'CLOUD_REFERENCE'});
});

test('an invalid signed reference path or an untrusted package cannot supply a reference',async t=>{
  const f=await fixture(t);
  await f.install('breeze',index=>{index.profiles.find(row=>row.characterId===target).cloudReference.file='../forged.wav';});
  const untrusted=await f.install('gpt');
  untrusted.status.state='source-untrusted';
  const resolver=f.references();
  assert.equal(await resolver.info(target),null);
  await assert.rejects(resolver.read(target),{code:'CLOUD_REFERENCE'});
});

test('an unavailable platform produces only safe reference metadata and errors',async()=>{
  const resolver=createBuiltinVoiceReferences({platform(){throw Error('synthetic-private-path');}});
  assert.equal(await resolver.info(target),null);
  await assert.rejects(resolver.read(target),error=>{
    assert.equal(error.code,'CLOUD_REFERENCE');
    assert.doesNotMatch(error.message,/synthetic-private-path/);
    return true;
  });
});
