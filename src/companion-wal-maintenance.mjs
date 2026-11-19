import {join,resolve} from 'node:path';
import {Worker} from 'node:worker_threads';

const managers=new Map();
const checkpointTimeoutMs=15_000;
const retryLimit=5;
const reasonPriority={scheduled:1,'restore-stage':2,'restore-finish':3};

function workerFile(){
  if(typeof __dirname==='string')return join(__dirname,'companion-wal-worker.mjs');
  return new URL('./companion-wal-worker.mjs',import.meta.url);
}

function startWorker(path,lastWrite){
  const worker=new Worker(workerFile(),{workerData:{path,lastWrite},execArgv:[]});
  let pending,stopped,failure;
  function finishRequest(){
    const request=pending;
    pending=null;
    clearTimeout(request?.timeout);
    return request;
  }
  function terminate(error){
    failure??=error;
    void worker.terminate().catch(()=>{});
  }
  worker.on('error',error=>{failure??=error;});
  worker.on('message',({result,error})=>{
    if(!pending||failure)return;
    const request=finishRequest();
    worker.unref();
    if(error)request.reject(Object.assign(Error(error.message),{code:error.code}));
    else request.resolve(result);
  });
  const exited=new Promise(done=>worker.once('exit',code=>{
    stopped=true;
    finishRequest()?.reject(failure??Error('Companion WAL worker exited without a result'));
    done(failure??(code===0?null:Error('Companion WAL worker exited unexpectedly')));
  }));
  worker.unref();
  return {
    get stopped(){return stopped;},
    checkpoint(reason){
      return new Promise((done,reject)=>{
        worker.ref();
        const timeout=setTimeout(()=>terminate(Object.assign(Error('Companion WAL checkpoint timed out'),{code:'COMPANION_WAL_TIMEOUT'})),checkpointTimeoutMs);
        pending={resolve:done,reject,timeout};
        try{worker.postMessage({reason});}
        catch(error){terminate(error);}
      });
    },
    async stop(){
      if(stopped)return;
      worker.ref();
      const timeout=setTimeout(()=>terminate(Error('Companion WAL worker close timed out')),checkpointTimeoutMs);
      try{
        try{worker.postMessage({stop:true});}
        catch(error){terminate(error);}
        const error=await exited;
        if(error)throw error;
      }finally{clearTimeout(timeout);}
    }
  };
}

function createManager(path,{lastWrite,intervalMs},remove){
  const leases=new Map();
  let worker,flight,flushing,flushReason,closing,timer,timerFlight,queuedReason,retries=0,retryCommit;
  function enqueue(reason){
    if(!queuedReason||reasonPriority[reason]>reasonPriority[queuedReason])queuedReason=reason;
  }
  function report(value){
    for(const audit of new Set(leases.values())){
      try{audit?.({type:'companion-wal-checkpoint',...value});}catch{}
    }
  }
  function checkpoint(reason){
    flight=Promise.resolve().then(()=>{
      if(!worker||worker.stopped)worker=startWorker(path,lastWrite);
      return worker.checkpoint(reason);
    }).then(value=>{
      if(reason==='flush'||reason!=='close'&&value.status!=='idle'&&value.status!=='deferred')report(value);
      return value;
    },error=>{
      if(reason!=='close')report({reason,status:'failed',code:error.code});
      throw error;
    }).finally(()=>{flight=null;});
    return flight;
  }
  async function checkpointWithRetries(reason){
    const commit=Atomics.load(lastWrite,1);
    let status='failed';
    try{
      const result=await checkpoint(reason);
      status=result.status;
      return result;
    }finally{
      if(status==='busy'||status==='failed'){
        if(retryCommit!==commit){retryCommit=commit;retries=0;}
        if(++retries<=retryLimit)enqueue(reason);
      }else{
        retries=0;
        if(status==='deferred'||Date.now()-Number(Atomics.load(lastWrite,0))<2000)enqueue('scheduled');
      }
    }
  }
  function arm(){
    if(timer||flight||flushing||closing||!queuedReason)return;
    timer=setTimeout(async()=>{
      timer=null;
      const reason=queuedReason;
      queuedReason=null;
      timerFlight=checkpointWithRetries(reason).catch(()=>{});
      await timerFlight;
      timerFlight=null;
      arm();
    },intervalMs);
    timer.unref();
  }
  function flush(reason='flush'){
    if(closing)return Promise.reject(Error('Companion WAL maintenance is closing'));
    if(flushing){
      if(flushReason===reason)return flushing;
      return flushing.catch(()=>{}).then(()=>flush(reason));
    }
    clearTimeout(timer);
    timer=null;
    flushReason=reason;
    flushing=(async()=>{
      await flight?.catch(()=>{});
      return reason==='restore-stage'||reason==='restore-finish'
        ?checkpointWithRetries(reason):checkpoint(reason);
    })().finally(()=>{flushing=null;flushReason=null;arm();});
    return flushing;
  }
  return {
    lease(audit){
      if(closing)throw Error('Companion WAL maintenance is closing');
      const lease={};
      leases.set(lease,audit);
      let closePromise;
      return {
        get busy(){return !!(flight||flushing);},
        get timerFlight(){return timerFlight;},
        schedule(reason='scheduled'){
          if(closePromise)return;
          enqueue(reason);
          arm();
        },
        flush(reason){
          if(closePromise)return Promise.reject(Error('Companion WAL maintenance is closing'));
          return flush(reason);
        },
        close({truncate=false}={}){
          if(closePromise)return closePromise;
          if(leases.size>1){
            leases.delete(lease);
            closePromise=Promise.resolve(null);
            return closePromise;
          }
          clearTimeout(timer);
          timer=null;
          // Callers drain writes and reads before returning the final lease.
          closing=closePromise=(async()=>{
            try{
              await flushing?.catch(()=>{});
              await flight?.catch(()=>{});
              return truncate?await checkpoint('close'):null;
            }finally{
              try{await worker?.stop();}
              finally{leases.delete(lease);remove();}
            }
          })();
          return closePromise;
        }
      };
    }
  };
}

export function createCompanionWalMaintenance(path,{lastWrite,audit,intervalMs=400}){
  const absolute=resolve(path),key=process.platform==='win32'?absolute.toLowerCase():absolute;
  let manager=managers.get(key);
  if(!manager){
    manager=createManager(absolute,{lastWrite,intervalMs},()=>managers.delete(key));
    managers.set(key,manager);
  }
  return manager.lease(audit);
}
