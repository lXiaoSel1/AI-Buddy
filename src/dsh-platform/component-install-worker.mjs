import {parentPort,workerData} from 'node:worker_threads';
import {createDshComponentManager} from './component-manager.mjs';

const controller=new AbortController(),abortView=new Int32Array(workerData.abortBuffer),pending=new Map();const deadline=Date.now()+600000;let nextId=0,lastProgress=0,lastPhase='';
const cancelled=()=>Object.assign(Error('Component installation cancelled'),{code:'ABORT_ERR'});
const check=()=>{if(Atomics.load(abortView,0)!==0)throw cancelled();controller.signal.throwIfAborted();if(Date.now()>=deadline)throw Object.assign(Error('Component installation timed out'),{code:'DSH_COMPONENT_INSTALL_TIMEOUT'});};
parentPort.on('message',row=>{if(row?.type==='cancel'){controller.abort(cancelled());for(const done of pending.values())done(true);pending.clear();}else if(row?.type==='busy-result'){pending.get(row.id)?.(row.busy!==false);pending.delete(row.id);}});
const busy=()=>{check();const id=++nextId;return new Promise(resolve=>{const timer=setTimeout(()=>{pending.delete(id);resolve(true);},30000);pending.set(id,value=>{clearTimeout(timer);resolve(value);});parentPort.postMessage({type:'busy',id});});};
const onProgress=value=>{const now=Date.now();if(value.phase!==lastPhase||now-lastProgress>=150||value.receivedBytes===value.totalBytes){lastProgress=now;lastPhase=value.phase;parentPort.postMessage({type:'progress',value});}};
try{
  const manager=createDshComponentManager({destinationRoot:workerData.destinationRoot,busy,check,onProgress});
  let value;if(workerData.kind==='status')value=await manager.status({signal:controller.signal,check});else if(workerData.kind==='install'){const plan=await manager.plan(workerData.item);value=await manager.install({...plan,signal:controller.signal});}else throw Object.assign(Error('Invalid component worker task'),{code:'DSH_COMPONENT_INVALID'});
  parentPort.postMessage({type:'result',value});
}catch(error){parentPort.postMessage({type:'error',error:{code:error.code??'DSH_COMPONENT_INSTALL_FAILED',message:String(error.message??'Component installation failed').slice(0,1000)}});}
finally{parentPort.close();}
