import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {watch,createReadStream,writeFileSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,lstat,utimes,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {createVoiceAssets} from '../src/voice/runtime-assets.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t,{members=32,bytes=256*1024}={}){
  const root=await mkdtemp(join(tmpdir(),'voice-verification-r213-')),directory=join(root,'package');await mkdir(directory);
  const files=Array.from({length:members},(_,index)=>({path:index?'lib/member-'+index+'.bin':'python.exe',bytes,sha256:sha(Buffer.alloc(bytes,index))}));
  const descriptor=Buffer.from(JSON.stringify({schemaVersion:1,platform:'win32',arch:'x64',kind:'asr',version:'1',python:'python.exe',files}));
  const descriptorHash=sha(descriptor),destination=join(root,'voice/components/asr',descriptorHash);await mkdir(join(destination,'lib'),{recursive:true});
  await writeFile(join(directory,'assets.json'),descriptor);
  for(let index=0;index<files.length;index++)await writeFile(join(destination,files[index].path),Buffer.alloc(bytes,index));
  const record={directory,sourceId:'legacy',archiveSha256:'archive-1',manifest:{files:[{path:'assets.json',bytes:descriptor.length,sha256:descriptorHash}]}};
  const proof='asr:legacy:archive-1:'+descriptorHash;await writeFile(join(destination,'.ready'),proof);
  const opened=[];
  const open=(options={})=>{const assets=createVoiceAssets({dataRoot:root,resolveVoicePackage:async()=>({...record,shared:record}),fetchImpl:async()=>{throw Error('Network is forbidden');},...options});opened.push(assets);return assets;};
  const assets=open();t.after(async()=>{for(const value of opened)await value.close();await rm(root,{recursive:true,force:true});});
  return {root,record,destination,files,proof,assets,open};
}
async function age(f){
  // A newly created file may suppress the first NTFS access notification. Warm
  // each file before resetting atime, then drain the real utimes notifications.
  for(const file of f.files)for await(const _ of createReadStream(join(f.destination,file.path))){}
  const old=new Date(Date.now()-72*3600e3);
  for(const file of f.files){const path=join(f.destination,file.path),info=await lstat(path);await utimes(path,old,info.mtime);}
  await sleep(1500);
}

test('verifyOnly accepts aged access-time notifications after a complete real-worker pass',async t=>{
  const f=await fixture(t),path=join(f.destination,'python.exe');let result,error,before,after,events,progress;
  for(let attempt=1;attempt<=5;attempt++){
    await age(f);before=await lstat(path,{bigint:true});events=[];progress=[];
    const watcher=watch(f.destination,{recursive:true},(type,path)=>events.push({type,path:String(path)}));
    error=undefined;try{result=await f.assets.prepare('asr',{engineId:'breeze',verifyOnly:true,onProgress:row=>progress.push(row)});}catch(cause){error=cause;}
    await sleep(100);watcher.close();after=await lstat(path,{bigint:true});
    t.diagnostic(JSON.stringify({attempt,events:events.length,samples:events.slice(0,4),ctimeBefore:String(before.ctimeNs),ctimeAfter:String(after.ctimeNs),atimeAdvanced:after.atimeNs>before.atimeNs,error:error?.code,progress}));
    if(events.some(row=>row.type==='change'&&row.path.endsWith('.bin')))break;
  }
  assert.ok(events.some(row=>row.type==='change'&&row.path.endsWith('.bin')),'this regression must observe real NTFS read/access notifications');
  assert.equal(after.ctimeNs,before.ctimeNs,'NTFS access updates must not revoke file identity');
  assert.ifError(error);assert.deepEqual(result,{state:'ready',reused:true});
  assert.ok(progress.some(row=>row.completedFiles===f.files.length&&row.hashedFiles===f.files.length));
});

