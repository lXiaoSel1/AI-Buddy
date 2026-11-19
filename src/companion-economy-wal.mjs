import {join} from 'node:path';
import {Worker} from 'node:worker_threads';

function workerFile(){
  if(typeof __dirname==='string')return join(__dirname,'companion-economy-wal-worker.mjs');
  return new URL('./companion-economy-wal-worker.mjs',import.meta.url);
}

function checkpoint(path,reason,closeWriter){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(workerFile(),{workerData:{path,reason},execArgv:[]});
    let report,failure;
    worker.on('message',message=>{
      if(message.opened){
        try{closeWriter();}catch(error){failure=error;}
        worker.postMessage('writer-closed');
      }else report=message.report;
    });
    worker.once('error',error=>{failure=error;});
    worker.once('exit',code=>{
      if(failure)reject(failure);
      else if(code!==0||!report)reject(Error('Economy WAL maintenance worker exited without a result'));
      else resolve(report);
    });
  });
}

export function createEconomyWalMaintenance(path,{database,audit,walMaintenanceIntervalMs=30_000}){
  let timer,flight,dirty=false,closing=false,closePromise;
  function log(reason,value){
    try{audit?.({type:'companion-economy-wal-checkpoint',database,reason,...value});}catch{}
  }
  function schedule(){
    if(closing||timer||flight||!dirty)return;
    timer=setTimeout(()=>{
      timer=null;
      dirty=false;
      flight=checkpoint(path,'scheduled').then(result=>{
        log('scheduled',result);
        if(result.status==='busy')dirty=true;
      },error=>{
        dirty=true;
        log('scheduled',{status:'failed',code:error.code});
      }).finally(()=>{
        flight=null;
        schedule();
      });
    },walMaintenanceIntervalMs);
    timer.unref();
  }
  return {
    recordWrite(){dirty=true;schedule();},
    close(closeWriter){
      if(closePromise)return closePromise;
      closing=true;
      clearTimeout(timer);
      closePromise=(async()=>{
        await flight;
        let writerClosed=false;
        function release(){
          if(writerClosed)return;
          closeWriter();
          writerClosed=true;
        }
        try{log('close',await checkpoint(path,'close',release));}
        catch(error){
          log('close',{status:'failed',code:error.code});
          // SQLite can still close safely if the worker could not open.
          release();
        }
      })();
      return closePromise;
    }
  };
}
