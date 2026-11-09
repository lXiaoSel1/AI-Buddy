import {Worker} from 'node:worker_threads';

const abort=()=>Object.assign(Error('语音组件校验已取消'),{name:'AbortError',code:'ABORT_ERR'});
const fault=()=>Object.assign(Error('语音组件校验进程已停止，请重试'),{code:'VOICE_ASSET_VERIFY'});
export function createVoiceAssetVerifier({workerPath}={}){
  let worker,serial=0,closed=false;
  const jobs=new Map(),known=new Set();
  function rejectAll(error){for(const job of jobs.values())for(const client of job.clients)client.finish(error);jobs.clear();known.clear();}
  function ensure(){
    if(closed)throw abort();if(worker)return worker;
    const child=worker=new Worker(workerPath??new URL('./asset-verifier-worker.mjs',import.meta.url));
    child.on('message',message=>{
      const job=[...jobs.values()].find(row=>row.id===message.id);if(!job)return;
      if(message.type==='progress'){for(const client of job.clients)try{client.onProgress(message.value);}catch{}return;}
      if(message.type!=='done'&&message.type!=='error')return;
      jobs.delete(job.key);
      const error=message.type==='error'?Object.assign(Error(message.error.message),{name:message.error.name,code:message.error.code}):null;
      for(const client of [...job.clients])client.finish(error,message.value);if(!jobs.size)child.unref();
    });
    child.on('error',()=>{if(worker===child){worker=undefined;rejectAll(fault());}});
    child.on('exit',()=>{if(worker===child){worker=undefined;rejectAll(fault());}});
    child.unref();return child;
  }
  function verify(selected,{signal,onProgress=()=>{}}={}){
    signal?.throwIfAborted();const child=ensure(),key=selected.destination+'|'+selected.proof;
    let job=jobs.get(key),fresh=!job;
    if(!job){job={key,id:++serial,clients:new Set()};jobs.set(key,job);}
    return new Promise((resolve,reject)=>{
      const client={onProgress,finish(error,value){signal?.removeEventListener('abort',cancel);job.clients.delete(client);error?reject(error):resolve(value);}};
      const cancel=()=>{client.finish(abort());if(!job.clients.size){jobs.delete(key);child.postMessage({type:'cancel',id:job.id});if(!jobs.size)child.unref();}};
      job.clients.add(client);signal?.addEventListener('abort',cancel,{once:true});
      if(signal?.aborted){cancel();return;}
      if(fresh){
        const plan=known.has(key)?undefined:{destination:selected.destination,files:selected.descriptor.files,proof:selected.proof,proofFile:selected.proofFile};known.add(key);child.ref();
        try{child.postMessage({type:'verify',id:job.id,key,plan});}catch{jobs.delete(key);known.delete(key);for(const pending of [...job.clients])pending.finish(fault());if(!jobs.size)child.unref();}
      }
    });
  }
  async function close(){closed=true;const child=worker;worker=undefined;rejectAll(abort());await child?.terminate();}
  return {verify,close};
}
