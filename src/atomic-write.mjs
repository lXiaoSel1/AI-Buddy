import {writeFileSync,openSync,fsyncSync,closeSync,renameSync,rmSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {open as openAsync,lstat as lstatAsync,readFile as readFileAsync,rename as renameAsync} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {renamePluginPath} from './plugin-files.mjs';

// Writes a new temporary file, syncs it and renames it over target, so readers see
// the old or the new content, never a partial one. A failed attempt removes its
// temporary file.
export function writeAtomic(target,data){
 const temp=target+'.'+randomUUID()+'.partial';
 try{writeFileSync(temp,data,{flag:'wx'});const fd=openSync(temp,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,target);}
 catch(error){rmSync(temp,{force:true});throw error;}
}


const atomicIdentity=info=>[info.dev,info.ino,info.mode,info.nlink,info.size,info.mtimeNs,info.ctimeNs].map(String).join(':');
const atomicDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
const atomicChanged=(path,code,cause)=>Object.assign(Error('Atomic publication ownership or bytes changed: '+path,{cause}),{code,path});
async function atomicSnapshot(path,code,{missing=false}={}){
 let before;try{before=await lstatAsync(path,{bigint:true});}catch(error){if(missing&&error.code==='ENOENT')return null;throw atomicChanged(path,code,error);}
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n)throw atomicChanged(path,code);
 try{const bytes=await readFileAsync(path),after=await lstatAsync(path,{bigint:true});if(atomicIdentity(before)!==atomicIdentity(after))throw atomicChanged(path,code);return atomicIdentity(after)+':'+atomicDigest(bytes);}
 catch(error){if(error.code===code)throw error;throw atomicChanged(path,code,error);}
}
// Async callers publish one fsynced candidate. Only its final rename is retried,
// yielding between Windows sharing errors; native actions are never replayed.
// A failed candidate stays at its unique path as evidence. Never remove a file
// that another owner may have substituted, nor delete an occupied destination.
export async function writeAtomicAsync(target,data,{platform=process.platform,renameImpl,sleepImpl,now=Date.now}={}){
 if(!isAbsolute(target))throw Object.assign(Error('An absolute atomic publication target is required'),{code:'ATOMIC_PATH_REQUIRED'});
 const temporary=target+'.'+randomUUID()+'.partial',bytes=Buffer.from(data),expectedDigest=atomicDigest(bytes);let handle;
 try{
  const destination=await atomicSnapshot(target,'ATOMIC_TARGET_CHANGED',{missing:true});
  handle=await openAsync(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();const opened=await handle.stat({bigint:true});await handle.close();handle=null;const committed=await lstatAsync(temporary,{bigint:true});if(opened.dev!==committed.dev||opened.ino!==committed.ino)throw atomicChanged(temporary,'ATOMIC_TEMP_CHANGED');const identity=atomicIdentity(committed);
  await renamePluginPath(temporary,target,{platform,now,...(sleepImpl?{sleepImpl}:{}),renameImpl:async(source,current)=>{
   if(await atomicSnapshot(source,'ATOMIC_TEMP_CHANGED')!==identity+':'+expectedDigest)throw atomicChanged(source,'ATOMIC_TEMP_CHANGED');
   if(await atomicSnapshot(current,'ATOMIC_TARGET_CHANGED',{missing:true})!==destination)throw atomicChanged(current,'ATOMIC_TARGET_CHANGED');
   return (renameImpl??renameAsync)(source,current);
  }});
 }catch(error){try{error.atomicWrite={temporary,target};}catch{}throw error;}
 finally{if(handle)await handle.close().catch(()=>{});}
}