test('cancelled verification keeps completed hashes for retry after reopening assets',async t=>{
  const f=await fixture(t,{members:48,bytes:1024*1024}),controller=new AbortController(),first=[];
  f.record.archiveSha256='archive-2';
  await assert.rejects(f.assets.prepare('asr',{engineId:'breeze',verifyOnly:true,signal:controller.signal,onProgress:row=>{
    first.push(row);if(row.completedFiles>=1)controller.abort();
  }}),{name:'AbortError'});
  const marker=await readFile(join(f.destination,'.ready'),'utf8');assert.equal(marker,f.proof);
  const failed=await f.assets.status('asr','breeze');assert.equal(failed.state,'verification-needed');assert.equal(failed.code,'ABORT_ERR');assert.equal(failed.downloadRequired,false);
  const retry=[],assets=f.open();await assets.prepare('asr',{engineId:'breeze',verifyOnly:true,onProgress:row=>retry.push(row)});
  const final=retry.at(-1);t.diagnostic(JSON.stringify({first,retry:final}));
  assert.ok(final.hashedFiles<f.files.length,'retry must reuse successfully hashed members');
  assert.equal(final.completedFiles,f.files.length);assert.equal((await assets.status('asr','breeze')).state,'ready');
  assert.match(await readFile(join(f.destination,'.ready'),'utf8'),/^asr:legacy:archive-2:/);
});

test('real changes report the relative member path and remain retryable without downloading',async t=>{
  const f=await fixture(t,{members:48,bytes:1024*1024}),progress=[];let changed=false;
  await assert.rejects(f.assets.prepare('asr',{engineId:'breeze',verifyOnly:true,onProgress:row=>{
    progress.push(row);if(!changed&&row.completedFiles){changed=true;writeFileSync(join(f.destination,'python.exe'),Buffer.alloc(1024*1024,99));}
  }}),error=>error.code==='VOICE_ASSET_CHANGED'&&error.path==='python.exe');
  const failed=await f.assets.status('asr','breeze');t.diagnostic(JSON.stringify({failed,progress}));
  assert.equal(failed.state,'verification-needed');assert.equal(failed.code,'VOICE_ASSET_CHANGED');assert.equal(failed.path,'python.exe');
  assert.equal(failed.verificationFailed,true);assert.equal(failed.downloadRequired,false);
  await writeFile(join(f.destination,'python.exe'),Buffer.alloc(1024*1024));
  const retry=[];await f.assets.prepare('asr',{engineId:'breeze',verifyOnly:true,onProgress:row=>retry.push(row)});
  assert.equal(retry.at(-1).hashedFiles,1,'unchanged successfully verified members survive a final-change failure');
  assert.equal((await f.assets.status('asr','breeze')).state,'ready');
});

test('source and archive registration changes reuse only the proof named by the old ready marker',async t=>{
  const f=await fixture(t,{members:12});await f.assets.resolve('asr','breeze');
  f.record.sourceId='official';f.record.archiveSha256='archive-2';
  assert.equal((await f.assets.status('asr','breeze')).state,'verification-needed');
  const progress=[];await f.assets.prepare('asr',{engineId:'breeze',verifyOnly:true,onProgress:row=>progress.push(row)});
  assert.equal(progress.at(-1).hashedFiles,0,'unchanged signed inventory and identities do not require another payload read');
  assert.match(await readFile(join(f.destination,'.ready'),'utf8'),/^asr:official:archive-2:/);
  // A cached proof never substitutes for validating the current package's signed descriptor.
  f.record.manifest.files[0].sha256='0'.repeat(64);
  await assert.rejects(f.assets.prepare('asr',{engineId:'breeze',verifyOnly:true}),{code:'VOICE_ASSET_MANIFEST'});
});

test('an unrelated receipt cannot authorize zero-read migration when the exact previous proof is absent',async t=>{
  const f=await fixture(t,{members:8});await f.assets.resolve('asr','breeze');
  const proofFile=join(f.root,'voice/components/.verification',sha(Buffer.from(f.proof+'|'+f.destination))+'.json');
  const unrelated=JSON.parse(await readFile(proofFile,'utf8'));unrelated.proof='asr:unrelated:other:'+f.proof.split(':')[3];
  await writeFile(join(f.root,'voice/components/.verification','unrelated.json'),JSON.stringify(unrelated));await rm(proofFile);
  f.record.sourceId='official';f.record.archiveSha256='archive-2';
  const progress=[];await f.assets.prepare('asr',{engineId:'breeze',verifyOnly:true,onProgress:row=>progress.push(row)});
  assert.equal(progress.at(-1).hashedFiles,8);
});

