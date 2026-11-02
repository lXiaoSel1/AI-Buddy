import {sourceMutation} from './work-source-registry.mjs';
import { parentPort,workerData } from 'node:worker_threads';
import { TokenMonitor } from './token-monitor.mjs';
import { appendFile,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {createMonitorWorkerLifecycle} from './monitor-worker-lifecycle.mjs';
const monitor=new TokenMonitor({...workerData,onSources:value=>parentPort.postMessage({type:'sources',value}),onUpdate:value=>parentPort.postMessage({type:'snapshot',value}),onTaskFeedback:value=>parentPort.postMessage({type:'task-feedback',value}),onAudit:value=>parentPort.postMessage({type:'audit',value})});
const ready=monitor.start().then(async()=>{await monitor.configure(workerData);return monitor;});ready.catch(error=>parentPort.postMessage({type:'error',message:error.stack}));
const lifecycle=createMonitorWorkerLifecycle({ready,postMessage:value=>parentPort.postMessage(value),close:()=>monitor.close(),closePort:()=>parentPort.close(),run:async message=>{
    if(message.type==='managed-work-source'){if(workerData.hostOwnsRegistry)throw Error('Managed registration belongs to the host');await ready;const value=await monitor.registerManagedWorkSource(message.value);parentPort.postMessage({type:'source-result',id:message.id,value});}
    if(message.type==='apply-source-registry'){await ready;monitor.applyWorkSourceProjection(message.projection);}
    if(message.type==='source-action'){if(workerData.hostOwnsRegistry&&sourceMutation(message.action))throw Error('Source settings must use the registry owner');await ready;const value=await monitor.action(message.action,message.args);parentPort.postMessage({type:'source-result',id:message.id,value});}
    if(message.type==='reward-drain'){await ready;monitor.syncAnalytics();parentPort.postMessage({type:'reward-facts',value:monitor.analytics.rewardOutbox?.pending()??[]});}
    if(message.type==='reward-ack'){await ready;monitor.analytics.rewardOutbox?.ack(message.sequences);}
  if(message.type==='configure'){await ready;if(message.refreshIntervalMs)monitor.setRefreshInterval(message.refreshIntervalMs);await monitor.configure(message);parentPort.postMessage({type:'configured',refreshIntervalMs:monitor.refreshIntervalMs});}
  if(message.type==='refresh'){await monitor.scan(true);parentPort.postMessage({type:'refreshed'});}
  if(message.type==='companion-usage') {
    await mkdir(workerData.dataRoot,{recursive:true});await appendFile(join(workerData.dataRoot,'companion-usage.jsonl'),'\n'+JSON.stringify({purpose:message.purpose,connectionIdentity:message.connectionIdentity,sessionId:message.sessionId,requestId:message.requestId,activityOriginId:message.activityOriginId,scope:message.scope,...(message.purpose==='work'?{workspace:message.workspace}:{}),model:message.model,timestamp:message.timestamp,usage:message.usage})+'\n');
    monitor.ingestCompanion(message);monitor.emit();
  }
}});
parentPort.on('message',message=>{void lifecycle.dispatch(message);});
