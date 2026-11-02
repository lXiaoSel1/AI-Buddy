import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentTaskStore} from '../src/agent-task-store.mjs';
import {AgentTaskService,inspectAgentWorkspace} from '../src/agent-task-service.mjs';

const scope={characterId:'deepseek',personaId:'persona-a',lifeId:'life-a',operationId:'operation-a'};
const binding={connectionId:'selected',provider:'test',model:'selected-model',harness:'mock',connectionFingerprint:'a'.repeat(64)};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const tick=()=>new Promise(resolve=>setTimeout(resolve,2));
class Adapter extends EventEmitter{
  constructor(script){super();this.script=script;}
  async startSession(options){this.options=options;return {sessionId:'native-'+Math.random(),model:options.model,provider:options.provider};}
  async resumeSession(options){this.options=options;this.resumed=options.sessionId;return {sessionId:options.sessionId,model:options.model,provider:options.provider};}
  async sendTurn(options){this.turn=options;await this.script?.call(this,options);return {status:'completed',turnId:'turn-'+Math.random()};}
  dispose(){}
}
async function fixture(t,options={}){
  const root=await mkdtemp(join(tmpdir(),'buddy-recovery-')),workspace=join(root,'project');await mkdir(workspace);await writeFile(join(workspace,'notes.txt'),'original');
  const state={now:1000,scope:{...scope},binding:{...binding},adapters:[],queries:[]},store=new AgentTaskStore({root:join(root,'tasks')});
  const make=()=>new AgentTaskService({store,connectionResolver:async()=>state.binding,scopeResolver:async()=>state.scope,contextProvider:async(task,{query}={})=>({developerInstructions:'fixed',queryText:query}),adapterFactory:async()=>{const adapter=new Adapter(async function(value){state.queries.push(value.text);await options.script?.call(this,value);});state.adapters.push(adapter);return adapter;},now:()=>state.now,...options});
  const service=make();await service.init();t.after(async()=>{await service.dispose();await rm(root,{recursive:true,force:true});});
  return {root,workspace,state,store,service,make,create:instruction=>service.create({...scope,workspace,instruction:instruction??'ORIGINAL_INITIAL_INSTRUCTION'})};
}
async function failedAttempt(service,method,payload){
  try{await service[method](payload);if(service.store.read(payload.taskId).status==='queued')await service.wait(payload.taskId);}catch(error){assert.equal(error.code,'WORKSPACE_CHANGED');}
  const task=service.read(payload.taskId);assert.equal(task.status,'paused-recoverable');assert.equal(task.errorCode,'WORKSPACE_CHANGED');return task;
}
async function confirm(service,taskId){const check=await service.inspectWorkspace({taskId});assert.equal(typeof check.checkId,'string');assert.equal(typeof check.requestId,'string');return {checkId:check.checkId,requestId:check.requestId,digest:check.digest};}

test('first queued writer changed files: async details lead to a one-time confirmed retry of the original target',async t=>{
  const entered=deferred(),release=deferred();let calls=0;const f=await fixture(t,{script:async function(){if(++calls===1){entered.resolve();await release.promise;await writeFile(join(this.options.workspace,'notes.txt'),'first writer changed');}}}),a=await f.create('FIRST_WRITER'),b=await f.create('SECOND_ORIGINAL_TARGET');
  try{await f.service.start({taskId:a.id});await entered.promise;await f.service.start({taskId:b.id});release.resolve();await Promise.all([f.service.wait(a.id),f.service.wait(b.id)]);}finally{release.resolve();}
  const blocked=f.service.read(b.id);assert.equal(blocked.turnCount,0);assert.equal(blocked.errorCode,'WORKSPACE_CHANGED');assert.equal(blocked.pendingAttempt.text,'SECOND_ORIGINAL_TARGET');assert.deepEqual(blocked.errorDetails.changes.changed,['notes.txt']);
  const approval=await confirm(f.service,b.id);await f.service.start({taskId:b.id,workspaceConfirmation:approval});assert.equal((await f.service.wait(b.id)).status,'completed');assert.equal(f.state.queries[1],'SECOND_ORIGINAL_TARGET');assert.equal(f.service.read(b.id).events.filter(row=>row.type==='user').length,1);
});

