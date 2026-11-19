import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {workerData} from 'node:worker_threads';

const root=process.env.AI_BUDDY_R19_ARCHIVE_FAULT_ROOT;
if(root&&['reader','auto-archive-publisher'].includes(workerData?.operation)&&dirname(workerData.path)===join(root,'galgame')){
 const checkpoint=new WeakMap(),prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;
 let injected=false;
 DatabaseSync.prototype.prepare=function(sql,...args){
  const statement=prepare.call(this,sql,...args);
  if(sql==='INSERT OR IGNORE INTO records VALUES(?,?,?)'){
   const run=statement.run.bind(statement);
   statement.run=(namespace,id,value)=>{
    const result=run(namespace,id,value);
    if(namespace==='daily-memory-checkpoint-v1'&&id.endsWith(':started'))checkpoint.set(this,id);
    return result;
   };
  }
  return statement;
 };
 DatabaseSync.prototype.exec=function(sql,...args){
  const id=checkpoint.get(this);
  if(sql==='COMMIT'&&id&&!injected){
   injected=true;
   assert.equal(prepare.call(this,'PRAGMA synchronous').get().synchronous,2);
   assert.equal(prepare.call(this,'PRAGMA journal_mode').get().journal_mode,'wal');
   const entered=performance.now();
   writeFileSync(join(root,'commit-entered.json'),JSON.stringify({id,lane:workerData.operation}));
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);
   const elapsedMs=performance.now()-entered;
   const result=exec.call(this,sql,...args);
   writeFileSync(join(root,'commit-finished.json'),JSON.stringify({elapsedMs}));
   return result;
  }
  return exec.call(this,sql,...args);
 };
}
