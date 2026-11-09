import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const builder=resolve(import.meta.dirname,'../tools/build-voice-downloads.py');
const finalizer=resolve(import.meta.dirname,'../tools/finalize-voice-downloads.mjs');
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'voice-r16-pack-')),source=join(root,'source'),out=join(root,'out');
  await mkdir(source);t.after(()=>rm(root,{recursive:true,force:true}));
  const entries=[['python.exe','runtime'],['lib/a.bin','dependency'],['model.bin','upstream-weight']];
  const files=[];
  for(const [path,value]of entries){const bytes=Buffer.from(value);await mkdir(join(source,path,'..'),{recursive:true});await writeFile(join(source,path),bytes);files.push({path,bytes:bytes.length,sha256:hash(bytes),...(path==='model.bin'?{url:'https://example.org/pinned/model.bin'}:{})});}
  const manifest=join(root,'assets.json');await writeFile(manifest,JSON.stringify({schemaVersion:1,platform:'win32',arch:'x64',kind:'asr',version:'1',python:'python.exe',files}));
  const run=(...extra)=>spawnSync('py',['-3',builder,'--manifest',manifest,'--source',source,'--out',out,'--part-bytes','12',...extra],{encoding:'utf8',windowsHide:true});
  return {root,source,out,manifest,files,run};
}
test('resource pack supplies missing runtime bytes without copying pinned upstream weights',async t=>{
  const f=await fixture(t),result=f.run();assert.equal(result.status,0,result.stderr);
  const plan=JSON.parse(await readFile(join(f.out,'downloads.template.json'),'utf8'));
  assert.equal(plan.assetsSha256,hash(await readFile(f.manifest)));assert.equal(plan.archives.length,2);
  assert.deepEqual(plan.archives.flatMap(row=>row.files).sort(),['lib/a.bin','python.exe']);
  for(const row of plan.archives){const bytes=await readFile(join(f.out,row.assetName));assert.equal(bytes.length,row.bytes);assert.equal(hash(bytes),row.sha256);assert.equal(Object.hasOwn(row,'url'),false);}
  const receipt=JSON.parse(await readFile(join(f.out,'PACKING.json'),'utf8'));
  assert.equal(receipt.publicDownloadReady,false);assert.equal(receipt.directBytes,15);assert.equal(receipt.packedInputBytes,17);
});
test('packaging rejects source bytes differing from the trusted inventory',async t=>{
  const f=await fixture(t);await writeFile(join(f.source,'python.exe'),'changed');
  const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/inventory|hash|size/i);
  await assert.rejects(readFile(join(f.out,'downloads.template.json')),{code:'ENOENT'});
});
test('delivery overrides bind an exact inventory file and never accept another hash',async t=>{
  const f=await fixture(t),override=join(f.root,'direct.json');
  await writeFile(override,JSON.stringify({directFiles:[{...f.files[0],url:'https://example.org/revision/python.exe',sha256:'0'.repeat(64)}]}));
  const result=f.run('--direct-files',override);assert.notEqual(result.status,0);assert.match(result.stderr,/override|inventory|hash/i);
});

test('release staging binds all three real archives to their exact inventories without claiming publication',async t=>{
  const f=await fixture(t),resources=join(f.root,'resources'),plugins=join(f.root,'plugins'),out=join(f.root,'metadata');
  await mkdir(resources);await mkdir(plugins);
  for(const [kind,name]of [['asr','voice-shared-runtime'],['breeze','voice-breeze'],['gpt','voice-gpt-sovits']]){
    const directory=join(plugins,name);await mkdir(directory);
    const manifest=join(directory,'assets.json');await writeFile(manifest,JSON.stringify({schemaVersion:1,platform:'win32',arch:'x64',kind,version:'1',python:'python.exe',files:f.files}));
    const result=spawnSync('py',['-3',builder,'--manifest',manifest,'--source',f.source,'--out',join(resources,kind)],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);
  }
  const result=spawnSync(process.execPath,[finalizer,'--resources='+resources,'--plugins='+plugins,'--out='+out,'--base-url=https://fixture.invalid/assets'],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);
  const receipt=JSON.parse(await readFile(join(out,'DELIVERY-METADATA.json'),'utf8'));assert.equal(receipt.publicUrlsVerified,false);assert.equal(receipt.signed,false);assert.equal(receipt.published,false);assert.equal(receipt.files.length,3);
  const metadata=JSON.parse(await readFile(join(out,'voice-breeze/downloads.json'),'utf8'));assert.equal(metadata.archives[0].url,'https://fixture.invalid/assets/voice-breeze-runtime-001.zip');assert.equal(Object.hasOwn(metadata.archives[0],'assetName'),false);
});
