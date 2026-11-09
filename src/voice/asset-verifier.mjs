import {Worker} from 'node:worker_threads';

const abort=()=>Object.assign(Error('语音组件校验已取消'),{name:'AbortError',code:'ABORT_ERR'});
const fault=()=>Object.assign(Error('语音组件校验进程已停止，请重试'),{code:'VOICE_ASSET_VERIFY'});
export function createVoiceAssetVerifier({workerPath}={}){
  let worker,serial=0,closed=false;
  const jobs=new Map(),drained=new Set();
  function notifyDrained(){if(!jobs.size)for(const resolve of drained){drained.delete(resolve);resolve();}}
  function rejectAll(error){for(const job of jobs.values()){for(const client of [...job.clients])client.finish(client.cancelled?abort():error);job.finish();}jobs.clear();notifyDrained();}
  function ensure(){
    if(closed)throw abort();if(worker)return worker;
    const child=worker=new Worker(workerPath??new URL('./asset-verifier-worker.mjs',import.meta.url));
    child.on('message',message=>{
      const job=[...jobs.values()].find(row=>row.id===message.id);if(!job)return;
      if(message.type==='progress'){for(const client of job.clients)if(!client.cancelled)try{client.onProgress(message.value);}catch{}return;}
      if(message.type!=='done'&&message.type!=='error')return;
      jobs.delete(job.key);
      const error=message.type==='error'?Object.assign(Error(message.error.message),{name:message.error.name,code:message.error.code,...(message.error.path?{path:message.error.path}:{})}):null;
      for(const client of [...job.clients])client.finish(client.cancelled?abort():error,message.value);job.finish();if(!jobs.size)child.unref();notifyDrained();
    });
    child.on('error',()=>{if(worker===child){worker=undefined;rejectAll(fault());}});
    child.on('exit',()=>{if(worker===child){worker=undefined;rejectAll(fault());}});
    child.unref();return child;
  }
  function verify(selected,{signal,onProgress=()=>{}}={}){
    signal?.throwIfAborted();const child=ensure(),key=selected.destination+'|'+selected.proof;
    let job=jobs.get(key),fresh=!job;
    if(job?.cancelling)return job.done.then(()=>verify(selected,{signal,onProgress}));
    if(!job){job={key,id:++serial,clients:new Set()};job.done=new Promise(resolve=>{job.finish=resolve;});jobs.set(key,job);}
    return new Promise((resolve,reject)=>{
      const client={onProgress,cancelled:false,finish(error,value){signal?.removeEventListener('abort',cancel);job.clients.delete(client);error?reject(error):resolve(value);}};
      const cancel=()=>{
        client.cancelled=true;
        if([...job.clients].some(row=>!row.cancelled)){client.finish(abort());return;}
        job.cancelling=true;child.postMessage({type:'cancel',id:job.id});
      };
      job.clients.add(client);signal?.addEventListener('abort',cancel,{once:true});
      if(signal?.aborted){if(fresh){jobs.delete(key);client.finish(abort());job.finish();notifyDrained();}else cancel();return;}
      if(fresh){
        const plan={destination:selected.destination,files:selected.descriptor.files,proof:selected.proof,proofFile:selected.proofFile,readProof:selected.readProof};child.ref();
        try{child.postMessage({type:'verify',id:job.id,key,plan});}catch{jobs.delete(key);for(const pending of [...job.clients])pending.finish(fault());job.finish();if(!jobs.size)child.unref();notifyDrained();}
      }
    });
  }
  async function close(){
    closed=true;const child=worker;
    if(child&&jobs.size){
      const finished=new Promise(resolve=>drained.add(resolve));
      for(const job of jobs.values()){for(const client of job.clients)client.cancelled=true;child.postMessage({type:'cancel',id:job.id});}
      await finished;
    }
    if(worker===child)worker=undefined;await child?.terminate();
  }
  return {verify,close};
}
