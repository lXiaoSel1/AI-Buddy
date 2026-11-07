import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createVoiceProfiles} from '../src/voice/voice-profiles.mjs';

// Explicit offline import of an accepted audition snapshot, never an upload.
const [input,destination,receiptFile]=process.argv.slice(2);
if(!input||!destination||!receiptFile)throw Error('Pass accepted audition directory, isolated data directory and receipt path');
const audition=resolve(input),dataRoot=resolve(destination),profiles=createVoiceProfiles({dataRoot});
await mkdir(dataRoot,{recursive:true});
const manifest=JSON.parse(await readFile(join(audition,'manifest.json'),'utf8'));
const references={};
for(const engine of ['breeze','gpt'])references[engine]=JSON.parse(await readFile(join(audition,'REFERENCES-'+engine.toUpperCase()+'.json'),'utf8')).entries;
const imported=[];
for(const role of manifest.roles){
  const full=references.breeze[role.id];
  for(const engine of ['breeze','gpt']){
    const ref=references[engine][role.id];
    for(const source of [ref,full]){
      const bytes=await readFile(join(audition,source.file));
      if(bytes.length!==source.bytes||createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw Error('Accepted reference changed: '+role.id+'/'+engine);
    }
    const existing=await profiles.current({characterId:role.id,engine});
    const row=existing??await profiles.importProfile({characterId:role.id,engine,label:role.label+' · 已确认r04',
      references:{calm:{file:join(audition,ref.file),text:ref.text,language:ref.language}},
      cloudReference:{file:join(audition,full.file),text:full.text,language:full.language}});
    const actual=await profiles.resolve({characterId:role.id,engine,profileId:row.id,profileVersion:row.version});
    if(actual.sha256!==ref.sha256||actual.cloudReference.sha256!==full.sha256)throw Error('Existing candidate profile differs; preserved without overwrite');
    imported.push({characterId:role.id,engine,profileId:row.id,version:row.version,localReferenceSHA256:ref.sha256,cloudReferenceSHA256:full.sha256});
  }
}
await writeFile(resolve(receiptFile),JSON.stringify({candidateOnly:true,audition,dataRoot,profiles:imported,cloudUploads:0},null,2));
console.log(JSON.stringify({profiles:imported.length,roles:manifest.roles.length,cloudUploads:0}));
