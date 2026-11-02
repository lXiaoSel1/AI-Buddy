import {Worker} from 'node:worker_threads';
import {resolve} from 'node:path';
import {inspectArchivePath,archiveFault} from './work-archive-cursor-worker.mjs';
const abortFault=()=>Object.assign(Error('Archive verification cancelled; publication remains pending'),{code:'ABORT_ERR'});
export function createArchiveCursorVerifier({root,inspect=inspectArchivePath,read,workerPath=null,limit=16,queueLimit=16,maxBytes=256*1024*1024,deadlineMs=15000}={}){
 const cache=new Map(),flights=new Map(),queue=[],incoming=new Map(),calls=new Set();let active=null,closed=false,closePromise=null;const state={reads:0,workersStarted:0,workersExited:0,waiters:0,peakActive:0,peakQueued:0};
 const same=(a,b)=>a.stamp===b.stamp&&a.ancestors===b.ancestors;
 async function readWorker(entry){
  if(closed||entry.controller.signal.aborted)throw abortFault();
  if(read){let cancel;try{return await Promise.race([read(entry.path,{signal:entry.controller.signal}),new Promise((_,reject)=>{cancel=()=>reject(abortFault());entry.controller.signal.addEventListener('abort',cancel,{once:true});if(entry.controller.signal.aborted)cancel();})]);}finally{entry.controller.signal.removeEventListener('abort',cancel);}}
  return new Promise((yes,no)=>{let value,error;const worker=new Worker(workerPath??new URL('./work-archive-cursor-worker.mjs',import.meta.url),{workerData:{path:entry.path,root:entry.root,maxBytes}});entry.worker=worker;state.workersStarted++;
   const cancel=()=>{error=abortFault();void worker.terminate();};entry.controller.signal.addEventListener('abort',cancel,{once:true});if(entry.controller.signal.aborted)cancel();
   worker.once('message',row=>{value=row.value;if(row.error)error=Object.assign(Error(row.error.message),{code:row.error.code});});worker.once('error',e=>{error=e;});
   worker.once('exit',code=>{state.workersExited++;entry.controller.signal.removeEventListener('abort',cancel);if(error||code!==0||!value)no(error??archiveFault('Archive worker exited without a result'));else yes(value);});
  });
 }
 function pump(){if(active||closed)return;const entry=queue.shift();if(!entry)return;if(entry.controller.signal.aborted){flights.delete(entry.key);entry.reject(abortFault());pump();return;}active=entry;state.peakActive=Math.max(state.peakActive,1);const timer=setTimeout(()=>entry.controller.abort(),deadlineMs);
  entry.done=(async()=>{try{const current=await inspect(entry.path,entry.root);if(closed||entry.controller.signal.aborted)throw abortFault();if(!same(current,entry.identity))throw archiveFault('Queued archive identity changed');state.reads++;const value=await readWorker(entry);const after=await inspect(entry.path,entry.root);if(entry.controller.signal.aborted||!same(after,entry.identity)||value.identity&&!same(value.identity,after))throw archiveFault('Archive changed before acknowledgement');if(!/^[a-f0-9]{64}$/i.test(value.sha256??'')||!Number.isSafeInteger(value.changeSequence)||value.changeSequence<0)throw archiveFault('Archive cursor is incomplete');cache.delete(entry.key);cache.set(entry.key,{identity:after,value});while(cache.size>limit)cache.delete(cache.keys().next().value);entry.resolve(value);}catch(error){entry.reject(error);}finally{clearTimeout(timer);flights.delete(entry.key);active=null;pump();}})();
 }
 async function perform(path,expected,{signal,root:callRoot=root}={}){
  if(closed)throw abortFault();signal?.throwIfAborted();if(!callRoot)throw archiveFault('Archive data root is required');path=resolve(path);callRoot=resolve(callRoot);const identity=await inspect(path,callRoot),key=callRoot+'|'+path;if(identity.size>maxBytes)throw archiveFault('Archive exceeds the bounded reader size');
  signal?.throwIfAborted();if(closed)throw abortFault();let entry=flights.get(key),value;const saved=cache.get(key);
  if(saved&&same(saved.identity,identity))value=saved.value;
  else{
   if(!entry){if(queue.length>=queueLimit)throw Object.assign(archiveFault('Archive verification queue is full; publication remains pending'),{deferred:true,pendingPreserved:true});let yes,no;const promise=new Promise((r,j)=>{yes=r;no=j;});entry={path,root:callRoot,key,identity,promise,resolve:yes,reject:no,controller:new AbortController(),waiters:0};flights.set(key,entry);queue.push(entry);state.peakQueued=Math.max(state.peakQueued,queue.length);pump();}
   entry.waiters++;state.waiters++;let cancel;const cancelled=signal&&new Promise((_,reject)=>{cancel=()=>reject(abortFault());signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();});
   try{value=await(cancelled?Promise.race([entry.promise,cancelled]):entry.promise);}finally{if(cancel)signal.removeEventListener('abort',cancel);entry.waiters--;state.waiters--;}
  }
  signal?.throwIfAborted();if(closed)throw abortFault();const after=await inspect(path,callRoot);signal?.throwIfAborted();if(closed)throw abortFault();if(!same(after,identity))throw archiveFault('Archive changed before caller acknowledgement');if(expected?.sha256!==value.sha256||expected?.changeSequence!==value.changeSequence)throw archiveFault('Archive cursor does not match actual projection');return {accepted:true,sha256:value.sha256,changeSequence:value.changeSequence};
 }
 async function verify(path,expected,options={}){const key=resolve(options.root??root??'.')+'|'+resolve(path);incoming.set(key,(incoming.get(key)??0)+1);const operation=perform(path,expected,options);calls.add(operation);try{return await operation;}finally{calls.delete(operation);const n=incoming.get(key)-1;if(n)incoming.set(key,n);else{incoming.delete(key);const entry=flights.get(key);if(entry){entry.controller.abort();const index=queue.indexOf(entry);if(index>=0){queue.splice(index,1);flights.delete(key);entry.reject(abortFault());}}}}}
 verify.snapshot=()=>({...state,active:active?1:0,queued:queue.length,cache:cache.size,closed});
 verify.close=()=>{if(closePromise)return closePromise;closed=true;closePromise=(async()=>{for(const entry of queue.splice(0)){flights.delete(entry.key);entry.reject(abortFault());}if(active){const owned=active;owned.controller.abort();await owned.done;}await Promise.allSettled([...calls]);cache.clear();})();return closePromise;};
 return verify;
}
