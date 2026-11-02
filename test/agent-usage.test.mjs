import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {Worker} from 'node:worker_threads';
import {buildAgentUsageRecords,lastAgentUsageBaseline} from '../src/agent-usage.mjs';
import {AgentTaskStore} from '../src/agent-task-store.mjs';
import {AgentTaskService} from '../src/agent-task-service.mjs';
import {LocalMonitor} from '../src/monitor.mjs';

const sessionId='11111111-2222-3333-4444-555555555555';
const first={inputTokens:100,outputTokens:20,totalTokens:120,cachedInputTokens:40},second={inputTokens:160,outputTokens:30,totalTokens:190,cachedInputTokens:50};
const count=(usage,timestamp)=>({type:'event_msg',timestamp,payload:{type:'token_count',info:{total_token_usage:{input_tokens:usage.inputTokens,output_tokens:usage.outputTokens,total_tokens:usage.totalTokens,cached_input_tokens:usage.cachedInputTokens}}}});
const sample=(usage,cumulative,extra={})=>({nativeSessionId:sessionId,turnId:'turn-1',taskId:'task-usage',workspaceId:'workspace-usage',workspace:'E:/fixture/project',connection:{model:'gpt-work'},connectionIdentity:{servicePlatform:'openai',channel:'codex'},usage,cumulative,...extra});

test('agent usage keeps diagnostic deltas and gives the ledger only native-session cumulative counters',()=>{
  const value=buildAgentUsageRecords(sample({inputTokens:60,outputTokens:10,totalTokens:70},second),{timestamp:'2026-10-23T15:00:01Z'});
  assert.equal(value.diagnostic.usage.total_tokens,70);assert.equal(value.diagnostic.usageMode,'delta');assert.equal(value.ledger.usage.total_tokens,190);assert.equal(value.ledger.sessionId,sessionId);assert.equal(value.ledger.purpose,'work');assert.equal(value.ledger.workspace,'E:/fixture/project');assert.equal(value.ledger.turnId,'turn-1');
  for(const patch of [{nativeSessionId:null},{cumulative:null},{billable:false},{cumulative:{inputTokens:-1,outputTokens:10}},{usage:null}])assert.equal(buildAgentUsageRecords(sample(first,first,patch)).ledger,null);
});

test('resume baseline is the last valid cumulative record for that exact native session',()=>{
  const event=(id,cumulative,extra={})=>({type:'usage',sessionId:id,payload:{cumulative},...extra});
  const task={sessionId,events:[event(sessionId,first),event('foreign-native',second),event(sessionId,{inputTokens:-1,outputTokens:0}),event(sessionId,second,{replay:true})]};
  assert.deepEqual(lastAgentUsageBaseline(task),first);assert.equal(lastAgentUsageBaseline(task,'new-native'),undefined);task.events.push(event(sessionId,second));assert.deepEqual(lastAgentUsageBaseline(task),second);
});

test('real monitor ledger counts two agent turns once alongside native logs with nonempty roots and restart',async t=>{
  const root=await mkdtemp(join(tmpdir(),'buddy-agent-ledger-')),logs=join(root,'native-logs'),dataRoot=join(root,'data'),workspace=join(root,'project');await Promise.all([mkdir(logs),mkdir(workspace)]);const path=join(logs,`rollout-2026-10-23T15-00-00-${sessionId}.jsonl`),times=['2026-10-23T15:00:00.000Z','2026-10-23T15:00:01.000Z'];
  const meta={type:'session_meta',timestamp:'2026-10-23T14:59:00.000Z',payload:{id:sessionId,cwd:workspace,originator:'ai_buddy_work',model_provider:'openai'}};await writeFile(path,JSON.stringify(meta)+'\n'+JSON.stringify(count(first,times[0]))+'\n');
  let monitor=new LocalMonitor({roots:[{provider:'codex',path:logs}],dataRoot});t.after(async()=>{await monitor.close();await rm(root,{recursive:true,force:true});});await monitor.start();assert.equal(monitor.snapshot().totals.codex.total,120);
  const one=buildAgentUsageRecords(sample(first,first,{workspace}),{timestamp:'2026-10-23T15:00:00.010Z'}).ledger,two=buildAgentUsageRecords(sample({inputTokens:60,outputTokens:10,totalTokens:70},second,{workspace,turnId:'turn-2'}),{timestamp:'2026-10-23T15:00:01.010Z'}).ledger;
  monitor.ingestCompanion(one);monitor.ingestCompanion(two);assert.equal(monitor.snapshot().totals.codex.total,190,'second delta is not mistaken for a cumulative counter');
  await appendFile(path,JSON.stringify(count(second,times[1]))+'\n');await monitor.scan(true);let snapshot=monitor.snapshot();assert.equal(snapshot.totals.codex.total,190,'native file and bridge share one counter identity');assert.equal(snapshot.totals.codex.requests,2);assert.equal(snapshot.workTotal,190);assert.equal(snapshot.sessions.length,1);assert.equal(snapshot.sessions[0].companion,false);assert.equal(snapshot.sessions[0].purpose,'work');assert.equal(snapshot.sessions[0].workspace,workspace);assert.ok(snapshot.cube.every(row=>row.purpose==='work'&&row.workspace===workspace));
  await writeFile(join(dataRoot,'companion-usage.jsonl'),JSON.stringify(one)+'\n'+JSON.stringify(two)+'\n');await monitor.close();monitor=new LocalMonitor({roots:[{provider:'codex',path:logs}],dataRoot});await monitor.start();snapshot=monitor.snapshot();assert.equal(snapshot.totals.codex.total,190);assert.equal(snapshot.totals.codex.requests,2);assert.equal(snapshot.workTotal,190);assert.equal(snapshot.sessions[0].workspace,workspace);
});

