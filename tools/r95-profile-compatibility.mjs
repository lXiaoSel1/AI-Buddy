// Offline audit helpers for NEW, OWNED test profiles only. This module has no
// production installation entry point and never discovers user data roots.
import {mkdirSync,existsSync,lstatSync,readdirSync,readFileSync,writeFileSync,copyFileSync,renameSync,realpathSync} from 'node:fs';
import {resolve,relative,join,dirname,isAbsolute,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const json=value=>JSON.stringify(value,null,2)+'\n';
const sha=value=>createHash('sha256').update(value).digest('hex');
const profileMarker='.r95-isolated-profile.json',programMarker='.r95-isolated-program.json';
const inside=(root,path)=>{const rel=relative(resolve(root),resolve(path));return !isAbsolute(rel)&&rel!==''&&!rel.split(sep).includes('..');};
const reject=(message,code)=>Object.assign(Error(message),{code});
function newDirectory(path){path=resolve(path);if(existsSync(path))throw reject('Audit target must be a new directory','R95_AUDIT_TARGET_EXISTS');mkdirSync(path,{recursive:true});return path;}
function marker(root,name,ownerId){
 root=resolve(root);if(lstatSync(root).isSymbolicLink())throw reject('Audit root cannot be a link','R95_AUDIT_LINK');
 const value=JSON.parse(readFileSync(join(root,name),'utf8'));if(value.format!=='ai-buddy-r95-isolated-audit'||value.ownerId!==ownerId||value.production!==false)throw reject('This tool accepts its own isolated audit profile only','R95_AUDIT_NOT_OWNED');return root;
}
export function createIsolatedProfile(root,{ownerId=randomUUID()}={}){root=newDirectory(root);writeFileSync(join(root,profileMarker),json({format:'ai-buddy-r95-isolated-audit',ownerId,production:false,createdAt:new Date().toISOString()}),{flag:'wx'});return {root,ownerId};}
export function assertOwnedProfile(root,ownerId){return marker(root,profileMarker,ownerId);}
export function profileManifest(root){
 root=resolve(root);if(lstatSync(root).isSymbolicLink())throw reject('Manifest root cannot be a link','R95_AUDIT_LINK');const files=[];
 function visit(directory){for(const item of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(directory,item.name),stat=lstatSync(path);if(stat.isSymbolicLink())throw reject('Audit profile contains a link','R95_AUDIT_LINK');if(stat.isDirectory())visit(path);else if(stat.isFile()){const bytes=readFileSync(path);files.push({path:relative(root,path).replaceAll('\\','/'),bytes:bytes.length,sha256:sha(bytes)});}else throw reject('Unsupported profile entry','R95_AUDIT_ENTRY');}}
 visit(root);files.sort((a,b)=>a.path.localeCompare(b.path));return {files,fileCount:files.length,bytes:files.reduce((n,value)=>n+value.bytes,0),sha256:sha(JSON.stringify(files))};
}
function copyManifest(source,target,manifest,onCopied){
 for(const item of manifest.files){if(item.path.split('/').some(part=>!part||part==='.'||part==='..')||isAbsolute(item.path))throw reject('Invalid manifest path','R95_AUDIT_PATH');const from=join(source,item.path),to=join(target,item.path);if(!inside(source,from)||!inside(target,to)||lstatSync(from).isSymbolicLink())throw reject('Profile copy boundary changed','R95_AUDIT_PATH');mkdirSync(dirname(to),{recursive:true});copyFileSync(from,to);onCopied?.(item);}
}
export function backupIsolatedProfile({profileRoot,backupRoot,ownerId,onCopied,rename=renameSync,platform=process.platform,wait}={}){
 profileRoot=assertOwnedProfile(profileRoot,ownerId);backupRoot=resolve(backupRoot);if(profileRoot===backupRoot||inside(profileRoot,backupRoot)||inside(backupRoot,profileRoot))throw reject('Backup must be disjoint from its source','R95_AUDIT_PATH');if(existsSync(backupRoot))throw reject('Existing backup cannot be overwritten','R95_AUDIT_TARGET_EXISTS');
 const before=profileManifest(profileRoot),stage=backupRoot+'.partial-'+randomUUID();newDirectory(stage);const payload=join(stage,'payload');mkdirSync(payload);copyManifest(profileRoot,payload,before,onCopied);
 const after=profileManifest(profileRoot),copied=profileManifest(payload);if(before.sha256!==after.sha256||before.sha256!==copied.sha256)throw reject('Source changed or copied bytes do not match; backup not committed','R95_AUDIT_SOURCE_CHANGED');
 const receipt={format:'ai-buddy-r95-isolated-backup',version:1,ownerId,production:false,at:new Date().toISOString(),sourceRoot:realpathSync(profileRoot),manifest:before};writeFileSync(join(stage,'RECEIPT.json'),json(receipt),{flag:'wx'});commitRestoredDirectory(stage,backupRoot,{rename,platform,wait});return {backupRoot,receiptSha256:sha(readFileSync(join(backupRoot,'RECEIPT.json'))),...receipt};
}
export function verifyIsolatedBackup({backupRoot,expectedReceiptSha256}={}){
 backupRoot=resolve(backupRoot);if(typeof expectedReceiptSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedReceiptSha256))throw reject('An external backup receipt hash is required','R95_AUDIT_RECEIPT_REQUIRED');const raw=readFileSync(join(backupRoot,'RECEIPT.json'));if(sha(raw)!==expectedReceiptSha256)throw reject('Backup receipt hash mismatch','R95_AUDIT_BACKUP_CORRUPT');const receipt=JSON.parse(raw);if(receipt.format!=='ai-buddy-r95-isolated-backup'||receipt.version!==1||receipt.production!==false)throw reject('Unsupported audit backup receipt','R95_AUDIT_BACKUP_CORRUPT');const payload=join(backupRoot,'payload'),actual=profileManifest(payload);if(actual.sha256!==receipt.manifest.sha256||JSON.stringify(actual.files)!==JSON.stringify(receipt.manifest.files))throw reject('Backup payload hash mismatch','R95_AUDIT_BACKUP_CORRUPT');assertOwnedProfile(payload,receipt.ownerId);return {...receipt,verified:true,receiptSha256:expectedReceiptSha256};
}
function commitRestoredDirectory(stage,target,{rename=renameSync,platform=process.platform,wait=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)}={}){
 const waits=[20,50,100,200,400,800],original=lstatSync(stage);
 for(let attempt=0;;attempt++){
  if(existsSync(target))throw reject('Restoring over current or existing data is forbidden','R95_AUDIT_REFUSE_OVERWRITE');
  const stat=lstatSync(stage);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==original.dev||stat.ino!==original.ino)throw reject('Restore stage ownership changed','R95_AUDIT_LINK');
  try{rename(stage,target);return;}
  catch(error){if(platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||waits[attempt]===undefined)throw error;wait(waits[attempt]);}
 }
}
export function restoreIsolatedBackup({backupRoot,expectedReceiptSha256,targetRoot,ownerId,rename=renameSync,platform=process.platform,wait}={}){
 const receipt=verifyIsolatedBackup({backupRoot,expectedReceiptSha256});if(receipt.ownerId!==ownerId)throw reject('Backup belongs to another audit owner','R95_AUDIT_NOT_OWNED');targetRoot=resolve(targetRoot);if(existsSync(targetRoot))throw reject('Restoring over current or existing data is forbidden','R95_AUDIT_REFUSE_OVERWRITE');const stage=targetRoot+'.partial-'+randomUUID();newDirectory(stage);copyManifest(join(resolve(backupRoot),'payload'),stage,receipt.manifest);if(profileManifest(stage).sha256!==receipt.manifest.sha256)throw reject('Restored copy failed hash verification','R95_AUDIT_BACKUP_CORRUPT');commitRestoredDirectory(stage,targetRoot,{rename,platform,wait});if(profileManifest(targetRoot).sha256!==receipt.manifest.sha256)throw reject('Committed restored copy failed hash verification','R95_AUDIT_BACKUP_CORRUPT');return {targetRoot,verified:true,manifestSha256:receipt.manifest.sha256};
}
export function createIsolatedProgram(root,{ownerId,profileRoot}={}){
 assertOwnedProfile(profileRoot,ownerId);root=newDirectory(root);writeFileSync(join(root,programMarker),json({format:'ai-buddy-r95-isolated-audit',ownerId,production:false}),{flag:'wx'});for(const build of ['legacy','r95']){mkdirSync(join(root,'builds',build),{recursive:true});writeFileSync(join(root,'builds',build,'SIMULATION.json'),json({build,executable:false}));}const pointer={version:'1.9.2',path:'builds/r95',dataRoot:resolve(profileRoot),selectedProfile:'test-selected-profile',pipe:'isolated-r95-not-started'};writeFileSync(join(root,'current-build.json'),json(pointer),{flag:'wx'});return pointer;
}
export function switchIsolatedProgram({programRoot,profileRoot,ownerId,buildPath='builds/legacy'}={}){
 programRoot=marker(programRoot,programMarker,ownerId);profileRoot=assertOwnedProfile(profileRoot,ownerId);if(!/^builds\/[A-Za-z0-9._-]+$/.test(buildPath)||!existsSync(join(programRoot,buildPath,'SIMULATION.json')))throw reject('Only known audit simulation builds can be selected','R95_AUDIT_PATH');const pointerPath=join(programRoot,'current-build.json'),beforeRaw=readFileSync(pointerPath),before=JSON.parse(beforeRaw),dataBefore=profileManifest(profileRoot);if(resolve(before.dataRoot)!==resolve(profileRoot))throw reject('Selected data profile changed','R95_AUDIT_NOT_OWNED');const next={...before,path:buildPath},temp=pointerPath+'.partial-'+randomUUID();writeFileSync(temp,json(next),{flag:'wx'});renameSync(temp,pointerPath);const dataAfter=profileManifest(profileRoot);if(dataAfter.sha256!==dataBefore.sha256)throw reject('Data changed during isolated pointer switch','R95_AUDIT_SOURCE_CHANGED');return {simulation:true,launched:false,beforeSha256:sha(beforeRaw),afterSha256:sha(readFileSync(pointerPath)),profileSha256:dataAfter.sha256,pointer:next};
}

