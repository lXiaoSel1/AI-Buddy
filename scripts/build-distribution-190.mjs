// Assemble release builds while preserving the separately approved 1.9.0 media.
import {copyFileSync,existsSync,linkSync,lstatSync,mkdirSync,readFileSync,readdirSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {resolve,join,relative,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {buildPortableLauncher} from './build-portable-launcher.mjs';

const repo=resolve(import.meta.dirname,'..');
const arg=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
for(const n of ['baseline30','baseline60','runtime','out','rcedit','media-receipt','media-approval'])if(!arg(n))throw Error('Supply --'+n);
const out=resolve(arg('out')),version=JSON.parse(readFileSync(join(repo,'package.json'),'utf8')).version,mediaVersion='1.9.0',linkAssets=process.argv.includes('--link-assets'),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8')),save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const approvedReceiptSha256='bb3b110d6f165eb449dbf797eef549c98f7d521cbf4d7766a746f7ac28122e58';
// Evidence may have been archived after a release; its bytes remain hash-bound.
const evidenceArchive=arg('evidence-archive')&&resolve(arg('evidence-archive'));
const integrationRoot=resolve(repo,'../../../../..','integration');
function evidencePath(path){
 if(existsSync(path))return resolve(path);
 const name=relative(integrationRoot,resolve(path));
 if(evidenceArchive&&name&&!name.startsWith('..')&&!resolve(path).startsWith(evidenceArchive)){
  const archived=join(evidenceArchive,name);if(existsSync(archived))return archived;
 }
 return resolve(path);
}
const receiptPath=resolve(arg('media-receipt')),approvalPath=resolve(arg('media-approval'));
if(hash(receiptPath)!==approvedReceiptSha256)throw Error('Media receipt is not the approved CRF28 baseline');
const mediaReceipt=read(receiptPath),approval=read(approvalPath);
if(approval.version!==mediaVersion||approval.approved!==true||approval.userApproved!==true||approval.mediaBaselineSha256!==approvedReceiptSha256||approval.mediaBaseline?.sha256!==approvedReceiptSha256||evidencePath(approval.mediaBaseline.path)!==receiptPath||![2,5].every(n=>approval.authorizedStages?.includes(n)))throw Error('Explicit approval of this media receipt and distribution stages is required');
if(mediaReceipt.version!==mediaVersion||mediaReceipt.crf!==28||!mediaReceipt.complete||!mediaReceipt.technicalPass||mediaReceipt.videoCount!==528||mediaReceipt.actionCountPerEdition!==264||mediaReceipt.technicalFailures?.length||!mediaReceipt.sourceUnchanged||mediaReceipt.gazeFramesRecompressed!==false||mediaReceipt.geometryOrAlphaReprocessed!==false||!mediaReceipt.independentReview?.passed||Object.keys(mediaReceipt.independentReview.receipts??{}).length!==11)throw Error('Incomplete approved media evidence');
const unavailableHistoricalEvidence=[];
function boundFile(path,sha256){
 path=evidencePath(path);
 if(!existsSync(path)&&evidenceArchive&&process.argv.includes('--reuse-approved-media')){
  unavailableHistoricalEvidence.push({path,sha256,reason:'Archived production intermediate removed; immutable approved inventory remains authoritative for byte reuse'});return;
 }
 if(!existsSync(path)||hash(path)!==sha256)throw Error('Media evidence changed '+path);
}
boundFile(mediaReceipt.sourceReceipt,mediaReceipt.sourceReceiptSha256);
for(const[path,digest]of Object.entries(mediaReceipt.producerReceipts))boundFile(join(dirname(receiptPath),path),digest);
for(const item of Object.values(mediaReceipt.independentReview.receipts))boundFile(item.path,item.sha256);
boundFile(mediaReceipt.builder.path,mediaReceipt.builder.sha256);
if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid release version');
if(existsSync(out))throw Error('Output must be a new directory; existing distributions are immutable');
function files(dir){return readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en')).flatMap(e=>{const p=join(dir,e.name);if(lstatSync(p).isSymbolicLink())throw Error('Symlink in distribution '+p);return e.isDirectory()?files(p):[p];});}
function transfer(source,target,{assets=false}={}){for(const p of files(source)){const name=relative(source,p),dest=join(target,name);mkdirSync(dirname(dest),{recursive:true});if(assets&&linkAssets&&name.replaceAll('\\','/').startsWith('assets/'))linkSync(p,dest);else copyFileSync(p,dest);}}
const proof=[];mkdirSync(out,{recursive:true});
for(const fps of [30,60]){
 const source=resolve(arg('baseline'+fps)),pkg=read(join(source,'package.json'));
 if(pkg.version!==version||pkg.animationProfile!==fps+'fps')throw Error('Wrong accepted candidate '+source);
 const approved=mediaReceipt.editions.find(e=>e.fps===fps);
 if(!approved||approved.videos!==264||approved.filesAfter!==Object.keys(approved.fileInventory??{}).length)throw Error('Missing approved edition '+fps);
 if(existsSync(approved.path)){
  const approvedFiles=files(approved.path).map(p=>relative(approved.path,p).replaceAll('\\','/'));
  if(approvedFiles.length!==approved.filesAfter||approvedFiles.some(p=>!approved.fileInventory[p]))throw Error('Approved baseline file tree changed '+fps);
  for(const[path,f]of Object.entries(approved.fileInventory)){const p=join(approved.path,path);if(statSync(p).size!==f.bytes||hash(p)!==f.sha256)throw Error('Approved baseline file changed '+p);}
  if(hash(join(approved.path,'assets/install-resource-index.json'))!==approved.resourceIndexSha256)throw Error('Approved resource index changed '+fps);
 }else if(!evidenceArchive||!process.argv.includes('--reuse-approved-media'))throw Error('Missing baseline; explicitly request reuse with archived hash-bound evidence');
 const index=read(join(source,'assets/install-resource-index.json'));
 const characters=read(join(source,'assets/character-sequence-manifest.json'));
 const owners=new Map(),expected=new Map();
 for(const [owner,list]of [[null,index.shared],...Object.entries(index.characters)])for(const f of list){
  if(expected.has(f.path.toLowerCase()))throw Error('Duplicate resource '+f.path);
  const p=join(source,f.path);if(statSync(p).size!==f.bytes||hash(p)!==f.sha256)throw Error('Accepted resource hash mismatch '+p);
  const accepted=approved.fileInventory[f.path];if(!accepted||accepted.bytes!==f.bytes||accepted.sha256!==f.sha256)throw Error('Rebuilt resource differs from approved media '+f.path);
  expected.set(f.path.toLowerCase(),f);owners.set(f.path,owner);
 }
 const actual=files(join(source,'assets')).map(p=>relative(source,p).replaceAll('\\','/')).filter(p=>p!=='assets/install-resource-index.json');
 if(actual.length!==expected.size||actual.some(p=>!expected.has(p.toLowerCase())))throw Error('Resource index does not cover the complete accepted asset tree');
 const approvedAssets=Object.keys(approved.fileInventory).filter(p=>p.startsWith('assets/')&&p!=='assets/install-resource-index.json');
 if(actual.length!==approvedAssets.length||actual.some(p=>!approvedAssets.includes(p)))throw Error('Rebuilt resource tree differs from approved media');
 // Old generated code and index ordering may be removed by retention. The immutable
 // inventory still binds every actual asset's name, length and SHA-256 above.
 const originalIndex=existsSync(approved.path)?read(join(approved.path,'assets/install-resource-index.json')):index;
 const normalizeIndex=x=>({...x,appVersion:version,edition:fps+'fps'});
 if(JSON.stringify(normalizeIndex(index))!==JSON.stringify(normalizeIndex(originalIndex)))throw Error('Rebuilt resource index differs from approved baseline');
 const dest=join(out,fps+'fps','build');transfer(source,dest,{assets:true});
 // Keep this generated index on a new inode even if the input build shared assets.
 const targetIndex=join(dest,'assets/install-resource-index.json');
 // Remove the copied file before writing the release-specific version metadata.
 unlinkSync(targetIndex);
 const next={...index,appVersion:version,edition:fps+'fps',shared:[],characters:Object.fromEntries(Object.keys(index.characters).map(id=>[id,[]]))};
 let media=0;const actionCounts={};
 for(const path of actual.sort()){
  const p=join(dest,path),f={path,bytes:statSync(p).size,sha256:hash(p)},owner=owners.get(path);
  (owner?next.characters[owner]:next.shared).push(f);
  if(/\.(webm|png|webp)$/i.test(path)){if(f.sha256!==expected.get(path.toLowerCase()).sha256)throw Error('Media changed '+path);media++;}
 }
 for(const[id,list]of Object.entries(next.characters)){
  const videos=list.filter(f=>f.path.endsWith('.webm'));
  if(videos.length!==24||Object.keys(characters[id]??{}).length!==24)throw Error(id+' must have 24 independent action videos');
  if(new Set(videos.map(f=>f.sha256)).size!==24)throw Error('Duplicate action video '+id);
  actionCounts[id]=24;
 }
 if(Object.keys(actionCounts).length!==11)throw Error('Eleven accepted characters are required');
 save(targetIndex,next);
 for(const name of ['pet-trajectory.html','pet-trajectory.js','workspace.css','main.cjs','preload.cjs','dashboard.js','pet.js'])if(!existsSync(join(dest,name))||hash(join(dest,name))!==hash(join(source,name)))throw Error('Missing accepted UI output '+name);
 const added=actual.filter(p=>p.startsWith('assets/theme/')||p.startsWith('assets/pet-glove-tint/'));
 if(added.length!==374)throw Error('Expected all 374 accepted theme and tinted glove assets');
 proof.push({edition:fps+'fps',baseline:source,approvedMediaBaseline:approved.path,approvedResourceIndexSha256:approved.resourceIndexSha256,acceptedFiles:files(source).length,unchangedMediaFiles:media,actionCounts,themeAndTintFiles:added.length,resourceIndexSha256:hash(targetIndex),codeFiles:files(dest).filter(p=>!relative(dest,p).replaceAll('\\','/').startsWith('assets/')).map(p=>({path:relative(dest,p).replaceAll('\\','/'),bytes:statSync(p).size,sha256:hash(p)}))});
}
const runtimeSource=resolve(arg('runtime')),runtime=join(out,'runtime');transfer(runtimeSource,runtime);
const rcedit=resolve(arg('rcedit'));if(hash(rcedit)!=='3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a')throw Error('Untrusted rcedit');
const executable=join(runtime,'AI Buddy.exe');let result;
// Antivirus can briefly lock a freshly copied PE. Retry only the new private copy.
for(let attempt=0;attempt<3;attempt++){result=spawnSync(rcedit,[executable,'--set-file-version',version,'--set-product-version',version],{windowsHide:true,encoding:'utf8'});if(result.status===0)break;if(attempt<2)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);}
if(result.status!==0)throw Error(result.stderr||result.stdout||'Runtime version stamping failed');
save(join(runtime,'resources/app/package.json'),{name:'ai-buddy',version,main:'main.cjs'});
save(join(runtime,'resources/app/build.json'),{appVersion:version,version,path:'builds/v'+version});
writeFileSync(join(runtime,'resources/app/main.cjs'),`const fs=require('node:fs'),path=require('node:path');const root=path.resolve(__dirname,'../../../..');const p=JSON.parse(fs.readFileSync(path.join(root,'local/current-build.json'),'utf8'));const target=path.resolve(root,p.path);if(!target.startsWith(root+path.sep))throw Error('Invalid build path');require('electron').app.setAppPath(target);require(path.join(target,'main.cjs'));`);
save(join(runtime,'runtime-manifest.json'),{version,upstream:'Electron 44.6.0',baseline:runtimeSource,rceditSha256:hash(rcedit),files:files(runtime).filter(p=>relative(runtime,p)!=='runtime-manifest.json').map(p=>({path:relative(runtime,p).replaceAll('\\','/'),bytes:statSync(p).size,sha256:hash(p)}))});
const root=join(out,'root');mkdirSync(root,{recursive:true});
for(const path of ['AI Buddy.cmd','AI Buddy.vbs','Start-AI-Buddy.ps1','LICENSE.md','README.md','README.en.md','THIRD_PARTY_NOTICES.md','THIRD_PARTY_MONITOR.md','CG_API_GUIDE.md','licenses','docs','assets/branding'])if(existsSync(join(repo,path))){const p=join(repo,path);if(statSync(p).isDirectory())transfer(p,join(root,path));else{mkdirSync(dirname(join(root,path)),{recursive:true});copyFileSync(p,join(root,path));}}
buildPortableLauncher(repo,join(root,'AI Buddy.exe'),version);
const receipt={ok:true,version,mediaVersion,reencoded:0,createdAt:new Date().toISOString(),approvedMedia:{receiptPath,sha256:approvedReceiptSha256,approvalPath,approvalSha256:hash(approvalPath),boundIndependentReceipts:11},proof,runtime:{executable:'AI Buddy.exe',sha256:hash(executable)},roots:files(root).map(p=>({path:relative(root,p).replaceAll('\\','/'),bytes:statSync(p).size,sha256:hash(p)}))};
receipt.unavailableHistoricalEvidence=unavailableHistoricalEvidence;
receipt.mediaValidation='Every asset name, length and SHA-256 verified against the immutable approved inventory; current index checked for complete coverage; no encoding rerun';
save(join(out,'media-proof.json'),receipt);console.log(JSON.stringify({ok:true,out,proof}));