test('task restart resumes with its persisted cumulative baseline and forwards only the new turn delta',async t=>{
  const root=await mkdtemp(join(tmpdir(),'buddy-agent-usage-restart-')),workspace=join(root,'project');await mkdir(workspace);await writeFile(join(workspace,'notes.txt'),'original');const binding={connectionId:'selected',provider:'openai',model:'chosen',harness:'codex'},scope={characterId:'role',personaId:'persona',lifeId:'life',operationId:'operation'},usages=[],baselines=[];let service,turn=0;
  const create=async()=>{const store=new AgentTaskStore({root:join(root,'tasks')});const value=new AgentTaskService({store,connectionResolver:async()=>binding,scopeResolver:async()=>scope,contextProvider:async()=>({developerInstructions:'current character'}),onUsage:value=>usages.push(value),adapterFactory:async()=>{
    const adapter=new EventEmitter();adapter.dispose=()=>{};adapter.startSession=async()=>({sessionId,model:binding.model,provider:binding.provider});adapter.resumeSession=async options=>{baselines.push(options.usageBaseline);return {sessionId:options.sessionId,model:binding.model,provider:binding.provider};};adapter.sendTurn=async()=>{const cumulative=++turn===1?first:second,base=baselines.at(-1)??{inputTokens:0,outputTokens:0,totalTokens:0},usage=Object.fromEntries(Object.entries(cumulative).map(([key,value])=>[key,Math.max(0,value-(base[key]??0))]));adapter.emit('event',{type:'usage',sessionId,turnId:'turn-'+turn,payload:{usage,cumulative,billable:true}});return {status:'completed',turnId:'turn-'+turn};};return adapter;
  }});await value.init();return value;};
  t.after(async()=>{await service?.dispose();await rm(root,{recursive:true,force:true});});service=await create();const task=await service.create({...scope,workspace,instruction:'Check files'});await service.start({taskId:task.id});await service.wait(task.id);await service.dispose();service=await create();await service.continue({taskId:task.id});await service.wait(task.id);
  assert.deepEqual(baselines,[first]);assert.equal(usages.length,2);assert.equal(usages[1].usage.totalTokens,70);assert.equal(usages[1].nativeSessionId,sessionId);assert.equal(usages[1].turnId,'turn-2');assert.equal(usages[1].workspace,task.workspace.path);assert.equal(usages[1].cumulative.totalTokens,190);assert.ok((await readFile(service.store.path(task.id),'utf8')).includes('"cumulative"'));
});

test('actual monitor worker persists work workspace and native identity for restart accounting',async t=>{
  const root=await mkdtemp(join(tmpdir(),'buddy-agent-worker-')),dataRoot=join(root,'data'),logs=join(root,'logs'),workspace=join(root,'project');await Promise.all([mkdir(logs),mkdir(workspace)]);const timestamp='2026-10-23T15:00:01.000Z',meta={type:'session_meta',timestamp:'2026-10-23T14:59:00Z',payload:{id:sessionId,cwd:workspace,originator:'ai_buddy_work'}};await writeFile(join(logs,`rollout-${sessionId}.jsonl`),JSON.stringify(meta)+'\n'+JSON.stringify(count(second,timestamp))+'\n');
  let worker;const messages=[];const waitFor=predicate=>new Promise((resolve,reject)=>{const old=messages.find(predicate);if(old){resolve(old);return;}const timeout=setTimeout(()=>{worker.off('message',onMessage);reject(Error('monitor worker evidence timed out'));},10000);const onMessage=message=>{if(message.type==='error'){clearTimeout(timeout);worker.off('message',onMessage);reject(Error(message.message));}else if(predicate(message)){clearTimeout(timeout);worker.off('message',onMessage);resolve(message);}};worker.on('message',onMessage);});
  const start=async()=>{messages.length=0;worker=new Worker(new URL('../src/monitor-worker.mjs',import.meta.url),{workerData:{dataRoot,home:root,env:{},roots:[{provider:'codex',path:logs}],persistentHistory:false,refreshIntervalMs:5000}});worker.on('message',message=>messages.push(message));const configured=waitFor(message=>message.type==='configured');worker.postMessage({type:'configure',statisticsTimeZone:'America/New_York'});await configured;};
  t.after(async()=>{await worker?.terminate();await rm(root,{recursive:true,force:true});});await start();const record=buildAgentUsageRecords(sample({inputTokens:60,outputTokens:10,totalTokens:70},second,{workspace}),{timestamp:'2026-10-23T15:00:01.010Z'}).ledger;worker.postMessage({type:'companion-usage',...record});await waitFor(message=>message.type==='snapshot'&&message.value.sessions.some(row=>row.id===sessionId&&row.purpose==='work'&&row.workspace===workspace&&row.connectionIdentity?.servicePlatform==='openai'));
  let closed=waitFor(message=>message.type==='closed');worker.postMessage({type:'close'});await closed;await worker.terminate();const saved=(await readFile(join(dataRoot,'companion-usage.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(saved[0].workspace,workspace);assert.equal(saved[0].sessionId,sessionId);assert.equal(saved[0].purpose,'work');assert.equal(saved[0].usage.total_tokens,190);
  await start();const snapshot=messages.filter(message=>message.type==='snapshot').at(-1).value;assert.equal(snapshot.totals.codex.total,190);assert.equal(snapshot.workTotal,190);assert.equal(snapshot.sessions.find(row=>row.id===sessionId).workspace,workspace);closed=waitFor(message=>message.type==='closed');worker.postMessage({type:'close'});await closed;
});
