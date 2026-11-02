import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm,appendFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {AgentTaskStore} from '../src/agent-task-store.mjs';
import {AgentTaskService,canonicalAgentWorkspace,inspectAgentWorkspace} from '../src/agent-task-service.mjs';
import {buildCharacterWorkContext,workMemoryVisible} from '../src/character-context-bridge.mjs';

const execute=promisify(execFile),tick=()=>new Promise(resolve=>setTimeout(resolve,5));
const binding={connectionId:'local-test',provider:'test-provider',model:'test-model',effort:'low',harness:'mock'};
const scope={characterId:'deepseek',personaId:'persona-a',lifeId:'life-a',operationId:'operation-a'};
class MockAdapter extends EventEmitter{
  constructor(script=async()=>{}){super();this.script=script;this.sessions=new Map();this.disposed=false;}
  async startSession(options){this.options=options;const session={sessionId:'native-'+Math.random(),model:options.model,provider:options.provider,capabilities:{resume:true}};this.sessions.set(session.sessionId,session);return session;}
  async resumeSession(options){this.options=options;this.resumed=options.sessionId;const session={sessionId:options.sessionId,model:options.model,provider:options.provider};this.sessions.set(session.sessionId,session);return session;}
  async sendTurn(options){this.turn=options;return await this.script.call(this,options)??{sessionId:options.sessionId,turnId:'turn-1',status:'completed'};}
  event(type,payload={},extra={}){this.emit('event',{type,sessionId:this.turn?.sessionId??this.resumed,turnId:'turn-1',itemId:'item-1',payload,...extra});}
  respondToRequest(answer){this.answer=answer;this.answerResolve?.();}
  dispose(){this.disposed=true;this.disposeReject?.(Object.assign(Error('disconnect'),{code:'HARNESS_DISCONNECTED'}));}
}
async function fixture(t,options={}){
  const root=await mkdtemp(join(tmpdir(),'buddy-work-'));t.after(()=>rm(root,{recursive:true,force:true}));const workspace=join(root,'project');await mkdir(workspace);await writeFile(join(workspace,'notes.txt'),'project original');
  const state={binding:{...binding},scope:{...scope},adapters:[],events:[],usage:[],experiences:[]},store=new AgentTaskStore({root:join(root,'tasks')});
  const service=new AgentTaskService({store,connectionResolver:async()=>state.binding,scopeResolver:async task=>({...state.scope,characterId:task.scope.characterId,personaId:task.scope.personaId}),contextProvider:async()=>({character:{id:'deepseek',effective:{name:'鲸鱼娘',personality:'当前人格'}}}),adapterFactory:async({task})=>{const adapter=new MockAdapter(options.script);adapter.taskId=task.id;state.adapters.push(adapter);return adapter;},onEvent:event=>state.events.push(event),onUsage:value=>state.usage.push(value),onExperience:source=>state.experiences.push(source),cancelTimeoutMs:25,...options});await service.init();t.after(()=>service.dispose());
  const create=extra=>service.create({...scope,workspace,instruction:'Read project, fix it and run checks',...extra});return {root,workspace,service,state,store,create};
}

