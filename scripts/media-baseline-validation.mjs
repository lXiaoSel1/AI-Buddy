import {readFileSync,lstatSync,realpathSync,readdirSync} from 'node:fs';
import {resolve,join,relative,isAbsolute,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {loadPublicAssetInventory,assertSourceAssetBindings} from './public-distribution-assets.mjs';

export const stableJson=value=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(v=>JSON.parse(stableJson(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(stableJson(value[k]))])):value);
export const shaBytes=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const same=(a,b)=>stableJson(a)===stableJson(b);
const assert=(ok,why)=>{if(!ok)throw Error('Media validation: '+why);};
const validSha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const entryId=x=>`${x.key}|${x.fps}`;
export function clipMetadataHash(clip){const value=structuredClone(clip);delete value.video.sha256;delete value.video.bytes;return shaBytes(stableJson(value));}
export function mediaRows(manifest,fps){return Object.entries(manifest).flatMap(([characterId,actions])=>Object.entries(actions).map(([actionId,clip])=>({key:characterId+'/'+actionId,characterId,actionId,fps,path:clip.video.src.replace(/^\.\//,''),sha256:clip.video.sha256,bytes:clip.video.bytes,metadataSha256:clipMetadataHash(clip)})));}
export function indexRows(index){return [...index.shared.map(x=>({...x,owner:'shared'})),...Object.entries(index.characters).flatMap(([owner,rows])=>rows.map(x=>({...x,owner})))];}
function diskFile(root,path){
  assert(typeof path==='string'&&path.startsWith('assets/')&&!path.includes('\\')&&!path.split('/').some(p=>p==='..'||p===''||p==='.'),'unsafe resource path');
  const p=resolve(root,path),lexical=relative(root,p);assert(!isAbsolute(lexical)&&!lexical.startsWith('..'),'resource escapes root');
  let ancestor=root;assert(!lstatSync(ancestor).isSymbolicLink(),'resource path contains a link');
  for(const segment of path.split('/')){ancestor=join(ancestor,segment);assert(!lstatSync(ancestor).isSymbolicLink(),'resource path contains a link');}
  assert(lstatSync(p).isFile(),'resource must be a regular file');
  const actual=relative(realpathSync(root),realpathSync(p));assert(!isAbsolute(actual)&&!actual.startsWith('..'),'resource resolves outside root');return p;
}
function statOrNull(path){try{return lstatSync(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
export function assertFreshCandidateOutput(path){
  let ancestor=resolve(path);assert(!statOrNull(ancestor),'optimized candidate output already exists; use a new directory');
  for(;;){const stat=statOrNull(ancestor);assert(!stat?.isSymbolicLink(),'candidate output has a linked ancestor');const parent=dirname(ancestor);if(parent===ancestor)break;ancestor=parent;}
}
function unique(rows,label){const map=new Map();for(const row of rows){const key=entryId(row);assert(!map.has(key),'duplicate '+label+' '+key);assert(validSha(row.sha256)&&Number.isSafeInteger(row.bytes)&&row.bytes>0,'invalid identity '+label+' '+key);map.set(key,row);}return map;}

export function validateMediaBuild({resources,legacyLockPath,baselinePath,approvalPath,interactionSamples,applicationVersion,mediaBaseVersion,assetInventory,sourceAssets=[],approvedMedia,publicEvidence=false}){
  assert(typeof publicEvidence==='boolean','public evidence flag must be boolean');
  assert(!publicEvidence||(!baselinePath&&!approvalPath&&!approvedMedia&&!assetInventory&&!sourceAssets.length&&!interactionSamples),'public evidence cannot be mixed with caller-supplied approval');
  assert(!interactionSamples||(!baselinePath&&!approvalPath&&!approvedMedia),'cannot combine approved media with interaction samples');
  assert(!approvedMedia||(!baselinePath&&!approvalPath),'public and original approval evidence cannot be mixed');
  const root=resolve(resources),legacy=read(legacyLockPath),pkg=read(join(root,'package.json'));
  if(publicEvidence){const repo=resolve(import.meta.dirname,'..'),inventory=loadPublicAssetInventory(repo);assertSourceAssetBindings(repo,inventory);assert(shaBytes(readFileSync(legacyLockPath))===inventory.basis.legacyLockSha256,'public legacy inventory differs');approvedMedia=inventory;applicationVersion=inventory.applicationVersion;mediaBaseVersion=inventory.mediaBaseVersion;const edition=inventory.editions.find(value=>value.profile===pkg.animationProfile);assert(edition,'unknown public edition');assetInventory=edition.assets;sourceAssets=inventory.sourceAssets;}
  assert((applicationVersion===undefined)===(mediaBaseVersion===undefined),'application and media versions must be supplied together');
  assert((mediaBaseVersion??legacy.appVersion)===legacy.appVersion,'media base version differs');
  assert(pkg.version===(applicationVersion??legacy.appVersion),'application version differs');
  const edition=legacy.editions.find(x=>x.profile===pkg.animationProfile);assert(edition,'unknown frame-rate edition');
  const chars=read(join(root,'assets/character-sequence-manifest.json')),mirror=read(join(root,'assets/frame-sequence-manifest.json'));
  assert(same(mirror,chars.deepseek),'DeepSeek mirror differs');
  const actual=mediaRows(chars,edition.fps),actualMap=unique(actual,'manifest'),oldMap=unique(edition.videos,'legacy');
  assert(actualMap.size===oldMap.size,'video coverage changed');
  for(const [id,row]of actualMap){const old=oldMap.get(id);assert(old&&old.path===row.path&&old.metadataSha256===row.metadataSha256,'timing, geometry or ownership changed: '+id);}
  const changed=actual.some(x=>{const old=oldMap.get(entryId(x));return old.sha256!==x.sha256||old.bytes!==x.bytes;});
  assert(Boolean(baselinePath)===Boolean(approvalPath),'baseline and approval must be supplied together');
  assert(!changed||baselinePath||approvedMedia,'changed media requires a new baseline and user approval');
  let mode='legacy',baselineSha256=null;
  if(approvedMedia){
    assert(applicationVersion&&mediaBaseVersion&&assetInventory&&approvedMedia.schemaVersion===1&&approvedMedia.kind==='ai-buddy-public-distribution-assets'&&approvedMedia.applicationVersion===applicationVersion&&approvedMedia.mediaBaseVersion===mediaBaseVersion&&approvedMedia.basis?.optimizedBaselineSha256==='12ac599d424e678acb1c7f964c65551fdc48dc40ac31ea47facb253256a7b871'&&approvedMedia.basis?.approvalSha256==='30f610d52dc03aee82baaddd31e1f081abd2be22758c3e66e7a74235e30428fb','public approval provenance differs');
    const allOld=unique(legacy.editions.flatMap(e=>e.videos),'all legacy'),allNew=unique(approvedMedia.editions.flatMap(e=>e.videos),'approved public');
    assert(allOld.size===allNew.size,'public approval does not cover every video');
    for(const[id,row]of allNew){const old=allOld.get(id);assert(old&&row.path===old.path&&row.metadataSha256===old.metadataSha256,'public media timing, geometry or ownership changed '+id);}
    for(const row of actual){const approved=allNew.get(entryId(row));assert(approved&&approved.bytes===row.bytes&&approved.sha256===row.sha256,'resource differs from approved public video '+entryId(row));}
    mode='optimized-public';baselineSha256=approvedMedia.basis.optimizedBaselineSha256;
  }
  if(baselinePath){
    mode='optimized';const raw=readFileSync(baselinePath),base=JSON.parse(raw),approval=read(approvalPath);baselineSha256=shaBytes(raw);
    assert(base.schemaVersion===1&&base.kind==='ai-buddy-optimized-media-baseline'&&base.appVersion===legacy.appVersion,'unsupported media baseline');
    assert(approval.schemaVersion===1&&approval.kind==='ai-buddy-optimized-media-approval'&&approval.approved===true&&typeof approval.approvedAt==='string'&&Number.isFinite(Date.parse(approval.approvedAt)),'explicit user approval missing');
    assert(approval.mediaBaselineSha256===baselineSha256,'approval belongs to another baseline');
    for(const key of ['inventorySha256','methodSha256','userReviewExportSha256'])assert(validSha(base[key])&&approval[key]===base[key],'approval provenance differs: '+key);
    const allOld=unique(legacy.editions.flatMap(e=>e.videos),'all legacy');
    const allNew=unique(base.editions.flatMap(e=>e.files),'baseline');const choices=unique(approval.selected,'approval');
    assert(allNew.size===allOld.size&&choices.size===allOld.size,'approval does not cover every video');
    for(const [id,row]of allNew){
      const old=allOld.get(id),choice=choices.get(id);assert(old&&choice,'unknown or missing choice '+id);
      assert(row.path===old.path&&row.metadataSha256===old.metadataSha256&&row.structuralPass===true,'unverified structure '+id);
      assert(['A','B','C','D'].includes(row.variant)&&choice.variant===row.variant&&choice.sha256===row.sha256&&choice.bytes===row.bytes,'choice identity differs '+id);
      assert(Array.isArray(row.qualityWarnings),'missing quality status '+id);
      if(row.requiresManualSelection)assert(choice.decisionSource==='manual','item requires a manual version choice '+id);
      if(row.sourceUnavailable)assert(row.variant==='A'&&choice.decisionSource==='manual','missing-source item requires manual retention of A '+id);
      if(row.qualityWarnings.length){assert(choice.decisionSource==='manual','warning item not manually selected '+id);if(row.variant!=='A')assert(choice.qualityWarningsAccepted===true,'quality warning not accepted '+id);}
      if(row.variant==='A')assert(row.sha256===old.sha256&&row.bytes===old.bytes,'A is not the unchanged current file '+id);
    }
    for(const row of actual){const approved=allNew.get(entryId(row));assert(approved.sha256===row.sha256&&approved.bytes===row.bytes,'resource differs from approved video '+entryId(row));}
  }
  const index=read(join(root,'assets/install-resource-index.json')),indexed=indexRows(index),lockIndex=edition.index;
  const indexVersion=publicEvidence?applicationVersion:applicationVersion&&[legacy.appVersion,applicationVersion].includes(index.appVersion)?index.appVersion:legacy.appVersion;
  assert(same(Object.fromEntries(Object.entries(index).filter(([k])=>!['shared','characters'].includes(k))),{...edition.indexHeader,appVersion:indexVersion}),'resource index header changed');
  assert((assetInventory?indexed.length>=lockIndex.length:indexed.length===lockIndex.length)&&new Set(indexed.map(x=>x.path)).size===indexed.length,'resource index coverage changed');
  const locked=new Map(lockIndex.map(x=>[x.path,x])),videoPaths=new Set(actual.map(x=>x.path));
  const approvedAssets=assetInventory?new Map(assetInventory.map(row=>[row.path,row])):null,sourceOwned=new Map(sourceAssets.map(row=>[row.path,row])),identity=(a,b)=>a&&b&&a.bytes===b.bytes&&a.sha256===b.sha256&&a.owner===b.owner;
  if(approvedAssets)assert(approvedAssets.size===assetInventory.length&&lockIndex.every(row=>indexed.some(value=>value.path===row.path)),'approved resource coverage differs');
  const physicallyVerified=new Set();
  for(const row of indexed){
    const before=locked.get(row.path),sourceRow=approvedAssets&&sourceOwned.get(row.path);assert((before&&before.owner===row.owner)||(sourceRow&&identity(sourceRow,row)),'resource ownership changed '+row.path);
    if(approvedAssets)assert(identity(approvedAssets.get(row.path),row),'approved asset differs '+row.path);
    if(!videoPaths.has(row.path)&&!['assets/frame-sequence-manifest.json','assets/character-sequence-manifest.json'].includes(row.path)&&!sourceRow)assert(row.bytes===before.bytes&&row.sha256===before.sha256,'non-video asset changed '+row.path);
    const file=diskFile(root,row.path),bytes=readFileSync(file);assert(bytes.length===row.bytes&&shaBytes(bytes)===row.sha256,'resource hash or size differs '+row.path);
    physicallyVerified.add(row.path);
  }
  if(approvedAssets){
    const physical=[];function visit(directory){for(const entry of readdirSync(directory,{withFileTypes:true})){const file=join(directory,entry.name);assert(!entry.isSymbolicLink(),'resource path contains a link');if(entry.isDirectory())visit(file);else{assert(entry.isFile(),'resource must be a regular file');const name=relative(root,file).replaceAll('\\','/');if(name!=='assets/install-resource-index.json')physical.push(name);}}}visit(join(root,'assets'));
    assert(physical.length===approvedAssets.size&&physical.every(name=>approvedAssets.has(name)),'physical asset coverage differs from approved inventory');
    const present=new Set(indexed.map(row=>row.path));for(const row of approvedAssets.values()){if(!present.has(row.path))assert(identity(sourceOwned.get(row.path),row),'unindexed asset lacks source binding '+row.path);if(!physicallyVerified.has(row.path)){const bytes=readFileSync(diskFile(root,row.path));assert(bytes.length===row.bytes&&shaBytes(bytes)===row.sha256,'approved physical asset differs '+row.path);}}
  }
  for(const row of actual){const indexedRow=indexed.find(x=>x.path===row.path);assert(indexedRow&&indexedRow.bytes===row.bytes&&indexedRow.sha256===row.sha256,'manifest and resource index differ '+entryId(row));}
  return {mode,version:pkg.version,mediaBaseVersion:legacy.appVersion,fps:edition.fps,videos:actual.length,resources:approvedAssets?.size??indexed.length,baselineSha256};
}
