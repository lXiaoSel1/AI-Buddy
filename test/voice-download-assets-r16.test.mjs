import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,stat,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {crc32,deflateRawSync} from 'node:zlib';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createVoiceAssets} from '../src/voice/runtime-assets.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function zip(files,{mutate}={}){
  const locals=[],centrals=[];let offset=0;
  for(const [path,raw] of files){
    const name=Buffer.from(path),body=deflateRawSync(raw),local=Buffer.alloc(30),central=Buffer.alloc(46),crc=crc32(raw)>>>0;
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(body.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(name.length,26);
    central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(8,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(body.length,20);central.writeUInt32LE(raw.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
    mutate?.({local,central,path});locals.push(local,name,body);centrals.push(central,name);offset+=30+name.length+body.length;
  }
  const central=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.size,8);end.writeUInt16LE(files.size,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,central,end]);
}
async function fixture(t,{archiveTransform,downloadTransform,stream,fetchOverride,directMode,descriptorTransform}={}){
  const root=await mkdtemp(join(tmpdir(),'voice-download-r16-')),records={},bodies=new Map(),opened=[],requests=[];
  for(const kind of ['asr','breeze','gpt']){
    const directory=join(root,'package-'+kind);await mkdir(directory);
    const payload=new Map([['python.exe',Buffer.from(kind+' python')],['lib/library.bin',Buffer.alloc(256*1024,7)]]);
    const files=[...payload].map(([path,bytes])=>({path,bytes:bytes.length,sha256:sha(bytes)}));
    const directUrl='https://downloads.example/'+kind+'-python.exe';
    if(directMode==='original')files[0].url=directUrl;
    descriptorTransform?.(files,kind);
    const descriptor=Buffer.from(JSON.stringify({schemaVersion:1,kind,platform:'win32',arch:'x64',version:'1',python:'python.exe',files}));
    const archived=new Map([...payload].filter(([path])=>!directMode||path!=='python.exe'));
    const archive=archiveTransform?.(archived,kind)??zip(archived),url='https://downloads.example/'+kind+'.zip';bodies.set(url,archive);bodies.set(directUrl,payload.get('python.exe'));
    const downloads={schemaVersion:1,assetsSha256:sha(descriptor),archives:[{id:kind+'-runtime',format:'zip',url,bytes:archive.length,sha256:sha(archive),files:[...archived.keys()]}],...(directMode==='override'?{directFiles:[{path:'python.exe',url:directUrl}]}:{})};
    downloadTransform?.(downloads,kind);
    const delivery=Buffer.from(JSON.stringify(downloads));await writeFile(join(directory,'assets.json'),descriptor);await writeFile(join(directory,'downloads.json'),delivery);
    records[kind]={directory,sourceId:'test',archiveSha256:'package-1',manifest:{files:[{path:'assets.json',bytes:descriptor.length,sha256:sha(descriptor)},{path:'downloads.json',bytes:delivery.length,sha256:sha(delivery)}]}};
  }
  const fetchImpl=async(url,options)=>{requests.push(String(url));if(fetchOverride)return fetchOverride(url,options,bodies);const bytes=bodies.get(String(url));return new Response(stream?stream(bytes,options):bytes);};
  const open=()=>{const assets=createVoiceAssets({dataRoot:root,fetchImpl,resolveVoicePackage:async id=>({...records[id.endsWith('breeze')?'breeze':'gpt'],shared:records.asr})});opened.push(assets);return assets;};
  const assets=open();t.after(async()=>{for(const asset of opened)await asset.close();await rm(root,{recursive:true,force:true});});return {root,assets,records,bodies,requests,open};
}

test('first-use prepares shared and the selected local engine from signed archives',async t=>{
  const f=await fixture(t);await f.assets.prepare('asr',{engineId:'breeze'});const result=await f.assets.prepareSelected({engineId:'breeze',provider:'local'});
  assert.equal(result.state,'ready');assert.deepEqual(result.components.map(row=>row.kind),['asr','breeze']);
  assert.deepEqual(f.requests,['https://downloads.example/asr.zip','https://downloads.example/breeze.zip']);
  assert.equal((await f.assets.status('gpt','gpt')).state,'missing');
  assert.equal(await readFile((await f.assets.resolve('asr','breeze')).python,'utf8'),'asr python');
  assert.equal(await readFile((await f.assets.resolve('breeze','breeze')).python,'utf8'),'breeze python');
});

test('cloud first-use downloads only shared runtime and status exposes a small delivery estimate',async t=>{
  const f=await fixture(t),before=await f.assets.status('asr','gpt');
  assert.equal(before.downloadAvailable,true);assert.equal(before.downloadBytes,f.bodies.get('https://downloads.example/asr.zip').length);
  const result=await f.assets.prepareSelected({engineId:'gpt',provider:'minimax'});
  assert.deepEqual(result.components.map(row=>row.kind),['asr']);assert.deepEqual(f.requests,['https://downloads.example/asr.zip']);
  assert.equal((await f.assets.status('gpt','gpt')).state,'missing');
});