test('mock engine reads, edits, runs a failing check, repairs, passes and resumes the same native session',async t=>{
  const f=await fixture(t,{script:async function(options){
    const file=join(this.options.workspace,'sum.mjs');
    if(!this.resumed){
      this.event('text',{text:'我先读取并修改函数。'});const original=await readFile(file,'utf8');assert.match(original,/a-b/);
      this.event('tool',{state:'started',item:{type:'fileChange',path:file}});await writeFile(file,'export const sum=(a,b)=>a+b-1;');
      let failed=false;try{await execute(process.execPath,['--input-type=module','-e',"import {sum} from './sum.mjs'; if(sum(2,3)!==5)process.exit(2)"],{cwd:this.options.workspace});}catch(error){failed=true;this.event('tool',{state:'completed',item:{type:'commandExecution',command:'node check-sum',exitCode:error.code,stdout:'expected 5'}});}assert.equal(failed,true);
      await writeFile(file,'export const sum=(a,b)=>a+b;');await execute(process.execPath,['--input-type=module','-e',"import {sum} from './sum.mjs'; if(sum(2,3)!==5)process.exit(2)"],{cwd:this.options.workspace});this.event('tool',{state:'completed',item:{type:'commandExecution',command:'node check-sum',exitCode:0}});this.event('text',{text:'已修复，检查通过。'});
    }else{assert.match(await readFile(file,'utf8'),/a\+b/);this.event('text',{text:'已核对上轮文件，继续完成。'});}
    this.event('usage',{usage:{inputTokens:20,outputTokens:10,totalTokens:30}},{eventId:'usage-current'});return {sessionId:options.sessionId,turnId:this.resumed?'turn-2':'turn-1',status:'completed'};
  }});
  await writeFile(join(f.workspace,'sum.mjs'),'export const sum=(a,b)=>a-b;');const task=await f.create();await f.service.start({taskId:task.id});const completed=await f.service.wait(task.id);
  assert.equal(completed.status,'completed');assert.equal(completed.turnCount,1);assert.match(completed.events.filter(row=>row.type==='text').map(row=>row.payload.text).join(''),/检查通过/);assert.equal(f.state.usage.length,1);assert.equal(f.state.experiences.length,0,'not presented means no shared experience');
  await f.service.present({taskId:task.id,requestId:completed.completedRequestId});assert.equal(f.state.experiences.length,1);assert.equal(f.state.experiences[0].workspaceId,task.workspace.id);await f.service.present({taskId:task.id,requestId:completed.completedRequestId});assert.equal(f.state.experiences.length,1);
  await f.service.dispose();const store=new AgentTaskStore({root:join(f.root,'tasks')}),reopened=new AgentTaskService({store,connectionResolver:async()=>binding,scopeResolver:async()=>scope,contextProvider:async()=>({}),adapterFactory:async()=>{const adapter=new MockAdapter(f.state.adapters[0].script);f.state.adapters.push(adapter);return adapter;}});t.after(()=>reopened.dispose());await reopened.init();assert.equal(reopened.list().length,1);assert.equal(f.state.adapters.length,1,'restart did not start execution');
  await reopened.continue({taskId:task.id,text:'continue'});const resumed=await reopened.wait(task.id);assert.equal(resumed.status,'completed');assert.equal(resumed.turnCount,2);assert.equal(f.state.adapters[1].resumed,completed.sessionId);assert.equal(resumed.sessionId,completed.sessionId);
});

test('fixed role/persona/life/binding scope persists; filtering cannot read another persona',async t=>{
  const f=await fixture(t);const a=await f.create(),b=await f.create({personaId:'persona-b'});assert.equal(f.service.list({personaId:'persona-a'}).length,1);assert.equal(f.service.read({taskId:b.id,scope:{personaId:'persona-b'}}).scope.personaId,'persona-b');assert.throws(()=>f.service.read({taskId:b.id,scope:{personaId:'persona-a'}}),/无法读取/);await assert.rejects(f.store.patch(a.id,{binding:{model:'other'}}),/固定归属/);
});

test('connection changes pause without creating a fallback adapter',async t=>{
  const f=await fixture(t),task=await f.create();f.state.binding.model='cheaper-other-model';await f.service.start({taskId:task.id});const paused=await f.service.wait(task.id);assert.equal(paused.status,'paused-recoverable');assert.equal(paused.errorCode,'AGENT_BINDING_CHANGED');assert.equal(f.state.adapters.length,0);assert.equal(paused.binding.model,'test-model');
});

test('actual model mismatch cannot execute a turn or publish a successful report',async t=>{
  const f=await fixture(t,{adapterFactory:async()=>{const adapter=new MockAdapter();adapter.startSession=async()=>({sessionId:'bad',model:'wrong',provider:'test-provider'});return adapter;}}),task=await f.create();await f.service.start({taskId:task.id});const paused=await f.service.wait(task.id);assert.equal(paused.errorCode,'HARNESS_MODEL_MISMATCH');assert.equal(paused.status,'paused-recoverable');assert.equal(f.state.experiences.length,0);
});

