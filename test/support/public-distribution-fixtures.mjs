import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mediaRows,indexRows,shaBytes} from '../../scripts/media-baseline-validation.mjs';
import {CHARACTER_IDS,APPROVED_BASELINE_SHA256,APPROVED_APPROVAL_SHA256} from '../../scripts/public-distribution-assets.mjs';
import {distributionFiles} from '../../scripts/build-distribution-202.mjs';
import {stageUpstreamMediaBuild} from '../../scripts/media-upstream-build.mjs';
import {fileURLToPath} from 'node:url';
const fixtureRepo=fileURLToPath(new URL('../..',import.meta.url));

export const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
export const save=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,Buffer.isBuffer(value)||typeof value==='string'?value:JSON.stringify(value));};
export function temporary(t){const dir=fs.mkdtempSync(path.join(tmpdir(),'buddy-public-distribution-'));t.after(()=>{if(path.dirname(dir)!==path.resolve(tmpdir())||!path.basename(dir).startsWith('buddy-public-distribution-'))throw Error('Unsafe test cleanup');fs.rmSync(dir,{recursive:true,force:true});});return dir;}
export const fileRow=(root,name)=>{const b=fs.readFileSync(path.join(root,name));return{path:name,bytes:b.length,sha256:shaBytes(b)};};
export function mediaFixture(t){
 const dir=temporary(t),editions=[],roots={},sourceAssets=[],assets={};
 for(const fps of[30,60]){const root=roots[fps]=path.join(dir,String(fps)),video='assets/pet-characters/deepseek/idle/motion.webm',bytes=Buffer.from('video-'+fps),clip={version:2,characterId:'deepseek',actionId:'idle',canvas:{width:576,height:624},anchor:{x:276,y:602},cycleMs:1000,loop:true,frames:[{timestampMs:0}],video:{src:'./'+video,sha256:shaBytes(bytes),bytes:bytes.length,fps,encodedFrameCount:fps}};
  save(path.join(root,'package.json'),{version:'2.0.2',animationProfile:fps+'fps'});save(path.join(root,video),bytes);save(path.join(root,'assets/still.webp'),'fixed-still');save(path.join(root,'assets/character-sequence-manifest.json'),{deepseek:{idle:clip}});save(path.join(root,'assets/frame-sequence-manifest.json'),{idle:clip});
  const index={version:1,appVersion:'1.9.2',edition:fps+'fps',defaultCharacter:'deepseek',shared:['assets/still.webp','assets/character-sequence-manifest.json','assets/frame-sequence-manifest.json'].map(p=>fileRow(root,p)),characters:{deepseek:[fileRow(root,video)]}};save(path.join(root,'assets/install-resource-index.json'),index);editions.push({fps,profile:fps+'fps',videos:mediaRows({deepseek:{idle:clip}},fps),index:indexRows(index),indexHeader:{version:1,appVersion:'1.9.2',edition:fps+'fps',defaultCharacter:'deepseek'}});assets[fps]=indexRows(index);
 }
 const legacyLockPath=path.join(dir,'legacy.json');save(legacyLockPath,{schemaVersion:1,appVersion:'1.9.2',editions});
 const base={schemaVersion:1,kind:'ai-buddy-optimized-media-baseline',appVersion:'1.9.2',inventorySha256:'a'.repeat(64),methodSha256:'b'.repeat(64),userReviewExportSha256:'c'.repeat(64),editions:editions.map(e=>({fps:e.fps,profile:e.profile,files:e.videos.map(row=>({...row,variant:'A',structuralPass:true,qualityWarnings:[]}))}))};
 const baselinePath=path.join(dir,'baseline.json'),approvalPath=path.join(dir,'approval.json');save(baselinePath,base);save(approvalPath,{schemaVersion:1,kind:'ai-buddy-optimized-media-approval',approved:true,approvedAt:'2026-10-24T23:51:32.183Z',mediaBaselineSha256:shaBytes(fs.readFileSync(baselinePath)),inventorySha256:base.inventorySha256,methodSha256:base.methodSha256,userReviewExportSha256:base.userReviewExportSha256,selected:base.editions.flatMap(e=>e.files)});
 return{dir,roots,assets,sourceAssets,legacyLockPath,baselinePath,approvalPath};
}
export function pythonFixture(t){
 const dir=temporary(t),candidate=path.join(dir,'candidate'),inventory={schemaVersion:1,kind:'ai-buddy-public-distribution-assets',applicationVersion:'2.0.2',mediaBaseVersion:'1.9.2',basis:{legacyLockSha256:'a'.repeat(64),optimizedBaselineSha256:APPROVED_BASELINE_SHA256,approvalSha256:APPROVED_APPROVAL_SHA256},sourceAssets:[],editions:[]},proof={schemaVersion:2,kind:'ai-buddy-public-distribution',ok:true,version:'2.0.2',applicationVersion:'2.0.2',mediaBaseVersion:'1.9.2',reencoded:0,workPluginIncluded:false,editions:[]};
 for(const fps of[30,60]){const root=path.join(candidate,fps+'fps/build'),characters={},videos=[];
  for(const id of CHARACTER_IDS){characters[id]=[];save(path.join(root,'assets/characters/'+id+'/still.webp'),'still-'+id);characters[id].push(fileRow(root,'assets/characters/'+id+'/still.webp'));
   for(let action=0;action<24;action++){const name='assets/characters/'+id+'/action-'+action+'.webm';save(path.join(root,name),'video-'+id+'-'+action+'-'+fps);const row=fileRow(root,name);characters[id].push(row);videos.push({key:id+'/action-'+action,characterId:id,actionId:'action-'+action,fps,...row,metadataSha256:'b'.repeat(64)});}
  }
  const food='assets/food/biscuit.webp';save(path.join(root,food),'source-bound-food');const shared=[fileRow(root,food)],index={version:1,appVersion:'2.0.2',edition:fps+'fps',defaultCharacter:'deepseek',shared,characters};save(path.join(root,'assets/install-resource-index.json'),index);save(path.join(root,'package.json'),{version:'2.0.2',animationProfile:fps+'fps'});save(path.join(root,'main.cjs'),'public-app');stageUpstreamMediaBuild(fixtureRepo,root);save(path.join(root,'ffmpeg-component-worker.mjs'),'fixture worker');
  const assets=indexRows(index);inventory.editions.push({fps,profile:fps+'fps',assets,videos});if(fps===30)inventory.sourceAssets=shared.map(row=>({...row,owner:'shared'}));proof.editions.push({fps,profile:fps+'fps',videos:264,mediaProof:{mode:'optimized-public',version:'2.0.2',mediaBaseVersion:'1.9.2',fps,videos:264,resources:assets.length,baselineSha256:APPROVED_BASELINE_SHA256},files:distributionFiles(root),resourceIndexSha256:shaBytes(fs.readFileSync(path.join(root,'assets/install-resource-index.json')))});
 }
 save(path.join(candidate,'root/README.md'),'public-fixture');save(path.join(candidate,'runtime/AI Buddy.exe'),'fixture-only-not-a-program');save(path.join(candidate,'runtime/resources/app/package.json'),{version:'2.0.2'});save(path.join(candidate,'runtime/runtime-manifest.json'),{version:'2.0.2',files:distributionFiles(path.join(candidate,'runtime'))});proof.roots=distributionFiles(path.join(candidate,'root'));proof.runtime={executable:'AI Buddy.exe',sha256:shaBytes(fs.readFileSync(path.join(candidate,'runtime/AI Buddy.exe'))),files:distributionFiles(path.join(candidate,'runtime'))};
 const inventoryPath=path.join(dir,'trusted-fixture-inventory.json'),raw=Buffer.from(JSON.stringify(inventory));save(inventoryPath,raw);save(path.join(candidate,'approved-assets.json'),raw);proof.approvedAssets={file:'approved-assets.json',sha256:shaBytes(raw),basis:inventory.basis};save(path.join(candidate,'media-proof.json'),proof);
 const rebind=()=>{for(const e of proof.editions){const root=path.join(candidate,e.profile,'build');e.files=distributionFiles(root);e.resourceIndexSha256=shaBytes(fs.readFileSync(path.join(root,'assets/install-resource-index.json')));}save(path.join(candidate,'media-proof.json'),proof);};
 return{dir,candidate,inventoryPath,inventorySha256:shaBytes(raw),proof,inventory,rebind};
}
