import {Worker} from 'node:worker_threads';
import {replyNetworkRoute} from '../network-worker.mjs';
import {createDshComponentManager,DSH_SOURCE_COMMIT} from './component-manager.mjs';
import {assertPublicDshComponentDescriptor,DSH_PUBLIC_COMPONENT} from './component-download.mjs';
const fault=(message,code)=>Object.assign(Error(message),{code});
const cancelled=()=>fault('Component installation cancelled','ABORT_ERR');

// The request can select the native picker, but cannot supply download identities
// or a path. Both online and advanced local plans retain the host release pins.
export async function planHostDshComponent({request={},descriptor,manager,chooseArchive}={}){
  const pinned=assertPublicDshComponentDescriptor(descriptor);
  if(request.localArchive!==undefined&&typeof request.localArchive!=='boolean')throw fault('Invalid component installation mode','DSH_COMPONENT_INVALID');
  if(request.localArchive===true){const archivePath=await chooseArchive?.();if(!archivePath)return {cancelled:true};return {...await manager.plan({...pinned,url:undefined,archivePath}),mode:'local'};}
  return {...await manager.plan(pinned),mode:'online'};
}

// Status is an informational snapshot. Initial verification and every install
// run in this manager's single owned worker; polling never reparses the archive
// or repeats full-tree hashing. Runtime consumers still verify their own entry.
export function createManagedDshComponentManager({destinationRoot,network,busy=()=>false,onUpdate=()=>{},workerPath=new URL('./component-install-worker.mjs',import.meta.url),workerFactory=(path,options)=>new Worker(path,options)}={}){
  const planner=createDshComponentManager({destinationRoot}),plans=new Map();let current={state:'missing',sourceCommit:DSH_SOURCE_COMMIT},checked=false,checking=null,active=null,operation=null,closed=false,closePromise=null,installation={state:'idle',phase:'idle'};
  const snapshot=()=>({...structuredClone(current),installation:structuredClone(installation)});
  const update=value=>{installation={...installation,...value};try{onUpdate(snapshot());}catch{}};
  function workerTask(kind,item,planId,official=false){
    const taskNetwork=network?.capture?.({official})??network;
    const abortBuffer=new SharedArrayBuffer(4),abortView=new Int32Array(abortBuffer),entry={kind,abortView,worker:null,promise:null};
    entry.promise=new Promise((resolve,reject)=>{
      let value,error,worker;try{worker=workerFactory(workerPath,{workerData:{kind,destinationRoot,item,abortBuffer,...(taskNetwork?{network:taskNetwork.snapshot()}:{} )}});entry.worker=worker;}catch(cause){reject(cause);return;}
      worker.on('message',row=>{
        if(row?.type==='network-route'){void replyNetworkRoute(worker,row,taskNetwork);return;}
        if(row?.type==='busy')void(async()=>{let value=true;try{value=closed||Atomics.load(abortView,0)!==0||Boolean(await busy());}catch{}try{worker.postMessage({type:'busy-result',id:row.id,busy:value});}catch{}})();
        else if(row?.type==='progress'&&kind==='install'&&operation?.entry===entry&&!operation.controller.signal.aborted)update({...row.value,planId});
        else if(row?.type==='result')value=row.value;
        else if(row?.type==='error')error=fault(String(row.error?.message??'Component worker failed').slice(0,1000),row.error?.code??'DSH_COMPONENT_WORKER_FAILED');
      });
      worker.once('error',()=>{error=fault('Component worker failed','DSH_COMPONENT_WORKER_FAILED');});
      worker.once('exit',code=>{if(error||code!==0||!value)reject(error??fault('Component worker exited without a completed receipt','DSH_COMPONENT_WORKER_FAILED'));else resolve(value);});
    });
    active=entry;return entry;
  }
  async function status(){
    if(operation||checked||closed)return snapshot();
    if(!checking){const entry=workerTask('status');checking=entry.promise.then(value=>{current=value;checked=true;return snapshot();}).finally(()=>{if(active===entry)active=null;checking=null;});}
    return checking;
  }
  async function plan(input){
    if(closed)throw fault('Component manager is closed','PLUGIN_CLOSED');
    const pinned=assertPublicDshComponentDescriptor({...input,url:DSH_PUBLIC_COMPONENT.url});
    if(input.url!==undefined&&input.url!==pinned.url)throw fault('Untrusted component download origin','DSH_COMPONENT_DOWNLOAD_ORIGIN');
    const item=input.archivePath?{...pinned,url:undefined,archivePath:input.archivePath}:pinned,result=await planner.plan(item);plans.set(result.planId,item);while(plans.size>16)plans.delete(plans.keys().next().value);return result;
  }
  // A logical install owns cancellation before it waits for the shared status
  // worker. Cancelling that wait never cancels the informational status request.
  function waitForStatus(promise,op){
    const signal=op.controller.signal;if(signal.aborted)return Promise.reject(signal.reason);
    return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});if(signal.aborted)abort();});
  }
  async function install({planId,signal,official=false}={}){
    if(closed)throw fault('Component manager is closed','PLUGIN_CLOSED');
    if(operation)throw fault('Runtime is busy','DSH_COMPONENT_BUSY');
    const item=plans.get(planId);if(!item)throw fault('Component installation plan expired','DSH_COMPONENT_PLAN_STALE');
    const op={planId,controller:new AbortController(),entry:null,promise:null},abort=()=>cancelOperation(op);operation=op;signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)op.controller.abort(cancelled());
    op.promise=(async()=>{
      try{
        update({state:op.controller.signal.aborted?'cancelling':'installing',phase:'checking',planId,error:undefined,receivedBytes:0,totalBytes:item.bytes});
        if(checking)await waitForStatus(checking,op);op.controller.signal.throwIfAborted();
        if(closed)throw cancelled();if(active)throw fault('Runtime is busy','DSH_COMPONENT_BUSY');
        const entry=workerTask('install',item,planId,official);op.entry=entry;if(op.controller.signal.aborted)cancelOperation(op);
        // After worker admission, wait for its exact exit/lock-cleanup receipt
        // even on cancellation, so a second task cannot overlap its side effects.
        const result=await entry.promise;current=result;checked=true;plans.delete(planId);update({state:result.state==='ready'?'ready':'failed',phase:result.state==='ready'?'ready':'failed'});return result;
      }catch(error){update({state:'failed',phase:error.code==='ABORT_ERR'?'cancelled':'failed',error:{code:error.code??'DSH_COMPONENT_INSTALL_FAILED',message:error.message}});throw error;}
      finally{signal?.removeEventListener('abort',abort);if(active===op.entry)active=null;if(operation===op)operation=null;}
    })();return op.promise;
  }
  function cancelOperation(op){
    if(!op||operation!==op)return false;op.controller.abort(cancelled());const entry=op.entry;if(entry){Atomics.store(entry.abortView,0,1);try{entry.worker?.postMessage({type:'cancel'});}catch{}}update({state:'cancelling'});return true;
  }
  function cancel(){return {cancelled:cancelOperation(operation)};}
  function close(){
    if(closePromise)return closePromise;closed=true;const op=operation,entry=active,pending=checking;cancelOperation(op);
    if(entry&&entry!==op?.entry){Atomics.store(entry.abortView,0,1);try{entry.worker?.postMessage({type:'cancel'});}catch{}}
    plans.clear();closePromise=(async()=>{await Promise.allSettled([op?.promise,entry?.promise,pending].filter(Boolean));return {closed:true};})();return closePromise;
  }
  return {status,plan,install,cancel,close,installing:()=>operation!==null};
}