test('a confirmed request is checked again after waiting for another writer',async t=>{
  const entered=deferred(),release=deferred();let calls=0;const f=await fixture(t,{script:async function(){if(++calls===1){entered.resolve();await release.promise;await writeFile(join(this.options.workspace,'notes.txt'),'writer-after-confirmation');}}}),a=await f.create('WRITER'),b=await f.create('CONFIRMED_B');await f.service.start({taskId:a.id});await entered.promise;await writeFile(join(f.workspace,'notes.txt'),'external-before-confirmation');await failedAttempt(f.service,'start',{taskId:b.id});const approval=await confirm(f.service,b.id);await f.service.start({taskId:b.id,workspaceConfirmation:approval});release.resolve();await Promise.all([f.service.wait(a.id),f.service.wait(b.id)]);assert.equal(f.service.read(b.id).errorCode,'WORKSPACE_CHANGED');assert.equal(f.service.read(b.id).pendingAttempt.text,'CONFIRMED_B');assert.equal(f.state.adapters.length,1);const again=await confirm(f.service,b.id);await f.service.start({taskId:b.id,workspaceConfirmation:again});await f.service.wait(b.id);assert.equal(f.state.queries.at(-1),'CONFIRMED_B');assert.equal(f.state.adapters.length,2);
});

test('a bare digest and forged/cross-task confirmation cannot approve workspace changes',async t=>{
  const f=await fixture(t),a=await f.create(),b=await f.create();await writeFile(join(f.workspace,'notes.txt'),'changed');await failedAttempt(f.service,'start',{taskId:a.id});await failedAttempt(f.service,'start',{taskId:b.id});
  const approval=await confirm(f.service,a.id);await assert.rejects(f.service.start({taskId:a.id,acceptWorkspaceDigest:approval.digest}),{code:'WORKSPACE_CONFIRMATION_REQUIRED'});
  await assert.rejects(f.service.start({taskId:b.id,workspaceConfirmation:approval}),{code:'WORKSPACE_CONFIRMATION_EXPIRED'});assert.equal(f.state.adapters.length,0);
  await assert.rejects(f.service.start({taskId:a.id,workspaceConfirmation:{...approval,checkId:'forged'}}),{code:'WORKSPACE_CONFIRMATION_EXPIRED'});assert.equal(f.state.adapters.length,0);
});

test('confirmation is bound to request and current digest and expires after five minutes',async t=>{
  const f=await fixture(t),task=await f.create();await writeFile(join(f.workspace,'notes.txt'),'first change');await failedAttempt(f.service,'start',{taskId:task.id});
  let approval=await confirm(f.service,task.id);await assert.rejects(f.service.start({taskId:task.id,workspaceConfirmation:{...approval,requestId:'wrong-request'}}),{code:'WORKSPACE_CONFIRMATION_EXPIRED'});
  approval=await confirm(f.service,task.id);f.state.now+=300001;await assert.rejects(f.service.start({taskId:task.id,workspaceConfirmation:approval}),{code:'WORKSPACE_CONFIRMATION_EXPIRED'});
  approval=await confirm(f.service,task.id);await writeFile(join(f.workspace,'notes.txt'),'second change');await assert.rejects(f.service.start({taskId:task.id,workspaceConfirmation:approval}),{code:'WORKSPACE_CHANGED'});assert.equal(f.state.adapters.length,0);
});

