import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentHostService,agentConnectionFingerprint,agentRequestPolicy} from '../src/agent-host-service.mjs';
import {workMemoryVisible} from '../src/character-context-bridge.mjs';

const tick=()=>new Promise(resolve=>setTimeout(resolve,2));
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
class Adapter extends EventEmitter{
  constructor(script){super();this.script=script;this.started=0;}
  async startSession(options){this.started++;return {sessionId:'native-current',model:options.model,provider:options.provider};}
  async sendTurn(options){this.options=options;await this.script?.call(this,options);return {status:'completed',turnId:'turn-current'};}
  event(type,payload){this.emit('event',{type,sessionId:'native-current',turnId:'turn-current',itemId:'item-current',payload});}
  respondToRequest(answer){this.answer=answer;this.answerResolve?.(answer);}
  dispose(){this.disposed=true;}
}
async function fixture(t,{script}={}){
  const root=await mkdtemp(join(tmpdir(),'buddy-host-boundaries-')),workspace=join(root,'project');await mkdir(workspace);await writeFile(join(workspace,'notes.txt'),'original');
  const state={lifeId:'life-a',operationId:'operation-a',personaId:'persona-a',profile:{id:'selected-connection',kind:'deepseek',protocol:'chat-completions',baseUrl:'https://api.deepseek.com/v1',model:'deepseek-flash',reasoningEffort:'low',key:'private-selected-key'},usages:[],adapters:[]};
  const game={context:()=>({characterId:'deepseek',personaId:state.personaId}),workScope:async(characterId,personaId=state.personaId)=>({characterId,personaId,lifeId:state.lifeId,operationId:state.operationId}),workConnection:async()=>({...state.profile}),workContext:async task=>({character:{id:task.scope.characterId},persona:{id:task.scope.personaId}}),recordWorkExperience:async()=>{}};
  const host=new AgentHostService({dataRoot:root,getGame:()=>game,onUsage:usage=>state.usages.push(usage),adapterFactory:async()=>{const adapter=new Adapter(script);state.adapters.push(adapter);return adapter;},serviceOptions:{cancelTimeoutMs:15}});await host.init();
  t.after(async()=>{await host.close();await rm(root,{recursive:true,force:true});});
  return {root,workspace,state,game,host,create:()=>host.action('create',{characterId:'deepseek',workspace,instruction:'Check the project'})};
}

test('request usage keeps the executing connection identity after the same profile is edited',async t=>{
  const entered=deferred(),release=deferred();const f=await fixture(t,{script:async function(){entered.resolve();await release.promise;this.event('usage',{billable:true,usage:{inputTokens:12,outputTokens:3}});}}),task=await f.create();
  try{await f.host.action('start',{taskId:task.id});await entered.promise;assert.equal(f.host.turnConnections.size,1);f.state.profile.baseUrl='https://api.moonshot.ai/v1';f.state.profile.model='changed-model';release.resolve();await f.host.service.wait(task.id);
    assert.equal(f.state.usages.length,1);const usage=f.state.usages[0];assert.equal(usage.connectionIdentity.servicePlatform,'deepseek');assert.equal(usage.connectionIdentity.address,'https://api.deepseek.com');assert.equal(usage.connection.model,'deepseek-flash');assert.equal(f.host.turnConnections.size,0);assert.ok(!JSON.stringify(usage).includes('private-selected-key'));
  }finally{release.resolve();}
});

test('a normalized connection fingerprint is stable across key rotation but changes for execution choices',()=>{
  const source={kind:'deepseek',protocol:'responses',baseUrl:'https://API.DeepSeek.com:443/v1/',model:'deepseek-v4',reasoningEffort:'high',key:'first-key'},hash=agentConnectionFingerprint(source);
  assert.equal(hash,agentConnectionFingerprint({...source,baseUrl:'https://api.deepseek.com/v1',key:'another-key'}));assert.match(hash,/^[a-f0-9]{64}$/);
  for(const patch of [{kind:'kimi'},{protocol:'chat-completions'},{baseUrl:'https://proxy.test/v1'},{model:'other-model'},{reasoningEffort:'low'}])assert.notEqual(hash,agentConnectionFingerprint({...source,...patch}));
  assert.throws(()=>agentConnectionFingerprint({...source,baseUrl:'https://api.deepseek.com/v1?key=secret'}),/密钥|查询/);
});

test('same connection id and model with a different endpoint cannot start an existing task',async t=>{
  const f=await fixture(t),task=await f.create();assert.match(task.binding.connectionFingerprint,/^[a-f0-9]{64}$/);f.state.profile.baseUrl='https://proxy.test/v1';await f.host.action('start',{taskId:task.id});const result=await f.host.service.wait(task.id);
  assert.equal(result.status,'paused-recoverable');assert.equal(result.errorCode,'AGENT_BINDING_CHANGED');assert.equal(f.state.adapters.length,0);assert.equal(result.binding.connectionFingerprint,task.binding.connectionFingerprint);
});

