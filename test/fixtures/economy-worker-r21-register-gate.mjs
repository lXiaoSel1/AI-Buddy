import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {workerData} from 'node:worker_threads';

// Hold only the second rules cache read; the worker event loop remains live
// so the production cancellation and close messages can be processed.
const gate=new Int32Array(workerData.registerGate);
const readFile=fs.promises.readFile;
fs.promises.readFile=async function(path,...args){
 if(path===workerData.registerGatePath&&Atomics.add(gate,1,1)+1===2){
  Atomics.store(gate,0,1);
  await Atomics.waitAsync(gate,2,0).value;
 }
 return readFile.call(this,path,...args);
};
syncBuiltinESMExports();
await import('../../src/companion-economy-worker.mjs');