test('a saved continuation survives an async queued failure and restart without becoming a generic prompt',async t=>{
  const entered=deferred(),release=deferred();let calls=0;const f=await fixture(t,{script:async function(){if(++calls===2){entered.resolve();await release.promise;await writeFile(join(this.options.workspace,'notes.txt'),'external writer');}}}),a=await f.create(),b=await f.create('BLOCKER');
  await f.service.start({taskId:a.id});await f.service.wait(a.id);await f.service.start({taskId:b.id});await entered.promise;await f.service.continue({taskId:a.id,text:'PRESERVE_THE_EXACT_CONTINUATION'});release.resolve();await Promise.all([f.service.wait(a.id),f.service.wait(b.id)]);
  assert.equal(f.service.read(a.id).pendingAttempt.text,'PRESERVE_THE_EXACT_CONTINUATION');await f.service.dispose();const reopened=new AgentTaskService({store:new AgentTaskStore({root:join(f.root,'tasks')}),connectionResolver:async()=>f.state.binding,scopeResolver:async()=>f.state.scope,contextProvider:async(task,{query}={})=>({developerInstructions:'fixed',queryText:query}),adapterFactory:async()=>{const adapter=new Adapter(async value=>f.state.queries.push(value.text));return adapter;},now:()=>f.state.now});await reopened.init();t.after(()=>reopened.dispose());
  const approval=await confirm(reopened,a.id);await reopened.continue({taskId:a.id,workspaceConfirmation:approval});await reopened.wait(a.id);assert.equal(f.state.queries.at(-1),'PRESERVE_THE_EXACT_CONTINUATION');assert.equal(reopened.read(a.id).events.filter(row=>row.type==='user'&&row.payload.text==='PRESERVE_THE_EXACT_CONTINUATION').length,1);
});

test('new text invalidates a prior request confirmation and never mutates the original instruction',async t=>{
  const f=await fixture(t),task=await f.create();await writeFile(join(f.workspace,'notes.txt'),'changed');await failedAttempt(f.service,'start',{taskId:task.id});const approval=await confirm(f.service,task.id);
  await assert.rejects(f.service.continue({taskId:task.id,text:'REPLACEMENT',workspaceConfirmation:approval}),{code:'WORKSPACE_CONFIRMATION_EXPIRED'});assert.equal(f.service.read(task.id).instruction,'ORIGINAL_INITIAL_INSTRUCTION');assert.equal(f.state.adapters.length,0);
  await assert.rejects(f.service.start({taskId:task.id,text:'OVERRIDE'}),{code:'AGENT_ACTION_INVALID'});assert.equal(f.service.read(task.id).instruction,'ORIGINAL_INITIAL_INSTRUCTION');
});

test('connection or life changes cannot be accepted by a file confirmation',async t=>{
  const f=await fixture(t),task=await f.create();await writeFile(join(f.workspace,'notes.txt'),'changed');await failedAttempt(f.service,'start',{taskId:task.id});const approval=await confirm(f.service,task.id);f.state.binding.model='other';await assert.rejects(f.service.start({taskId:task.id,workspaceConfirmation:approval}),{code:'AGENT_BINDING_CHANGED'});assert.equal(f.state.adapters.length,0);
  f.state.binding={...binding};f.state.scope.operationId='new-life';await assert.rejects(f.service.start({taskId:task.id,workspaceConfirmation:approval}),{code:'AGENT_STALE_SCOPE'});assert.equal(f.state.adapters.length,0);
});

test('double confirmation starts one engine and consumed or replaced credentials cannot start another turn',async t=>{
  const f=await fixture(t),task=await f.create();await writeFile(join(f.workspace,'notes.txt'),'changed');await failedAttempt(f.service,'start',{taskId:task.id});const old=await confirm(f.service,task.id),approval=await confirm(f.service,task.id);
  await assert.rejects(f.service.start({taskId:task.id,workspaceConfirmation:old}),{code:'WORKSPACE_CONFIRMATION_EXPIRED'});await Promise.allSettled([f.service.start({taskId:task.id,workspaceConfirmation:approval}),f.service.start({taskId:task.id,workspaceConfirmation:approval})]);assert.equal((await f.service.wait(task.id)).status,'completed');assert.equal(f.state.adapters.length,1);await assert.rejects(f.service.start({taskId:task.id,workspaceConfirmation:approval}),{code:'WORKSPACE_CONFIRMATION_EXPIRED'});assert.equal(f.state.adapters.length,1);
});

