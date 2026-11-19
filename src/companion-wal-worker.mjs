import {closeSync,openSync,readSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {parentPort,workerData} from 'node:worker_threads';

const {path,lastWrite}=workerData;
const db=new DatabaseSync(path);
db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0; PRAGMA journal_size_limit=8388608;');

function walGeneration(){
  let fd;
  try{
    fd=openSync(path+'-wal','r');
    const salt=Buffer.alloc(8);
    return readSync(fd,salt,0,salt.length,16)===salt.length?salt.toString('hex'):null;
  }catch(error){
    if(['ENOENT','EPERM','EACCES','EBUSY'].includes(error.code))return null;
    throw error;
  }finally{if(fd!==undefined)closeSync(fd);}
}

function checkpoint(reason){
  const commits=Number(Atomics.load(lastWrite,1));
  if(reason!=='close'){
    // NOOP reports active frames even when the WAL file retains old space.
    const measured=db.prepare('PRAGMA wal_checkpoint(NOOP)').get();
    if(measured.busy)return {status:'busy',reason,...measured,commits};
    const idle=Date.now()-Number(Atomics.load(lastWrite,0))>=2000;
    const pending=measured.log-measured.checkpointed;
    let threshold=idle?1000:4000;
    if(reason==='restore-stage'||reason==='restore-finish')threshold=1500;
    if(reason==='flush')threshold=0;
    if(pending<threshold)return {status:idle||!pending?'idle':'deferred',reason,...measured};
  }
  const startedAt=Date.now(),started=performance.now(),generation=walGeneration();
  const result=db.prepare(reason==='close'?'PRAGMA wal_checkpoint(TRUNCATE)':'PRAGMA wal_checkpoint(PASSIVE)').get();
  const busy=result.busy||result.checkpointed<result.log;
  return {
    status:busy?'busy':reason==='close'?'truncated':'checkpointed',
    ...result,reason,commits,walGeneration:generation===walGeneration()?generation:null,
    startedAt,endedAt:Date.now(),elapsedMs:performance.now()-started
  };
}

parentPort.on('message',({reason,stop})=>{
  if(stop){
    db.close();
    parentPort.close();
    return;
  }
  try{parentPort.postMessage({result:checkpoint(reason)});}
  catch(error){parentPort.postMessage({error:{message:error.message,code:error.code}});}
});
