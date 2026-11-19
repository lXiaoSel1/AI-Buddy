import {isMainThread,Worker} from 'node:worker_threads';
import {join} from 'node:path';
import {channel} from 'node:diagnostics_channel';
import {lifeImageChunkBytes,lifeImageGate as imageGate,maxLifeImageBytes,maxLifeThumbnailBytes} from './companion-life-image-wire.mjs';

import {sendLifeMetadata} from './companion-life-metadata-wire.mjs';

const workerStart=channel('ai-buddy.companion.worker-start');

const sessions=new Map();
function workerFile(){
  if(typeof __dirname==='string')return join(__dirname,'companion-storage-worker.mjs');
  return new URL('./companion-storage-worker.mjs',import.meta.url);
}

export function runCompanionStorageWorker(data,onProgress,{onModel,timeoutMs,streamLifeMetadata}={}){
  const workerData=streamLifeMetadata?{...data,streamLifeMetadata:true}:data;
  const worker=new Worker(workerFile(),{workerData,execArgv:[]});
  workerStart.publish(data.operation);
  return new Promise((resolve,reject)=>{
    let result,error,terminating,exited=false;
    const stop=()=>{terminating??=worker.terminate();void terminating.catch(()=>{});};
    const timeout=timeoutMs===undefined?null:setTimeout(()=>{
      error=Object.assign(Error('Companion storage worker timed out'),{code:'COMPANION_WORKER_TIMEOUT'});
      stop();
    },timeoutMs);
    worker.on('message',message=>{
      if(terminating)return;
      if(message.model){
        Promise.resolve().then(()=>{
          if(!onModel)throw Error('Companion worker model callback is unavailable');
          return onModel(message.model.characterId,message.model.options);
        }).then(value=>worker.postMessage({modelResult:{id:message.model.id,value}}),failure=>{
          worker.postMessage({modelResult:{id:message.model.id,error:{message:failure.message,code:failure.code}}});
        }).catch(failure=>{error=failure;void worker.terminate();});
        return;
      }
      if(message.progress){try{onProgress?.(message.progress);}catch{}}
      if(message.result!==undefined)result=message.result;
      if(message.error)error=Object.assign(Error(message.error.message),{code:message.error.code});
    });
    worker.on('error',value=>{error??=value;});
    worker.once('exit',async code=>{
      exited=true;
      clearTimeout(timeout);
      if(terminating)try{await terminating;}catch(value){error.cause=value;}
      if(error||code!==0||result===undefined)reject(error??Error('Companion storage worker exited without a result'));
      else resolve(result);
    });
    if(streamLifeMetadata)void sendLifeMetadata(worker,streamLifeMetadata,()=>!terminating&&!exited).catch(value=>{
      error??=value;
      stop();
    });
  });
}

export function prepareCompanionStorage(path,legacyPath,initial,{onMigrationProgress,interruptMigrationAfter,cleanRestoreSources}={}){
  if(!isMainThread)throw Error('Only the companion host may start migration');
  if(sessions.has(path))return sessions.get(path);
  const task=runCompanionStorageWorker({
    operation:'migrate',path,legacyPath,initial,interruptAfter:interruptMigrationAfter,cleanRestoreSources
  },onMigrationProgress).finally(()=>sessions.delete(path));
  sessions.set(path,task);
  return task;
}

const readers=new Map();
const readerCloseTimeoutMs=1000;
const retryable=()=>Object.assign(Error('Companion storage worker exited; retry the request'),{code:'COMPANION_WORKER_RETRY'});