test('legacy tasks without endpoint provenance pause without rewriting their binding or starting an engine',async t=>{
  const f=await fixture(t),task=await f.create(),{connectionFingerprint,...legacyBinding}=task.binding;const legacy=await f.host.store.create({...task,id:task.id+'-legacy',binding:legacyBinding});
  await f.host.action('start',{taskId:legacy.id});const result=await f.host.service.wait(legacy.id);assert.equal(result.status,'paused-recoverable');assert.equal(result.errorCode,'AGENT_BINDING_UNVERIFIED');assert.match(result.error,/旧工作记录|原始连接/);assert.equal(result.binding.connectionFingerprint,undefined);assert.equal(f.state.adapters.length,0);
  assert.equal(JSON.stringify(await readFile(f.host.store.path(legacy.id),'utf8')).includes('private-selected-key'),false);
});

test('a task awaiting context is busy for life transactions and pause waits for the real worker',async t=>{
  const entered=deferred(),release=deferred();const f=await fixture(t),task=await f.create(),original=f.game.workContext;f.game.workContext=async value=>{entered.resolve();await release.promise;return original(value);};
  let paused=false;try{await f.host.action('start',{taskId:task.id});await entered.promise;assert.equal(f.host.store.read(task.id).status,'queued');assert.throws(()=>f.host.lifeBridge.assertIdle('deepseek'),{code:'AGENT_LIFE_BUSY'});assert.throws(()=>f.host.lifeBridge.snapshot(task.scope),{code:'AGENT_LIFE_BUSY'});
    const pause=f.host.lifeBridge.pauseCharacter('deepseek').then(()=>paused=true);await tick();assert.equal(paused,false);release.resolve();await pause;assert.equal(f.state.adapters.length,0);assert.equal(f.host.busy(),false);assert.doesNotThrow(()=>f.host.lifeBridge.assertIdle('deepseek'));
  }finally{release.resolve();}
});

test('a report crossing the two stores blocks life snapshot until its presentation commit finishes',async t=>{
  const f=await fixture(t),task=await f.create();await f.host.action('start',{taskId:task.id});const done=await f.host.service.wait(task.id),entered=deferred(),release=deferred();f.game.recordWorkExperience=async()=>{entered.resolve();await release.promise;};
  try{const presentation=f.host.action('present',{taskId:task.id,requestId:done.completedRequestId});await entered.promise;assert.throws(()=>f.host.lifeBridge.assertIdle('deepseek'),{code:'AGENT_LIFE_BUSY'});assert.throws(()=>f.host.lifeBridge.snapshot(task.scope),{code:'AGENT_LIFE_BUSY'});release.resolve();await presentation;assert.doesNotThrow(()=>f.host.lifeBridge.assertIdle('deepseek'));
  }finally{release.resolve();}
});

test('work memory requires an explicit source kind, presentation and authorized project identity',()=>{
  const task={id:'task-current',scope:{characterId:'deepseek',personaId:'persona-a',lifeId:'life-a'},workspace:{id:'workspace-current'}},base={characterId:'deepseek',personaId:'persona-a',lifeId:'life-a',presented:true,kind:'work',visibility:'project',workspaceId:'workspace-current'};
  assert.equal(workMemoryVisible(base,task),true);assert.equal(workMemoryVisible({...base,taskId:'other-task-in-same-project'},task),true);
  for(const patch of [{kind:undefined},{kind:'conversation'},{kind:'group'},{visibility:undefined},{presented:undefined},{presented:false},{replay:true},{workspaceId:undefined},{workspaceId:'outside'},{personaId:'persona-b'},{lifeId:'old-life'}])assert.equal(workMemoryVisible({...base,...patch},task),false,JSON.stringify(patch));
  assert.equal(workMemoryVisible({characterId:'deepseek',lifeId:'life-a',kind:'personal',visibility:'character',presented:true},task),true);
  assert.equal(workMemoryVisible({...base,kind:'personal',visibility:'character'},task),false);
});

test('a budgeted work query reaches the engine while original instructions remain in the journal',async t=>{
  const f=await fixture(t),queries=[];f.game.workContext=async(task,options)=>{if(options?.query!==undefined)queries.push(options.query);return {character:{id:task.scope.characterId},queryText:options?.query!==undefined?'budgeted:'+queries.length:undefined,capacity:{tokens:4096,source:'test'}};};
  const task=await f.create();await f.host.action('start',{taskId:task.id});await f.host.service.wait(task.id);assert.deepEqual(queries,[task.instruction]);assert.equal(f.state.adapters[0].options.text,'budgeted:1');
  const next='Continue with a complete original instruction';await f.host.action('continue',{taskId:task.id,text:next,newSession:true});await f.host.service.wait(task.id);
  assert.match(queries[1],/旧会话原文证据/);assert.ok(queries[1].includes(task.instruction));assert.ok(queries[1].endsWith(next));assert.equal(f.state.adapters[1].options.text,'budgeted:2');
  const saved=f.host.store.read(task.id);assert.ok(saved.events.some(row=>row.type==='user'&&row.payload.text===task.instruction));assert.ok(saved.events.some(row=>row.type==='user'&&row.payload.text===next));
});

