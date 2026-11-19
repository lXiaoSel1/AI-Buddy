import {parentPort,workerData} from 'node:worker_threads';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';

const {path,reason}=workerData;
const db=new DatabaseSync(path);
let report;
try{
  db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0;');
  if(reason==='close'){
    // Keep a connection open while the writer closes, so SQLite's last
    // connection cleanup cannot run on the main thread. Open the database
    // pager before acknowledging, since opening a SQLite handle can be lazy.
    db.prepare('SELECT name FROM sqlite_schema LIMIT 1').get();
    const writerClosed=once(parentPort,'message');
    parentPort.postMessage({opened:true});
    await writerClosed;
  }
  const before=db.prepare('PRAGMA wal_checkpoint(NOOP)').get();
  const startedAt=Date.now(),started=performance.now();
  const result=db.prepare(reason==='close'?'PRAGMA wal_checkpoint(TRUNCATE)':'PRAGMA wal_checkpoint(PASSIVE)').get();
  const busy=Boolean(result.busy)||result.checkpointed<result.log;
  report={...result,status:busy?'busy':'checkpointed',before,startedAt,endedAt:Date.now(),elapsedMs:performance.now()-started};
}finally{db.close();}
parentPort.postMessage({report});
parentPort.close();
