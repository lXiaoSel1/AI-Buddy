import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,link,rename,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVoiceAssets} from '../src/voice/runtime-assets.mjs';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'voice-r5-assets-')),seed=join(root,'seed'),directory=join(root,'package');await mkdir(seed);await mkdir(directory);
  const files=[];
  for(const path of ['python.exe','lib/deep/a.bin','lib/deep/b.bin']){
    const bytes=Buffer.alloc(4096,files.length+1);await mkdir(join(seed,path,'..'),{recursive:true});await writeFile(join(seed,path),bytes);
    files.push({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  const descriptor=Buffer.from(JSON.stringify({schemaVersion:1,platform:'win32',arch:'x64',kind:'asr',version:'1',python:'python.exe',files}));
  await writeFile(join(directory,'assets.json'),descriptor);
  const record={sourceId:'test-v1',archiveSha256:'archive-v1',directory,manifest:{files:[{path:'assets.json',bytes:descriptor.length,sha256:createHash('sha256').update(descriptor).digest('hex')}]}};
  const opened=[];const open=()=>{const assets=createVoiceAssets({dataRoot:root,resolveVoicePackage:async()=>({...record,shared:record})});opened.push(assets);return assets;};
  t.after(async()=>{for(const assets of opened)await assets.close();await rm(root,{recursive:true,force:true});});
  const assets=open();await assets.prepare('asr',{engineId:'breeze',localRoot:seed});return {root,assets,open,record};
}

test('a version hashes once, reuses a live watch, and across restart only rechecks metadata',async t=>{
  const f=await fixture(t),first=await f.assets.resolve('asr','breeze');
  assert.equal(first.verification,'full');assert.equal(first.verificationDetails.hashedFiles,3);
  const hot=await f.assets.resolve('asr','breeze');assert.equal(hot.verification,'reused');assert.equal(hot.verificationDetails.checkedFiles,0);assert.equal(hot.verificationDetails.hashedFiles,0);
  await f.assets.close();
  const cold=await f.open().resolve('asr','breeze');assert.equal(cold.verification,'metadata');assert.equal(cold.verificationDetails.checkedFiles,3);assert.equal(cold.verificationDetails.hashedFiles,0);
});

test('a deep file modification invalidates watched proof and a restart cannot trust old metadata',async t=>{
  const f=await fixture(t),first=await f.assets.resolve('asr','breeze'),path=join(first.root,'lib/deep/a.bin');
  await writeFile(path,Buffer.alloc(4096,99));
  await assert.rejects(f.assets.resolve('asr','breeze'),{code:'VOICE_ASSET_HASH'});
  await f.assets.close();await assert.rejects(f.open().resolve('asr','breeze'),{code:'VOICE_ASSET_HASH'});
});

test('unchanged bytes with changed identity rehash only the changed file and hardlinks remain rejected',async t=>{
  const f=await fixture(t),first=await f.assets.resolve('asr','breeze'),path=join(first.root,'lib/deep/a.bin');
  await writeFile(path,await readFile(path));
  const changed=await f.assets.resolve('asr','breeze');assert.equal(changed.verificationDetails.hashedFiles,1);assert.equal(changed.verificationDetails.checkedFiles,3);
  await link(path,join(f.root,'extra-hardlink'));
  await assert.rejects(f.assets.resolve('asr','breeze'),{code:'VOICE_ASSET_HASH'});
});

test('a ready marker without a host proof cannot bypass first-use hashing',async t=>{
  const f=await fixture(t),directory=join(f.root,'voice/components/asr');
  const [version]=await readdir(directory);await writeFile(join(directory,version,'python.exe'),Buffer.alloc(4096,99));
  await assert.rejects(f.assets.resolve('asr','breeze'),{code:'VOICE_ASSET_HASH'});
});

test('a damaged persisted proof forces full verification and changed install identity revokes admission',async t=>{
  const f=await fixture(t);await f.assets.resolve('asr','breeze');await f.assets.close();
  const directory=join(f.root,'voice/components/.verification'),[proof]=await readdir(directory);await writeFile(join(directory,proof),'invalid');
  const next=f.open(),verified=await next.resolve('asr','breeze');assert.equal(verified.verification,'full');assert.equal(verified.verificationDetails.hashedFiles,3);
  f.record.archiveSha256='archive-v2';await assert.rejects(next.resolve('asr','breeze'),{code:'VOICE_ASSET_HASH'});
});

test('replacing the component root renews its watch instead of watching the retired tree',async t=>{
  const f=await fixture(t),first=await f.assets.resolve('asr','breeze'),retired=join(f.root,'retired');
  await rename(first.root,retired);await cp(retired,first.root,{recursive:true});
  assert.equal((await f.assets.resolve('asr','breeze')).verificationDetails.hashedFiles,3);
  await writeFile(join(first.root,'lib/deep/a.bin'),Buffer.alloc(4096,99));
  await assert.rejects(f.assets.resolve('asr','breeze'),{code:'VOICE_ASSET_HASH'});
});

test('a watcher created before a failed first hash follows the replacement root after recovery',async t=>{
  const f=await fixture(t),parent=join(f.root,'voice/components/asr'),[version]=await readdir(parent),destination=join(parent,version),retired=join(f.root,'failed-first-root');
  await writeFile(join(destination,'lib/deep/a.bin'),Buffer.alloc(4096,99));
  await assert.rejects(f.assets.resolve('asr','breeze'),{code:'VOICE_ASSET_HASH'});
  await rename(destination,retired);await cp(join(f.root,'seed'),destination,{recursive:true});
  await writeFile(join(destination,'.ready'),await readFile(join(retired,'.ready')));
  assert.equal((await f.assets.resolve('asr','breeze')).verification,'full');
  await writeFile(join(destination,'lib/deep/a.bin'),Buffer.alloc(4096,88));
  await assert.rejects(f.assets.resolve('asr','breeze'),{code:'VOICE_ASSET_HASH'});
});