function startStorageSession(path,operation,lane='reader'){
  const worker=new Worker(workerFile(),{workerData:{path,operation:lane},execArgv:[]});
  const pending=new Map();
  let stopped=false;
  const exited=new Promise(resolve=>{
    worker.once('exit',()=>{
      stopped=true;
      for(const {reject,timeout,timeoutError} of pending.values()){
        clearTimeout(timeout);
        reject(timeoutError??retryable());
      }
      pending.clear();
      resolve();
    });
  });
  function finish(id){
    const request=pending.get(id);
    clearTimeout(request?.timeout);
    pending.delete(id);
    if(!pending.size&&!stopped)worker.unref();
    return request;
  }
  // Worker errors terminate the thread. The exit handler rejects outstanding
  // requests only after synchronous SQLite work has definitively stopped.
  worker.on('error',()=>{});
  worker.on('message',message=>{
    if(stopped)return;
    const request=pending.get(message.id);
    if(!request)return;
    if(message.model){
      const {id,characterId,options}=message.model;
      Promise.resolve().then(()=>{
        if(!request.onModel)throw Error('Companion worker model callback is unavailable');
        return request.onModel(characterId,options);
      }).then(value=>({id,value}),error=>({id,error:{message:error.message,code:error.code}}))
        .then(modelResult=>{
          if(!stopped&&pending.has(message.id))worker.postMessage({id:message.id,modelResult});
        }).catch(()=>{void worker.terminate();});
      return;
    }
    if(message.image){
      const {bytes,gate,output,convert}=message.image,outputLimit=convert?maxLifeImageBytes:maxLifeThumbnailBytes;
      const {STATUS,TOTAL,OFFSET,LENGTH,WAITING,CHUNK,DONE,FAILED}=imageGate;
      function assertWaiting(){
        if(stopped||!pending.has(message.id)||Atomics.load(gate,STATUS)!==WAITING)
          throw Error('Companion worker image validation did not complete');
      }
      let received=0,declared=0;
      async function onThumbnailChunk({offset,total,bytes}){
        assertWaiting();
        if(!output||offset!==received||declared&&declared!==total||
          !Number.isSafeInteger(total)||total<24||total>outputLimit||
          !(bytes instanceof Uint8Array)||!bytes.byteLength||bytes.byteLength>lifeImageChunkBytes||
          offset+bytes.byteLength>total)throw Error('Companion worker thumbnail is unavailable');
        declared=total;output.set(bytes);
        Atomics.store(gate,TOTAL,total);Atomics.store(gate,OFFSET,offset);Atomics.store(gate,LENGTH,bytes.byteLength);
        if(Atomics.compareExchange(gate,STATUS,WAITING,CHUNK)!==WAITING)
          throw Error('Companion worker image validation did not complete');
        Atomics.notify(gate,STATUS);
        await Atomics.waitAsync(gate,STATUS,CHUNK,10000).value;
        assertWaiting();
        received+=bytes.byteLength;
      }
      Promise.resolve().then(()=>{
        if(!request.onImage)throw Error('Companion worker image callback is unavailable');
        return request.onImage(Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength),{thumbnail:!!output&&!convert,convert,onThumbnailChunk});
      }).then(result=>{
        assertWaiting();
        if(result===false)throw Error('Companion worker image validation did not complete');
        if(output){
          const bytes=convert?result?.bytes:result?.thumbnailBytes,sha256=convert?result?.sha256:result?.thumbnailSha256;
          if(received<24||received!==declared||received!==bytes||
            typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256))
            throw Error('Companion worker PNG output is unavailable');
          output.set(Buffer.from(sha256,'hex'),lifeImageChunkBytes);
        }
        if(Atomics.compareExchange(gate,STATUS,WAITING,DONE)!==WAITING)
          throw Error('Companion worker image validation did not complete');
      }).catch(()=>Atomics.store(gate,STATUS,FAILED)).finally(()=>Atomics.notify(gate,STATUS));
      return;
    }
    if(message.batch||message.archive){
      const type=message.archive?'archive':'batch',callback=message.archive?request.onArchive:request.onBatch;
      const {id,value}=message[type];
      const assertCurrent=()=>{
        if(stopped||pending.get(message.id)!==request)throw retryable();
      };
      Promise.resolve().then(()=>{
        assertCurrent();
        if(!callback)throw Error('Companion worker '+type+' callback is unavailable');
        return callback(value,assertCurrent);
      }).then(()=>({id}),error=>({id,error:{message:error.message,code:error.code}}))
        .then(result=>{
          if(!stopped&&pending.has(message.id))worker.postMessage({id:message.id,[type+'Result']:result});
        }).catch(()=>{void worker.terminate().catch(()=>{});});
      return;
    }
    finish(message.id);
    if(message.error){
      const {message:description,code,missing}=message.error;
      const error=Object.assign(Error(description),{code});
      if(code==='LIFE_ARCHIVE_MISSING_CG'&&Array.isArray(missing))error.missing=missing;
      request.reject(error);
    }
    else request.resolve(message.result);
  });
  let sequence=0;
  const session={
    get stopped(){return stopped;},exited,
    read(data,lease,{onModel,onBatch,onImage,onArchive,timeoutMs}){
      worker.ref();
      const id=++sequence;
      return new Promise((resolve,reject)=>{
        const request={lease,resolve,reject,onModel,onBatch,onImage,onArchive};
        if(timeoutMs!==undefined)request.timeout=setTimeout(()=>{
          request.timeoutError=Object.assign(Error('Companion storage request timed out'),{code:'COMPANION_WORKER_TIMEOUT'});
          stopped=true;
          void worker.terminate().catch(()=>{});
        },timeoutMs);
        pending.set(id,request);
        try{worker.postMessage({id,data});}catch(error){finish(id);reject(error);}
      });
    },
    cancel(lease){
      for(const [id,request] of pending)if(request.lease===lease){
        finish(id);
        request.reject(retryable());
        if(!stopped)worker.postMessage({id,cancel:true});
      }
    },
    async stop(force){
      worker.ref();
      if(force){await worker.terminate();await exited;return;}
      if(!stopped)worker.postMessage({close:true});
      let timer;
      try{
        await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>resolve(worker.terminate()),readerCloseTimeoutMs);})]);
      }finally{clearTimeout(timer);}
    }
  };
  workerStart.publish(operation);
  worker.unref();
  return session;
}

