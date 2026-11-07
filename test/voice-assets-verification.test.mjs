import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVoiceAssets} from '../src/voice/runtime-assets.mjs';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'voice-assets-verification-'));
  const seed=join(root,'seed'),directory=join(root,'package');await mkdir(seed);await mkdir(directory);
  const files=[];
  for(let index=0;index<12;index++){
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
  return {root,directory,assets};
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