test('only one writer enters a canonical workspace; double-click start is deduplicated',async t=>{
  let release;const entered=[],hold=new Promise(resolve=>release=resolve);const f=await fixture(t,{script:async function(){entered.push(this.taskId);if(entered.length===1)await hold;this.event('text',{text:'done'});}}),a=await f.create(),b=await f.create();
  try{await Promise.all([f.service.start({taskId:a.id}),f.service.start({taskId:a.id}),f.service.start({taskId:b.id})]);for(let n=0;n<400&&entered.length===0;n++)await tick();assert.equal(entered.length,1);const waiting=entered[0]===a.id?b:a;assert.equal(f.service.read(waiting.id).status,'queued');}finally{release();}
  await Promise.all([f.service.wait(a.id),f.service.wait(b.id)]);assert.equal(entered.length,2);assert.equal(f.service.read(a.id).turnCount,1);
});

test('independent projects can execute concurrently without changing task identity',async t=>{
  let entered=0,release;const hold=new Promise(resolve=>release=resolve);const f=await fixture(t,{script:async function(){entered++;await hold;}}),other=join(f.root,'other');await mkdir(other);const a=await f.create(),b=await f.create({workspace:other});try{await Promise.all([f.service.start({taskId:a.id}),f.service.start({taskId:b.id})]);for(let n=0;n<400&&entered<2;n++)await tick();assert.equal(entered,2);assert.notEqual(a.workspace.id,b.workspace.id);}finally{release();}await Promise.all([f.service.wait(a.id),f.service.wait(b.id)]);
});

test('turn completion with a still failing check is paused instead of claiming task success',async t=>{
  const f=await fixture(t,{script:async function(){this.event('tool',{state:'completed',item:{type:'commandExecution',command:'node --test',exitCode:2}});this.event('text',{text:'I claim success despite failure'});}}),task=await f.create();await f.service.start({taskId:task.id});const result=await f.service.wait(task.id);assert.equal(result.status,'paused-recoverable');assert.equal(result.errorCode,'AGENT_CHECKS_FAILED');assert.equal(result.unresolvedChecks.length,1);assert.equal(f.state.experiences.length,0);await assert.rejects(f.service.present({taskId:task.id,requestId:result.queuedRequestId}),/尚未完成/);
});

test('resume checks source hashes and requires a fresh request-bound confirmation',async t=>{
  const f=await fixture(t),task=await f.create();await f.service.start({taskId:task.id});await f.service.wait(task.id);await writeFile(join(f.workspace,'notes.txt'),'external edit');let changed;try{await f.service.continue({taskId:task.id});assert.fail();}catch(error){assert.equal(error.code,'WORKSPACE_CHANGED');changed=error.details;assert.deepEqual(changed.changes.changed,['notes.txt']);}
  await assert.rejects(f.service.continue({taskId:task.id,acceptWorkspaceDigest:'old'}),error=>error.code==='WORKSPACE_CONFIRMATION_REQUIRED');assert.equal(f.state.adapters.length,1);
  const check=await f.service.inspectWorkspace({taskId:task.id});await f.service.continue({taskId:task.id,workspaceConfirmation:{checkId:check.checkId,requestId:check.requestId,digest:check.digest}});assert.equal((await f.service.wait(task.id)).status,'completed');assert.equal(f.state.adapters[1].resumed,f.service.read(task.id).sessionId);
});

test('native replay is ignored; duplicate usage is recorded once and cumulative context metrics are not billed',async t=>{
  const f=await fixture(t,{script:async function(){this.event('text',{text:'old replay'},{replay:true});this.event('usage',{usage:{totalTokens:100}},{replay:true,eventId:'replay'});this.event('text',{text:'new result'},{eventId:'same'});this.event('text',{text:'new result'},{eventId:'same'});this.event('usage',{usage:{totalTokens:3}},{eventId:'u'});this.event('usage',{usage:{totalTokens:3}},{eventId:'u'});this.event('usage',{contextUsage:{used:999},billable:false});}}),task=await f.create();await f.service.start({taskId:task.id});const result=await f.service.wait(task.id);assert.equal(result.events.filter(row=>row.type==='text').map(row=>row.payload.text).join(''),'new result');assert.equal(f.state.usage.length,1);assert.equal(f.state.usage[0].usage.totalTokens,3);
});

