import {appendFileSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const rowsPerAppend=64;
const bytesPerAppend=64*1024;
const attemptsPerDrain=3;
const changedLog=()=>Object.assign(Error('API journal append target changed'),{code:'API_JOURNAL_TARGET_CHANGED'});
const failedLog=(file,cause)=>Object.assign(Error('Could not append the API journal ('+file+')',{cause}),{
 code:'API_JOURNAL_WRITE_FAILED',file,reason:cause?.code
});

function pendingBatch(lines){
 let end=0,bytes=0;
 while(end<lines.length&&end<rowsPerAppend){
  const length=Buffer.byteLength(lines[end]);
  if(end&&bytes+length>bytesPerAppend)break;
  bytes+=length;end++;
 }
 return {data:Buffer.from(lines.splice(0,end).join('')),start:null,identity:null,offset:0};
}

async function recoverPrefix(handle,batch,size){
 const written=size-batch.start;
 if(written<batch.offset||written>batch.data.length)throw changedLog();
 if(written===0)return;
 const actual=Buffer.alloc(written);
 let offset=0;
 while(offset<written){
  const {bytesRead}=await handle.read(actual,offset,written-offset,batch.start+offset);
  if(!bytesRead)throw changedLog();
  offset+=bytesRead;
 }
 if(!actual.equals(batch.data.subarray(0,written)))throw changedLog();
 batch.offset=written;
}

async function writeBatch(path,batch,openFile){
 const file=await openFile(path,'a+');
 try{
  const {size,dev,ino}=await file.stat({bigint:true});
  const fileSize=Number(size),identity=dev+':'+ino;
  if(!Number.isSafeInteger(fileSize))throw changedLog();
  if(batch.start===null){batch.start=fileSize;batch.identity=identity;}
  else{
   if(batch.identity!==identity)throw changedLog();
   await recoverPrefix(file,batch,fileSize);
  }
  while(batch.offset<batch.data.length){
   const remaining=batch.data.length-batch.offset;
   const {bytesWritten}=await file.write(batch.data,batch.offset,remaining,null);
   if(!Number.isSafeInteger(bytesWritten)||bytesWritten<1||bytesWritten>remaining)
    throw Error('API journal reported invalid append progress');
   batch.offset+=bytesWritten;
  }
 }finally{await file.close();}
}

function createLog({file,dataRoot,openFile,onAppended,onError,syncAppend}){
 const path=join(dataRoot,file),lines=[];
 let batch=null,inFlight=null,scheduled=null,failed=false;
 const pending=()=>batch!==null||lines.length>0;

 async function publish(){
  while(pending()){
   batch??=pendingBatch(lines);
   let attempt=0;
   for(;;){
    try{await writeBatch(path,batch,openFile);break;}
    catch(error){
     if(error.code==='API_JOURNAL_TARGET_CHANGED'||++attempt===attemptsPerDrain)throw failedLog(file,error);
     await delay(25*attempt);
    }
   }
   batch=null;
   try{onAppended?.();}catch(error){
    try{onError?.(Object.assign(Error('Could not request a usage monitor refresh',{cause:error}),{
     code:'API_JOURNAL_REFRESH_FAILED',file,reason:error?.code
    }));}catch{}
   }
  }
 }
 function drain(){
  if(scheduled!==null){clearImmediate(scheduled);scheduled=null;}
  if(inFlight)return inFlight;
  if(!pending())return Promise.resolve();
  failed=false;
  inFlight=publish().catch(error=>{
   failed=true;
   try{onError?.(error);}catch{}
   throw error;
  }).finally(()=>{inFlight=null;});
  return inFlight;
 }
 return {
  push(line,{immediate=false}={}){
   // The ordinary audit writer may stay synchronous only when doing so
   // cannot overtake a queued request audit entry.
   if(immediate&&!pending()&&!inFlight){syncAppend(path,line);return;}
   lines.push(line);
   if(!inFlight&&scheduled===null&&!failed)
    scheduled=setImmediate(()=>{scheduled=null;void drain().catch(()=>{});});
  },
  drain
 };
}

export function createApiUsageJournal({dataRoot,onRecorded,onError,openFile=open,appendAuditSync=appendFileSync}){
 const options={dataRoot,openFile,onError};
 const usage=createLog({...options,file:'api-usage.jsonl',onAppended:onRecorded});
 const auditLog=createLog({...options,file:'runtime-audit.jsonl',syncAppend:appendAuditSync});
 return {
  recordUsage:value=>usage.push(JSON.stringify(value)+'\n'),
  audit:value=>auditLog.push(JSON.stringify({timestamp:new Date().toISOString(),...value})+'\n',{immediate:value.type!=='api-request'}),
  async drain(){
   const results=await Promise.allSettled([usage.drain(),auditLog.drain()]);
   const failure=results.find(result=>result.status==='rejected');
   if(failure)throw failure.reason;
  }
 };
}