test('cancelling a file review invalidates its credential and preserves the saved instruction',async t=>{
  const f=await fixture(t),task=await f.create();await writeFile(join(f.workspace,'notes.txt'),'changed');await failedAttempt(f.service,'start',{taskId:task.id});const approval=await confirm(f.service,task.id);await f.service.cancel({taskId:task.id});await assert.rejects(f.service.start({taskId:task.id,workspaceConfirmation:approval}),{code:'WORKSPACE_CONFIRMATION_EXPIRED'});assert.equal(f.state.adapters.length,0);assert.equal(f.service.read(task.id).pendingAttempt.text,task.instruction);
});

test('legacy paused unsubmitted journal restores the matching user text, not the newest unrelated event',async t=>{
  const f=await fixture(t),task=await f.create();await f.store.patch(task.id,{status:'paused-recoverable',queuedRequestId:'legacy-pending-request',turnCount:1,sessionId:'existing-session',errorCode:'WORKSPACE_CHANGED',outcomeUnknown:false});await f.store.append(task.id,{type:'user',requestId:'legacy-pending-request',payload:{text:'RESTORE_LEGACY_EXACT_TEXT'}});await f.store.append(task.id,{type:'user',requestId:'unrelated-request',payload:{text:'DO_NOT_USE_THIS_OTHER_REQUEST'}});
  await f.service.continue({taskId:task.id});await f.service.wait(task.id);assert.equal(f.state.queries[0],'RESTORE_LEGACY_EXACT_TEXT');assert.equal(f.service.read(task.id).events.filter(row=>row.type==='user'&&row.payload.text==='RESTORE_LEGACY_EXACT_TEXT').length,1);
});

test('cancel during preflight prevents a late queue entry or engine',async t=>{
  let scanning=false;const entered=deferred(),release=deferred();const f=await fixture(t,{workspaceInspector:async(...args)=>{if(scanning){entered.resolve();await release.promise;}return inspectAgentWorkspace(...args);}}),task=await f.create();scanning=true;const start=f.service.start({taskId:task.id});await Promise.race([entered.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('preflight never entered')),1000))]);await f.service.cancel({taskId:task.id});release.resolve();await start.catch(error=>assert.equal(error.code,'ABORT_ERR'));await f.service.wait(task.id);assert.equal(f.state.adapters.length,0);assert.equal(f.service.queue.length,0);assert.equal(f.service.read(task.id).status,'paused-recoverable');
});

test('a late workspace inspection cannot issue a confirmation for a replacement request',async t=>{
  let scanning=false;const entered=deferred(),release=deferred();const f=await fixture(t,{workspaceInspector:async(...args)=>{if(scanning){entered.resolve();await release.promise;}return inspectAgentWorkspace(...args);}}),task=await f.create();await writeFile(join(f.workspace,'notes.txt'),'changed');await failedAttempt(f.service,'start',{taskId:task.id});const oldId=f.service.read(task.id).pendingAttempt.requestId;scanning=true;const inspecting=f.service.inspectWorkspace({taskId:task.id,requestId:oldId});await entered.promise;await f.store.patch(task.id,{pendingAttempt:{...f.service.read(task.id).pendingAttempt,requestId:'replacement-request'}});release.resolve();await assert.rejects(inspecting,{code:'WORKSPACE_CONFIRMATION_EXPIRED'});assert.equal(f.service.confirmations.size,1,'old issued check is not replaced with a credential for another request');
});