test('same assets in a newly signed plugin are fully checked and reused in place without a download',async t=>{
  const f=await fixture(t);await f.assets.prepare('asr',{engineId:'breeze'});const original=await f.assets.resolve('asr','breeze'),identity=await stat(original.python);
  f.records.asr.archiveSha256='package-2';
  await assert.rejects(f.assets.resolve('asr','breeze'),{code:'VOICE_ASSET_HASH'});
  const progress=[],result=await f.assets.prepare('asr',{engineId:'breeze',onProgress:row=>progress.push(row)});
  assert.deepEqual(result,{state:'ready',reused:true});assert.equal(f.requests.length,1);
  assert.ok(progress.some(row=>row.phase==='verifying'&&row.hashedFiles===2));
  const renewed=await f.assets.resolve('asr','breeze');assert.equal((await stat(renewed.python)).ino,identity.ino);assert.ok(renewed.proof.includes('package-2'));
});

test('progress can cancel a stream before any file ends and removes only the owned stage',async t=>{
  const controller=new AbortController(),progress=[];
  const f=await fixture(t,{stream:bytes=>new ReadableStream({async pull(stream){await new Promise(resolve=>setTimeout(resolve,10));stream.enqueue(bytes.subarray(0,16));}})});
  await assert.rejects(f.assets.prepare('asr',{engineId:'breeze',signal:controller.signal,onProgress:row=>{progress.push(row);if(row.downloadReceivedBytes>0)controller.abort();}}),{name:'AbortError'});
  assert.ok(progress.some(row=>row.downloadReceivedBytes>0&&row.receivedBytes===0));
  assert.deepEqual(await readdir(join(f.root,'voice/components/asr')),[]);
  assert.equal((await f.assets.status('asr','breeze')).state,'missing');
});

for(const mode of ['original','override'])test('direct '+mode+' URLs retain per-file hashes alongside archived runtime files',async t=>{
  const f=await fixture(t,{directMode:mode});await f.assets.prepare('asr',{engineId:'breeze'});
  assert.deepEqual(f.requests,['https://downloads.example/asr-python.exe','https://downloads.example/asr.zip']);
  assert.equal(await readFile((await f.assets.resolve('asr','breeze')).python,'utf8'),'asr python');
});

for(const [name,mutate] of [
  ['asset binding',row=>row.assetsSha256='0'.repeat(64)],
  ['missing coverage',row=>row.archives[0].files.pop()],
  ['duplicate coverage',row=>row.archives[0].files.push('python.exe')],
  ['outside inventory',row=>row.archives[0].files.push('unknown.bin')],
  ['traversal',row=>row.archives[0].files[0]='../python.exe'],
  ['packed limit',row=>row.archives[0].bytes=2*1024**3+1],
  ['unsafe URL',row=>row.archives[0].url='https://user:secret@downloads.example/a.zip'],
  ['direct overlap',row=>row.directFiles=[{path:'python.exe',url:'https://downloads.example/python.exe'}]],
])test('invalid delivery '+name+' is rejected before any network request',async t=>{
  const f=await fixture(t,{downloadTransform:mutate});await assert.rejects(f.assets.prepare('asr',{engineId:'breeze'}));assert.equal(f.requests.length,0);
});

for(const [name,transform] of [
  ['undeclared file',files=>zip(new Map([...files,['extra.bin',Buffer.from('extra')]]))],
  ['symlink',files=>zip(files,{mutate:({central})=>central.writeUInt32LE(0xa1ff0000,38)})],
  ['directory',files=>zip(files,{mutate:({central})=>central.writeUInt32LE(0x10,38)})],
  ['unsupported flags',files=>zip(files,{mutate:({central,local})=>{central.writeUInt16LE(9,8);local.writeUInt16LE(9,6);}})],
  ['local mismatch',files=>zip(files,{mutate:({local})=>local.writeUInt16LE(1,10)})],
  ['extra field',files=>zip(files,{mutate:({central})=>central.writeUInt16LE(1,30)})],
  ['corrupted output',files=>zip(new Map([...files].map(([path,bytes])=>[path,Buffer.alloc(bytes.length,9)])))],
  ['overlapping payload',files=>{const bytes=zip(files),centralAt=bytes.readUInt32LE(bytes.length-6),second=centralAt+46+Buffer.byteLength('python.exe');bytes.writeUInt32LE(0,second+42);return bytes;}],
])test('signed '+name+' archive cannot become ready',async t=>{
  const f=await fixture(t,{archiveTransform:transform});await assert.rejects(f.assets.prepare('asr',{engineId:'breeze'}));
  assert.equal((await f.assets.status('asr','breeze')).state,'missing');assert.deepEqual(await readdir(join(f.root,'voice/components/asr')),[]);
});

test('compressed archive SHA is checked before extraction',async t=>{
  const f=await fixture(t);const url='https://downloads.example/asr.zip',bytes=Buffer.from(f.bodies.get(url));bytes[32]^=1;f.bodies.set(url,bytes);
  await assert.rejects(f.assets.prepare('asr',{engineId:'breeze'}),{code:'VOICE_ASSET_HASH'});assert.equal((await f.assets.status('asr','breeze')).state,'missing');
});

