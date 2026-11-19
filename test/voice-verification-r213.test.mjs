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
const receiptPath=(f,proof=f.proof)=>join(f.root,'voice/components/.verification',sha(Buffer.from(proof+'|'+f.destination))+'.json');
async function assertDurableProof(f,proof=f.proof){
 const target=receiptPath(f,proof),saved=JSON.parse(await readFile(target,'utf8'));
 assert.equal(saved.proof,proof);assert.equal(saved.destination,f.destination);assert.equal(saved.files.length,f.files.length);
 const byPath=new Map(saved.files.map(row=>[row.path,row]));
 for(const file of f.files){
   const info=await lstat(join(f.destination,file.path),{bigint:true});
   const identity=[info.dev,info.ino,info.nlink,info.size,info.mtimeNs,info.ctimeNs].join(':');
   assert.deepEqual(byPath.get(file.path),{path:file.path,identity,sha256:file.sha256});
 }
 return saved;
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
  const ready=await readFile(join(f.destination,'.ready'),'utf8');
  assert.match(ready,/^asr:legacy:archive-2:/);await assertDurableProof(f,ready);
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
  const ready=await readFile(join(f.destination,'.ready'),'utf8');
  assert.match(ready,/^asr:official:archive-2:/);await assertDurableProof(f,ready);
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

test('starting after a registration change requests verification without declaring intact files damaged',async t=>{
  const f=await fixture(t,{members:8});await f.assets.resolve('asr','breeze');
  f.record.sourceId='official';f.record.archiveSha256='archive-2';
  await assert.rejects(f.assets.resolve('asr','breeze'),{code:'VOICE_ASSET_VERIFY_REQUIRED'});
  const status=await f.assets.status('asr','breeze');assert.equal(status.state,'verification-needed');assert.equal(status.downloadRequired,false);
  const progress=[];await f.assets.prepare('asr',{engineId:'breeze',verifyOnly:true,onProgress:row=>progress.push(row)});
  assert.equal(progress.at(-1).hashedFiles,0);assert.equal((await f.assets.status('asr','breeze')).state,'ready');
});

test('a payload changed after its final metadata read is rejected in the same verification',async t=>{
  const f=await fixture(t,{members:8,bytes:4096}),verificationWorker=join(f.root,'late-change-worker.mjs'),receipt=join(f.root,'late-change.json');
  const python=join(f.destination,'python.exe'),later=join(f.destination,'lib/member-1.bin');
  await writeFile(verificationWorker,`import fs from 'node:fs';import promises from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const watch=fs.watch,stat=promises.lstat;let watcher,pythonStats=0,injected=false;
fs.watch=(...args)=>(watcher=watch(...args));
promises.lstat=async(path,...args)=>{
  const value=await stat(path,...args);
  if(String(path)===${JSON.stringify(python)}&&++pythonStats===2)watcher.emit('change','change','python.exe');
  if(String(path)===${JSON.stringify(later)}&&pythonStats>=3&&!injected){
    injected=true;let timer;
    const notified=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('No real late-write notification')),2000);watcher.once('change',(type,name)=>resolve({type,path:String(name)}));});
    await promises.writeFile(${JSON.stringify(python)},Buffer.alloc(4096,99));
    const event=await notified;clearTimeout(timer);await promises.writeFile(${JSON.stringify(receipt)},JSON.stringify({pythonStats,injected,event}));
  }
  return value;
};syncBuiltinESMExports();await import(${JSON.stringify(new URL('../src/voice/asset-verifier-worker.mjs',import.meta.url).href)});`);
  const assets=f.open({verificationWorker});let error;
  try{await assets.prepare('asr',{engineId:'breeze',verifyOnly:true});}catch(cause){error=cause;}
  const evidence=JSON.parse(await readFile(receipt,'utf8'));t.diagnostic(JSON.stringify(evidence));
  assert.equal(evidence.injected,true);assert.ok(evidence.pythonStats>=3);assert.equal(evidence.event.type,'change');assert.equal(evidence.event.path,'python.exe');
  assert.equal(error?.code,'VOICE_ASSET_CHANGED');assert.equal(error?.path,'python.exe');
});

test('continuous final-pass notifications fail within a bounded number of metadata reviews',{timeout:5000},async t=>{
  const f=await fixture(t,{members:8,bytes:4096}),verificationWorker=join(f.root,'continuous-change-worker.mjs'),receipt=join(f.root,'continuous-change.json');
  const python=join(f.destination,'python.exe'),later=join(f.destination,'lib/member-1.bin'),marker=join(f.destination,'.ready');
  await writeFile(verificationWorker,`import fs from 'node:fs';import promises from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const watch=fs.watch,stat=promises.lstat;let watcher,pythonStats=0,passes=0;
fs.watch=(...args)=>(watcher=watch(...args));
promises.lstat=async(path,...args)=>{
  const value=await stat(path,...args);
  if(String(path)===${JSON.stringify(python)}&&++pythonStats===2)watcher.emit('change','change','python.exe');
  if(String(path)===${JSON.stringify(later)}&&pythonStats>=3){
    let timer;const notified=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('No continuous write notification')),2000);watcher.once('change',(type,name)=>resolve({type,path:String(name)}));});
    await promises.writeFile(${JSON.stringify(marker)},${JSON.stringify(f.proof)});const event=await notified;clearTimeout(timer);
    await promises.writeFile(${JSON.stringify(receipt)},JSON.stringify({passes:++passes,event}));
  }
  return value;
};syncBuiltinESMExports();await import(${JSON.stringify(new URL('../src/voice/asset-verifier-worker.mjs',import.meta.url).href)});`);
  const assets=f.open({verificationWorker});await assert.rejects(assets.prepare('asr',{engineId:'breeze',verifyOnly:true}),{code:'VOICE_ASSET_CHANGED'});
  const evidence=JSON.parse(await readFile(receipt,'utf8'));t.diagnostic(JSON.stringify(evidence));
  assert.ok(evidence.passes>0&&evidence.passes<16);assert.equal(evidence.event.type,'change');assert.equal(evidence.event.path,'.ready');
});
test('unchanged Breeze proof writes no receipt or progress bytes after a watcher event or a fresh verifier',async t=>{
  const f=await fixture(t,{members:8,bytes:4096}),worker=join(f.root,'receipt-io-worker.mjs'),log=join(f.root,'receipt-io.jsonl');
  const directory=join(f.root,'voice/components/.verification'),proofFile=join(directory,sha(Buffer.from(f.proof+'|'+f.destination))+'.json');
  const scratch=join(f.destination,'lib/r17-work-scratch.bin');
  await writeFile(scratch,'before');
  await writeFile(worker,`import fs from 'node:fs';import io from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const actualWatch=fs.watch,actualWrite=io.writeFile,actualAppend=io.appendFile;
const destination=${JSON.stringify(directory)},log=${JSON.stringify(log)};
const event=value=>actualAppend(log,JSON.stringify(value)+'\\n');
fs.watch=(...args)=>{
 const watcher=actualWatch(...args);
 watcher.on('change',(_type,path)=>{if(String(path).endsWith('r17-work-scratch.bin'))void event({kind:'watch'});});
 return watcher;
};
for(const [kind,write] of [['writeFile',actualWrite],['appendFile',actualAppend]])io[kind]=async(path,value,...args)=>{
 if(String(path).startsWith(destination))await event({kind,bytes:Buffer.byteLength(value)});
 return write(path,value,...args);
};
syncBuiltinESMExports();await import(${JSON.stringify(new URL('../src/voice/asset-verifier-worker.mjs',import.meta.url).href)});`);
  const events=async()=>{try{return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return[];throw error;}};
  const stamps=async()=>Promise.all(f.files.map(({path})=>lstat(join(f.destination,path),{bigint:true}).then(row=>[row.dev,row.ino,row.nlink,row.size,row.mtimeNs,row.ctimeNs])));
  const assets=f.open({verificationWorker:worker}),first=await assets.resolve('asr','breeze');
  assert.equal(first.verificationDetails.hashedFiles,8);assert.equal(first.verificationDetails.watching,true);
  const metadata=await stamps(),before=await lstat(proofFile,{bigint:true}),initialWrites=(await events()).filter(e=>e.kind!=='watch').length;
  assert.ok(initialWrites>0,'initial complete check must persist a receipt');
  await writeFile(scratch,'after!');
  for(let n=0;n<150&&!(await events()).some(e=>e.kind==='watch');n++)await sleep(5);
  assert.ok((await events()).some(e=>e.kind==='watch'),'use a real payload-directory watch notification');
  const watched=await assets.resolve('asr','breeze');
  assert.equal(watched.verification,'metadata');assert.equal(watched.verificationDetails.checkedFiles,8);
  assert.equal(watched.verificationDetails.hashedFiles,0);
  assert.deepEqual(await stamps(),metadata);
  const watchedWrites=(await events()).filter(e=>e.kind!=='watch').slice(initialWrites);
  const watchedMtime=(await lstat(proofFile,{bigint:true})).mtimeNs;
  await assets.close();
  const reopened=await f.open({verificationWorker:worker}).resolve('asr','breeze');
  assert.equal(reopened.verification,'metadata');assert.equal(reopened.verificationDetails.hashedFiles,0);
  const allWrites=(await events()).filter(e=>e.kind!=='watch').slice(initialWrites);
  assert.deepEqual({watcherBytes:watchedWrites.reduce((sum,row)=>sum+row.bytes,0),reopenBytes:allWrites.slice(watchedWrites.length).reduce((sum,row)=>sum+row.bytes,0)},
    {watcherBytes:0,reopenBytes:0});
  assert.equal(watchedMtime,before.mtimeNs);assert.equal((await lstat(proofFile,{bigint:true})).mtimeNs,before.mtimeNs);
});

test('a cancelled changed-identity pass publishes the pending complete proof on retry without rehashing',async t=>{
 const f=await fixture(t,{members:8,bytes:4096}),target=receiptPath(f),controller=new AbortController();
 await f.assets.resolve('asr','breeze');
 const initial=await assertDurableProof(f),input=join(f.destination,'python.exe');
 await writeFile(input,await readFile(input));let hashed=false;
 await assert.rejects(f.assets.resolve('asr','breeze',{signal:controller.signal,onProgress:row=>{
  if(row.hashedFiles>0){hashed=true;controller.abort();}
 }}),{name:'AbortError'});
 assert.equal(hashed,true,'the same bytes have a changed file identity and were verified before cancel');
 assert.deepEqual(JSON.parse(await readFile(target,'utf8')),initial,'cancellation did not publish the complete receipt');
 const pending=(await readFile(target+'.partial','utf8')).trim().split('\n').flatMap(line=>JSON.parse(line).files);
 assert.deepEqual(pending.map(row=>row.path),['python.exe']);
 const retry=await f.assets.resolve('asr','breeze');
 assert.equal(retry.verificationDetails.hashedFiles,0);
 const updated=await assertDurableProof(f);
 assert.notEqual(updated.files.find(row=>row.path==='python.exe').identity,initial.files.find(row=>row.path==='python.exe').identity);
 await assert.rejects(lstat(target+'.partial'),{code:'ENOENT'});
});

test('a reopened partial-only proof publishes the missing complete receipt even with no new hashes',async t=>{
 const f=await fixture(t,{members:8,bytes:4096}),target=receiptPath(f);
 await f.assets.resolve('asr','breeze');const saved=await assertDurableProof(f);
 await f.assets.close();
 await writeFile(target+'.partial',JSON.stringify(saved)+'\n');
 await rm(target);
 const reopened=await f.open().resolve('asr','breeze');
 assert.equal(reopened.verificationDetails.hashedFiles,0);
 const current=await assertDurableProof(f);assert.equal(current.rootIdentity,saved.rootIdentity);
 await assert.rejects(lstat(target+'.partial'),{code:'ENOENT'});
});
