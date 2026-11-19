import {DatabaseSync} from 'node:sqlite';
import {parentPort,workerData} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
import {economyWrites} from '../../src/companion-economy-operations.mjs';
import {block,observeEconomyRelease} from './economy-release.mjs';

let active=false,operation,requestId,probing=false;
const control=workerData.crash?new Int32Array(workerData.crash):null;
const operations=Object.keys(economyWrites);
function crash(phase){
 if(!control||Atomics.load(control,1)!==phase)return;
 const index=operations.indexOf(operation)+1;
 if(index>0&&Atomics.compareExchange(control,0,index,0)===index)process.exit(19);
}
parentPort.on('message',message=>{
 operation=message.op;
 probing=message.receiptOnly===true;
 if(probing&&workerData.probeFault==='secondTransport')process.exit(19);
 requestId=message.requestId;
 active=operation===workerData.fault?.op;
 if(operation==='games.registerRules'&&workerData.registerRulesDelayMs){
  const clock=new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(clock,0,0,workerData.registerRulesDelayMs);
 }
 crash(3);
 if(operation==='games.registerRules')crash(1);
});
const send=parentPort.postMessage.bind(parentPort);
parentPort.postMessage=message=>{
 if(message.requestId===requestId){
  if(message.error)crash(4);
  if(operation==='games.registerRules')crash(2);
 }
 return send(message);
};
observeEconomyRelease(phase=>{
 crash(phase==='before'?1:2);
 const fault=workerData.fault;
 if(!active||fault?.phase!==phase)return;
 active=false;
 if(fault.ms)block(fault.ms);
 else process.exit(19);
});
if(workerData.probeMetrics){
 const metrics=new Int32Array(workerData.probeMetrics),exec=DatabaseSync.prototype.exec;
 DatabaseSync.prototype.exec=function(sql,...args){
  if(probing){
   if(sql==='PRAGMA query_only=ON')Atomics.add(metrics,0,1);
   if(sql.startsWith('SAVEPOINT economy_'))Atomics.add(metrics,1,1);
   if(sql==='PRAGMA query_only=OFF')Atomics.add(metrics,2,1);
  }
  return exec.call(this,sql,...args);
 };
}
if(workerData.probeFault){
 const prepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql,...args){
  if(probing&&sql.startsWith('SELECT * FROM commands')){
   switch(workerData.probeFault){
    case 'sqlite':return prepare.call(this,'SELECT * FROM r19_missing_table');
    case 'sqliteReadOnly':return prepare.call(this,'CREATE TABLE r19_probe_must_not_write(id INTEGER)').run();
    case 'unexpectedCode':throw Object.assign(Error('r19 fixture programmer fault'),{code:'GAME_TRANSACTION_ASYNC'});
   }
  }
  return prepare.call(this,sql,...args);
 };
}
await import(workerData.workerModulePath?pathToFileURL(workerData.workerModulePath).href:'../../src/companion-economy-worker.mjs');
