import {resolve,dirname,join} from 'node:path';
import {realpathSync} from 'node:fs';

export const DEFERRED_SAVE_INTERVAL_MS=60*60*1000;
const key=path=>{
 let current=resolve(path);const missing=[];
 for(;;){try{current=join(realpathSync.native(current),...missing.reverse());break;}catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;const parent=dirname(current);if(parent===current)break;missing.push(current.slice(parent.length).replace(/^[\\/]+/,''));current=parent;}}
 return process.platform==='win32'?current.toLowerCase():current;
};
const fault=code=>Object.assign(Error(code),{code});

export function createDeferredSaves({setIntervalFn=setInterval,clearIntervalFn=clearInterval,onAudit=()=>{}}={}){
 const stores=new Map(),pauses=new Map();let timer=null,tail=Promise.resolve(),audit=onAudit;
 const report=value=>{try{audit(value);}catch{}};
 const paused=scope=>(pauses.get('*')??0)>0||(pauses.get(scope)??0)>0;
 const selected=({scope,automatic=false}={})=>[...stores.values()].filter(row=>(!scope||row.scope===key(scope))&&(!automatic||!paused(row.scope))).sort((a,b)=>Number(a.kind==='engine')-Number(b.kind==='engine')||a.target.localeCompare(b.target));
 const enqueue=fn=>{const run=tail.then(fn,fn);tail=run.catch(()=>{});return run;};
 function flushSyncAll(options={}){
  const receipts=[];
  // Both publications share one JS turn: no new companion event/engine ACK can interleave.
  for(const row of selected(options)){
   try{const receipt=row.flushSync();if(receipt&&typeof receipt.then==='function')throw fault('DEFERRED_SAVE_SYNC_REQUIRED');receipts.push({kind:row.kind,target:row.target,receipt});}
   catch(error){report({type:'deferred-save-failed',kind:row.kind,phase:'flush',code:error.code??'SAVE_FAILED'});throw error;}
  }
  return receipts;
 }
 function flushAll(options={}){
  return enqueue(async()=>{
   await Promise.all(selected(options).map(row=>row.drain?.()));
   return flushSyncAll(options);
  });
 }
 function pause({scope}={}){
  const id=scope?key(scope):'*';pauses.set(id,(pauses.get(id)??0)+1);let released=false;
  return ()=>{if(released)return;released=true;const n=(pauses.get(id)??1)-1;if(n)pauses.set(id,n);else pauses.delete(id);};
 }
 const api={
  register(kind,{target,scope,drain=()=>{},flushSync,reload}={}){
   if(!['companion','engine'].includes(kind)||typeof target!=='string'||typeof scope!=='string'||typeof drain!=='function'||typeof flushSync!=='function')throw fault('DEFERRED_SAVE_REGISTRATION_INVALID');
   const id=key(target);if(stores.has(id))throw fault('DEFERRED_SAVE_ALREADY_REGISTERED');
   const row={kind,target:id,scope:key(scope),drain,flushSync,reload};stores.set(id,row);
   return ()=>{if(stores.get(id)===row)stores.delete(id);};
  },
  flushAll,flushSyncAll,pause,
  beforeRead(target){const row=stores.get(key(target));return row?flushAll({scope:row.scope}):Promise.resolve([]);},
  async withPaused(fn,options={}){const resume=pause(options);try{await flushAll(options);return await fn();}finally{resume();}},
  reloadAll(options={}){
   const resume=pause(options);
   return enqueue(async()=>{
    const rows=selected(options);if(rows.some(row=>typeof row.reload!=='function'))throw fault('DEFERRED_SAVE_RELOAD_UNAVAILABLE');
    await Promise.all(rows.map(row=>row.drain?.()));
    for(const row of rows)await row.reload();
   }).finally(resume);
  },
  setAudit(fn){if(typeof fn!=='function')throw fault('DEFERRED_SAVE_AUDIT_INVALID');audit=fn;},
  start(){if(timer!==null)return;timer=setIntervalFn(async()=>{try{await flushAll({automatic:true});}catch(error){report({type:'deferred-save-hourly-failed',code:error.code??'SAVE_FAILED'});}},DEFERRED_SAVE_INTERVAL_MS);timer?.unref?.();},
  stop(){if(timer===null)return;clearIntervalFn(timer);timer=null;},
 };
 return api;
}

export const deferredSaves=createDeferredSaves();