test('restart retains unknown outcomes and original tools but never starts an engine automatically',async t=>{
  const f=await fixture(t),task=await f.create();await f.store.patch(task.id,{status:'running',sessionId:'native-existing'});await f.store.append(task.id,{type:'tool',payload:{item:{type:'commandExecution',command:'do not repeat automatically'}}});
  const reopened=new AgentTaskStore({root:join(f.root,'tasks')});await reopened.init();await reopened.recoverInterrupted();const saved=reopened.read(task.id);assert.equal(saved.status,'paused-recoverable');assert.equal(saved.outcomeUnknown,true);assert.match(saved.events[0].payload.item.command,/do not repeat/);assert.equal(f.state.adapters.length,0);
});

test('cancel stays cancelling until adapter acknowledges; late output does not add text or rewards',async t=>{
  let entered;const ready=new Promise(resolve=>entered=resolve);const f=await fixture(t,{script:async function(options){this.event('text',{text:'partial'});entered();await new Promise((resolve,reject)=>{this.disposeReject=reject;options.signal.addEventListener('abort',()=>{this.event('text',{text:'late'});setTimeout(()=>reject(Object.assign(Error('cancelled'),{code:'ABORT_ERR'})),10);},{once:true});});}}),task=await f.create();await f.service.start({taskId:task.id});await ready;const stopping=await f.service.cancel({taskId:task.id});assert.equal(stopping.status,'cancelling');const final=await f.service.wait(task.id);assert.equal(final.status,'paused-recoverable');assert.equal(final.outcomeUnknown,true);assert.equal(final.events.filter(row=>row.type==='text').map(row=>row.payload.text).join(''),'partial');assert.equal(f.state.experiences.length,0);
});

test('cancelling preparation cannot create a late engine/session or submit a model turn',async t=>{
  for(const stage of ['context','factory','session']){
    let entered,release,contextCalls=0,adapters=0,sessions=0,turns=0;const ready=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);
    const f=await fixture(t,{contextProvider:async()=>{if(stage==='context'&&++contextCalls>1){entered();await hold;}return {};},adapterFactory:async()=>{
      adapters++;if(stage==='factory'){entered();await hold;}const adapter=new MockAdapter(async()=>{turns++;});const start=adapter.startSession.bind(adapter);adapter.startSession=async options=>{sessions++;if(stage==='session'){entered();await hold;}return start(options);};return adapter;
    }}),task=await f.create();
    try{await f.service.start({taskId:task.id});await ready;await f.service.cancel({taskId:task.id});}finally{release();}
    const final=await f.service.wait(task.id);assert.equal(final.status,'paused-recoverable',stage);assert.equal(final.outcomeUnknown,false,stage);assert.equal(turns,0,stage);if(stage==='context')assert.equal(adapters,0);if(stage==='factory')assert.equal(sessions,0);
  }
});

test('life changes suppress old asynchronous text and prevent reporting an old life as current',async t=>{
  let release,entered;const ready=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);const f=await fixture(t,{script:async function(){entered();await hold;this.event('text',{text:'belongs to old life'});}}),task=await f.create();await f.service.start({taskId:task.id});await ready;f.state.scope.operationId='new-life-operation';release();const final=await f.service.wait(task.id);assert.equal(final.status,'paused-recoverable');assert.equal(final.errorCode,'AGENT_STALE_SCOPE');assert.equal(final.events.filter(row=>row.type==='text').length,0);assert.equal(f.state.experiences.length,0);
});

test('permission input waits for an explicit answer and rejects duplicate or expired answers',async t=>{
  let asked;const ready=new Promise(resolve=>asked=resolve);const f=await fixture(t,{script:async function(){this.event('request',{requestId:7,method:'item/commandExecution/requestApproval',command:'node --test'});asked();await new Promise(resolve=>this.answerResolve=resolve);assert.deepEqual(this.answer.result,{decision:'accept'});this.event('text',{text:'test complete'});}}),task=await f.create();await f.service.start({taskId:task.id});await ready;for(let n=0;n<100&&f.service.read(task.id).status!=='waiting-for-user';n++)await tick();assert.equal(f.service.read(task.id).status,'waiting-for-user');assert.throws(()=>f.service.assertCharacterIdle('deepseek'),/暂停/);await f.service.respond({taskId:task.id,requestId:7,result:{decision:'accept'}});assert.equal((await f.service.wait(task.id)).status,'completed');await assert.rejects(f.service.respond({taskId:task.id,requestId:7,result:{decision:'accept'}}),/不存在|已处理/);
});

