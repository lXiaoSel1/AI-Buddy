import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {createEconomyStore} from '../../src/companion-economy-store.mjs';

const original=DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare=function(sql,...args){
 if(sql.startsWith('UPDATE meals SET operation_id=?')){
  parentPort.postMessage('paused-after-hunger-update');
  Atomics.wait(new Int32Array(workerData.barrier),0,0);
 }
 return original.call(this,sql,...args);
};
const economy=createEconomyStore(workerData.root);
economy.rebindPendingMeals({transactionId:'worker-crash-rollback',beforeScope:workerData.before,rollbackScope:workerData.after});
parentPort.postMessage('unexpectedly-committed');
