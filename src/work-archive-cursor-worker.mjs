import {isMainThread,parentPort,workerData} from 'node:worker_threads';
import {lstat,realpath,open} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute,sep} from 'node:path';
export const archiveFault=message=>Object.assign(Error(message),{code:'WORK_ARCHIVE_CHANGED'});
const fold=p=>process.platform==='win32'?p.toLowerCase():p;
export const archiveStamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
export async function inspectArchivePath(path,root){
 path=resolve(path);root=resolve(root);const part=relative(fold(root),fold(path));
 if(!part||isAbsolute(part)||part==='..'||part.startsWith('..'+sep))throw archiveFault('Archive is outside its plugin data directory');
 const ancestors=[];for(let p=path;;p=dirname(p)){const info=await lstat(p,{bigint:true});if(info.isSymbolicLink()||(p===path?!info.isFile():!info.isDirectory()))throw archiveFault('Archive path is linked or is not a regular file');ancestors.push([fold(p),String(info.dev),String(info.ino)]);if(dirname(p)===p)break;}
 const canonical=await realpath(path);if(fold(canonical)!==fold(path))throw archiveFault('Archive canonical path differs');
 const info=await lstat(path,{bigint:true});if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1n)throw archiveFault('Archive leaf changed');
 return {path,stamp:archiveStamp(info),ancestors:JSON.stringify(ancestors),size:Number(info.size)};
}
async function readCursor({path,root,maxBytes}){
 const before=await inspectArchivePath(path,root);if(before.size>maxBytes)throw archiveFault('Archive exceeds the bounded reader size');
 const file=await open(path,'r');let bytes;
 try{const first=await file.stat({bigint:true});if(archiveStamp(first)!==before.stamp||!first.isFile())throw archiveFault('Archive changed before opening');
 bytes=Buffer.alloc(Number(first.size));let offset=0;while(offset<bytes.length){const {bytesRead}=await file.read(bytes,offset,Math.min(1024*1024,bytes.length-offset),offset);if(!bytesRead)throw archiveFault('Archive was truncated');offset+=bytesRead;}
 if(archiveStamp(await file.stat({bigint:true}))!==before.stamp)throw archiveFault('Archive changed while reading');
 const after=await inspectArchivePath(path,root);if(after.stamp!==before.stamp||after.ancestors!==before.ancestors)throw archiveFault('Archive was replaced while reading');
 }finally{await file.close();}
 const raw=JSON.parse(bytes.toString('utf8'));
 if(raw.schemaVersion!==1||!/^[a-f0-9]{64}$/i.test(raw.sha256??'')||!Number.isSafeInteger(raw.changeSequence)||raw.changeSequence<0)throw archiveFault('Archive cursor is incomplete');
 const after=await inspectArchivePath(path,root);if(after.stamp!==before.stamp||after.ancestors!==before.ancestors)throw archiveFault('Archive was replaced during parsing');
 return {sha256:raw.sha256,changeSequence:raw.changeSequence,identity:after};
}
if(!isMainThread)void (async()=>{try{parentPort.postMessage({value:await readCursor(workerData)});}catch(error){parentPort.postMessage({error:{code:error.code??'WORK_ARCHIVE_CHANGED',message:String(error.message).slice(0,500)}});process.exitCode=1;}})();