test('connection credentials and bearer tokens never enter task journals or errors',async t=>{
  const secret='test-private-credential-123456',f=await fixture(t,{script:async function(){this.event('text',{text:'echo '+secret+' Bearer hidden-value'});this.event('tool',{item:{apiKey:secret,key:secret,message:secret}});throw Error('failure: '+secret);}});f.state.binding.key=secret;const task=await f.create();await f.service.start({taskId:task.id});await f.service.wait(task.id);const raw=await readFile(f.store.path(task.id),'utf8');assert.ok(!raw.includes(secret));assert.ok(!raw.includes('hidden-value'));assert.ok(!raw.includes('"apiKey"'));assert.match(raw,/redacted/);
});

test('presentation retry after a cross-store interruption reuses the same source identity, time and version',async t=>{
  const sources=[];let clock=1000;const f=await fixture(t,{now:()=>clock,onExperience:async source=>{sources.push(source);if(sources.length===1)throw Error('simulated interruption after receiver commit');}}),task=await f.create();await f.service.start({taskId:task.id});const done=await f.service.wait(task.id);await assert.rejects(f.service.present({taskId:task.id,requestId:done.completedRequestId}),/interruption/);clock=2000;await f.service.present({taskId:task.id,requestId:done.completedRequestId});assert.equal(sources.length,2);assert.deepEqual(sources[0],sources[1]);assert.equal(sources[0].createdAt,1000);assert.equal(f.service.read(task.id).presentedAt,1000);
});

test('append-only records are hash chained and corruption never silently discards the original',async t=>{
  const f=await fixture(t),task=await f.create();await f.store.append(task.id,{type:'text',payload:{text:'preserved original'}});const original=await readFile(f.store.path(task.id),'utf8');await appendFile(f.store.path(task.id),'{"unfinished":');const reopened=new AgentTaskStore({root:join(f.root,'tasks')});await reopened.init();assert.equal(reopened.read(task.id).status,'failed');assert.ok(reopened.read(task.id).journalError);await assert.rejects(reopened.patch(task.id,{status:'queued'}),error=>error.code==='AGENT_JOURNAL_CORRUPT');assert.equal(await readFile(f.store.path(task.id),'utf8'),original+'{"unfinished":');
});

test('work context uses current personality and filters private, absent, cross-persona, cross-life and cross-project memories',async t=>{
  const f=await fixture(t),task=await f.create(),base={characterId:scope.characterId,lifeId:scope.lifeId,personaId:scope.personaId,presented:true,kind:'work',workspaceId:task.workspace.id,visibility:'project'};
  const sources=[{...base,id:'allowed',text:'允许的项目事实'},{...base,id:'other-persona',personaId:'persona-b',text:'私人秘密'},{...base,id:'other-life',lifeId:'other-life',text:'旧人生秘密'},{...base,id:'other-project',workspaceId:'other-workspace',text:'其他项目'},{...base,id:'not-seen',presented:false,text:'未呈现'},{...base,id:'group',kind:'group',text:'未授权群聊'},{...base,id:'private',visibility:'private-chat',text:'私聊秘密'}];
  const context=buildCharacterWorkContext({task,character:{id:'deepseek',revision:9,effective:{name:'鲸鱼娘',personality:'成长后的当前人格'}},persona:{id:'persona-a',nickname:'玩家甲'},memorySources:sources});assert.match(context.developerInstructions,/成长后的当前人格/);assert.match(context.developerInstructions,/允许的项目事实/);for(const term of ['私人秘密','旧人生秘密','其他项目"','未呈现','未授权群聊','私聊秘密'])assert.ok(!context.developerInstructions.includes(term));assert.deepEqual(context.sources,[{id:'allowed',version:null}]);assert.equal(workMemoryVisible(sources[1],task),false);
});

