import { parentPort,workerData } from 'node:worker_threads';
import { TokenMonitor } from './token-monitor.mjs';
import { appendFile,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const monitor=new TokenMonitor({...workerData,onSources:value=>parentPort.postMessage({type:'sources',value}),onUpdate:value=>parentPort.postMessage({type:'snapshot',value}),onTaskFeedback:value=>parentPort.postMessage({type:'task-feedback',value}),onAudit:value=>parentPort.postMessage({type:'audit',value})});
parentPort.on('message',async message=>{
  try{
    if(message.type==='source-action'){await ready;const value=await monitor.action(message.action,message.args);parentPort.postMessage({type:'source-result',id:message.id,value});}
  if(message.type==='configure'){await ready;if(message.refreshIntervalMs)monitor.setRefreshInterval(message.refreshIntervalMs);await monitor.configure(message);parentPort.postMessage({type:'configured',refreshIntervalMs:monitor.refreshIntervalMs});}
  if(message.type==='refresh'){await monitor.scan(true);parentPort.postMessage({type:'refreshed'});}
  if(message.type==='close') {await monitor.close(); parentPort.postMessage({type:'closed'});}
  if(message.type==='companion-usage') {
    await mkdir(workerData.dataRoot,{recursive:true});await appendFile(join(workerData.dataRoot,'companion-usage.jsonl'),'\n'+JSON.stringify({purpose:message.purpose,connectionIdentity:message.connectionIdentity,sessionId:message.sessionId,model:message.model,timestamp:message.timestamp,usage:message.usage})+'\n');
    monitor.ingestCompanion(message);monitor.emit();
  }
  }catch(error){if(message.type==='source-action')parentPort.postMessage({type:'source-result',id:message.id,error:error.message});else parentPort.postMessage({type:'error',message:error.stack});}
});
const ready=monitor.start().then(async()=>{await monitor.configure(workerData);return monitor;});ready.catch(error=>parentPort.postMessage({type:'error',message:error.stack}));
