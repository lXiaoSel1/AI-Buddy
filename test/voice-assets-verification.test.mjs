import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVoiceAssets} from '../src/voice/runtime-assets.mjs';

async function fixture(t,{members=12}={}){
  const root=await mkdtemp(join(tmpdir(),'voice-assets-verification-'));
  const seed=join(root,'seed'),directory=join(root,'package');await mkdir(seed);await mkdir(directory);
  const files=[];
  for(let index=0;index<members;index++){
    const path=index?'library-'+index+'.bin':'python.exe',bytes=Buffer.alloc(4096,index);
    await writeFile(join(seed,path),bytes);files.push({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  const manifest={schemaVersion:1,platform:'win32',arch:'x64',kind:'asr',version:'1',python:'python.exe',files};
  const descriptor=Buffer.from(JSON.stringify(manifest)),descriptorHash=createHash('sha256').update(descriptor).digest('hex');
  await writeFile(join(directory,'assets.json'),descriptor);
  const record={sourceId:'test',archiveSha256:'archive',directory,manifest:{files:[{path:'assets.json',bytes:descriptor.length,sha256:descriptorHash}]}};
  const assets=createVoiceAssets({dataRoot:root,resolveVoicePackage:async()=>({...record,shared:record})});
  t.after(async()=>{await assets.close?.();await rm(root,{recursive:true,force:true});});
  await assets.prepare('asr',{engineId:'breeze',localRoot:seed});
  return {root,directory,assets,record};
}

test('cancelled component verification cannot proceed to model launch',async t=>{
  const {assets}=await fixture(t),controller=new AbortController();controller.abort();
  await assert.rejects(assets.resolve('asr','breeze',{signal:controller.signal}),{name:'AbortError'});
});

test('verification exposes bounded progress and cancellation without invalidating prepared files',async t=>{
  const {assets}=await fixture(t),controller=new AbortController(),progress=[];
  await assert.rejects(assets.resolve('asr','breeze',{signal:controller.signal,onProgress:row=>{
    progress.push(row);if(row.completedFiles>=1)controller.abort();
  }}),{name:'AbortError'});
  assert.ok(progress.some(row=>row.phase==='verifying'&&row.totalFiles===12&&row.completedFiles>=1));
  const ready=await assets.resolve('asr','breeze');
  assert.equal((await readFile(ready.python)).length,4096);
  await writeFile(ready.python,Buffer.alloc(4096,99));
  await assert.rejects(assets.resolve('asr','breeze'),{code:'VOICE_ASSET_HASH'});
});

test('descriptor reuse still rejects a changed signed component manifest',async t=>{
  const {assets,directory}=await fixture(t);
  await assets.resolve('asr','breeze');
  const path=join(directory,'assets.json'),value=JSON.parse(await readFile(path,'utf8'));value.version='2';
  await writeFile(path,JSON.stringify(value));
  await assert.rejects(assets.resolve('asr','breeze'),{code:'VOICE_ASSET_MANIFEST'});
});

test('one caller cancelling shared verification cannot cancel another caller',async t=>{
  const {assets}=await fixture(t),controller=new AbortController();
  const cancelled=assets.resolve('asr','breeze',{signal:controller.signal,onProgress:row=>{if(row.completedFiles)controller.abort();}});
  const retained=assets.resolve('asr','breeze');
  await assert.rejects(cancelled,{name:'AbortError'});
  assert.ok((await retained).proof.includes('asr:'));
});

test('repeated settings status has bounded filesystem work independent of component member count',async t=>{
  const small=await fixture(t,{members:2}),large=await fixture(t,{members:256}),original=fsPromises.lstat;let count;
  fsPromises.lstat=async function(path,...args){if(count){count.all++;if(/(?:python\.exe|library-\d+\.bin)$/.test(String(path)))count.payload++;}return original.call(this,path,...args);};syncBuiltinESMExports();
  async function measure(f,state){count={all:0,payload:0};for(let index=0;index<3;index++)assert.equal((await f.assets.status('asr','breeze')).state,state);const result=count;count=null;return result;}
  try{
    const readySmall=await measure(small,'ready'),readyLarge=await measure(large,'ready');small.record.archiveSha256='new-archive';large.record.archiveSha256='new-archive';
    const pendingSmall=await measure(small,'verification-needed'),pendingLarge=await measure(large,'verification-needed');
    t.diagnostic(JSON.stringify({readsPerCase:3,smallMembers:2,largeMembers:256,readySmall,readyLarge,pendingSmall,pendingLarge}));
    assert.equal(readyLarge.all,readySmall.all,'ordinary status work must not grow with members');assert.equal(pendingLarge.all,pendingSmall.all,'upgrade status work must not grow with members');
    for(const row of [readySmall,readyLarge,pendingSmall,pendingLarge])assert.equal(row.payload,0,'settings status must not stat payload members');
  }finally{count=null;fsPromises.lstat=original;syncBuiltinESMExports();}
});