test('legacy DeepSeek transport never resumes in place; explicit fork freezes evidence and starts a fresh budgeted session only on request',async t=>{
  const f=await fixture(t);f.state.binding={...binding,provider:'deepseek'};const task=await f.create('PRESERVE_ORIGINAL_FORK_TARGET');await f.store.patch(task.id,{turnCount:1,sessionId:'legacy-native',status:'paused-recoverable'});await f.store.append(task.id,{type:'user',requestId:'old-request',payload:{text:'OLD_EXACT_USER'}});await f.store.append(task.id,{type:'tool',requestId:'old-request',payload:{item:{command:'old-command',stdout:'FROZEN_TOOL_RECEIPT'}}});await f.store.append(task.id,{type:'usage',requestId:'old-request',payload:{usage:{totalTokens:999}}});
  f.state.binding.workTransport={version:1,provider:'deepseek',protocol:'chat-completions',engine:'codex',adapter:'responses-chat-bridge-v1'};await f.service.start({taskId:task.id});assert.equal((await f.service.wait(task.id)).errorCode,'AGENT_WORK_TRANSPORT_UNVERIFIED');assert.equal(f.state.adapters.length,0);
  const fork=await f.service.fork({taskId:task.id,expectedConnectionFingerprint:f.state.binding.connectionFingerprint});assert.notEqual(fork.id,task.id);assert.equal(fork.instruction,task.instruction);assert.equal(fork.status,'paused-recoverable');assert.equal(fork.sessionId,null);assert.equal(fork.continuedFrom.taskId,task.id);assert.match(fork.sourceEvidence.sha256,/^[a-f0-9]{64}$/);assert.equal(fork.sourceEvidence.events.some(row=>row.type==='usage'),false);assert.equal(f.state.adapters.length,0);
  await f.service.start({taskId:fork.id});const done=await f.service.wait(fork.id);assert.equal(done.status,'completed');assert.notEqual(done.sessionId,'legacy-native');assert.equal(f.state.adapters[0].resumed,undefined);assert.match(f.state.queries[0],/FROZEN_TOOL_RECEIPT/);assert.match(f.state.queries[0],/OLD_EXACT_USER/);assert.match(f.state.queries[0],/PRESERVE_ORIGINAL_FORK_TARGET/);assert.equal(f.service.read(task.id).sessionId,'legacy-native');
});

test('fork does not silently accept another connection, model, effort, persona or life',async t=>{
  const f=await fixture(t),task=await f.create();for(const patch of [{connectionId:'other'},{model:'other'},{effort:'high'},{connectionFingerprint:'b'.repeat(64)}]){const before={...f.state.binding};Object.assign(f.state.binding,patch);await assert.rejects(f.service.fork({taskId:task.id}),{code:'AGENT_BINDING_CHANGED'});f.state.binding=before;}assert.equal(f.service.list().length,1);
  f.state.scope.personaId='other-persona';await assert.rejects(f.service.fork({taskId:task.id}),{code:'AGENT_STALE_SCOPE'});assert.equal(f.service.list().length,1);
});

test('explicit legacy DeepSeek fork binds the reviewed current endpoint and refuses capability drift',async t=>{
  const f=await fixture(t);f.state.binding={...binding,provider:'deepseek'};const task=await f.create();f.state.binding={...f.state.binding,connectionFingerprint:'b'.repeat(64),workTransport:{version:1,protocol:'responses',endpoint:'https://new-reviewed.example',model:binding.model}};await assert.rejects(f.service.fork({taskId:task.id}),{code:'AGENT_FORK_CONFIRMATION_REQUIRED'});const fork=await f.service.fork({taskId:task.id,expectedConnectionFingerprint:'b'.repeat(64)});assert.equal(fork.binding.connectionFingerprint,'b'.repeat(64));assert.equal(fork.sourceEvidence.binding.connectionFingerprint,'a'.repeat(64));assert.equal(f.service.read(task.id).binding.connectionFingerprint,'a'.repeat(64));assert.equal(fork.sessionId,null);f.state.binding.connectionFingerprint='c'.repeat(64);await assert.rejects(f.service.fork({taskId:task.id,expectedConnectionFingerprint:'b'.repeat(64)}),{code:'AGENT_BINDING_CHANGED'});assert.equal(f.service.list().length,2);
});

