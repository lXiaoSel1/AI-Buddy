import {downloadPinnedFile} from './network-download.mjs';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,readFile,writeFile,stat,lstat,statfs,open,rename,rm,readdir} from 'node:fs/promises';
import {join,resolve,relative,dirname,isAbsolute,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {createInflateRaw} from 'node:zlib';
import net from 'node:net';
import {openQqPreparation} from './qq-component-transaction.mjs';

const fail=code=>Object.assign(Error(code),{code});
export async function sha256File(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
export function componentChild(root,name){if(!name||name.includes('\\')||name.includes(':')||name.split('/').some(s=>!s||s==='.'||s==='..')||isAbsolute(name))throw fail('QQ_COMPONENT_PATH_INVALID');const target=resolve(root,name),rel=relative(resolve(root),target);if(!rel||rel.startsWith('..'+sep)||rel==='..'||isAbsolute(rel))throw fail('QQ_COMPONENT_PATH_INVALID');return target;}
async function noLinks(path){for(let p=resolve(path);;p=dirname(p)){try{if((await lstat(p)).isSymbolicLink())throw fail('QQ_COMPONENT_LINK_DENIED');}catch(e){if(e.code!=='ENOENT')throw e;}if(p===dirname(p))break;}}
async function readAt(file,position,length){const data=Buffer.alloc(length);const {bytesRead}=await file.read(data,0,length,position);if(bytesRead!==length)throw fail('QQ_COMPONENT_ZIP_INVALID');return data;}
export async function extractPinnedZip(archive,destination,descriptor,{signal}={}){
 if(await sha256File(archive)!==descriptor.sha256)throw fail('QQ_COMPONENT_HASH_MISMATCH');
 await noLinks(destination);await mkdir(destination,{recursive:false});const handle=await open(archive,'r');
 try{
  const size=(await handle.stat()).size;if(size!==descriptor.bytes)throw fail('QQ_COMPONENT_SIZE_MISMATCH');
  const tail=await readAt(handle,Math.max(0,size-65557),Math.min(size,65557));let eocd=-1;
  for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){eocd=i;break;}
  if(eocd<0||tail.readUInt16LE(eocd+4)||tail.readUInt16LE(eocd+6))throw fail('QQ_COMPONENT_ZIP_INVALID');
  const count=tail.readUInt16LE(eocd+10),centralSize=tail.readUInt32LE(eocd+12),centralOffset=tail.readUInt32LE(eocd+16);
  if(count>2000||centralOffset+centralSize>size-22||centralSize>2*1024*1024)throw fail('QQ_COMPONENT_ZIP_INVALID');
  const central=await readAt(handle,centralOffset,centralSize),expected=new Map(descriptor.files.map(f=>[f.path,f]));let at=0;const entries=[],seen=new Set(),ranges=[];
  for(let n=0;n<count;n++){
   if(at+46>central.length||central.readUInt32LE(at)!==0x02014b50)throw fail('QQ_COMPONENT_ZIP_INVALID');
   const flags=central.readUInt16LE(at+8),method=central.readUInt16LE(at+10),packed=central.readUInt32LE(at+20),unpacked=central.readUInt32LE(at+24),nameLength=central.readUInt16LE(at+28),extra=central.readUInt16LE(at+30),comment=central.readUInt16LE(at+32),attributes=central.readUInt32LE(at+38),offset=central.readUInt32LE(at+42);
   if(at+46+nameLength+extra+comment>central.length||flags&1||![0,8].includes(method)||(attributes>>>16&0xf000)===0xa000)throw fail('QQ_COMPONENT_ZIP_INVALID');
   const name=central.subarray(at+46,at+46+nameLength).toString('utf8'),directory=name.endsWith('/'),normalized=directory?name.slice(0,-1):name;
   componentChild(destination,normalized);if(seen.has(name.toLowerCase()))throw fail('QQ_COMPONENT_ZIP_DUPLICATE');seen.add(name.toLowerCase());
   at+=46+nameLength+extra+comment;if(directory){if(unpacked!==0)throw fail('QQ_COMPONENT_ZIP_INVALID');continue;}
   const proof=expected.get(name);if(!proof||proof.bytes!==unpacked)throw fail('QQ_COMPONENT_FILE_UNEXPECTED');expected.delete(name);
   const header=await readAt(handle,offset,30);if(header.readUInt32LE(0)!==0x04034b50||header.readUInt16LE(8)!==method)throw fail('QQ_COMPONENT_ZIP_INVALID');
   const localName=await readAt(handle,offset+30,header.readUInt16LE(26));if(localName.toString('utf8')!==name)throw fail('QQ_COMPONENT_ZIP_INVALID');
   const start=offset+30+header.readUInt16LE(26)+header.readUInt16LE(28),end=start+packed;if(end>centralOffset)throw fail('QQ_COMPONENT_ZIP_INVALID');ranges.push([offset,end]);entries.push({name,proof,method,start,end});
  }
  if(expected.size||at!==central.length)throw fail('QQ_COMPONENT_FILE_MISSING');ranges.sort((a,b)=>a[0]-b[0]);if(ranges.some((r,i)=>i&&r[0]<ranges[i-1][1]))throw fail('QQ_COMPONENT_ZIP_OVERLAP');
  for(const entry of entries){
   signal?.throwIfAborted();const target=componentChild(destination,entry.name);await mkdir(dirname(target),{recursive:true});const hash=createHash('sha256');let bytes=0;
   const checking=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;if(bytes>entry.proof.bytes)return callback(fail('QQ_COMPONENT_SIZE_MISMATCH'));hash.update(chunk);callback(null,chunk);}});
   if(entry.end===entry.start){await writeFile(target,Buffer.alloc(0),{flag:'wx'});}else await pipeline(createReadStream(archive,{start:entry.start,end:entry.end-1}),...(entry.method===8?[createInflateRaw()]:[]),checking,createWriteStream(target,{flags:'wx'}),{signal});
   if(bytes!==entry.proof.bytes||hash.digest('hex')!==entry.proof.sha256)throw fail('QQ_COMPONENT_FILE_HASH_MISMATCH');
  }
 }finally{await handle.close();}
}
export async function verifyComponent(directory,descriptor){
 await noLinks(directory);
 for(const item of descriptor.files){const path=componentChild(directory,item.path);await noLinks(path);const info=await stat(path);if(!info.isFile()||info.size!==item.bytes||await sha256File(path)!==item.sha256)throw fail('QQ_COMPONENT_FILE_HASH_MISMATCH');}
 return directory;
}
const downloadHosts=new Set(['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com','objects-origin.githubusercontent.com']);
async function downloadResponse(url,options){for(let i=0;i<6;i++){const parsed=new URL(url);if(parsed.protocol!=='https:'||!downloadHosts.has(parsed.hostname)||parsed.username||parsed.password)throw fail('QQ_COMPONENT_DOWNLOAD_ORIGIN');const response=await fetch(parsed,{...options,redirect:'manual'});if([301,302,303,307,308].includes(response.status)){await response.body?.cancel();url=new URL(response.headers.get('location'),parsed).href;continue;}return response;}throw fail('QQ_COMPONENT_DOWNLOAD_REDIRECT');}
export function createQqComponent({directory,descriptor,network,fetchImpl=fetch,fetchDownload}={}){
 let pending=null;
 async function ensure({signal,onProgress=()=>{},official=false}={}){
  if(process.platform!=='win32'||process.arch!=='x64')throw fail('QQ_COMPONENT_PLATFORM_UNSUPPORTED');
  if(pending)return pending;
  pending=(async()=>{
   await noLinks(directory);await mkdir(directory,{recursive:true});
   // An OS-owned pipe lease disappears on crash; it cannot leave a stale file
   // lock, and another app instance cannot prepare the same component at once.
   const lock=net.createServer(socket=>socket.destroy()),pipe='\\\\.\\pipe\\ai-buddy-qq-prepare-'+createHash('sha256').update(resolve(directory).toLowerCase()).digest('hex').slice(0,24);
   try{await new Promise((yes,no)=>{lock.once('error',no);lock.listen(pipe,yes);});}catch{throw fail('QQ_COMPONENT_PREPARATION_BUSY');}
   let transaction,stage;
   try{
    transaction=await openQqPreparation(directory,descriptor);const target=join(transaction.directory,'napcat-'+descriptor.version),proofPath=join(target,'buddy-component.json');
    const targetInfo=await lstat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(targetInfo){
     // A partially missing installation is not an absent installation. Preserve
     // it for explicit repair instead of downloading over the existing target.
     try{if(!targetInfo.isDirectory())throw fail('QQ_COMPONENT_REPAIR_REQUIRED');const proof=JSON.parse(await readFile(proofPath,'utf8'));if(proof.sha256!==descriptor.sha256||proof.version!==descriptor.version)throw fail('QQ_COMPONENT_REPAIR_REQUIRED');await verifyComponent(target,descriptor);}catch(cause){if(cause.code==='QQ_COMPONENT_LINK_DENIED')throw cause;throw fail('QQ_COMPONENT_REPAIR_REQUIRED');}
     await transaction.complete();return target;
    }
    const disk=await statfs(directory);if(disk.bavail*disk.bsize<descriptor.bytes+descriptor.expandedBytes+64*1024*1024)throw fail('QQ_COMPONENT_DISK_FULL');
    stage=await transaction.begin();const part=transaction.partial;
    await noLinks(part);await transaction.phase('downloading');
    await downloadPinnedFile(descriptor,part,{partial:part,fetchImpl:fetchDownload??fetchImpl,planDownload:network?.planDownload,official,signal,onProgress:value=>onProgress({downloadedBytes:value.receivedBytes,totalBytes:value.totalBytes}),validateUrl:value=>{const url=new URL(value);if(url.protocol!=='https:'||!downloadHosts.has(url.hostname)||url.username||url.password)throw fail('QQ_COMPONENT_DOWNLOAD_ORIGIN');return url;}});
    await transaction.phase('extracting');await extractPinnedZip(part,stage,descriptor,{signal});await writeFile(join(stage,'buddy-component.json'),JSON.stringify({sha256:descriptor.sha256,version:descriptor.version}),{flag:'wx'});signal?.throwIfAborted();await rename(stage,target);
    await transaction.phase('committed');await transaction.complete();return target;
   }catch(cause){
    if(transaction&&stage){if(['QQ_COMPONENT_HASH_MISMATCH','QQ_COMPONENT_SIZE_MISMATCH'].includes(cause.code)){await noLinks(transaction.partial);await rm(transaction.partial,{force:true});}await transaction.cleanupStage();await transaction.interrupted();}
    throw cause;
   }finally{
    await new Promise(resolve=>lock.close(resolve));
   }
  })();try{return await pending;}finally{pending=null;}
 }
 return {ensure,info:()=>({version:descriptor.version,bytes:descriptor.bytes,expandedBytes:descriptor.expandedBytes,url:descriptor.url,sha256:descriptor.sha256,license:'Limited Redistribution License',platform:'win32-x64'})};
}