test('workspace fingerprints hash contents even when byte length remains unchanged',async t=>{
  const f=await fixture(t),workspace=await canonicalAgentWorkspace(f.workspace),before=await inspectAgentWorkspace(workspace);await writeFile(join(f.workspace,'notes.txt'),'project modified');const after=await inspectAgentWorkspace(workspace);assert.equal(before.bytes,after.bytes);assert.notEqual(before.digest,after.digest);assert.deepEqual(after.excluded,['.git','node_modules','.cache','.venv','venv','target','dist']);
});

test('restored life forks from frozen task evidence and never resumes later native history',async t=>{
  const nativeHistory=new Map(),resumes=[],sent=[],queries=[];let nativeSequence=0,turnSequence=0;
  const f=await fixture(t,{contextProvider:async(task,{query}={})=>{if(query!=null)queries.push({taskId:task.id,query});return {developerInstructions:'Current authorized character',queryText:query==null?undefined:'BUDGETED\n'+query};},adapterFactory:async()=>{
    const adapter=new MockAdapter(async function(options){sent.push({sessionId:options.sessionId,text:options.text,inherited:this.inherited??[]});const text=++turnSequence===1?'T1_FROZEN_RESULT':turnSequence===2?'T2_PRIVATE_AFTER_ARCHIVE':'RESTORED_NEW_RESULT';nativeHistory.get(options.sessionId).push(text);this.event('text',{text});return {sessionId:options.sessionId,turnId:'turn-'+turnSequence,status:'completed'};});
    adapter.startSession=async options=>{adapter.options=options;const sessionId='native-owned-'+(++nativeSequence);nativeHistory.set(sessionId,[]);return {sessionId,model:options.model,provider:options.provider};};
    adapter.resumeSession=async options=>{resumes.push(options.sessionId);adapter.options=options;adapter.inherited=[...nativeHistory.get(options.sessionId)];return {sessionId:options.sessionId,model:options.model,provider:options.provider};};return adapter;
  }}),task=await f.create();await f.service.start({taskId:task.id});const t1=await f.service.wait(task.id),evidence=f.service.snapshotLife(scope);
  await f.service.continue({taskId:task.id,text:'Create future private T2'});await f.service.wait(task.id);assert.deepEqual(nativeHistory.get(t1.sessionId),['T1_FROZEN_RESULT','T2_PRIVATE_AFTER_ARCHIVE']);assert.equal(resumes.length,1);
  const projectBefore=await readFile(join(f.workspace,'notes.txt'),'utf8');f.state.scope.operationId='restored-operation';const restored=await f.service.restoreLife({...scope,operationId:'restored-operation',evidence,transactionId:'frozen-restore'}),id=restored.restoredTaskIds[0],archived=f.service.read(id);
  assert.equal(archived.sessionId,null);assert.equal(archived.archivedNativeSessionId,t1.sessionId);assert.equal(archived.restoredSessionPending,true);assert.equal(archived.events.some(row=>row.payload?.text==='T2_PRIVATE_AFTER_ARCHIVE'),false);
  const queryCount=queries.length;await f.service.continue({taskId:id,text:'Continue only the frozen archive',newSession:false});const continued=await f.service.wait(id);assert.equal(continued.status,'completed');assert.equal(resumes.length,1,'the archived native thread is never read');assert.notEqual(continued.sessionId,t1.sessionId);assert.equal(continued.restoredSessionPending,false);assert.equal(continued.archivedNativeSessionId,t1.sessionId);assert.equal(queries.length,queryCount+1,'archive and request enter one budget pass');
  const latest=sent.at(-1);assert.deepEqual(latest.inherited,[]);assert.match(latest.text,/^BUDGETED\n/);assert.match(latest.text,/T1_FROZEN_RESULT/);assert.match(latest.text,/Continue only the frozen archive/);assert.ok(!latest.text.includes('T2_PRIVATE_AFTER_ARCHIVE'));assert.equal(await readFile(join(f.workspace,'notes.txt'),'utf8'),projectBefore);assert.equal(restored.externalFilesChanged,false);
  await f.service.continue({taskId:id,text:'Continue the independent restored session'});await f.service.wait(id);assert.equal(resumes.at(-1),continued.sessionId,'later turns may resume only the new independent native session');
});

