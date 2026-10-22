import {readFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {validateFrameSequence} from '../src/frame-sequence.mjs';

export const INTERACTION_IDS=Object.freeze(['sleep-enter','sleep-loop','wake','throw-start','throw-loop','land-recover']);
// Both the original DeepSeek sample and complete character batches use the same checks.
export function readInteractionResources(directory,{edition,characterIds}){
 const root=resolve(directory),index=JSON.parse(readFileSync(resolve(root,'runtime-manifest.json'),'utf8'));
 if(index.complete!==true||!['30fps','60fps'].includes(index.edition)||index.edition!==edition)throw Error('Interaction manifest is incomplete or frame rate differs');
 const entries=index.characters??(index.characterId?{[index.characterId]:{actions:index.actions}}:null);
 if(!entries||!Object.keys(entries).length||Object.keys(entries).some(id=>!characterIds.includes(id)))throw Error('Unknown interaction character');
 const files=[],indexed=new Map(),characters={};
 for(const file of index.files??[]){
  const parts=typeof file.path==='string'?file.path.split('/'):[];
  if(parts.length<5||parts[0]!=='assets'||parts[1]!=='interaction-samples'||!entries[parts[2]]||parts.some(p=>!p||p==='.'||p==='..')||file.path.includes('\\')||indexed.has(file.path))throw Error('Invalid or duplicate interaction destination');
  if(typeof file.source!=='string'||!Number.isSafeInteger(file.bytes)||file.bytes<=0||!/^[a-f0-9]{64}$/.test(file.sha256??''))throw Error('Invalid interaction file metadata');
  const from=resolve(root,file.source);if(!from.startsWith(root+sep))throw Error('Invalid interaction source');
  const bytes=readFileSync(from);if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('Interaction resource hash/length mismatch');
  const record={from,path:file.path,characterId:parts[2],sha256:file.sha256};files.push(record);indexed.set(file.path,record);
 }
 const used=new Set();
 for(const [characterId,value] of Object.entries(entries)){
  const actions=value.actions;if(!actions||Object.keys(actions).length!==INTERACTION_IDS.length)throw Error('Missing or unexpected interaction action');
  for(const id of INTERACTION_IDS){
   const clip=actions[id],fps=clip?.video?.fps??clip?.derivation?.targetFps;
   if(!clip||clip.characterId!==characterId||clip.actionId!==id||clip.backend!=='webm-alpha'||clip.canvas?.width!==576||clip.canvas?.height!==624||fps!==Number(edition.slice(0,2))||(clip.derivation?.targetFps!==undefined&&clip.derivation.targetFps!==fps))throw Error('Invalid character interaction clip: '+characterId+'/'+id);
   validateFrameSequence(clip);
   for(const ref of [clip.video,...Object.values(clip.staticFrames??{})]){
    const path=typeof ref.src==='string'&&ref.src.startsWith('./')?ref.src.slice(2):ref.src,record=indexed.get(path);
    if(!record||record.characterId!==characterId||ref.sha256!==record.sha256)throw Error('Clip refers to an unverified or different character resource');
    used.add(path);
   }
  }
  characters[characterId]=actions;
 }
 if(used.size!==indexed.size)throw Error('Unreferenced interaction resource');
 return {characters,files};
}
