import test from 'node:test';
import assert from 'node:assert/strict';
import io,{link,mkdir,mkdtemp,readdir,rename,rm,utimes,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBuiltinCloudVoice} from '../src/voice/builtin-cloud.mjs';

function cloudService(t,dataRoot){
  const service=createBuiltinCloudVoice({
    dataRoot,now:()=>Date.parse('2040-01-01T00:00:00Z'),characters:()=>[],
    settings:{get:async()=>({})},asr:{status:async()=>({state:'missing'}),close:async()=>{}},
    fetchImpl:async()=>assert.fail('unexpected provider request'),
  });
  t.after(()=>service.close());
  return service;
}


test('cloud voice loading removes only stale single-link atomic candidates',async t=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'builtin-partials-r6-'));
  t.after(()=>rm(dataRoot,{recursive:true,force:true}));
  const voice=join(dataRoot,'voice'),cloud=join(voice,'cloud');
  await mkdir(cloud,{recursive:true});
  const candidate=(target,id)=>target+'.12345678-1234-4234-8234-'+String(id).padStart(12,'0')+'.partial';
  const original='builtin-v1.json',recovered='builtin-recovered-v1-12.json',local='builtin-local-fallback-v1.json';
  const old=new Date(Date.now()-11*60*1000);
  async function stale(directory,name){
    const file=join(directory,name);
    await writeFile(file,'synthetic fixture');
    await utimes(file,old,old);
    return file;
  }

  const recent=candidate(original,2),nonmatch=original+'.manual.partial',directory=candidate(original,3);
  const hardLink=candidate(original,4),symbolicLink=candidate(original,5),source='unrelated.txt';
  const wrongUuid=original+'.12345678-1234-1234-1234-000000000001.partial';
  await writeFile(join(cloud,original),JSON.stringify({version:1,route:'local:breeze',accounts:{},choices:{},bindings:{},savedAccounts:{}}));
  await stale(cloud,candidate(original,1));
  await stale(cloud,candidate(recovered,1));
  await stale(voice,candidate(local,1));
  await stale(cloud,candidate(local,1));
  await stale(voice,candidate(original,1));
  await stale(cloud,nonmatch);
  await stale(cloud,wrongUuid);
  await writeFile(join(cloud,recent),'recent fixture');
  await mkdir(join(cloud,directory));
  await utimes(join(cloud,directory),old,old);
  const busy=candidate(original,6),busyPath=await stale(cloud,busy);
  const sourcePath=await stale(cloud,source);
  await link(sourcePath,join(cloud,hardLink));
  const symbolicLinkPath=await stale(cloud,symbolicLink);
  // File symlink creation requires privileges that the Windows test runner lacks.
  const originalLstat=io.lstat;
  t.mock.method(io,'lstat',async (path,...args)=>path===symbolicLinkPath
    ? {isSymbolicLink:()=>true,isFile:()=>false,nlink:1,mtimeMs:Number(old)}
    : originalLstat(path,...args));
  const originalUnlink=io.unlink;
  const unlink=t.mock.method(io,'unlink',async path=>{
    if(path===busyPath)throw Object.assign(new Error('Synthetic sharing violation'),{code:'EPERM'});
    return originalUnlink(path);
  });
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});

  const service=cloudService(t,dataRoot);
  assert.equal((await service.snapshot()).status,'off');
  assert.ok(unlink.mock.calls.some(call=>call.arguments[0]===busyPath));
  assert.deepEqual((await readdir(cloud)).sort(),
    [original,candidate(local,1),recent,nonmatch,wrongUuid,directory,hardLink,symbolicLink,source,busy].sort());
  assert.deepEqual((await readdir(voice)).sort(),['cloud',candidate(original,1)].sort());
});

test('cloud voice loading skips a linked cloud directory',async t=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'builtin-partials-r6-linked-'));
  t.after(()=>rm(dataRoot,{recursive:true,force:true}));
  const cloud=join(dataRoot,'voice','cloud');
  await mkdir(cloud,{recursive:true});
  const originalLstat=io.lstat,originalReaddir=io.readdir;
  t.mock.method(io,'lstat',async path=>path===cloud?{isSymbolicLink:()=>true}:originalLstat(path));
  const read=t.mock.method(io,'readdir',async (...args)=>originalReaddir(...args));
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});

  assert.equal((await cloudService(t,dataRoot).snapshot()).status,'unavailable');
  assert.ok(read.mock.calls.every(call=>call.arguments[0]!==cloud));
});


test('cloud voice cleanup preserves candidates replaced during enumeration or eligibility checks',async t=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'builtin-partials-r6-replaced-'));
  t.after(()=>rm(dataRoot,{recursive:true,force:true}));
  const voice=join(dataRoot,'voice'),cloud=join(voice,'cloud');
  await mkdir(cloud,{recursive:true});
  const cloudCandidate=join(cloud,'builtin-v1.json.12345678-1234-4234-8234-000000000001.partial');
  const localCandidate=join(voice,'builtin-local-fallback-v1.json.12345678-1234-4234-8234-000000000002.partial');
  const old=new Date(Date.now()-11*60*1000);
  for(const candidate of [cloudCandidate,localCandidate]){
    await writeFile(candidate,'synthetic fixture');
    await utimes(candidate,old,old);
  }
  const originalLstat=io.lstat,originalReaddir=io.readdir;
  let cloudEnumerated=false,localChecks=0;
  t.mock.method(io,'readdir',async path=>{
    const names=await originalReaddir(path);
    if(path===cloud)cloudEnumerated=true;
    return names;
  });
  t.mock.method(io,'lstat',async (path,...args)=>{
    if(path===cloud&&cloudEnumerated)return {isSymbolicLink:()=>true};
    const info=await originalLstat(path,...args);
    if(path===localCandidate&&++localChecks===1){
      // A different file with an equally old mtime must still be preserved.
      const replacement=join(voice,'replacement');
      await writeFile(replacement,'new candidate');
      await utimes(replacement,old,old);
      await rename(replacement,path);
    }
    return info;
  });
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});

  await cloudService(t,dataRoot).snapshot();
  const outcomes=await Promise.allSettled([originalLstat(cloudCandidate),originalLstat(localCandidate)]);
  assert.deepEqual(outcomes.map(outcome=>outcome.status),['fulfilled','fulfilled']);
});
