import {build} from 'esbuild';
import {existsSync,readFileSync,mkdirSync,readdirSync,copyFileSync,writeFileSync,linkSync,statSync,unlinkSync,constants} from 'node:fs';
import {resolve,join,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {CHARACTER_EXPRESSIONS} from '../src/character-expressions.generated.mjs';
import {checkReleaseVersion,checkResourceVersion} from './check-release-version.mjs';
import {readInteractionResources} from './interaction-resources.mjs';
import {buildPetButtons} from './build-pet-buttons.mjs';
import {validateMediaBuild,assertFreshCandidateOutput} from './media-baseline-validation.mjs';
import {buildManagedProcessGuard} from './build-managed-process-guard.mjs';
import {createOwnedCandidateOutput} from './owned-candidate-output.mjs';
import {upstreamMediaMode,stageUpstreamMediaBuild} from './media-upstream-build.mjs';
const root=resolve(import.meta.dirname,'..'),resources=process.argv.find(a=>a.startsWith('--resources='))?.slice(12);
const releaseState=checkReleaseVersion(root),upstreamMedia=upstreamMediaMode(process.argv.slice(2));
if(!resources)throw Error('Pass --resources=<build folder from the matching portable release>');
const outputName=process.argv.find(a=>a.startsWith('--out='))?.slice(6)??'development';
if(!/^[a-zA-Z0-9_-]+$/.test(outputName))throw Error('Output must be a single candidate directory name');
if(process.argv.includes('--copy-assets')&&process.argv.includes('--link-assets'))throw Error('Choose only one asset materialization mode');
const source=resolve(resources),finalOut=join(root,'builds',outputName),linkAssets=!process.argv.includes('--copy-assets');
let linkedAssetFiles=0,linkedAssetBytes=0,copiedAssetFiles=0,copiedAssetBytes=0,reusedAssetFiles=0;
assertFreshCandidateOutput(finalOut);
const mediaArg=prefix=>process.argv.find(arg=>arg.startsWith(prefix))?.slice(prefix.length);
const samplesArg=mediaArg('--interaction-samples=');
const mediaProof=validateMediaBuild({resources:source,legacyLockPath:join(root,'scripts/media-baselines/r192-r5.json'),baselinePath:mediaArg('--media-baseline='),approvalPath:mediaArg('--media-approval='),publicEvidence:process.argv.includes('--public-evidence'),interactionSamples:samplesArg});
console.log('Media baseline validation: '+JSON.stringify(mediaProof));
if(!existsSync(join(source,'assets/frame-sequence-manifest.json')))throw Error('Resource manifest missing');
checkResourceVersion(releaseState.version,JSON.parse(readFileSync(join(source,'package.json'),'utf8')).version,releaseState);
const proof=JSON.parse(readFileSync(join(root,'assets/cg-references/maid-left.source.json'),'utf8'));
for(const[file,hash]of [['assets/maid-left.webp',proof.sourceSha256],['assets/cg-references/maid-left.png',proof.pngSha256],...Object.values(CHARACTER_EXPRESSIONS).flatMap(r=>Object.values(r.expressions).map(a=>[a.src,a.sha256]))])if(createHash('sha256').update(readFileSync(resolve(source,file))).digest('hex')!==hash)throw Error('Reference/expression resources differ from this release: '+file);
const candidateOutput=createOwnedCandidateOutput(join(root,'builds'),outputName),out=candidateOutput.stagePath;
try{
const sequences=JSON.parse(readFileSync(join(source,'assets/frame-sequence-manifest.json'),'utf8')),previews=JSON.parse(readFileSync(join(source,'assets/gallery-preview-manifest.json'),'utf8'));
const characterManifest=join(source,'assets/character-sequence-manifest.json');
const characters=existsSync(characterManifest)?JSON.parse(readFileSync(characterManifest,'utf8')):{deepseek:sequences};
const approvedIndex=JSON.parse(readFileSync(join(source,'assets/install-resource-index.json'),'utf8'));
const indexedAssets=new Map([...(approvedIndex.shared??[]),...Object.values(approvedIndex.characters??{}).flat()].map(row=>[row.path,row]));
let sampleFiles=[];
if(samplesArg){
  if(!linkAssets||outputName==='development')throw Error('Unapproved interaction samples require an isolated linked candidate');
  const batch=readInteractionResources(samplesArg,{edition:JSON.parse(readFileSync(join(source,'package.json'),'utf8')).animationProfile,characterIds:Object.keys(characters)});
  for(const [characterId,actions] of Object.entries(batch.characters)){Object.assign(characters[characterId],actions);if(characterId==='deepseek')Object.assign(sequences,actions);}
  sampleFiles=batch.files.map(file=>({...file,to:join(out,file.path)}));
}
if(Object.keys(characters).length!==11)throw Error('AI Buddy requires the matching eleven-character resources');
function copyAssets(from,to,prefix='assets'){
  mkdirSync(to,{recursive:true});
  for(const entry of readdirSync(from,{withFileTypes:true})){
    const a=join(from,entry.name),b=join(to,entry.name),assetPath=prefix+'/'+entry.name;
    if(from===join(source,'assets')&&['frame-sequence-manifest.json','character-sequence-manifest.json','install-resource-index.json'].includes(entry.name))continue;
    if(entry.isDirectory()){copyAssets(a,b,assetPath);continue;}
    if(!entry.isFile())throw Error('Unsupported resource entry');
    const input=statSync(a);
    // Some source-tree chrome assets also appear in the approved resource tree.
    // A fresh output may encounter them twice within this one build; never overwrite either copy.
    if(existsSync(b)){
      const old=statSync(b);
      if(old.size!==input.size||createHash('sha256').update(readFileSync(b)).digest('hex')!==createHash('sha256').update(readFileSync(a)).digest('hex'))throw Error('Duplicate asset differs inside this candidate: '+assetPath);
      reusedAssetFiles++;continue;
    }
    const identity=indexedAssets.get(assetPath),immutableMedia=linkAssets&&/\.(webm|webp|png)$/i.test(assetPath)&&identity;
    if(immutableMedia){
      if(input.size!==identity.bytes||createHash('sha256').update(readFileSync(a)).digest('hex')!==identity.sha256)throw Error('Indexed immutable media changed before linking: '+assetPath);
      linkSync(a,b);
      const linked=statSync(b);
      if(linked.dev!==input.dev||linked.ino!==input.ino)throw Error('Indexed media did not retain source identity: '+assetPath);
      linkedAssetFiles++;linkedAssetBytes+=input.size;
    }else{
      copyFileSync(a,b,constants.COPYFILE_EXCL);
      copiedAssetFiles++;copiedAssetBytes+=input.size;
    }
  }
}
copyAssets(join(source,'assets'),join(out,'assets'));
buildPetButtons(root,out);
buildManagedProcessGuard(root,out);
if(existsSync(join(root,'assets/group-thumbnails')))copyAssets(join(root,'assets/group-thumbnails'),join(out,'assets/group-thumbnails'),'assets/group-thumbnails');
if(existsSync(join(root,'assets/group-scene')))copyAssets(join(root,'assets/group-scene'),join(out,'assets/group-scene'),'assets/group-scene');
if(existsSync(join(root,'assets/food')))copyAssets(join(root,'assets/food'),join(out,'assets/food'),'assets/food'); // shop artwork (2.0 UI)
if(existsSync(join(root,'assets/pet-glove-v2')))copyAssets(join(root,'assets/pet-glove-v2'),join(out,'assets/pet-glove-v2'),'assets/pet-glove-v2');
// Theme backdrops, ornaments, heads and window/tray icons (UI polish 1.9.0): app chrome, shared by every edition.
if(existsSync(join(root,'assets/theme')))copyAssets(join(root,'assets/theme'),join(out,'assets/theme'),'assets/theme');
// Glove cursors with the cuff in each theme's accent (design 5.4); pet-glove-v2 stays the untinted fallback.
if(existsSync(join(root,'assets/pet-glove-tint')))copyAssets(join(root,'assets/pet-glove-tint'),join(out,'assets/pet-glove-tint'),'assets/pet-glove-tint');
const listFiles=(dir,prefix='')=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?listFiles(join(dir,entry.name),prefix+entry.name+'/'):entry.isFile()?[prefix+entry.name]:[]);
for(const file of sampleFiles){mkdirSync(dirname(file.to),{recursive:true});if(existsSync(file.to)){if(createHash('sha256').update(readFileSync(file.to)).digest('hex')!==file.sha256)throw Error('Existing candidate sample differs; use a new candidate output');}else linkSync(file.from,file.to);}
// These generated manifests belong to this candidate. Never overwrite an inherited hardlink.
function ownedJson(name,value){const file=join(out,'assets',name);if(existsSync(file))unlinkSync(file);writeFileSync(file,JSON.stringify(value));}
ownedJson('frame-sequence-manifest.json',sequences);ownedJson('character-sequence-manifest.json',characters);
const installIndex=JSON.parse(readFileSync(join(source,'assets/install-resource-index.json'),'utf8'));
const indexedFile=path=>{const bytes=readFileSync(join(out,path));return {path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};};
installIndex.shared=installIndex.shared.map(file=>['assets/frame-sequence-manifest.json','assets/character-sequence-manifest.json'].includes(file.path)?indexedFile(file.path):file);
for(const name of readdirSync(join(root,'assets/group-thumbnails'))){const path='assets/group-thumbnails/'+name;if(!installIndex.shared.some(file=>file.path===path))installIndex.shared.push(indexedFile(path));}
for(const name of readdirSync(join(root,'assets/group-scene'))){const path='assets/group-scene/'+name;if(!installIndex.shared.some(file=>file.path===path))installIndex.shared.push(indexedFile(path));}
if(existsSync(join(root,'assets/pet-glove-v2')))for(const name of readdirSync(join(root,'assets/pet-glove-v2'))){const path='assets/pet-glove-v2/'+name,entry=indexedFile(path),index=installIndex.shared.findIndex(file=>file.path===path);if(index<0)installIndex.shared.push(entry);else installIndex.shared[index]=entry;}
for(const folder of ['assets/pet-glove-tint'])if(existsSync(join(root,folder)))for(const name of listFiles(join(root,folder))){const path=folder+'/'+name,entry=indexedFile(path),index=installIndex.shared.findIndex(file=>file.path===path);if(index<0)installIndex.shared.push(entry);else installIndex.shared[index]=entry;}
if(existsSync(join(root,'assets/theme')))for(const name of listFiles(join(root,'assets/theme'))){const path='assets/theme/'+name,entry=indexedFile(path),index=installIndex.shared.findIndex(file=>file.path===path);if(index<0)installIndex.shared.push(entry);else installIndex.shared[index]=entry;}
for(const file of sampleFiles){const path=file.to.slice(out.length+1).replaceAll('\\','/');if(!installIndex.characters[file.characterId].some(entry=>entry.path===path))installIndex.characters[file.characterId].push(indexedFile(path));}
ownedJson('install-resource-index.json',installIndex);
const shared={bundle:true,logLevel:'info',legalComments:'eof'};
for(const entry of ['main','preload','plugin-client-preload','monitor-worker','plugin-runner','plugin-maintenance'])await build({...shared,entryPoints:[join(root,'src',entry+'.mjs')],outfile:join(out,entry+'.cjs'),platform:'node',target:'node24',format:'cjs',external:['electron'],define:entry==='main'?{'__FRAME_SEQUENCES__':JSON.stringify(sequences),'__PET_CHARACTER_SEQUENCES__':JSON.stringify(characters)}:undefined});
// App-owned archive parser runs as a separate ESM worker beside the CJS host.
await build({...shared,entryPoints:[join(root,'src/work-archive-cursor-worker.mjs')],outfile:join(out,'work-archive-cursor-worker.mjs'),platform:'node',target:'node24',format:'esm'});
await build({...shared,entryPoints:[join(root,'src/dsh-platform/component-install-worker.mjs')],outfile:join(out,'dsh-component-worker.mjs'),platform:'node',target:'node24',format:'esm'});
await build({...shared,entryPoints:[join(root,'src/media-components/ffmpeg-worker.mjs')],outfile:join(out,'ffmpeg-component-worker.mjs'),platform:'node',target:'node24',format:'esm'});
await build({...shared,entryPoints:[join(root,'src/buddy-plugin-services/bili-full-media-worker.mjs')],outfile:join(out,'bili-full-media-worker.mjs'),platform:'node',target:'node24',format:'esm'});
for(const entry of ['dashboard','pet','pet-trajectory'])await build({...shared,entryPoints:[join(root,'src',entry+'.mjs')],outfile:join(out,entry+'.js'),platform:'browser',target:'chrome144',format:'iife',define:{'process.env.NODE_ENV':'"production"','__ALL_ACTION_RIGS__':'false','__FIVE_ACTIONS_V014__':'false','__FRAME_SEQUENCES__':JSON.stringify(sequences),'__PET_CHARACTER_SEQUENCES__':JSON.stringify(characters),'__PREVIEW_ATLASES__':JSON.stringify(entry==='dashboard'?previews.resources:{})}});
for(const name of ['index.html','pet.html','dashboard.css','appearance.css','workspace.css','pet-trajectory.html'])copyFileSync(join(root,'src',name),join(out,name));
const componentDescriptor=join(root,'release','dsh-component.json');
if(existsSync(componentDescriptor))copyFileSync(componentDescriptor,join(out,'dsh-component.json'));
// This app-owned Cordis policy is loaded by the pinned native Host at runtime.
// Keep it as ESM; import.meta cannot locate a sibling through main.cjs bundling.
mkdirSync(join(out,'dsh-platform'),{recursive:true});
for(const file of ['native-bridge-host.mjs','inert-bootstrap.mjs'])copyFileSync(join(root,'src','dsh-platform',file),join(out,'dsh-platform',file));
mkdirSync(join(out,'social-login-assets'),{recursive:true});
for(const file of ['native-path-guard.cjs','NAPCAT-LICENSE.txt','QRCODE-LICENSE.txt'])copyFileSync(join(root,'src','social-login-assets',file),join(out,'social-login-assets',file));
writeFileSync(join(out,'package.json'),JSON.stringify({name:'ai-buddy',productName:'AI Buddy',version:JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version,animationProfile:JSON.parse(readFileSync(join(source,'package.json'),'utf8')).animationProfile,main:'main.cjs'}));
if(upstreamMedia)stageUpstreamMediaBuild(root,out);
const mediaKit=mediaArg('--bili-media-tools=');
const mediaSingle=mediaArg('--bili-ffmpeg='),mediaLicense=mediaArg('--bili-ffmpeg-license=');
if(mediaKit&&mediaSingle)throw Error('Choose full media kit or the locked FFmpeg-only kit');
if(mediaKit){
 const locked=JSON.parse(readFileSync(join(root,'scripts/bili-media-windows-x64.json'),'utf8'));
 mkdirSync(join(out,'bili-media'),{recursive:true});
 for(const [name,digest] of Object.entries(locked)){
  const src=join(resolve(mediaKit),name),dst=join(out,'bili-media',name);
  if(createHash('sha256').update(readFileSync(src)).digest('hex')!==digest)throw Error('Bilibili media component changed: '+name);
  if(linkAssets){try{linkSync(src,dst);continue;}catch(e){if(e.code!=='EXDEV')throw e;}}
  copyFileSync(src,dst,constants.COPYFILE_EXCL);
 }
}
if(mediaSingle){
 const locked=JSON.parse(readFileSync(join(root,'scripts/bili-media-windows-x64.json'),'utf8')),src=resolve(mediaSingle),digest=createHash('sha256').update(readFileSync(src)).digest('hex');
 if(digest!==locked['ffmpeg.exe']||!mediaLicense)throw Error('FFmpeg-only kit requires the fixed executable and its license');
 mkdirSync(join(out,'bili-media'),{recursive:true});const dst=join(out,'bili-media','ffmpeg.exe');
 if(linkAssets){try{linkSync(src,dst);}catch(error){if(error.code!=='EXDEV')throw error;copyFileSync(src,dst,constants.COPYFILE_EXCL);}}else copyFileSync(src,dst,constants.COPYFILE_EXCL);
 copyFileSync(resolve(mediaLicense),join(out,'bili-media','LICENSE.txt'),constants.COPYFILE_EXCL);
 writeFileSync(join(out,'bili-media','COMPONENTS.json'),JSON.stringify({mode:'ffmpeg-only',ffmpegSha256:digest,localSpeechRecognition:false,source:'existing pinned local media component'},null,2));
}
candidateOutput.commit();
console.log('Built '+finalOut);
console.log('Asset materialization: '+JSON.stringify({mode:linkAssets?'hardlink':'physical-copy',linkedAssetFiles,linkedAssetBytes,copiedAssetFiles,copiedAssetBytes,reusedAssetFiles}));
}catch(error){
 try{candidateOutput.abort();}catch(cleanupError){throw new AggregateError([error,cleanupError],'Candidate build failed and owned staging could not be cleaned');}
 throw error;
}
