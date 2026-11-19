import {randomUUID} from 'node:crypto';
import {mkdir,open,rm} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import {lstatSync,readdirSync,realpathSync,unlinkSync} from 'node:fs';

export const lifeArchiveChunkBytes=512*1024;
const MAX_ZIP=512*1024*1024,MAX_BASE64=715827884,MAX_ACTIVE=4,TTL=5*60*1000;
const transferIdPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const invalid=()=>Error('人生 ZIP 编码或大小无效');
const unavailable=()=>Error('人生存档不存在');

export function lifeTransferPath(dataRoot,id){
 if(typeof id!=='string'||!transferIdPattern.test(id))throw invalid();
 return join(dataRoot,'galgame','.life-archive-transfers',id+'.partial');
}

export function assertLifeTransferParent(path){
 const directory=dirname(path),parent=realpathSync(dirname(directory)),resolved=realpathSync(directory);
 if(dirname(resolved)!==parent||basename(resolved)!=='.life-archive-transfers')throw invalid();
}
export function assertLifeTransferFile(path,limit){
 assertLifeTransferParent(path);
 const file=lstatSync(path);
 if(!file.isFile()||file.isSymbolicLink()||file.size>limit)throw invalid();
 return file.size;
}
export function cleanLifeArchiveTransfers(dataRoot){
 const sample=lifeTransferPath(dataRoot,'00000000-0000-0000-0000-000000000000');
 try{assertLifeTransferParent(sample);}
 catch(error){if(error.code==='ENOENT')return;throw error;}
 for(const item of readdirSync(dirname(sample),{withFileTypes:true})){
  if(!item.isFile()||!item.name.endsWith('.partial')||!transferIdPattern.test(item.name.slice(0,-8)))continue;
  try{unlinkSync(join(dirname(sample),item.name));}
  catch(error){if(!['ENOENT','EBUSY','EPERM'].includes(error.code))throw error;}
 }
}
export function createLifeArchiveTransfers(dataRoot){
 const active=new Map(),operations=new Set();let closing=false;
 function run(fn){
  const task=Promise.resolve().then(fn);
  operations.add(task);
  void task.finally(()=>operations.delete(task)).catch(()=>{});
  return task;
 }
 async function remove(entry){
  if(active.get(entry.id)!==entry)return;
  active.delete(entry.id);clearTimeout(entry.timer);
  try{assertLifeTransferParent(entry.path);}
  catch(error){if(error.code==='ENOENT')return;throw error;}
  await rm(entry.path,{force:true});
 }
 function touch(entry){
  clearTimeout(entry.timer);
  entry.timer=setTimeout(()=>{if(entry.busy)touch(entry);else void run(()=>remove(entry)).catch(()=>{});},TTL);
  entry.timer.unref();
 }
 function reserve(kind,bytes,encoding='zip'){
  if(closing||active.size>=MAX_ACTIVE||!Number.isSafeInteger(bytes)||bytes<1||bytes>(encoding==='base64'?MAX_BASE64:MAX_ZIP))throw invalid();
  const id=randomUUID(),path=lifeTransferPath(dataRoot,id),entry={id,path,kind,bytes,encoding,offset:0,busy:false};
  active.set(id,entry);touch(entry);return entry;
 }
 function withEntry(id,kind,fn){
  const entry=active.get(id);
  if(closing||!entry||entry.kind!==kind||entry.busy)throw unavailable();
  entry.busy=true;touch(entry);
  return run(async()=>{try{return await fn(entry);}finally{entry.busy=false;if(entry.cancelled)await remove(entry);}});
 }
 const descriptor=entry=>({id:entry.id,bytes:entry.bytes,chunkBytes:lifeArchiveChunkBytes});
 const api={
  beginImport(bytes,encoding='zip'){
   const entry=reserve('import',bytes,encoding);
   entry.busy=true;
   return run(async()=>{
    try{await mkdir(dirname(entry.path),{recursive:true});assertLifeTransferParent(entry.path);const file=await open(entry.path,'wx');await file.close();return descriptor(entry);}
    catch(error){await remove(entry);throw error;}
    finally{entry.busy=false;if(entry.cancelled)await remove(entry);}
   });
  },
  beginExport(bytes,prepare){
   const entry=reserve('export',bytes);
   entry.busy=true;
   return run(async()=>{
    try{
     await mkdir(dirname(entry.path),{recursive:true});
     assertLifeTransferParent(entry.path);
     const metadata=await prepare(entry.id);
     if(metadata.bytes!==bytes)throw invalid();
     return {...descriptor(entry),fileName:metadata.fileName,sha256:metadata.sha256};
    }catch(error){await remove(entry);throw error;}
    finally{entry.busy=false;if(entry.cancelled)await remove(entry);}
   });
  },
  append(id,offset,value){
   return withEntry(id,'import',async entry=>{
    const data=entry.encoding==='base64'?(typeof value==='string'?value:null):
     value instanceof Uint8Array?Buffer.from(value.buffer,value.byteOffset,value.byteLength):null;
    if(!data?.length||data.length>lifeArchiveChunkBytes||offset!==entry.offset||entry.offset+data.length>entry.bytes||
     typeof data==='string'&&Buffer.byteLength(data,'utf8')!==data.length)throw invalid();
    if(assertLifeTransferFile(entry.path,entry.bytes)!==entry.offset)throw invalid();
    try{
     const target=await open(entry.path,'a');
     try{await target.writeFile(data);}
     finally{await target.close();}
    }catch(error){await remove(entry);throw error;}
    entry.offset+=data.length;
    return {offset:entry.offset};
   });
  },
  next(id,offset){
   return withEntry(id,'export',async entry=>{
    if(offset!==entry.offset||offset>=entry.bytes)throw invalid();
    if(assertLifeTransferFile(entry.path,entry.bytes)!==entry.bytes)throw invalid();
    const length=Math.min(lifeArchiveChunkBytes,entry.bytes-offset),data=Buffer.alloc(length),file=await open(entry.path,'r');
    try{
     let read=0;
     while(read<length){const result=await file.read(data,read,length-read,offset+read);if(!result.bytesRead)throw invalid();read+=result.bytesRead;}
    }finally{await file.close();}
    entry.offset+=length;
    return {data,done:entry.offset===entry.bytes};
   });
  },
  finishImport(id,finish){
   return withEntry(id,'import',async entry=>{
    if(entry.offset!==entry.bytes)throw invalid();
    if(assertLifeTransferFile(entry.path,entry.bytes)!==entry.bytes)throw invalid();
    try{return await finish(entry);}
    finally{await remove(entry);}
   });
  },
  abort(id){
   return run(async()=>{
    const entry=active.get(id);if(!entry)return;
    entry.cancelled=true;if(!entry.busy)await remove(entry);
   });
  },
  async close(){closing=true;while(operations.size)await Promise.allSettled([...operations]);await Promise.all([...active.values()].map(remove));}
 };
 return api;
}
