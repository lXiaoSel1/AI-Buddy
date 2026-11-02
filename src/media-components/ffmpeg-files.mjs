import {createHash} from 'node:crypto';
import {lstat,open,readFile,realpath} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute,sep} from 'node:path';

export const ffmpegError=(code,message=code)=>Object.assign(Error(message),{code:'FFMPEG_COMPONENT_'+code});
export const samePath=(left,right)=>process.platform==='win32'?resolve(left).toLowerCase()===resolve(right).toLowerCase():resolve(left)===resolve(right);
export const fileStamp=info=>[info.dev,info.ino,info.mode,info.nlink,info.size,info.mtimeNs,info.ctimeNs].map(String).join(':');
export function checkpoint(signal,check=()=>{}){check();if(signal?.aborted)throw ffmpegError('CANCELLED','FFmpeg preparation cancelled');}
export function zipPath(value,{directory=false}={}){
  if(typeof value!=='string'||!value||Buffer.byteLength(value)>512||/[\\:\0<>"|?*]/.test(value)||value.startsWith('/'))throw ffmpegError('ZIP_PATH','Unsafe FFmpeg archive path');
  const path=directory?value.replace(/\/$/,''):value;if(!path||path.split('/').some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/^(con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)||/[\x00-\x1f\x7f]/.test(part)))throw ffmpegError('ZIP_PATH','Unsafe FFmpeg archive path');return path;
}
export function ownedChild(root,name){const path=resolve(root,zipPath(name)),rel=relative(resolve(root),path);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw ffmpegError('PATH','FFmpeg path leaves its owned directory');return path;}
const pathIdentity=info=>[info.dev,info.ino,info.mode].map(String).join(':');
// Reject actual links before expanding legal Windows short names. A missing root
// keeps only its suffix; its deepest existing plain ancestor owns the identity.
export async function canonicalPath(path){
  const requested=resolve(path),ancestors=[],missing=[];let deepest=null;
  for(let current=requested;;current=dirname(current)){try{const info=await lstat(current,{bigint:true});if(info.isSymbolicLink())throw ffmpegError('LINK','FFmpeg path contains a link');if(current!==requested&&!info.isDirectory())throw ffmpegError('LINK','FFmpeg path ancestor is not a plain directory');const row={path:current,identity:pathIdentity(info)};ancestors.push(row);deepest??=row;}catch(cause){if(cause.code!=='ENOENT')throw cause;if(!deepest)missing.unshift(current.slice(dirname(current).length).replace(/^[\\/]+/,''));}if(dirname(current)===current)break;}
  if(!deepest)throw ffmpegError('LINK','FFmpeg path has no existing plain ancestor');const canonical=await realpath(deepest.path);
  for(let current=canonical;;current=dirname(current)){const info=await lstat(current,{bigint:true});if(info.isSymbolicLink()||current!==canonical&&!info.isDirectory())throw ffmpegError('LINK','FFmpeg canonical path contains a link');if(current===canonical&&pathIdentity(info)!==deepest.identity)throw ffmpegError('CHANGED','FFmpeg path changed during canonicalization');if(dirname(current)===current)break;}
  for(const row of ancestors){const info=await lstat(row.path,{bigint:true});if(info.isSymbolicLink()||pathIdentity(info)!==row.identity)throw ffmpegError('CHANGED','FFmpeg path changed during canonicalization');}
  return resolve(canonical,...missing);
}
export async function noLinks(path){return canonicalPath(path);}
export async function inspectFile(path){await noLinks(path);const info=await lstat(path,{bigint:true});if(!info.isFile()||info.isSymbolicLink())throw ffmpegError('FILE','FFmpeg component entry is not a regular file');return {bytes:Number(info.size),stamp:fileStamp(info)};}
export async function inspectDirectory(path){await noLinks(path);const info=await lstat(path,{bigint:true});if(!info.isDirectory()||info.isSymbolicLink())throw ffmpegError('LINK','FFmpeg component directory is not plain');return {stamp:fileStamp(info)};}
export async function hashFile(path,{bytes,sha256,signal,check}={}){
  checkpoint(signal,check);const before=await inspectFile(path);if(bytes!==undefined&&before.bytes!==bytes)throw ffmpegError('SIZE','FFmpeg component size differs');const file=await open(path,'r');
  try{if(fileStamp(await file.stat({bigint:true}))!==before.stamp)throw ffmpegError('CHANGED','FFmpeg component changed while opening');const hash=createHash('sha256');let total=0;for await(const chunk of file.createReadStream({autoClose:false})){checkpoint(signal,check);total+=chunk.length;if(bytes!==undefined&&total>bytes)throw ffmpegError('SIZE','FFmpeg component exceeds pinned size');hash.update(chunk);}const actual=hash.digest('hex');if(bytes!==undefined&&total!==bytes||sha256!==undefined&&actual!==sha256)throw ffmpegError('HASH','FFmpeg component digest differs');if(fileStamp(await file.stat({bigint:true}))!==before.stamp||(await inspectFile(path)).stamp!==before.stamp)throw ffmpegError('CHANGED','FFmpeg component changed during verification');checkpoint(signal,check);return {...before,sha256:actual};}finally{await file.close();}
}
export async function smallJson(path){const info=await inspectFile(path);if(info.bytes>65536)throw ffmpegError('REPAIR_REQUIRED','FFmpeg receipt exceeds its limit');return JSON.parse(await readFile(path,'utf8'));}