test('restored session preparation cancellation retains the frozen-evidence requirement for retry',async t=>{
  const f=await fixture(t),task=await f.create();await f.service.start({taskId:task.id});await f.service.wait(task.id);await f.store.append(task.id,{type:'text',payload:{text:'FROZEN_BEFORE_NEW_SESSION'}});const evidence=f.service.snapshotLife(scope);f.state.scope.operationId='restore-cancel';const restored=await f.service.restoreLife({...scope,operationId:'restore-cancel',evidence,transactionId:'restore-cancel'}),id=restored.restoredTaskIds[0];
  let entered,release,sessions=0,turns=0,resumes=0;const ready=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);f.service.contextProvider=async(task,{query}={})=>({developerInstructions:'current',queryText:query});
  f.service.adapterFactory=async()=>{const adapter=new MockAdapter(async function(options){turns++;assert.match(options.text,/FROZEN_BEFORE_NEW_SESSION/);});adapter.startSession=async options=>{const sessionId='new-restored-'+(++sessions);if(sessions===1){entered();await hold;}return {sessionId,model:options.model,provider:options.provider};};adapter.resumeSession=async()=>{resumes++;throw Error('must not resume a session without its archived query');};return adapter;};
  try{await f.service.continue({taskId:id,text:'First restore attempt'});await ready;await f.service.cancel({taskId:id});release();const stopped=await f.service.wait(id);assert.equal(stopped.restoredSessionPending,true);assert.equal(stopped.outcomeUnknown,false);assert.equal(turns,0);await f.service.continue({taskId:id,text:'Retry restore after cancelled preparation'});const completed=await f.service.wait(id);assert.equal(completed.status,'completed');assert.equal(completed.restoredSessionPending,false);assert.equal(turns,1);assert.equal(sessions,2);assert.equal(resumes,0);}finally{release();}
});

test('retry of a restored task retains new-life tool evidence without reading the archived native thread',async t=>{
  const f=await fixture(t),task=await f.create();await f.service.start({taskId:task.id});await f.service.wait(task.id);await f.store.append(task.id,{type:'text',payload:{text:'ARCHIVED_T1'}});const evidence=f.service.snapshotLife(scope);f.state.scope.operationId='restore-tools';const restored=await f.service.restoreLife({...scope,operationId:'restore-tools',evidence,transactionId:'restore-tools'}),id=restored.restoredTaskIds[0];
  let entered,turns=0,resumes=0;const ready=new Promise(resolve=>entered=resolve),queries=[];f.service.contextProvider=async(task,{query}={})=>{queries.push(query);return {developerInstructions:'current',queryText:'BUDGETED\n'+query};};f.service.adapterFactory=async()=>{const adapter=new MockAdapter(async function(options){if(++turns===1){this.event('tool',{state:'completed',item:{type:'commandExecution',command:'fixture-command-with-unknown-side-effect',exitCode:0,stdout:'NEW_LIFE_EFFECT_RECEIPT'}});entered();await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(Error('cancelled'),{code:'ABORT_ERR'})),{once:true}));}else{assert.match(options.text,/ARCHIVED_T1/);assert.match(options.text,/NEW_LIFE_EFFECT_RECEIPT/);assert.match(options.text,/Check the actual effect before continuing/);}});adapter.resumeSession=async()=>{resumes++;throw Error('no native replay');};return adapter;};
  await f.service.continue({taskId:id,text:'Initial restored turn'});await ready;await f.service.cancel({taskId:id});const stopped=await f.service.wait(id);assert.equal(stopped.outcomeUnknown,true);assert.equal(stopped.restoredSessionPending,true);await f.service.continue({taskId:id,text:'Check the actual effect before continuing'});assert.equal((await f.service.wait(id)).status,'completed');assert.equal(resumes,0);assert.equal(queries.length,2);assert.match(queries[1],/NEW_LIFE_EFFECT_RECEIPT/);
});
