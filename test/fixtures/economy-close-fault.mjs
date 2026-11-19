import {DatabaseSync} from 'node:sqlite';
import {workerData} from 'node:worker_threads';

const prepare=DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare=function(sql){
 if(sql==='PRAGMA wal_checkpoint(TRUNCATE)')throw Object.assign(Error('isolated economy checkpoint failure'),{code:'FIXTURE_ECONOMY_CHECKPOINT_FAILED'});
 return prepare.call(this,sql);
};
await import(workerData.writerUrl);