test('an explicit reviewed legacy fork may use the selected new provider/model while preserving all original evidence',async t=>{
  const f=await fixture(t);f.state.binding={...binding,provider:'deepseek'};const task=await f.create('ORIGINAL_PROVIDER_TARGET');f.state.binding={connectionId:'new-codex',provider:'openai',model:'chosen-codex-model',effort:'high',harness:'codex',connectionFingerprint:'b'.repeat(64)};const fork=await f.service.fork({taskId:task.id,expectedConnectionFingerprint:'b'.repeat(64)});assert.deepEqual(fork.binding,f.state.binding);assert.deepEqual(fork.sourceEvidence.binding,task.binding);assert.deepEqual(fork.scope,task.scope);assert.deepEqual(fork.workspace,task.workspace);assert.equal(fork.instruction,task.instruction);assert.equal(fork.status,'paused-recoverable');assert.equal(fork.sessionId,null);assert.equal(f.state.adapters.length,0);
});

test('fork refuses an externally damaged journal and frozen evidence cannot be patched',async t=>{
  const f=await fixture(t),task=await f.create();const fork=await f.service.fork({taskId:task.id});for(const key of ['instruction','sourceEvidence','continuedFrom'])await assert.rejects(f.store.patch(fork.id,{[key]:{changed:true}}),/固定归属/);
  await appendFile(f.store.path(task.id),'broken');await assert.rejects(f.service.fork({taskId:task.id}),{code:'AGENT_JOURNAL_CORRUPT'});assert.equal(f.service.list().length,2);assert.match(await readFile(f.store.path(task.id),'utf8'),/broken$/);
});

test('fork of result-unknown work requires explicit guidance and freezes it without changing the original target',async t=>{
  const f=await fixture(t),task=await f.create();await f.store.patch(task.id,{status:'paused-recoverable',outcomeUnknown:true});await assert.rejects(f.service.fork({taskId:task.id}),{code:'AGENT_CONTINUE_INSTRUCTION_REQUIRED'});const fork=await f.service.fork({taskId:task.id,text:'CHECK_THE_REAL_EFFECT_FIRST'});assert.equal(fork.instruction,task.instruction);assert.equal(fork.sourceEvidence.outcomeUnknown,true);assert.equal(fork.sourceGuidance,'CHECK_THE_REAL_EFFECT_FIRST');await assert.rejects(f.store.patch(fork.id,{sourceGuidance:'replace'}),/固定归属/);await f.service.start({taskId:fork.id});await f.service.wait(fork.id);assert.match(f.state.queries[0],/CHECK_THE_REAL_EFFECT_FIRST/);assert.equal(f.state.adapters.length,1);
});

test('fork preparation is busy and cancelling it prevents a late child task',async t=>{
  const f=await fixture(t),task=await f.create(),entered=deferred(),release=deferred();f.service.contextProvider=async()=>{entered.resolve();await release.promise;return {developerInstructions:'held context'};};const pending=f.service.fork({taskId:task.id});await entered.promise;assert(f.service.scheduling.has(task.id));assert(f.service.preparations.has(task.id));await f.service.cancel({taskId:task.id});release.resolve();await assert.rejects(pending,{code:'ABORT_ERR'});assert.equal(f.service.list().length,1);assert.equal(f.state.adapters.length,0);assert.equal(f.service.scheduling.size,0);assert.equal(f.service.preparations.size,0);
});

test('a life switch during task creation cannot commit a task for the stale life',async t=>{
  const f=await fixture(t),entered=deferred(),release=deferred();f.service.contextProvider=async()=>{entered.resolve();await release.promise;return {developerInstructions:'held context'};};const pending=f.create();await entered.promise;f.state.scope.operationId='changed-during-create';release.resolve();await assert.rejects(pending,{code:'AGENT_STALE_SCOPE'});assert.equal(f.service.list().length,0);assert.equal(f.state.adapters.length,0);
});