export const memoryRecordBatchRows=64,memoryRecordBatchBytes=48*1024;

export function boundedMemoryRecordPlanBytes({owners,recordStages,messageMoves,recordMoves}){
  if(owners.size||messageMoves.length||recordMoves.length)return null;
  let rows=0,bytes=0;
  for(const {rows:records,descriptor,cleared,removed} of recordStages.values()){
    if(cleared)return null;
    rows+=records.size+Number(!!descriptor)+Number(removed);
    if(rows>memoryRecordBatchRows)return null;
    for(const record of records.values())if(record){
      bytes+=Buffer.byteLength(JSON.stringify(record.value));
      if(bytes>memoryRecordBatchBytes)return null;
    }
  }
  return rows?bytes:null;
}

function createStoragePublisher(path,operation,lane){
  let session;
  return {
    async publish(data,options){
      if(session?.stopped){
        const previous=session;
        await previous.exited;
        if(session===previous)session=null;
      }
      session??=startStorageSession(path,operation,lane);
      return session.read(data,null,options);
    },
    async stop(force=false){
      if(!session)return;
      try{await session.stop(force);}
      catch(error){
        if(!force){await session.stop(true);session=null;}
        throw error;
      }
      session=null;
    }
  };
}

// The producer can be blocked awaiting a batch reply on the reader lane.
export const createCompanionMemoryPublisher=path=>createStoragePublisher(path,'memory.publisher','memory-publisher');
// Auto eviction and memory checkpoints must share the same write connection
// even when independent companion store leases are open on this path.
const autoArchiveOwners=new Map();
export function createCompanionAutoArchivePublisher(path){
  let owner=autoArchiveOwners.get(path);
  if(!owner){
    owner={publisher:createStoragePublisher(path,'archive-auto-evidence','auto-archive-publisher'),leases:0,closing:null};
    autoArchiveOwners.set(path,owner);
  }
  owner.leases++;
  let stopped=false;
  return {
    async publish(data,options){
      if(owner.closing)await owner.closing;
      if(stopped)throw retryable();
      return owner.publisher.publish(data,options);
    },
    async stop(){
      if(stopped)return;
      stopped=true;
      if(--owner.leases)return;
      owner.closing??=owner.publisher.stop().finally(()=>{
        owner.closing=null;
        if(!owner.leases)autoArchiveOwners.delete(path);
      });
      return owner.closing;
    }
  };
}

export function acquireCompanionStorageReader(path){
  let shared=readers.get(path);
  if(!shared){
    shared={leases:new Set(),session:null,lastWrite:new BigInt64Array(new SharedArrayBuffer(16))};
    readers.set(path,shared);
  }
  const lease={},reads=new Set();
  shared.leases.add(lease);
  let closed=false;
  return {
    read(data,options={}){
      if(closed)return Promise.reject(retryable());
      if(!shared.session||shared.session.stopped)shared.session=startStorageSession(path,data.operation);
      const task=shared.session.read(data,lease,options);
      reads.add(task);
      void task.finally(()=>reads.delete(task)).catch(()=>{});
      return task;
    },
    noteWrite(){Atomics.store(shared.lastWrite,0,BigInt(Date.now()));Atomics.add(shared.lastWrite,1,1n);},
    get lastWrite(){return shared.lastWrite;},
    async drain(){
      if(!reads.size)return;
      let timeout,timedOut=false;
      try{
        await Promise.race([
          Promise.allSettled([...reads]),
          new Promise(resolve=>{timeout=setTimeout(()=>{timedOut=true;resolve();},readerCloseTimeoutMs);})
        ]);
      }finally{clearTimeout(timeout);}
      if(!timedOut)return;
      const session=shared.session;
      if(shared.leases.size>1){session?.cancel(lease);return;}
      if(shared.session===session)shared.session=null;
      await session?.stop(true);
    },
    async close(){
      closed=true;
      await this.drain();
      shared.leases.delete(lease);
      if(shared.leases.size)return;
      readers.delete(path);
      await shared.session?.stop(false);
    }
  };
}