test('revocation during extraction prevents promotion and cleans the active stage',async t=>{
  const f=await fixture(t);await assert.rejects(f.assets.prepare('asr',{engineId:'breeze',onProgress:row=>{if(row.phase==='extracting'&&row.receivedBytes)f.records.asr.archiveSha256='revoked';}}),{code:'VOICE_ASSET_REVOKED'});
  assert.equal((await f.assets.status('asr','breeze')).state,'missing');assert.deepEqual(await readdir(join(f.root,'voice/components/asr')),[]);
});

test('same-assets rebind never admits altered files or hardlinks',async t=>{
  const f=await fixture(t);await f.assets.prepare('asr',{engineId:'breeze'});const original=await f.assets.resolve('asr','breeze');
  f.records.asr.archiveSha256='package-2';await link(original.python,join(f.root,'linked-python'));
  await assert.rejects(f.assets.prepare('asr',{engineId:'breeze'}),{code:'VOICE_ASSET_HASH'});assert.equal(f.requests.length,1);
});

test('closing assets cancels an in-flight header request without leaving a ready component',async t=>{
  let began;const started=new Promise(resolve=>began=resolve),f=await fixture(t,{fetchOverride:()=>{began();return new Promise(()=>{});}});
  const running=f.assets.prepare('asr',{engineId:'breeze'}),verdict=assert.rejects(running,{name:'AbortError'});await started;await f.assets.close();await verdict;
  assert.equal((await f.assets.status('asr','breeze')).state,'missing');
});

test('offline import can copy a hardlinked source into independent verified destination files',async t=>{
  const f=await fixture(t),seed=join(f.root,'offline');await mkdir(join(seed,'lib'),{recursive:true});
  await writeFile(join(seed,'python.exe'),'asr python');await writeFile(join(seed,'lib/library.bin'),Buffer.alloc(256*1024,7));
  await link(join(seed,'python.exe'),join(f.root,'source-hardlink'));
  await f.assets.prepare('asr',{engineId:'breeze',localRoot:seed});const ready=await f.assets.resolve('asr','breeze');
  assert.equal((await stat(ready.python)).nlink,1);assert.equal(await readFile(ready.python,'utf8'),'asr python');assert.deepEqual(f.requests,[]);
});

test('delivery metadata must remain bound to the owning signed package',async t=>{
  const f=await fixture(t);await f.assets.status('asr','breeze');
  await writeFile(join(f.records.asr.directory,'downloads.json'),'{}');
  await assert.rejects(f.assets.prepare('asr',{engineId:'breeze'}),{code:'VOICE_ASSET_MANIFEST'});assert.deepEqual(f.requests,[]);
});

test('same-host redirects work but cross-host redirects and redirect loops stay bounded',async t=>{
  const f=await fixture(t,{fetchOverride:(url,options,bodies)=>String(url).endsWith('/asr.zip')?new Response(null,{status:302,headers:{location:'/asr-final.zip'}}):new Response(bodies.get('https://downloads.example/asr.zip'))});
  await f.assets.prepare('asr',{engineId:'breeze'});assert.equal(f.requests.length,2);
  const rejected=await fixture(t,{fetchOverride:()=>new Response(null,{status:302,headers:{location:'https://untrusted.example/runtime.zip'}})});
  await assert.rejects(rejected.assets.prepare('asr',{engineId:'breeze'}),{code:'VOICE_ASSET_SOURCE'});assert.equal(rejected.requests.length,1);
  const loop=await fixture(t,{fetchOverride:()=>new Response(null,{status:302,headers:{location:'/loop.zip'}})});
  await assert.rejects(loop.assets.prepare('asr',{engineId:'breeze'}),{code:'VOICE_ASSET_DOWNLOAD'});assert.equal(loop.requests.length,5);
});

for(const phase of ['headers','body'])test('a stalled download '+phase+' fails on the bounded idle deadline',async t=>{
  let began;const started=new Promise(resolve=>began=resolve);
  const f=await fixture(t,{fetchOverride:()=>{if(phase==='headers'){began();return new Promise(()=>{});}return new Response(new ReadableStream({pull(){began();return new Promise(()=>{});}}));}});
  t.mock.timers.enable({apis:['setTimeout']});
  try{
    const running=f.assets.prepare('asr',{engineId:'breeze'}),verdict=assert.rejects(running,{code:'VOICE_ASSET_DOWNLOAD'});await started;await nextTurn();t.mock.timers.tick(60001);await verdict;
    assert.equal((await f.assets.status('asr','breeze')).state,'missing');
  }finally{t.mock.timers.reset();}
});

test('a signed archive stream cannot exceed its pinned compressed byte count',async t=>{
  const f=await fixture(t,{fetchOverride:(url,options,bodies)=>new Response(Buffer.concat([bodies.get(String(url)),Buffer.from('extra')]))});
  await assert.rejects(f.assets.prepare('asr',{engineId:'breeze'}),{code:'VOICE_ASSET_HASH'});assert.equal((await f.assets.status('asr','breeze')).state,'missing');
});