test('post-submission model drift preserves unknown outcome and historical tools and requires explicit new guidance',async t=>{
  const f=await fixture(t,{script:async function(){this.emit('event',{type:'tool',payload:{state:'completed',item:{command:'side-effect',stdout:'ACTUAL_EFFECT',exitCode:0}}});this.emit('event',{type:'status',payload:{status:'model-mismatch'}});await tick();}}),task=await f.create();await f.service.start({taskId:task.id});const stopped=await f.service.wait(task.id);assert.equal(stopped.errorCode,'HARNESS_MODEL_MISMATCH');assert.equal(stopped.outcomeUnknown,true);assert.equal(stopped.pendingAttempt.submitted,true);assert(stopped.events.some(row=>row.type==='tool'&&row.payload.item.stdout==='ACTUAL_EFFECT'));
  await assert.rejects(f.service.continue({taskId:task.id}),{code:'AGENT_CONTINUE_INSTRUCTION_REQUIRED'});assert.equal(f.state.adapters.length,1);
});

test('trusted zero-upstream context capacity rejection preserves the unsubmitted original request',async t=>{
  const f=await fixture(t,{script:async()=>{throw Object.assign(Error('capacity before upstream'),{code:'HARNESS_WORK_CONTEXT_CAPACITY',details:{capacity:4096,upstreamSubmitted:false,upstreamAttempts:0}});}}),task=await f.create();await f.service.start({taskId:task.id});const stopped=await f.service.wait(task.id);assert.equal(stopped.errorCode,'HARNESS_WORK_CONTEXT_CAPACITY');assert.equal(stopped.outcomeUnknown,false);assert.equal(stopped.pendingAttempt.submitted,false);assert.equal(stopped.pendingAttempt.text,task.instruction);
});

test('capacity rejection after an earlier upstream tool attempt remains result-unknown',async t=>{
  const f=await fixture(t,{script:async function(){this.emit('event',{type:'tool',payload:{state:'completed',item:{command:'earlier-native-tool',stdout:'EFFECT_BEFORE_BUDGET_REJECTION',exitCode:0}}});throw Object.assign(Error('capacity after earlier tool rounds'),{code:'HARNESS_WORK_CONTEXT_CAPACITY',details:{capacity:4096,upstreamSubmitted:false,upstreamAttempts:1}});}}),task=await f.create();await f.service.start({taskId:task.id});const stopped=await f.service.wait(task.id);assert.equal(stopped.outcomeUnknown,true);assert.equal(stopped.pendingAttempt.submitted,true);assert(stopped.events.some(row=>row.payload.item?.stdout==='EFFECT_BEFORE_BUDGET_REJECTION'));await assert.rejects(f.service.continue({taskId:task.id}),{code:'AGENT_CONTINUE_INSTRUCTION_REQUIRED'});
});

test('asynchronous adapter disposal holds the writer and completion until cleanup really finishes',async t=>{
  const entered=deferred(),release=deferred();let disposed=0;const f=await fixture(t,{adapterFactory:async()=>{const adapter=new Adapter();adapter.dispose=async()=>{disposed++;entered.resolve();await release.promise;};return adapter;}}),task=await f.create();await f.service.start({taskId:task.id});await entered.promise;
  assert.equal(f.service.read(task.id).status,'running');assert(f.service.runs.has(task.id));assert.equal(f.service.writerLocks.get(task.workspace.id),task.id);release.resolve();assert.equal((await f.service.wait(task.id)).status,'completed');assert.equal(disposed,1);assert.equal(f.service.writerLocks.size,0);
});

test('closing during asynchronous cleanup never publishes completion and waits for one owned disposal',async t=>{
  const entered=deferred(),release=deferred();let disposed=0;const f=await fixture(t,{adapterFactory:async()=>{const adapter=new Adapter();adapter.dispose=async()=>{disposed++;entered.resolve();await release.promise;};return adapter;}}),task=await f.create();await f.service.start({taskId:task.id});await entered.promise;let closed=false;const closing=f.service.dispose().then(()=>closed=true);await tick();assert.equal(closed,false);release.resolve();await closing;const stopped=f.service.read(task.id);assert.equal(stopped.status,'paused-recoverable');assert.equal(stopped.outcomeUnknown,true);assert.equal(disposed,1);assert.equal(f.service.runs.size,0);assert.equal(f.service.writerLocks.size,0);
});
