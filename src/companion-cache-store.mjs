import {join,resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
import {messageInvalidator,scopeMatches} from './companion-cache-schema.mjs';

function startWorker(filename,retryMs,onEvents,unavailable,nativeRecovery){
 const file=typeof __dirname==='string'
  ?join(__dirname,'companion-cache-worker.mjs')
  :new URL('./companion-cache-worker.mjs',import.meta.url);
 const worker=new Worker(file,{workerData:{filename,retryMs,unavailable,nativeRecovery},execArgv:[]});
 const pending=new Map();
 let sequence=0,stopped=false,closing=false;
 function rejectPending(error){
  if(!stopped&&!closing)onEvents([{type:'companion-cache-memory-fallback',code:'COMPANION_CACHE_WORKER_EXIT'}],[]);
  stopped=true;
  for(const {reject} of pending.values())reject(error);
  pending.clear();
 }
 const exited=new Promise(resolve=>worker.once('exit',()=>{
  rejectPending(Object.assign(Error('Cache worker exited'),{code:'COMPANION_CACHE_WORKER_EXIT'}));
  resolve();
 }));
 worker.on('error',rejectPending);
 worker.on('message',({seq,ok,result,error,errorKind,audit,appliedPrivacy,appliedNative,appliedApi})=>{
  const request=pending.get(seq);
  if(!request)return;
  pending.delete(seq);
  if(!pending.size)worker.unref();
  onEvents(audit,appliedPrivacy,appliedNative,appliedApi);
  if(ok)request.resolve(result);
  else request.reject(Object.assign(Error('Cache storage request failed'),{code:error,errorKind}));
 });
 worker.unref();
 return {
  get stopped(){return stopped;},
  exited,
  request(op,clientId,args,work){
   return new Promise((resolve,reject)=>{
    if(stopped){reject(Object.assign(Error('Cache worker is unavailable'),{code:'COMPANION_CACHE_WORKER_EXIT'}));return;}
    const seq=++sequence;
    pending.set(seq,{resolve,reject});
    worker.ref();
    try{worker.postMessage({seq,op,clientId,args,work});}
    catch(error){
     pending.delete(seq);
     if(!pending.size)worker.unref();
     reject(error);
    }
   });
  },
  async close(){
   closing=true;
   worker.ref();
   try{await this.request('close');}
   catch{await worker.terminate();}
   finally{worker.ref();}
   await exited;
  },
 };
}

const workers=new Map();
const nativeRetryDelays=[100,400,1000,5000];
let nextClientId=0,nextChangeId=0;
export const NATIVE_WRITE_QUEUED=Symbol('Native write queued in memory');

function leaseWorker(dataRoot,audit,retryMs,observePrivacy){
 const filename=resolve(dataRoot,'companion-cache-r1.sqlite');
 const pathKey=process.platform==='win32'?filename.toLowerCase():filename;
 let entry=workers.get(pathKey);
 if(!entry){
  entry={tail:Promise.resolve(),scheduled:0,audits:new Map(),privacyObservers:new Map(),privacy:new Map(),native:new Map(),nativeChanges:new Map(),nativeRows:new Map(),api:new Map(),durable:true,retryMs};
  workers.set(pathKey,entry);
 }
 const clientId=++nextClientId;
 entry.audits.set(clientId,audit);
 if(observePrivacy)entry.privacyObservers.set(clientId,observePrivacy);
 const schedule=run=>{
  entry.scheduled++;
  const task=entry.tail.then(run).finally(()=>{entry.scheduled--;});
  entry.tail=task.catch(()=>{});
  return task;
 };
 const onEvents=(events,appliedPrivacy=[],appliedNative=[],appliedApi=[])=>{
  for(const id of appliedPrivacy){
   entry.privacy.get(id)?.onApplied();
   entry.privacy.delete(id);
  }
  for(const {key,id} of appliedNative){
   entry.nativeChanges.delete(id);
   if(entry.native.get(key)?.id===id)entry.native.delete(key);
  }
  for(const {clientId,ids} of appliedApi){
   const rows=entry.api.get(clientId);
   if(!rows)continue;
   for(const [key,id] of ids){
    const pending=rows.get(key);
    if(pending?.id!==id)continue;
    rows.delete(key);
    pending.onApplied(pending.row);
   }
   if(!rows.size)entry.api.delete(clientId);
  }
  for(const event of events){
   if(event.type==='companion-cache-memory-fallback')entry.durable=false;
   if(event.type==='companion-cache-durability-restored')entry.durable=true;
   for(const subscriber of entry.audits.values())try{subscriber(event);}catch{}
  }
 };
 const perform=async(op,args=[])=>{
  if(entry.worker?.stopped){await entry.worker.exited;entry.worker=null;}
  if(!entry.worker){
   try{entry.worker=startWorker(filename,entry.retryMs,onEvents,!entry.durable,entry.durable?undefined:[...entry.nativeRows]);}
   catch(error){
    if(entry.durable)onEvents([{type:'companion-cache-memory-fallback',code:error.code??error.name}]);
    throw error;
   }
  }
  const privacy=[...entry.privacy.values()].map(({id,clientId,op,args})=>({id,clientId,op,args}));
  const work={privacy,native:[...entry.nativeChanges.values()]};
  if(op==='flush'||op==='probe'||op==='nativeProbe'||op==='drain'){
   if(op!=='nativeProbe')work.api=[...entry.api].map(([clientId,rows])=>({clientId,rows:[...rows.values()].map(({id,row,base})=>({id,row,base}))}));
   work.openClients=[...entry.audits.keys()];
  }else if(op==='hydrate'){
   work.closedApi=[...entry.api].filter(([id])=>!entry.audits.has(id)).map(([clientId,rows])=>({
    clientId,rows:[...rows].map(([key,{id,base}])=>({key,id,base})),
   }));
  }
  return entry.worker.request(op,clientId,args,work);
 };
 const request=(op,...args)=>schedule(()=>perform(op,args));
 const hasPending=()=>entry.privacy.size||entry.nativeChanges.size||entry.api.size;
 const scheduleNativeReplay=()=>{
  if(entry.nativeReplayTimer||!entry.nativeChanges.size||!entry.audits.size)return;
  const attempt=entry.nativeReplayAttempt??0;
  const timer=setTimeout(()=>{
   void schedule(async()=>{
    if(entry.nativeReplayTimer!==timer)return;
    try{
     if(entry.nativeChanges.size&&entry.audits.size)await perform('nativeProbe');
     entry.nativeReplayAttempt=0;
    }catch{
     entry.nativeReplayAttempt=Math.min(attempt+1,nativeRetryDelays.length-1);
    }finally{
     // Keep one replay scheduled even while the regular worker lane is busy.
     if(entry.nativeReplayTimer===timer){
      entry.nativeReplayTimer=null;
      scheduleNativeReplay();
     }
    }
   });
  },nativeRetryDelays[attempt]);
  entry.nativeReplayTimer=timer;
  timer.unref();
 };
 const dropApi=(key,pending,rows)=>{
  rows.delete(key);
  pending.onApplied(pending.row);
 };
 const reviseApi=(rows,key,pending,row)=>rows.set(key,{...pending,row,id:++nextChangeId});
 scheduleNativeReplay();
 return {
  get durable(){return entry.durable;},
  get hasPrivacy(){return entry.privacy.size>0;},
  get hasApi(){return entry.api.has(clientId);},
  projectPendingApi(scope,payload){
   for(const {op,args,repair} of entry.privacy.values()){
    if(op==='clear'&&scopeMatches(scope,args))return null;
    if(repair)payload=repair(payload,scope.conversationId)??payload;
   }
   return payload;
  },
  hydrate(onApplied){
   return schedule(async()=>{
    const {rows,adopted}=await perform('hydrate');
    if(!adopted.length)return rows;
    const visible=new Map(rows.map(row=>[row.scope.key,row]));
    const owned=new Map();
    for(const {previousId,key,id} of adopted){
     const previous=entry.api.get(previousId),pending=previous?.get(key);
     if(pending?.id!==id)continue;
     previous.delete(key);
     if(!previous.size)entry.api.delete(previousId);
     owned.set(key,{...pending,onApplied});
     visible.set(key,pending.row);
    }
    if(owned.size)entry.api.set(clientId,owned);
    return [...visible.values()];
   });
  },
  reviseApi(row){
   const rows=entry.api.get(clientId),pending=rows?.get(row.scope.key);
   if(pending)reviseApi(rows,row.scope.key,pending,row);
  },
  flush(currentBatch,onApplied){
   return schedule(async()=>{
    const batch=currentBatch();
    if(batch.length){
     const rows=entry.api.get(clientId)??new Map();
     for(const [key,row] of batch)rows.set(key,{id:++nextChangeId,row,onApplied});
     entry.api.set(clientId,rows);
    }
    return perform('flush');
   });
  },
  privacy(op,args,onApplied){
   const id=++nextChangeId;
   const repair=op==='invalidate'?messageInvalidator(args):null;
   const acknowledgements=[onApplied];
   entry.privacy.set(id,{id,clientId,op,args,repair,onApplied(){for(const acknowledge of acknowledgements)acknowledge();}});
   for(const [owner,observe] of entry.privacyObservers)if(owner!==clientId)acknowledgements.push(observe(op,args));
   for(const [id,rows] of entry.api){
    for(const [key,pending] of rows){
     const {row}=pending;
     if(op==='clear'&&scopeMatches(row.scope,args))dropApi(key,pending,rows);
     else if(repair){
      const payload=repair(row.payload,row.scope.conversationId);
      if(payload)reviseApi(rows,key,pending,{...row,revision:row.revision+1,payload});
     }
    }
    if(!rows.size)entry.api.delete(id);
   }
   return request('probe');
  },
  native(op,key,value){
   if(op==='nativeRead'){
    const read=()=>structuredClone(entry.nativeRows.get(key)??null);
    if(entry.native.has(key)||(entry.nativeHydrated&&entry.scheduled))return read();
    return schedule(async()=>{
     if(!entry.native.has(key)){
      try{
       const row=await perform(op,[key]);
       // A write can enter the live projection while the read is in flight.
       if(!entry.native.has(key)){
        if(row===null)entry.nativeRows.delete(key);
        else entry.nativeRows.set(key,row);
       }
      }catch{}
     }
     return read();
    });
   }
   if(op==='nativeList'){
    const list=()=>[...entry.nativeRows.keys()].sort().map(key=>({key,value:structuredClone(entry.nativeRows.get(key))}));
    if(entry.nativeHydrated&&entry.scheduled)return list();
    return schedule(async()=>{
     try{
      const rows=await perform(op);
      entry.nativeRows=new Map(rows.map(({key,value})=>[key,value]));
      for(const change of entry.native.values()){
       if(change.remove)entry.nativeRows.delete(change.key);
       else entry.nativeRows.set(change.key,change.value);
      }
      entry.nativeHydrated=true;
     }catch(error){
      if(value&&!entry.nativeHydrated)throw error;
     }
     return list();
    });
   }
   // Keep acknowledged writes and removals in the durable sequence even
   // when a different facade has already projected a newer value.
   const remove=op==='nativeRemove',deferred=op==='nativeWriteDeferred';
   const previous=entry.native.get(key);
   if(deferred&&previous?.deferred)entry.nativeChanges.delete(previous.id);
   const change={id:++nextChangeId,key,value,remove,deferred};
   entry.nativeChanges.set(change.id,change);
   entry.native.set(key,change);
   if(remove)entry.nativeRows.delete(key);
   else entry.nativeRows.set(key,value);
   if(deferred){
    scheduleNativeReplay();
    return NATIVE_WRITE_QUEUED;
   }
   return schedule(async()=>{
    try{await perform('probe');return true;}
    catch{return remove?false:NATIVE_WRITE_QUEUED;}
   });
  },
  close(){
   entry.audits.delete(clientId);
   entry.privacyObservers.delete(clientId);
   const lastLease=!entry.audits.size;
   if(lastLease){clearTimeout(entry.nativeReplayTimer);entry.nativeReplayTimer=null;entry.nativeReplayAttempt=0;}
   return schedule(async()=>{
    if(entry.audits.size||hasPending()){
     if(lastLease&&!entry.audits.size)await perform('drain').catch(()=>{});
     const queued=entry.api.get(clientId);
     if(queued){
      const bases=await entry.worker?.request('park',clientId,[...queued.keys()]).catch(()=>null);
      for(const [key,base] of bases??[]){const pending=queued.get(key);if(pending)pending.base=base;}
     }else await entry.worker?.request('release',clientId,[]).catch(()=>{});
     if(entry.audits.size||hasPending())return;
    }
    try{await entry.worker?.close();}
    finally{
     entry.worker=null;
     if(!entry.audits.size)workers.delete(pathKey);
    }
   });
  },
 };
}

// The authoritative conversation store and all r21 schemas stay untouched.
export function createCompanionCacheStore(dataRoot,audit=()=>{},{retryMs=600000}={}){
 const rows=new Map();
 const dirty=new Map();
 const beforeHydrate=[];
 const clearing=new Set();
 const discarded=new Set();
 let worker,hydration,closing;
 let hydrated=!dataRoot;
 let tail=Promise.resolve();
 function onFlushed(row){
  const {key}=row.scope;
  if(dirty.get(key)===row)dirty.delete(key);
 }
 function projectClear(selector,sibling=false){
  for(const [key,row] of rows)if(scopeMatches(row.scope,selector)){
   rows.delete(key);
   if(dirty.delete(key)&&sibling)discarded.add(key);
  }
 }
 function projectInvalidation(inputs){
  const repair=messageInvalidator(inputs);
  for(const [key,row] of rows){
   const payload=repair(row.payload,row.scope.conversationId);
   if(!payload)continue;
   const next={...row,revision:row.revision+1,payload};
   rows.set(key,next);
   if(dirty.has(key)){dirty.set(key,next);worker?.reviseApi(next);}
  }
 }
 function syncPrivacy(op,args){
  if(op==='clear')clearing.add(args);
  const apply=()=>op==='clear'?projectClear(args,true):projectInvalidation(args);
  if(hydrated)apply();
  else beforeHydrate.push(apply);
  return ()=>{if(op==='clear')clearing.delete(args);};
 }
 function ready(){
  if(hydration)return hydration;
  hydration=(async()=>{
   if(!dataRoot)return;
   try{
    worker=leaseWorker(dataRoot,audit,retryMs,syncPrivacy);
    for(const row of await worker.hydrate(onFlushed))if(!rows.has(row.scope.key))rows.set(row.scope.key,row);
   }catch(error){
    if(worker?.durable)audit({type:'companion-cache-memory-fallback',code:error.code??error.name});
   }
   finally{
    hydrated=true;
    for(const apply of beforeHydrate.splice(0))apply();
   }
  })();
  return hydration;
 }
 function schedule(run){
  const task=tail.then(async()=>{
   await ready();
   return run();
  });
  tail=task.catch(()=>{});
  return task;
 }
 function change(op,args,apply){
  if(closing)return Promise.resolve(false);
  if(hydrated)apply();
  else beforeHydrate.push(apply);
  if(!dataRoot)return Promise.resolve(true);
  return schedule(async()=>{
   try{return await worker.privacy(op,args,()=>{if(op==='clear')clearing.delete(args);});}
   catch(error){
    audit({type:'companion-cache-privacy-cleanup-failed',code:error.errorKind??error.code??error.name});
    return false;
   }
  });
 }
 function clear(selector){
  if(Object.entries(selector).some(([key,value])=>key!=='legacyConversationIds'&&(typeof value!=='string'||!value)))return Promise.resolve(false);
  if(dataRoot&&!closing)clearing.add(selector);
  return change('clear',selector,()=>projectClear(selector));
 }
 function flush(scopeKey){
  if(!dataRoot)return Promise.resolve(true);
  if(!worker&&!hydration&&!dirty.size)return Promise.resolve(true);
  return schedule(async()=>{
   const selected=key=>scopeKey===undefined||scopeKey===key;
   const keys=[...dirty.keys()].filter(selected);
   let rejected=false;
   const takeDiscarded=()=>{
    for(const key of discarded)if(selected(key)){
     discarded.delete(key);
     rejected=true;
    }
   };
   takeDiscarded();
   if(!keys.length&&worker.durable&&!worker.hasPrivacy&&!worker.hasApi)return !rejected;
   try{
    const committed=await worker.flush(()=>{
     // Privacy can replace or remove rows while this flush waits for the shared worker.
     takeDiscarded();
     const current=[];
     for(const key of keys){
      const row=dirty.get(key);
      if(row)current.push([key,row]);
     }
     return current;
    },onFlushed);
    if(!committed)audit({type:'companion-cache-write-conflict'});
    return committed&&!rejected;
   }catch(error){
    audit({type:'companion-cache-flush-failed',code:error.errorKind??error.code??error.name});
    return false;
   }
  });
 }
 return {
  isDurable:()=>!!dataRoot&&(worker?.durable??true),
  hasPendingWrite:scopeKey=>dirty.has(scopeKey),
  ready,
  read(scopeKey){
   const row=rows.get(scopeKey);
   return row?{...structuredClone(row.payload),revision:row.revision}:null;
  },
  write(scope,previousRevision,payload){
   if(!hydrated||closing||(rows.get(scope.key)?.revision??null)!==(previousRevision??null))return null;
   for(const selector of clearing)if(scopeMatches(scope,selector))return null;
   const revision=(previousRevision??0)+1;
   let window={...structuredClone(payload),version:1};
   if(worker?.hasPrivacy){window=worker.projectPendingApi(scope,window);if(!window)return null;}
   const row={scope:{...scope},revision,payload:window};
   rows.set(scope.key,row);
   discarded.delete(scope.key);
   if(dataRoot){dirty.set(scope.key,row);worker?.reviseApi(row);}
   return revision;
  },
  flush,
  invalidateMessages(messages){
   if(!messages.length)return Promise.resolve(true);
   const inputs=structuredClone(messages);
   return change('invalidate',inputs,()=>projectInvalidation(inputs));
  },
  clearScope:clear,
  clearCharacter:characterId=>clear({characterId}),
  clearConversation:conversationId=>clear({conversationId}),
  clearPersona:(personaId,legacyConversationIds=[])=>clear({personaId,legacyConversationIds:[...legacyConversationIds]}),
  clearLife:(characterId,lifeId,legacyConversationIds=[])=>clear({characterId,lifeId,legacyConversationIds:[...legacyConversationIds]}),
  close(){
   closing??=(async()=>{
    await hydration;
    await flush();
    await worker?.close();
    rows.clear();
    dirty.clear();
    clearing.clear();
    discarded.clear();
   })();
   return closing;
  },
 };
}

// Native lifecycle records share the M3 storage worker; no synchronous SQLite
// operation runs on the application's main thread. The provider owns this
// namespace independently of the append-only conversation windows.
export function createCompanionNativeStore(dataRoot,audit=()=>{}){
 const memory=new Map();
 let worker,closing;
 const pending=new Set();
 const run=async(op,...args)=>{
  if(closing)throw Object.assign(Error('Native cache is closed'),{code:'COMPANION_CACHE_CLOSED'});
  if(!dataRoot){
   if(op==='nativeRead')return structuredClone(memory.get(args[0])??null);
   if(op==='nativeList')return [...memory].map(([key,value])=>({key,value:structuredClone(value)}));
   if(op==='nativeWrite'||op==='nativeWriteDeferred'){memory.set(args[0],structuredClone(args[1]));return true;}
   memory.delete(args[0]);return true;
  }
  worker??=leaseWorker(dataRoot,audit,600000);
  const result=worker.native(op,...args);
  if(!(result instanceof Promise))return result;
  pending.add(result);
  try{return await result;}
  finally{pending.delete(result);}
 };
 const key=value=>{
  if(typeof value!=='string'||!value||value.length>4096)throw TypeError('Invalid native cache key');
  return value;
 };
 return {
  read:value=>run('nativeRead',key(value)),
  list:({requireSnapshot=false}={})=>run('nativeList',undefined,requireSnapshot),
  write:(name,value,{deferBusy=false}={})=>{
   if(!value||typeof value!=='object'||Array.isArray(value))throw TypeError('Invalid native cache value');
   const cloned=structuredClone(value);
   if(dataRoot)JSON.stringify(cloned);
   return run(deferBusy?'nativeWriteDeferred':'nativeWrite',key(name),cloned);
  },
  remove:value=>run('nativeRemove',key(value)),
  close(){closing??=(async()=>{await Promise.allSettled([...pending]);await worker?.close();memory.clear();})();return closing;},
 };
}
