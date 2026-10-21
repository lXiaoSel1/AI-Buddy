import {build} from 'esbuild';
import {existsSync,readFileSync,mkdirSync,readdirSync,copyFileSync,writeFileSync,linkSync,statSync,unlinkSync} from 'node:fs';
import {resolve,join,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {CHARACTER_EXPRESSIONS} from '../src/character-expressions.generated.mjs';
import {checkReleaseVersion,checkResourceVersion} from './check-release-version.mjs';
import {readInteractionResources} from './interaction-resources.mjs';
import {buildPetButtons} from './build-pet-buttons.mjs';
const root=resolve(import.meta.dirname,'..'),resources=process.argv.find(a=>a.startsWith('--resources='))?.slice(12);
const releaseState=checkReleaseVersion(root);
if(!resources)throw Error('Pass --resources=<build folder from the matching portable release>');
const outputName=process.argv.find(a=>a.startsWith('--out='))?.slice(6)??'development';
if(!/^[a-zA-Z0-9_-]+$/.test(outputName))throw Error('Output must be a single candidate directory name');
const source=resolve(resources),out=join(root,'builds',outputName),linkAssets=process.argv.includes('--link-assets');
if(!existsSync(join(source,'assets/frame-sequence-manifest.json')))throw Error('Resource manifest missing');
checkResourceVersion(releaseState.version,JSON.parse(readFileSync(join(source,'package.json'),'utf8')).version,releaseState);
const proof=JSON.parse(readFileSync(join(root,'assets/cg-references/maid-left.source.json'),'utf8'));
for(const[file,hash]of [['assets/maid-left.webp',proof.sourceSha256],['assets/cg-references/maid-left.png',proof.pngSha256],...Object.values(CHARACTER_EXPRESSIONS).flatMap(r=>Object.values(r.expressions).map(a=>[a.src,a.sha256]))])if(createHash('sha256').update(readFileSync(resolve(source,file))).digest('hex')!==hash)throw Error('Reference/expression resources differ from this release: '+file);
const sequences=JSON.parse(readFileSync(join(source,'assets/frame-sequence-manifest.json'),'utf8')),previews=JSON.parse(readFileSync(join(source,'assets/gallery-preview-manifest.json'),'utf8'));
const characterManifest=join(source,'assets/character-sequence-manifest.json');
const characters=existsSync(characterManifest)?JSON.parse(readFileSync(characterManifest,'utf8')):{deepseek:sequences};
const samplesArg=process.argv.find(a=>a.startsWith('--interaction-samples='))?.slice(22);let sampleFiles=[];
if(samplesArg){
  if(!linkAssets||outputName==='development')throw Error('Unapproved interaction samples require an isolated linked candidate');
  const batch=readInteractionResources(samplesArg,{edition:JSON.parse(readFileSync(join(source,'package.json'),'utf8')).animationProfile,characterIds:Object.keys(characters)});
  for(const [characterId,actions] of Object.entries(batch.characters)){Object.assign(characters[characterId],actions);if(characterId==='deepseek')Object.assign(sequences,actions);}
  sampleFiles=batch.files.map(file=>({...file,to:join(out,file.path)}));
}
if(Object.keys(characters).length!==11)throw Error('AI Buddy requires the matching eleven-character resources');
function copyAssets(from,to){mkdirSync(to,{recursive:true});for(const entry of readdirSync(from,{withFileTypes:true})){const a=join(from,entry.name),b=join(to,entry.name);if(from===join(source,'assets')&&['frame-sequence-manifest.json','character-sequence-manifest.json','install-resource-index.json'].includes(entry.name))continue;if(entry.isDirectory())copyAssets(a,b);else if(entry.isFile()){if(linkAssets){if(existsSync(b)){const old=statSync(b),current=statSync(a);if(old.dev!==current.dev||old.ino!==current.ino)throw Error('Candidate asset already exists independently; inspect before replacing: '+b);}else linkSync(a,b);}else copyFileSync(a,b);}else throw Error('Unsupported resource entry');}}
mkdirSync(out,{recursive:true});copyAssets(join(source,'assets'),join(out,'assets'));
buildPetButtons(root,out);
if(existsSync(join(root,'assets/group-thumbnails')))copyAssets(join(root,'assets/group-thumbnails'),join(out,'assets/group-thumbnails'));
if(existsSync(join(root,'assets/group-scene')))copyAssets(join(root,'assets/group-scene'),join(out,'assets/group-scene'));
if(existsSync(join(root,'assets/pet-glove-v2')))copyAssets(join(root,'assets/pet-glove-v2'),join(out,'assets/pet-glove-v2'));
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
for(const file of sampleFiles){const path=file.to.slice(out.length+1).replaceAll('\\','/');if(!installIndex.characters[file.characterId].some(entry=>entry.path===path))installIndex.characters[file.characterId].push(indexedFile(path));}
ownedJson('install-resource-index.json',installIndex);
const shared={bundle:true,logLevel:'info',legalComments:'eof'};
for(const entry of ['main','preload','monitor-worker'])await build({...shared,entryPoints:[join(root,'src',entry+'.mjs')],outfile:join(out,entry+'.cjs'),platform:'node',target:'node24',format:'cjs',external:['electron'],define:entry==='main'?{'__FRAME_SEQUENCES__':JSON.stringify(sequences),'__PET_CHARACTER_SEQUENCES__':JSON.stringify(characters)}:undefined});
for(const entry of ['dashboard','pet','pet-trajectory'])await build({...shared,entryPoints:[join(root,'src',entry+'.mjs')],outfile:join(out,entry+'.js'),platform:'browser',target:'chrome144',format:'iife',define:{'process.env.NODE_ENV':'"production"','__ALL_ACTION_RIGS__':'false','__FIVE_ACTIONS_V014__':'false','__FRAME_SEQUENCES__':JSON.stringify(sequences),'__PET_CHARACTER_SEQUENCES__':JSON.stringify(characters),'__PREVIEW_ATLASES__':JSON.stringify(entry==='dashboard'?previews.resources:{})}});
for(const name of ['index.html','pet.html','dashboard.css','appearance.css','pet-trajectory.html'])copyFileSync(join(root,'src',name),join(out,name));
writeFileSync(join(out,'package.json'),JSON.stringify({name:'ai-buddy',productName:'AI Buddy',version:JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version,animationProfile:JSON.parse(readFileSync(join(source,'package.json'),'utf8')).animationProfile,main:'main.cjs'}));
console.log('Built '+out);
