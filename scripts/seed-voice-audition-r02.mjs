import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {writeAtomic} from '../src/atomic-write.mjs';

const [archive,sampleRoot,destination] = process.argv.slice(2,5).map(value=>resolve(value));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const load = async path => JSON.parse(await readFile(path,'utf8'));
const snapshot = await readFile(join(sampleRoot,'VOICE-SAMPLES.json'));
const current = JSON.parse(snapshot);
const originalPath = join(archive,'samples','VOICE-SAMPLES.json');
const originalBytes = await readFile(originalPath);
const original = JSON.parse(originalBytes);
const results = join(archive,'results');
const oldIndex = await load(join(results,'manifest.json'));
const oldRefs = await load(join(results,'REFERENCES.json'));
if (oldIndex.sourceManifestSHA !== sha(originalBytes) || oldRefs.sourceManifestSHA !== oldIndex.sourceManifestSHA) throw Error('Archived source index mismatch');
const sourceManifestSHA = sha(snapshot);
const index = {schemaVersion:1,sourceManifestSHA,text:oldIndex.text,engines:{},roles:[]};
const references = {schemaVersion:1,sourceManifestSHA,entries:{}};
const reused = [], changed = [], copies = [];

async function verifiedFile(root,row) {
  if (!row?.file || !/^(?:audio|comparison)\/[A-Za-z0-9/_-]+\.wav$/.test(row.file)) throw Error('Invalid archived file path');
  const bytes = await readFile(join(root,row.file));
  if (bytes.length !== row.bytes || sha(bytes) !== row.sha256) throw Error('Archived bytes do not match: '+row.file);
  return bytes;
}
for (const role of current.roles) {
  const id = role.id;
  const key = id+':calm';
  const row = current.entries[key];
  const sample = {file:row.file,bytes:row.bytes,sha256:row.sha256,durationMs:row.durationMs};
  if (row.authorized !== true) throw Error('Unauthorized source '+id);
  await verifiedFile(sampleRoot,sample);
  const prior = original.entries[key], old = oldIndex.roles.find(item=>item.id===id), ref = oldRefs.entries[id];
  const item = {id,label:role.name,color:role.color,sample,gpt:{state:'pending'},breeze:{state:'pending'}};
  if (prior?.authorized === true && prior.sha256 === row.sha256 && prior.text === row.text && prior.language === row.language &&
      old?.sample.sha256 === row.sha256 && old.comparisonReference?.sha256 === ref?.sha256 && ref?.sourceSHA === row.sha256 &&
      ['gpt','breeze'].every(engine=>old[engine]?.state === 'ready' && old[engine].sourceSHA === row.sha256 && old[engine].referenceSHA === ref.sha256)) {
    await verifiedFile(join(archive,'samples'),prior);
    const files = [ref,old.gpt,old.breeze];
    for (const file of files) copies.push({file:file.file,bytes:await verifiedFile(results,file)});
    references.entries[id] = ref;
    Object.assign(item,{comparisonReference:old.comparisonReference,gpt:old.gpt,breeze:old.breeze});
    reused.push(id);
  } else changed.push(id);
  index.roles.push(item);
}

const expected = (process.argv.length > 5 ? process.argv.slice(5) : ['deepseek','hunyuan','kimi','minimax']).sort();
if (JSON.stringify([...changed].sort()) !== JSON.stringify(expected)) throw Error('Audition scope differs: '+changed.join(', '));
await mkdir(destination);
for (const item of copies) {
  const path = join(destination,item.file);
  await mkdir(dirname(path),{recursive:true});
  await writeFile(path,item.bytes,{flag:'wx'});
}
const write = (name,value) => writeAtomic(join(destination,name),JSON.stringify(value,null,2)+'\n');
write('REFERENCES.json',references);
write('manifest.json',index);
write('REUSE-RECEIPT.json',{schemaVersion:1,archivedSourceSHA:oldIndex.sourceManifestSHA,sourceManifestSHA,reused,changed,
  verifiedArchivedWavFiles:copies.length,sourceVerification:['authorization','sha256','byte length','verbatim transcript','language']});
console.log(JSON.stringify({reused,changed,files:copies.length}));

