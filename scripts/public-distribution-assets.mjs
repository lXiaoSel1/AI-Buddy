import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const APPLICATION_VERSION='2.0.13',MEDIA_BASE_VERSION='1.9.2';
export const APPROVED_BASELINE_SHA256='12ac599d424e678acb1c7f964c65551fdc48dc40ac31ea47facb253256a7b871';
export const APPROVED_APPROVAL_SHA256='30f610d52dc03aee82baaddd31e1f081abd2be22758c3e66e7a74235e30428fb';
export const PUBLIC_ASSET_INVENTORY_SHA256='4a20f703900d4c7c113ecb5cbaae84c67a85233aa6d74ac8b7d80f0ea2fc73e8';
export const CHARACTER_IDS=Object.freeze(['deepseek','claude','grok','seed','kimi','qwen','minimax','chatgpt','gemini','glm','hunyuan']);
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>{throw Error('Distribution validation: '+message);};
export function assertNoLinkedAncestors(input){
 if(!path.isAbsolute(input))fail('absolute path required');
 for(let item=path.resolve(input);;){let stat;try{stat=fs.lstatSync(item);}catch(error){if(error.code!=='ENOENT')throw error;}if(stat?.isSymbolicLink())fail('linked ancestor: '+item);const parent=path.dirname(item);if(parent===item)break;item=parent;}
}
const overlaps=(left,right)=>{const a=path.resolve(left).toLowerCase(),b=path.resolve(right).toLowerCase(),prefix=value=>value.endsWith(path.sep)?value:value+path.sep;return a===b||a.startsWith(prefix(b))||b.startsWith(prefix(a));};
export function assertDistributionPaths({inputs=[],outputs=[],fresh=[]}){
 for(const file of [...inputs,...outputs])assertNoLinkedAncestors(file);
 for(const output of outputs)for(const input of inputs)if(overlaps(output,input))fail('input/output overlap');
 for(let i=0;i<outputs.length;i++)for(const other of outputs.slice(i+1))if(overlaps(outputs[i],other))fail('output/output overlap');
 for(const file of fresh)if(fs.existsSync(file))fail('fresh output required');
}
export function assertPublicPath(name){
 if(/(^|\/)bili-media\/|(^|\/)(?:ffmpeg|ffplay|ffprobe|whisper-cli)\.exe$|(^|\/)ggml-[^/]+\.bin$/i.test(name))fail('Upstream media binaries are not redistributed');
 if(typeof name!=='string'||!name||path.isAbsolute(name)||name.split('/').some(v=>!v||v==='.'||v==='..'||/[\\<>:"|?*\x00-\x1f]/.test(v)||/[. ]$/.test(v)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v)))fail('unsafe public path');
 if(/(^|\/)(?:local|test-data|receipts|node_modules|\.ssh|\.git)(\/|$)|work-collaboration|(?:^|\/)(?:\.env|companion\.json|accounts-v1\.sqlite|runtime-audit\.jsonl)$/i.test(name))fail('private or deferred public file: '+name);
}
export function inventoryMap(rows,{owners=false}={}){
 if(!Array.isArray(rows))fail('file inventory must be an array');const map=new Map(),folded=new Set();
 for(const row of rows){assertPublicPath(row?.path);const key=row.path.toLowerCase();if(folded.has(key)||!Number.isSafeInteger(row.bytes)||row.bytes<0||!/^[a-f0-9]{64}$/.test(row.sha256??'')||owners&&!['shared',...CHARACTER_IDS].includes(row.owner))fail('duplicate or invalid file identity');folded.add(key);map.set(row.path,row);}
 return map;
}
export function validatePublicAssetInventory(value){
 if(value?.schemaVersion!==1||value.kind!=='ai-buddy-public-distribution-assets'||value.applicationVersion!==APPLICATION_VERSION||value.mediaBaseVersion!==MEDIA_BASE_VERSION||value.basis?.optimizedBaselineSha256!==APPROVED_BASELINE_SHA256||value.basis?.approvalSha256!==APPROVED_APPROVAL_SHA256||!Array.isArray(value.editions)||value.editions.length!==2)fail('unsupported approved asset inventory');
 const source=inventoryMap(value.sourceAssets,{owners:true});
 for(const row of source.values())if(row.owner!=='shared'||!/^assets\/(?:group-thumbnails|group-scene|card-games|food|pet-glove-v2|theme|pet-glove-tint)\//.test(row.path))fail('unapproved source UI scope');
 const editions=new Set();
 for(const edition of value.editions){if(![30,60].includes(edition.fps)||edition.profile!==edition.fps+'fps'||editions.has(edition.fps))fail('duplicate or unknown edition');editions.add(edition.fps);const assets=inventoryMap(edition.assets,{owners:true}),videos=inventoryMap(edition.videos),identities=new Set();if(videos.size!==264||edition.videos.length!==264)fail('complete approved video coverage required');
  for(const video of edition.videos){const asset=assets.get(video.path),identity=video.characterId+'/'+video.actionId;if(!CHARACTER_IDS.includes(video.characterId)||video.key!==identity||video.fps!==edition.fps||identities.has(identity)||!/^[a-f0-9]{64}$/.test(video.metadataSha256??'')||!asset||asset.owner!==video.characterId||asset.sha256!==video.sha256||asset.bytes!==video.bytes)fail('approved video identity differs');identities.add(identity);}
  for(const id of CHARACTER_IDS)if(edition.videos.filter(v=>v.characterId===id).length!==24)fail('each character requires 24 actions');
  if([...assets.keys()].filter(name=>name.endsWith('.webm')).length!==264)fail('unapproved extra video');
  for(const row of source.values()){const expected=assets.get(row.path);if(!expected||['bytes','sha256','owner'].some(key=>expected[key]!==row[key]))fail('source UI inventory differs');}
 }
 return value;
}
export function loadPublicAssetInventory(repo){
 const file=path.join(repo,'scripts/media-baselines/public-204-assets.json');assertNoLinkedAncestors(file);const raw=fs.readFileSync(file);if(sha256(raw)!==PUBLIC_ASSET_INVENTORY_SHA256)fail('bundled approved asset inventory changed');return validatePublicAssetInventory(JSON.parse(raw));
}
export function assertSourceAssetBindings(repo,inventory){
 for(const row of inventory.sourceAssets){const file=path.join(repo,row.path);assertNoLinkedAncestors(file);const bytes=fs.readFileSync(file);if(bytes.length!==row.bytes||sha256(bytes)!==row.sha256)fail('source UI resource changed: '+row.path);}
}
export function distributionIndex(header,edition){
 const strip=({owner,...row})=>row;return {...header,appVersion:APPLICATION_VERSION,edition:edition.profile,shared:edition.assets.filter(row=>row.owner==='shared').map(strip),characters:Object.fromEntries(CHARACTER_IDS.map(id=>[id,edition.assets.filter(row=>row.owner===id).map(strip)]))};
}
// Recompute the public inventory from distributed media and checked-in UI assets. No original private receipt is needed.
// The bundled hash-bound inventory remains the selection certificate; this function cannot approve a new media choice.
export async function rebuildPublicAssetInventory({repo,resources30,resources60}){
 const {mediaRows}=await import('./media-baseline-validation.mjs');
 const template=loadPublicAssetInventory(repo),result=structuredClone(template);assertSourceAssetBindings(repo,template);
 for(const edition of result.editions){const root=edition.fps===30?resources30:resources60;assertNoLinkedAncestors(root);const manifest=JSON.parse(fs.readFileSync(path.join(root,'assets/character-sequence-manifest.json'),'utf8')),actual=new Map(mediaRows(manifest,edition.fps).map(row=>[row.key,row]));
  for(const video of edition.videos){const row=actual.get(video.key);if(!row||Object.keys(video).some(key=>row[key]!==video[key]))fail('public video metadata changed');}if(actual.size!==264)fail('public video coverage changed');
  const names=[];function visit(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isSymbolicLink())fail('linked asset');if(entry.isDirectory())visit(file);else if(entry.isFile()){const name=path.relative(root,file).replaceAll('\\','/');if(name!=='assets/install-resource-index.json')names.push(name);}else fail('unsupported asset');}}visit(path.join(root,'assets'));if(names.length!==edition.assets.length||names.some(name=>!edition.assets.some(row=>row.path===name)))fail('public asset coverage changed');
  for(const row of edition.assets){const file=path.join(root,row.path);assertNoLinkedAncestors(file);const bytes=fs.readFileSync(file);row.bytes=bytes.length;row.sha256=sha256(bytes);}
 }
 const raw=Buffer.from(JSON.stringify(result)+'\n');if(sha256(raw)!==PUBLIC_ASSET_INVENTORY_SHA256)fail('recomputed public inventory differs from approved selection');return raw;
}
