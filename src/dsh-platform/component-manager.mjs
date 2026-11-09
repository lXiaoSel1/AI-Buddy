import {processLockOwner,processLockAlive} from '../process-lock-owner.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {readFile,mkdir,open,rename,lstat,writeFile,readdir,unlink,rm} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute,sep} from 'node:path';
import {gunzipSync,createGzip} from 'node:zlib';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {assertPluginTreeNoLinks} from '../plugin-archive.mjs';
import {writeAtomic} from '../atomic-write.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {downloadDshComponent,assertPublicDshComponentDescriptor,DSH_PUBLIC_COMPONENT} from './component-download.mjs';

export const DSH_SOURCE_COMMIT='22ddee3792402c3e70ec5f86a63c3e3e895a2f60';
export const DSH_NODE_VERSION='24.21.0';
export const DSH_PNPM_VERSION='11.28.5';
const hash=b=>createHash('sha256').update(b).digest('hex');
const failure=(message,code='DSH_COMPONENT_INVALID')=>Object.assign(Error(message),{code});
// Memory only. A settled verification is never returned without checking the
// complete tree and every current file identity again.
const componentVerifications=new Map(),componentFileHashes=new Map(),componentEpochs=new Map();let componentGlobalEpoch=0;
const componentEpoch=directory=>componentGlobalEpoch+':'+(componentEpochs.get(directory)??0);
export function invalidateDshComponentVerification(directory){
  if(directory==null){componentGlobalEpoch++;componentVerifications.clear();componentFileHashes.clear();return;}
  const root=resolve(directory);componentEpochs.set(root,(componentEpochs.get(root)??0)+1);
  for(const map of [componentVerifications,componentFileHashes])for(const key of map.keys())if(JSON.parse(key)[0]===root)map.delete(key);
}
const fileIdentity=info=>[info.dev,info.ino,info.mode,info.size,info.mtimeNs,info.ctimeNs,info.birthtimeNs].join(':');
function freezeVerification(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))freezeVerification(item);Object.freeze(value);}return value;}
async function parallelComponentRows(rows,limit,visit){let index=0,error;await Promise.all(Array.from({length:Math.min(limit,rows.length)},async()=>{while(!error&&index<rows.length){const item=rows[index++];try{await visit(item);}catch(cause){error??=cause;}}}));if(error)throw error;}
function componentPath(path){
  if(typeof path!=='string'||!path||path.length>1024||path.startsWith('/')||/[\\:\0]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw failure('Unsafe component path');
  return path;
}
function inside(root,path){const full=resolve(root,componentPath(path)),rel=relative(root,full);if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw failure('Component path leaves its root');return full;}
export async function verifyDshComponent(directory,{sourceCommit=DSH_SOURCE_COMMIT,nodeVersion=DSH_NODE_VERSION,pnpmVersion=DSH_PNPM_VERSION,concurrency=16,signal,check=()=>{}}={}){
  const checkpoint=()=>{check();signal?.throwIfAborted();};checkpoint();directory=resolve(directory);const epoch=componentEpoch(directory);await assertPluginTreeNoLinks(directory);
  const manifest=join(directory,'runtime-lock.json'),manifestInfo=await lstat(manifest,{bigint:true});if(!manifestInfo.isFile()||manifestInfo.isSymbolicLink())throw failure('Runtime manifest is not a regular file');
  const bytes=await readFile(manifest),manifestSha256=hash(bytes),cacheKey=JSON.stringify([directory,manifestSha256,sourceCommit,nodeVersion,pnpmVersion,epoch]);
  if(componentVerifications.has(cacheKey))return componentVerifications.get(cacheKey);
  const checking=(async()=>{
    const started=performance.now(),lock=JSON.parse(bytes),limit=Math.min(16,Math.max(1,Number(concurrency)||16));
    if(lock.schemaVersion!==1||lock.stage!=='ready'||lock.sourceCommit!==sourceCommit||lock.nodeVersion!==nodeVersion||lock.pnpmVersion!==pnpmVersion||!Array.isArray(lock.files)||!lock.files.length)throw failure('Runtime manifest does not match the pinned component');
    const names=new Set(),rows=lock.files.map(row=>{const path=componentPath(row.path);if(names.has(path.toLowerCase())||!/^[a-f0-9]{64}$/.test(row.sha256)||!Number.isSafeInteger(row.bytes)||row.bytes<0)throw failure('Invalid or duplicate component inventory');names.add(path.toLowerCase());return {...row,path,file:inside(directory,path)};});
    for(const key of ['node','pnpm','cli','sdk','bridge'])if(typeof lock.paths?.[key]!=='string'||!names.has(componentPath(lock.paths[key]).toLowerCase()))throw failure('Unindexed runtime entry: '+key);
    async function scan(){let frontier=[directory],actual=0;const directories=new Map();while(frontier.length){const next=[];await parallelComponentRows(frontier,limit,async dir=>{checkpoint();const info=await lstat(dir,{bigint:true});if(!info.isDirectory()||info.isSymbolicLink())throw failure('Runtime contains a link or special entry');directories.set(dir,fileIdentity(info));for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name),rel=relative(directory,path).split(sep).join('/');if(entry.isSymbolicLink()||!entry.isDirectory()&&!entry.isFile())throw failure('Runtime contains a link or special entry');if(entry.isDirectory())next.push(path);else if(rel!=='runtime-lock.json'){if(!names.has(rel.toLowerCase()))throw failure('Unindexed component file: '+rel);actual++;}}});frontier=next;}if(actual!==rows.length)throw failure('Runtime inventory file count differs');return directories;}
    const directories=await scan(),previous=componentFileHashes.get(cacheKey)??new Map(),verified=new Map();let hashedFiles=0,cacheHits=0,hashedBytes=0;
    await parallelComponentRows(rows,limit,async row=>{
      checkpoint();const info=await lstat(row.file,{bigint:true});if(!info.isFile()||info.isSymbolicLink()||info.size!==BigInt(row.bytes))throw failure('Component file size differs: '+row.path);
      const identity=fileIdentity(info),cached=previous.get(row.path);if(cached?.identity===identity&&cached.sha256===row.sha256){cacheHits++;verified.set(row.path,cached);return;}
      const file=await open(row.file,'r');try{if(fileIdentity(await file.stat({bigint:true}))!==identity)throw failure('Component file changed during verification: '+row.path);const actual=createHash('sha256');for await(const chunk of file.createReadStream({autoClose:false})){checkpoint();actual.update(chunk);}if(actual.digest('hex')!==row.sha256)throw failure('Component digest differs: '+row.path);if(fileIdentity(await file.stat({bigint:true}))!==identity||fileIdentity(await lstat(row.file,{bigint:true}))!==identity)throw failure('Component file changed during verification: '+row.path);}finally{await file.close();}
      hashedFiles++;hashedBytes+=row.bytes;verified.set(row.path,{identity,sha256:row.sha256});
    });
    const afterDirectories=await scan();if(directories.size!==afterDirectories.size||[...directories].some(([path,identity])=>afterDirectories.get(path)!==identity))throw failure('Runtime directories changed during verification');
    await parallelComponentRows(rows,limit,async row=>{if(fileIdentity(await lstat(row.file,{bigint:true}))!==verified.get(row.path).identity)throw failure('Component file changed during verification: '+row.path);});
    await assertPluginTreeNoLinks(directory);if(fileIdentity(await lstat(manifest,{bigint:true}))!==fileIdentity(manifestInfo)||!(await readFile(manifest)).equals(bytes))throw failure('Runtime manifest changed during verification');
    checkpoint();if(componentEpoch(directory)!==epoch)throw failure('Runtime verification was invalidated; verify again');
    componentFileHashes.set(cacheKey,verified);while(componentFileHashes.size>4)componentFileHashes.delete(componentFileHashes.keys().next().value);
    return freezeVerification({lock,manifestSha256,files:rows.length,verification:{concurrency:limit,hashedFiles,cacheHits,hashedBytes,scannedDirectories:directories.size,durationMs:Math.round(performance.now()-started)}});
  })();
  componentVerifications.set(cacheKey,checking);try{return await checking;}catch(error){componentFileHashes.delete(cacheKey);throw error;}finally{if(componentVerifications.get(cacheKey)===checking)componentVerifications.delete(cacheKey);}
}
function tarString(bytes,start,length){return bytes.subarray(start,start+length).toString('utf8').replace(/\0.*$/s,'');}
function tarNumber(bytes,start,length){const value=tarString(bytes,start,length).trim();if(!/^[0-7]*$/.test(value))throw failure('Unsupported TAR numeric field');return value?parseInt(value,8):0;}
/** Component archives are deterministic USTAR: regular files and directories only. */
export async function extractDshComponentArchive(bytes,directory,{expandedLimit=1536*1024*1024,signal,check=()=>{}}={}){
  const checkpoint=()=>{check();signal?.throwIfAborted();};checkpoint();let tar;try{tar=gunzipSync(bytes,{maxOutputLength:expandedLimit});}catch{throw failure('Invalid or oversized component gzip');}
  let offset=0;const seen=new Set();await assertPluginTreeNoLinks(directory);await mkdir(directory,{recursive:true});
  while(offset+512<=tar.length){checkpoint();const header=tar.subarray(offset,offset+512);if(header.every(b=>b===0)){if(tar.subarray(offset).some(b=>b!==0))throw failure('Data follows TAR terminator');return;}
    const expected=tarNumber(header,148,8);let checksum=0;for(let i=0;i<512;i++)checksum+=i>=148&&i<156?32:header[i];if(expected!==checksum)throw failure('TAR header checksum differs');
    const prefix=tarString(header,345,155),name=tarString(header,0,100),type=String.fromCharCode(header[156]||48),path=(prefix?prefix+'/':'')+name;
    const safe=componentPath(type==='5'?path.replace(/\/$/,''):path),size=tarNumber(header,124,12);if(!['0','5'].includes(type)||type==='5'&&size)throw failure('Component archive links or special entries rejected');
    const key=safe.toLowerCase();if(seen.has(key))throw failure('Duplicate component archive path');seen.add(key);if(seen.size>100000)throw failure('Too many component entries');
    const begin=offset+512,end=begin+size;if(end>tar.length)throw failure('Truncated component archive');const target=inside(directory,safe);await assertPluginTreeNoLinks(target);await mkdir(dirname(target),{recursive:true});
    if(type==='5')await mkdir(target,{recursive:true});else await writeFile(target,tar.subarray(begin,end),{flag:'wx'});
    offset=begin+Math.ceil(size/512)*512;
  }
  throw failure('Component archive has no terminator');
}
function tarHeader(path,size){
  componentPath(path);const header=Buffer.alloc(512);let name=path,prefix='';if(Buffer.byteLength(name)>100){const split=[...path.matchAll(/\//g)].map(match=>match.index).find(index=>Buffer.byteLength(path.slice(0,index))<=155&&Buffer.byteLength(path.slice(index+1))<=100);if(split==null)throw failure('Component archive path exceeds USTAR capacity');prefix=path.slice(0,split);name=path.slice(split+1);}
  const put=(s,offset,length)=>{if(Buffer.byteLength(s)>length)throw failure('TAR field too long');header.write(s,offset,length,'utf8');};
  put(name,0,100);put('0000644\0',100,8);put('0000000\0',108,8);put('0000000\0',116,8);put(size.toString(8).padStart(11,'0')+'\0',124,12);put('00000000000\0',136,12);header.fill(32,148,156);header[156]=48;put('ustar\0',257,6);put('00',263,2);put(prefix,345,155);const sum=header.reduce((n,b)=>n+b,0);put(sum.toString(8).padStart(6,'0')+'\0 ',148,8);return header;
}
export async function packDshComponent(directory,target){
  const proof=await verifyDshComponent(directory);const names=['runtime-lock.json',...proof.lock.files.map(row=>row.path)].sort();if(new Set(names).size!==names.length)throw failure('Runtime manifest must not inventory itself');
  async function* content(){for(const path of names){const file=inside(directory,path),info=await lstat(file);yield tarHeader(path,info.size);for await(const chunk of createReadStream(file))yield chunk;const pad=(512-info.size%512)%512;if(pad)yield Buffer.alloc(pad);}yield Buffer.alloc(1024);}
  await mkdir(dirname(target),{recursive:true});await pipeline(Readable.from(content()),createGzip({level:6}),createWriteStream(target,{flags:'wx'}));const digest=createHash('sha256');let bytes=0;for await(const chunk of createReadStream(target)){digest.update(chunk);bytes+=chunk.length;}
  return {schemaVersion:1,sourceCommit:proof.lock.sourceCommit,nodeVersion:proof.lock.nodeVersion,pnpmVersion:proof.lock.pnpmVersion,bytes,sha256:digest.digest('hex'),manifestSha256:proof.manifestSha256};
}
function processAlive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;if(error.code==='EPERM')return true;throw error;}}
async function acquireInstallLock(path,identity,isProcessAlive){
  for(let attempt=0;attempt<3;attempt++){
    let handle;try{handle=await open(path,'wx');await handle.writeFile(JSON.stringify(identity));await handle.sync();return handle;}
    catch(error){if(handle){await handle.close();throw error;}if(error.code!=='EEXIST')throw error;}
    await assertPluginTreeNoLinks(path);let bytes,old;try{bytes=await readFile(path);old=JSON.parse(bytes);}catch(error){if(error.code==='ENOENT')continue;throw failure('Installation lock needs inspection','DSH_COMPONENT_LOCK_INVALID');}
    if(!Number.isSafeInteger(old.pid)||old.pid<1||typeof old.id!=='string'||!old.id)throw failure('Installation lock needs inspection','DSH_COMPONENT_LOCK_INVALID');
    if(await isProcessAlive(old.pid)&&(!old.creationTime||await processLockAlive(old)))throw failure('Another installer still owns this component','DSH_COMPONENT_BUSY');
    if(!(await readFile(path)).equals(bytes))throw failure('Installation ownership changed','DSH_COMPONENT_BUSY');
    try{await rename(path,path+'.abandoned-'+randomUUID());}catch(error){if(error.code!=='ENOENT')throw error;}
  }throw failure('Installation ownership could not be acquired','DSH_COMPONENT_BUSY');
}
async function removeOwnedStage(root,directory){
  const name=relative(root,directory);if(!/^staging-[a-f0-9-]{36}$/.test(name)||resolve(root,name)!==resolve(directory))throw failure('Invalid staging ownership');
  await assertPluginTreeNoLinks(directory);let info;try{info=await lstat(directory);}catch(error){if(error.code==='ENOENT')return;throw error;}if(!info.isDirectory()||info.isSymbolicLink())throw failure('Invalid staging ownership');await rm(directory,{recursive:true,force:true});
}
async function retainFailedStage(root,directory,id){
  await assertPluginTreeNoLinks(directory);const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())return;
  const marker='.failed-staging-'+id+'.json';await writeFile(join(root,marker),JSON.stringify({schemaVersion:1,id,directory:'staging-'+id}),{flag:'wx'});
  for(const entry of await readdir(root)){const match=/^\.failed-staging-([a-f0-9-]{36})\.json$/.exec(entry);if(!match||entry===marker)continue;const path=join(root,entry);await assertPluginTreeNoLinks(path);const old=JSON.parse(await readFile(path,'utf8'));if(old.schemaVersion!==1||old.id!==match[1]||old.directory!=='staging-'+old.id)continue;await removeOwnedStage(root,join(root,old.directory));await unlink(path);}
}
export function createDshComponentManager({destinationRoot,fetchImpl=fetch,planDownload,transportOrigin,busy=()=>false,sourceCommit=DSH_SOURCE_COMMIT,nodeVersion=DSH_NODE_VERSION,pnpmVersion=DSH_PNPM_VERSION,isProcessAlive=processAlive,renameStage=rename,renamePlatform=process.platform,renameSleep=delay,onProgress=()=>{},check=()=>{},downloadTimeoutMs=300000}={}){
  if(!isAbsolute(destinationRoot??''))throw TypeError('Component destination must be absolute');const plans=new Map();let running=false;
  async function status({signal,check=()=>{}}={}){let pointerFound=false;try{const pointerPath=join(destinationRoot,'current.json');await assertPluginTreeNoLinks(pointerPath);const pointer=JSON.parse(await readFile(pointerPath,'utf8'));pointerFound=true;if(pointer.schemaVersion!==1||pointer.sourceCommit!==sourceCommit||pointer.nodeVersion!==nodeVersion||!/^[a-f0-9]{64}$/.test(pointer.manifestSha256??'')||!/^[a-f0-9]{64}$/.test(pointer.archiveSha256??''))throw failure('Component pointer identity differs');const directory=inside(destinationRoot,pointer.directory);const proof=await verifyDshComponent(directory,{sourceCommit,nodeVersion,pnpmVersion,signal,check});if(proof.manifestSha256!==pointer.manifestSha256)throw failure('Runtime inventory differs from the installed receipt');return {state:'ready',runtimeLockPath:join(directory,'runtime-lock.json'),sourceCommit,nodeVersion,pnpmVersion,archiveSha256:pointer.archiveSha256,manifestSha256:proof.manifestSha256};}catch(error){if(error.code==='ENOENT'&&!pointerFound)return {state:'missing',sourceCommit};return {state:'failed',sourceCommit,error:{code:error.code??'DSH_COMPONENT_INVALID',message:error.message}};}}
  async function plan(input){
    if(!input||!/^[a-f0-9]{64}$/.test(input.sha256)||!Number.isSafeInteger(input.bytes)||input.bytes<1||input.bytes>1024*1024*1024||input.sourceCommit!==sourceCommit||input.nodeVersion!==nodeVersion||input.pnpmVersion!=null&&input.pnpmVersion!==pnpmVersion||input.manifestSha256!=null&&!/^[a-f0-9]{64}$/.test(input.manifestSha256))throw failure('Component download descriptor is not pinned');
    if(input.url){if(fetchImpl===globalThis.fetch)assertPublicDshComponentDescriptor(input);const url=new URL(input.url);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&url.hostname==='127.0.0.1')||url.username||url.password)throw failure('Invalid component download origin');}
    else if(!isAbsolute(input.archivePath??''))throw failure('Choose a verified local component archive');
    const planId=randomUUID(),value={...structuredClone(input),planId};plans.set(planId,value);while(plans.size>16)plans.delete(plans.keys().next().value);return {planId,sourceCommit,nodeVersion,bytes:input.bytes,sha256:input.sha256,requiresInstallation:true};
  }
  async function install({planId,signal}={}){
    const item=plans.get(planId);if(!item)throw failure('Component installation plan expired','DSH_COMPONENT_PLAN_STALE');if(running)throw failure('Runtime is busy','DSH_COMPONENT_BUSY');running=true;let handle,staging;const checkpoint=()=>{check();signal?.throwIfAborted();},requireIdle=async message=>{checkpoint();const occupied=await busy();checkpoint();if(occupied)throw failure(message,'DSH_COMPONENT_BUSY');},id=randomUUID(),lockPath=join(destinationRoot,'component-install.lock');
    try{checkpoint();onProgress({phase:'checking'});await requireIdle('Runtime is busy');await assertPluginTreeNoLinks(destinationRoot);await mkdir(destinationRoot,{recursive:true});handle=await acquireInstallLock(lockPath,{...await processLockOwner(),id,planId},isProcessAlive);
      checkpoint();let bytes;
      const current=await status({signal,check:checkpoint});checkpoint();if(current.state==='ready'&&current.archiveSha256===item.sha256&&(!item.manifestSha256||item.manifestSha256===current.manifestSha256)){plans.delete(planId);return current;}
      if(item.archivePath){onProgress({phase:'reading-local'});await assertPluginTreeNoLinks(item.archivePath);const info=await lstat(item.archivePath);if(!info.isFile()||info.size!==item.bytes)throw failure('Component archive digest or size differs');bytes=await readFile(item.archivePath,{signal});checkpoint();if(bytes.length!==item.bytes||hash(bytes)!==item.sha256)throw failure('Component archive digest or size differs');}else{onProgress({phase:'downloading',receivedBytes:0,totalBytes:item.bytes});const fixtureOrigin=fetchImpl!==globalThis.fetch&&item.url!==DSH_PUBLIC_COMPONENT.url?new URL(item.url).origin:null;bytes=await downloadDshComponent(item,{fetchImpl,planDownload,transportOrigin,signal,timeoutMs:downloadTimeoutMs,fixtureOrigin,onProgress,check:checkpoint,cacheDirectory:join(destinationRoot,'downloads')});}
      checkpoint();onProgress({phase:'extracting'});staging=join(destinationRoot,'staging-'+id);await extractDshComponentArchive(bytes,staging,{signal,check:checkpoint});bytes=null;onProgress({phase:'verifying'});const proof=await verifyDshComponent(staging,{sourceCommit,nodeVersion,pnpmVersion,signal,check:checkpoint});if(item.manifestSha256&&item.manifestSha256!==proof.manifestSha256)throw failure('Component inventory identity differs');
      checkpoint();await requireIdle('Runtime became busy before activation');const name='component-'+sourceCommit.slice(0,12)+'-'+item.sha256.slice(0,12),target=join(destinationRoot,name);
      let existing;try{await lstat(target);existing=await verifyDshComponent(target,{sourceCommit,nodeVersion,pnpmVersion,signal,check:checkpoint});}catch(error){if(error.code!=='ENOENT')throw error;}
      if(existing){if(existing.manifestSha256!==proof.manifestSha256)throw failure('Existing runtime has different content','DSH_COMPONENT_CONFLICT');await removeOwnedStage(destinationRoot,staging);staging=null;}else {
        // A Windows scanner can temporarily deny directory rename after hashing.
        // Retry only the exact validated stage; never remove/replace the target,
        // extract again, release the lock or activate an unverified pointer.
        const waits=[50,100,250,500,1000,2000],deadline=Date.now()+4000;
        for(let attempt=0;;attempt++)try{checkpoint();await renameStage(staging,target);staging=null;break;}catch(error){const wait=waits[attempt];if(renamePlatform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||wait===undefined||Date.now()+wait>deadline)throw error;await renameSleep(wait);checkpoint();if(Date.now()>=deadline)throw error;}
      }
      checkpoint();await requireIdle('Runtime became busy before activation');await assertPluginTreeNoLinks(join(destinationRoot,'current.json'));checkpoint();onProgress({phase:'activating'});writeAtomic(join(destinationRoot,'current.json'),JSON.stringify({schemaVersion:1,directory:name,archiveSha256:item.sha256,manifestSha256:proof.manifestSha256,sourceCommit,nodeVersion,pnpmVersion,installedAt:new Date().toISOString()}));plans.delete(planId);onProgress({phase:'ready'});return status();
    }catch(error){if(staging)try{await retainFailedStage(destinationRoot,staging,id);}catch{await removeOwnedStage(destinationRoot,staging).catch(()=>{});}throw error;}finally{try{if(handle){await handle.close();const current=JSON.parse(await readFile(lockPath,'utf8'));if(current.id!==id)throw failure('Installation lock ownership changed','DSH_COMPONENT_LOCK_INVALID');await unlink(lockPath);}}finally{running=false;}}
  }
  return {status,plan,install};
}