// Copies only hash-pinned legacy modules needed by the two readers. It never
// imports executable code from the shared R82 directory or alters that source.
export async function loadFrozenLegacyReaders({sourceRoot,inventoryPath,targetRoot}={}){
 sourceRoot=resolve(sourceRoot);const inventory=JSON.parse(readFileSync(inventoryPath,'utf8')),expected=new Map(inventory.files.map(row=>[row.path,row.sha256])),pending=['src/companion-store.mjs','src/usage-repository.mjs'],frozen=new Map();
 while(pending.length){const path=pending.pop();if(frozen.has(path))continue;const absolute=resolve(sourceRoot,path);if(!inside(sourceRoot,absolute))throw reject('Legacy source boundary invalid','R95_AUDIT_PATH');const content=readFileSync(absolute),hash=sha(content);if(hash!==expected.get(path))throw reject('Legacy source does not match its pinned baseline: '+path,'R95_AUDIT_LEGACY_SOURCE_CHANGED');frozen.set(path,content);const text=content.toString('utf8');for(const match of text.matchAll(/(?:from\s*|import\s*)['"](\.[^'"\n]+)['"]/g)){const dependency=resolve(dirname(absolute),match[1]);if(!inside(sourceRoot,dependency))throw reject('Legacy dependency escaped baseline','R95_AUDIT_PATH');pending.push(relative(sourceRoot,dependency).replaceAll('\\','/'));}}
 targetRoot=newDirectory(targetRoot);for(const[path,content]of frozen){const target=join(targetRoot,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,content,{flag:'wx'});}const files=[...frozen].map(([path,content])=>({path,bytes:content.length,sha256:sha(content)})).sort((a,b)=>a.path.localeCompare(b.path));writeFileSync(join(targetRoot,'FROZEN-READER-SOURCE.json'),json({format:'r95-legacy-reader-source',sourceTree:inventory.sourceTreeSha256,files}),{flag:'wx'});
 return {files,sourceRoot:targetRoot,companion:await import(pathToFileURL(join(targetRoot,'src/companion-store.mjs')).href),life:await import(pathToFileURL(join(targetRoot,'src/companion-life.mjs')).href),usage:await import(pathToFileURL(join(targetRoot,'src/usage-repository.mjs')).href)};
}