test('resolve with an invalid persistent cache and aged files makes exactly one full pass',async t=>{
  const f=await fixture(t);await f.assets.resolve('asr','breeze');
  const proofFile=join(f.root,'voice/components/.verification',sha(Buffer.from(f.proof+'|'+f.destination))+'.json');let events;
  for(let attempt=1;attempt<=5;attempt++){
    await age(f);const receipt=JSON.parse(await readFile(proofFile,'utf8'));receipt.rootIdentity='invalidated';await writeFile(proofFile,JSON.stringify(receipt));
    events=[];const progress=[],watcher=watch(f.destination,{recursive:true},(type,path)=>events.push({type,path:String(path)}));
    const resolved=await f.open().resolve('asr','breeze',{onProgress:row=>progress.push(row)});await sleep(100);watcher.close();
    t.diagnostic(JSON.stringify({attempt,events:events.length,verificationDetails:resolved.verificationDetails,passes:progress.filter(row=>row.completedFiles===1).length}));
    assert.equal(resolved.verificationDetails.hashedFiles,32);assert.equal(progress.filter(row=>row.completedFiles===1).length,1);
    if(events.some(row=>row.type==='change'&&row.path.endsWith('.bin')))break;
  }
  assert.ok(events.some(row=>row.type==='change'&&row.path.endsWith('.bin')),'exercise an actual read-triggered filesystem notification');
});

for(const mode of ['hash','missing'])test('confirmed '+mode+' damage requests downloading but can be reverified without restarting',async t=>{
  const f=await fixture(t,{members:8,bytes:4096}),path=join(f.destination,'python.exe');
  if(mode==='hash')await writeFile(path,Buffer.alloc(4096,99));else await rm(path);
  await assert.rejects(f.assets.prepare('asr',{engineId:'breeze',verifyOnly:true}),{code:mode==='hash'?'VOICE_ASSET_HASH':'VOICE_ASSET_MISSING'});
  const failed=await f.assets.status('asr','breeze');assert.equal(failed.downloadRequired,true);assert.equal(failed.verificationFailed,true);assert.equal(failed.state,mode==='hash'?'error':'missing');
  await writeFile(path,Buffer.alloc(4096));const retry=[];await f.assets.prepare('asr',{engineId:'breeze',verifyOnly:true,onProgress:row=>retry.push(row)});
  assert.equal(retry.at(-1).hashedFiles,5,'the three successful siblings from the failed batch are reusable');assert.equal((await f.assets.status('asr','breeze')).state,'ready');
});

test('a watcher error uses metadata fallback and still rejects a real change',async t=>{
  const f=await fixture(t,{members:48,bytes:1024*1024}),verificationWorker=join(f.root,'watcher-error-worker.mjs');
  await writeFile(verificationWorker,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const watch=fs.watch;fs.watch=(...args)=>{const watcher=watch(...args);setTimeout(()=>watcher.emit('error',Error('synthetic OS watcher failure')),0);return watcher;};syncBuiltinESMExports();await import(${JSON.stringify(new URL('../src/voice/asset-verifier-worker.mjs',import.meta.url).href)});`);
  const assets=f.open({verificationWorker}),first=await assets.resolve('asr','breeze');assert.equal(first.verificationDetails.watching,false);
  let changed=false;
  await assert.rejects(assets.prepare('asr',{engineId:'breeze',verifyOnly:true,onProgress:row=>{
    if(!changed&&row.completedFiles){changed=true;writeFileSync(join(f.destination,'python.exe'),Buffer.alloc(1024*1024,99));}
  }}),error=>error.code==='VOICE_ASSET_CHANGED'&&error.path==='python.exe');
  assert.equal((await assets.status('asr','breeze')).downloadRequired,false);
});

test('a stopped verification worker leaves a retryable status and restarts on the next verification',async t=>{
  const f=await fixture(t,{members:8}),verificationWorker=join(f.root,'stopped-once-worker.mjs'),sentinel=join(f.root,'worker-started');
  await writeFile(verificationWorker,`import {existsSync,writeFileSync} from 'node:fs';
if(!existsSync(${JSON.stringify(sentinel)})){writeFileSync(${JSON.stringify(sentinel)},'once');process.exit(19);}await import(${JSON.stringify(new URL('../src/voice/asset-verifier-worker.mjs',import.meta.url).href)});`);
  const assets=f.open({verificationWorker});await assert.rejects(assets.prepare('asr',{engineId:'breeze',verifyOnly:true}),{code:'VOICE_ASSET_VERIFY'});
  const failed=await assets.status('asr','breeze');assert.equal(failed.state,'verification-needed');assert.equal(failed.downloadRequired,false);assert.equal(failed.code,'VOICE_ASSET_VERIFY');assert.equal(failed.verificationFailed,true);
  await assets.prepare('asr',{engineId:'breeze',verifyOnly:true});assert.equal((await assets.status('asr','breeze')).state,'ready');
});