test('prebuilt developer contexts also send only their budgeted query',async t=>{
  const f=await fixture(t);f.game.workContext=async()=>({developerInstructions:'Prebuilt current character context',queryText:'compressed prebuilt request',hash:'test-context'});const task=await f.create();await f.host.action('start',{taskId:task.id});await f.host.service.wait(task.id);assert.equal(f.state.adapters[0].options.text,'compressed prebuilt request');
});

test('native permission paths reject parent traversal, outside roots, junctions and malformed JSON types',async t=>{
  const f=await fixture(t),task=await f.create(),outside=join(f.root,'outside');await mkdir(outside);await writeFile(join(outside,'keep.txt'),'keep');await symlink(outside,join(f.workspace,'external-link'),process.platform==='win32'?'junction':'dir');
  const command={requestId:1,method:'item/commandExecution/requestApproval',cwd:f.workspace};assert.equal(await agentRequestPolicy({task,request:command}),null);
  for(const patch of [{cwd:outside},{cwd:join(f.workspace,'..','outside')},{cwd:join(f.workspace,'external-link')},{cwd:42},{additionalPermissions:{fileSystem:{write:[outside]}}},{additionalPermissions:{fileSystem:{read:{path:f.workspace}}}},{additionalPermissions:{fileSystem:{entries:[{access:'write',path:{type:'path'}}]}}},{additionalPermissions:{fileSystem:{entries:[{access:'write',path:{type:'glob_pattern',pattern:'**'}}]}}}]){
    const denied=await agentRequestPolicy({task,request:{...command,...patch}});assert.equal(denied.denied,true,JSON.stringify(patch));assert.deepEqual(denied.result,{decision:'decline'});
  }
  assert.equal((await agentRequestPolicy({task,request:{requestId:2,method:'item/fileChange/requestApproval',grantRoot:outside}})).denied,true);
  assert.equal(await agentRequestPolicy({task,request:{...command,additionalPermissions:{fileSystem:{write:[join(f.workspace,'missing','new.txt')]}}}}),null);
});

test('ACP permission correlates preflight tool JSON and cannot approve a file outside the workspace',async t=>{
  const f=await fixture(t),task=await f.create(),request={requestId:2,method:'session/request_permission',params:{toolCall:{toolCallId:'call-1',title:'Write'},options:[{optionId:'once',kind:'allow_once'},{optionId:'always',kind:'allow_always'}]}};
  const tools=path=>[{type:'tool',itemId:'call-1',payload:{update:{content:[{type:'content',content:{type:'text',text:JSON.stringify({path,content:'fixture'})}}]}}}];
  assert.equal(await agentRequestPolicy({task,request,tools:tools(join(f.workspace,'new.txt'))}),null);
  assert.equal((await agentRequestPolicy({task,request,tools:tools(join(f.root,'outside.txt'))})).denied,true);
  assert.equal((await agentRequestPolicy({task,request,tools:[{type:'tool',itemId:'call-1',payload:{update:{rawInput:'not-json-object'}}}]})).denied,true);
  assert.equal((await agentRequestPolicy({task,request,tools:tools(join(f.workspace,'new.txt')),result:{outcome:{outcome:'selected',optionId:'always'}}})).denied,true);
  assert.equal(await agentRequestPolicy({task,request,tools:tools(join(f.workspace,'new.txt')),result:{outcome:{outcome:'selected',optionId:'once'}}}),null);
});

test('a native permission request outside the workspace is declined and journalled without a UI approval path',async t=>{
  const f=await fixture(t,{script:async function(){const response=new Promise(resolve=>this.answerResolve=resolve);this.event('request',{requestId:4,method:'item/commandExecution/requestApproval',cwd:join(this.options.workspace??f.workspace,'..')});await response;assert.deepEqual(this.answer.result,{decision:'decline'});}}),task=await f.create();
  await f.host.action('start',{taskId:task.id});const result=await f.host.service.wait(task.id);assert.deepEqual(result.pendingRequests,[]);assert.ok(result.events.some(row=>row.type==='status'&&row.payload.status==='permission-denied'));await assert.rejects(f.host.action('respond',{taskId:task.id,requestId:4,result:{decision:'accept'}}),{code:'AGENT_REQUEST_EXPIRED'});
});

test('UI responses cannot enlarge a once-only native approval into a session rule',async t=>{
  const entered=deferred(),f=await fixture(t,{script:async function(){const response=new Promise(resolve=>this.answerResolve=resolve);this.event('request',{requestId:5,method:'item/commandExecution/requestApproval',cwd:f.workspace});entered.resolve();await response;}}),task=await f.create();
  await f.host.action('start',{taskId:task.id});await entered.promise;while(f.host.store.read(task.id).status!=='waiting-for-user')await tick();await f.host.action('respond',{taskId:task.id,requestId:5,result:{decision:'acceptForSession'}});const result=await f.host.service.wait(task.id);assert.deepEqual(f.state.adapters[0].answer.result,{decision:'decline'});assert.ok(result.events.some(row=>row.payload?.status==='permission-denied'));
});
