import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeCard,effectiveCard} from '../src/companion-store.mjs';
import {enableGrowth,applyGrowthCandidates} from '../src/companion-growth.mjs';
import {ensureLives} from '../src/companion-life.mjs';
import {createCompanionMemory,collectMemoryEvents,appendWorkExperience,workExperienceHash,workMemoryScope} from '../src/companion-memory.mjs';
import {createCompanionLives} from '../src/companion-life-service.mjs';
import {createLifeArchiveRepository,workEvidenceHash} from '../src/companion-life-archive.mjs';
import {AgentTaskStore} from '../src/agent-task-store.mjs';
import {AgentTaskService,canonicalAgentWorkspace} from '../src/agent-task-service.mjs';

const copy=value=>structuredClone(value),now=Date.parse('2026-10-23T08:00:00Z'),at=Date.parse('2026-10-22T12:00:00Z');
function stateOf(){const state={schema:1,cards:{a:makeCard({id:'a',name:'A'}),b:makeCard({id:'b',name:'B'})},personas:{p:{id:'p',name:'P',relationships:{}},q:{id:'q',name:'Q',relationships:{}}},relationships:{a:{mode:'independent',byPersona:{p:{level:3,affection:8},q:{level:2,affection:5}}},b:{mode:'independent',byPersona:{p:{level:9,affection:8}}}},conversations:{a0:{id:'a0',characterId:'a',personaId:'p',createdAt:at,messages:[]}},groups:{g:{id:'g',name:'group',personaId:'p',seq:0,memberIds:['a','b'],messages:[],intervals:{a:[{start:1,end:null}],b:[{start:1,end:null}]}}},activeCharacterId:'a',activePersonaId:'p',activeConversationId:'a0',lifeArchives:{},draftCards:{},accountLedger:{tokens:1234}};ensureLives(state,at);state.memorySettings.timeZone='UTC';return state;}
function memoryStore(initial=stateOf()){let state=copy(initial),tail=Promise.resolve();return {get state(){return state;},snapshot:()=>copy(state),mutate(fn){const task=tail.then(async()=>{const next=copy(state),result=await fn(next);state=next;return result;});tail=task.catch(()=>{});return task;}};}
function source(store,{id='work-report',personaId='p',workspaceId='workspace-one',text='该项目的私有工作成果',...rest}={}){const life=store.state.lives.a;return {id,kind:'work',taskId:'task-sealed',workspaceId,characterId:'a',personaId,lifeId:life.id,operationId:life.operationId,presented:true,createdAt:at,text,sourceVersion:4,...rest};}
function makeMemory(store,calls=[]){return createCompanionMemory({store,now:()=>now,autoStart:false,getCapacity:()=>({tokens:272000,reasoning:false,reasoningVerified:true}),runModel:async(_id,request)=>{const body=JSON.parse(request.messages[0].text);calls.push(body);return JSON.stringify({coverageHash:body.coverageHash,summary:{text:'已核对项目成果',eventIds:body.todayEventIds??body.events?.map(row=>row.id)??[]},guide:{text:'项目工作来源',eventIds:body.todayEventIds??body.events?.map(row=>row.id)??[]},core:[],branches:[],growthCandidates:[]});}});}

test('presented work reports require exact scope and dedupe by immutable source hash',async()=>{
 const store=memoryStore(),row=source(store);assert.equal((await appendWorkExperience(store,row)).duplicate,false);assert.equal((await appendWorkExperience(store,row)).duplicate,true);assert.equal(store.state.lives.a.workExperiences.length,1);assert.equal(store.state.lives.a.workExperiences[0].sourceHash,workExperienceHash(row));await assert.rejects(appendWorkExperience(store,{...row,text:'changed'}),/来源发生变化/);await assert.rejects(appendWorkExperience(store,{...row,id:'unseen',presented:false}),/尚未呈现/);await assert.rejects(appendWorkExperience(store,{...row,id:'late',operationId:'old-operation'}),error=>error.code==='MEMORY_STALE_LIFE');
});

test('work memory is absent from ordinary private/group contexts and visible only to matching Persona and explicitly authorized project',async()=>{
 const store=memoryStore();await appendWorkExperience(store,source(store));await appendWorkExperience(store,source(store,{id:'q-report',personaId:'q',text:'Q身份项目秘密'}));const memory=makeMemory(store);
 try{
  for(const options of [{personaId:'p'},{personaId:'q',workspaceId:'workspace-one',authorizedWorkspaceIds:[]},{personaId:'p',workspaceId:'other-project',authorizedWorkspaceIds:['other-project']},{personaId:'p',groupId:'g',workspaceId:'workspace-one',authorizedWorkspaceIds:['workspace-one']}]){const context=await memory.context({characterId:'a',query:'成果',...options});assert.ok(!JSON.stringify(context).includes('该项目的私有工作成果'));}
  const context=await memory.context({characterId:'a',personaId:'p',workspaceId:'workspace-one',authorizedWorkspaceIds:['workspace-one'],query:'成果'});assert.ok(JSON.stringify(context).includes('该项目的私有工作成果'));assert.ok(!JSON.stringify(context).includes('Q身份项目秘密'));assert.equal(context.messages[0].source.type,'work');assert.match(context.messages[0].source.sha256,/^[a-f0-9]{64}$/);
  assert.equal((await memory.view({characterId:'a',personaId:'p'})).events.length,0);assert.equal((await memory.view({characterId:'a',personaId:'p',workspaceId:'workspace-one',authorizedWorkspaceIds:['workspace-one']})).events.length,1);
 }finally{await memory.close();}
});

test('daily work Summary/Guide has separate project/Persona scope, source hashes and exactly one logical daily commit',async()=>{
 const store=memoryStore(),calls=[];await appendWorkExperience(store,source(store));const memory=makeMemory(store,calls);try{const first=await memory.tick();assert.equal(first.results.length,1);assert.equal(first.results[0].status,'committed',first.results[0].error);const workScope=workMemoryScope('p','workspace-one'),summary=store.state.lives.a.memory.summaries[workScope+'|2026-10-22'];assert.ok(summary);assert.match(summary.cutoff[0].sourceHash,/^[a-f0-9]{64}$/);assert.equal(summary.cutoff[0].taskId,'task-sealed');assert.equal(summary.cutoff[0].workspaceId,'workspace-one');assert.equal(calls.length,1);await memory.tick();assert.equal(calls.length,1);assert.equal(store.state.lives.a.workExperiences[0].text,'该项目的私有工作成果');assert.ok(!JSON.stringify(await memory.context({characterId:'a',personaId:'p',groupId:'g'})).includes('项目工作来源'));}finally{await memory.close();}
});

test('edited or old-life work sources cannot re-enter current retrieval through a stale derived index',async()=>{
 const store=memoryStore();await appendWorkExperience(store,source(store));const memory=makeMemory(store);try{await memory.sync('a');assert.equal(collectMemoryEvents(store.state,'a').length,1);await store.mutate(state=>{state.lives.a.workExperiences[0].text='tampered';});assert.equal(collectMemoryEvents(store.state,'a').length,0);assert.equal((await memory.view({characterId:'a',personaId:'p',workspaceId:'workspace-one',authorizedWorkspaceIds:['workspace-one']})).events.length,0);await store.mutate(state=>{state.lives.a.id='new-life';});assert.equal(collectMemoryEvents(store.state,'a').length,0);}finally{await memory.close();}
});

test('only opted-in growth can use multiple shown work experiences across days without sharing project details or relations',async()=>{
 const store=memoryStore();await store.mutate(state=>{state.cards.a.fields.interests={mode:'custom',value:'尚未形成稳定偏好'};enableGrowth(state,'a','seed',at);});
 for(const [index,date]of ['2026-10-20T12:00:00Z','2026-10-21T12:00:00Z','2026-10-21T13:00:00Z'].entries())await appendWorkExperience(store,source(store,{id:'work-'+index,taskId:'task-'+index,createdAt:Date.parse(date),text:'完成真实项目中的一次独立工作与检查 '+index}));
 const memory=makeMemory(store);try{await memory.sync('a');const state=store.snapshot(),life=state.lives.a,events=Object.values(life.memory.events),eventIds=events.map(event=>event.id),scope=workMemoryScope('p','workspace-one'),relations=copy(state.relationships);
  assert.ok(events.every(event=>event.sourceKind==='personal-activity'&&event.scope===scope&&event.source.type==='work'));
  const candidate={field:'interests',before:effectiveCard(state.cards.a).interests,after:'开始对验证推理表现出持续兴趣',sourceEventIds:eventIds,counterEvidenceIds:[],scope:'general',reason:'多次完成独立工作后形成小幅偏好',context:'项目检查',expectedCardVersion:state.cards.a.revision,lifeId:life.id,operationId:life.operationId,kind:'small-behavior',privacy:'general-behavior'};
  const batch={id:'work-growth-day',day:'2026-10-22',lifeId:life.id,operationId:life.operationId,scope,eventIds};const result=applyGrowthCandidates(state,'a',[candidate],batch,now);assert.equal(result.applied.length,1,JSON.stringify(result));assert.deepEqual(state.relationships,relations);assert.equal(state.lives.a.growth.history[0].activeDays,2);
  const normal=copy(state);normal.lives.a.mode='normal';const normalResult=applyGrowthCandidates(normal,'a',[candidate],{...batch,id:'normal-stays-normal'},now);assert.equal(normalResult.applied.length,0);assert.equal(normal.lives.a.mode,'normal');
  assert.ok(!JSON.stringify(await memory.context({characterId:'a',personaId:'q',query:'工作'})).includes('真实项目'));assert.ok(!JSON.stringify(await memory.context({characterId:'a',personaId:'p',groupId:'g',query:'工作'})).includes('真实项目'));
 }finally{await memory.close();}
});

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'buddy-work-life-'));t.after(()=>rm(root,{recursive:true,force:true}));const project=join(root,'external-project');await mkdir(project);const file=join(project,'valuable.txt');await writeFile(file,'current user project, never roll back');const store=memoryStore(),taskStore=await new AgentTaskStore({root:join(root,'work-records')}).init(),workspace=await canonicalAgentWorkspace(project),life=store.state.lives.a;
 const tasks=new AgentTaskService({store:taskStore,connectionResolver:()=>({connectionId:'test',provider:'test',model:'test',harness:'mock'}),scopeResolver:task=>({characterId:task.scope.characterId,...{lifeId:store.state.lives[task.scope.characterId].id,operationId:store.state.lives[task.scope.characterId].operationId}}),contextProvider:()=>({}),adapterFactory:()=>{throw Error('archive must never start engine');}});await tasks.init();t.after(()=>tasks.dispose());
 const task=await taskStore.create({id:'task-evidence',scope:{characterId:'a',personaId:'p',lifeId:life.id,operationId:life.operationId},workspace,binding:{connectionId:'test',provider:'test',model:'test',harness:'mock',effort:null},title:'sealed work',instruction:'do work',writing:true,status:'completed',pendingRequests:[]});await taskStore.append(task.id,{type:'tool',requestId:'req',payload:{item:{type:'commandExecution',command:'node --test',exitCode:0}}});await taskStore.append(task.id,{type:'text',requestId:'req',payload:{text:'原始工作报告'}});await taskStore.patch(task.id,{status:'completed',sessionId:'native-sealed',turnCount:1,completedRequestId:'req'});await appendWorkExperience(store,source(store,{taskId:task.id,workspaceId:workspace.id,text:'原始工作报告'}));
 const workBridge={assertIdle:id=>tasks.assertCharacterIdle(id),snapshot:args=>tasks.snapshotLife(args),restore:args=>tasks.restoreLife(args)},options={store,dataRoot:root,imageCodec:()=>false,call:async(action,args)=>action==='companion-life-content'?{ok:true,content:{}}:{ok:true},syncCard:async()=>{},projectPersona:async()=>{},enableGrowth:()=>{},now:()=>now,workBridge};const lives=await createCompanionLives(options);return {root,project,file,store,taskStore,tasks,task,lives,options};
}

test('v2 life archives preserve complete task text/tool evidence and source hash while v1 remains readable',async t=>{
 const f=await fixture(t),archive=await f.lives.save('a'),snapshot=f.lives.preview(archive.id);assert.equal(snapshot.version,2);assert.deepEqual(snapshot.requiredCapabilities,['work-task-evidence-v1']);assert.equal(snapshot.workEvidence.sha256,workEvidenceHash(snapshot.workEvidence));assert.ok(JSON.stringify(snapshot.workEvidence.tasks[0].events).includes('node --test'));assert.ok(JSON.stringify(snapshot.workEvidence.tasks[0].events).includes('原始工作报告'));assert.equal(snapshot.life.workExperiences[0].sourceHash,workExperienceHash(snapshot.life.workExperiences[0]));
 const repo=createLifeArchiveRepository({dataRoot:f.root,imageCodec:()=>false,worker:false});const old={...snapshot,version:1,life:{...snapshot.life,workExperiences:[]}};delete old.workEvidence;delete old.requiredCapabilities;assert.equal(repo.decode(repo.prepare(old)).snapshot.version,1);const invalid={...snapshot,workEvidence:{...snapshot.workEvidence,sha256:'0'.repeat(64)}};assert.throws(()=>repo.prepare(invalid),/哈希/);
});

test('reset archives work, restores tasks only as independent paused records and leaves external project and other character unchanged',async t=>{
 const f=await fixture(t),other=copy(f.store.state.lives.b),ledger=copy(f.store.state.accountLedger),lifeId=f.store.state.lives.a.id,saved=await f.lives.save('a');await f.lives.reset('a');assert.notEqual(f.store.state.lives.a.id,lifeId);assert.equal(f.store.state.lives.a.workExperiences,undefined);await writeFile(f.file,'new external change after reset');await f.lives.restore(saved.id);assert.equal(f.store.state.lives.a.id,lifeId);assert.equal(f.store.state.lives.a.workExperiences[0].text,'原始工作报告');assert.equal(await readFile(f.file,'utf8'),'new external change after reset');assert.deepEqual(f.store.state.lives.b,other);assert.deepEqual(f.store.state.accountLedger,ledger);const restored=f.tasks.list({characterId:'a',lifeId,operationId:f.store.state.lives.a.operationId});assert.equal(restored.length,1);assert.equal(restored[0].status,'paused-recoverable');assert.notEqual(restored[0].id,f.task.id);assert.equal(restored[0].sessionId,null);assert.equal(restored[0].archivedNativeSessionId,'native-sealed');assert.equal(restored[0].restoredSessionPending,true);assert.ok(JSON.stringify(f.tasks.read(restored[0].id).events).includes('原始工作报告'));
});

test('life restore evidence import is idempotent across replay and cannot trigger backend or overwrite project files',async t=>{
 const f=await fixture(t),evidence=f.tasks.snapshotLife({characterId:'a',lifeId:f.store.state.lives.a.id,operationId:f.store.state.lives.a.operationId}),args={characterId:'a',lifeId:f.store.state.lives.a.id,operationId:'rotated-op',transactionId:'replay-id',evidence};const first=await f.tasks.restoreLife(args),second=await f.tasks.restoreLife(args);assert.deepEqual(first.restoredTaskIds,second.restoredTaskIds);assert.equal(f.tasks.list({operationId:'rotated-op'}).length,1);assert.equal(f.tasks.read(first.restoredTaskIds[0]).events.length,2);assert.equal(await readFile(f.file,'utf8'),'current user project, never roll back');
});

test('active work blocks life save/reset until paused; missing work bridge cannot create incomplete archives',async t=>{
 const f=await fixture(t);await f.taskStore.patch(f.task.id,{status:'running'});await assert.rejects(f.lives.save('a'),/暂停/);await assert.rejects(f.lives.reset('a'),/暂停/);await f.taskStore.patch(f.task.id,{status:'paused-recoverable'});assert.ok((await f.lives.save('a')).sha256);const legacy=await createCompanionLives({...f.options,workBridge:null});await assert.rejects(legacy.save('a'),/完整任务证据/);const exported=f.lives.export((await f.lives.save('a')).id);await assert.rejects(legacy.import(exported.base64),/工作证据/);
});

test('explicit work context excludes the same Persona private transcript as well as group messages',async()=>{
 const store=memoryStore();await store.mutate(state=>state.conversations.a0.messages.push({id:'private-sensitive',role:'user',text:'仅在私聊的秘密，不自动进入工作任务',createdAt:at,status:'sent'}));await appendWorkExperience(store,source(store));const memory=makeMemory(store);
 try{const privateView=await memory.context({characterId:'a',personaId:'p',query:'秘密'});assert.match(JSON.stringify(privateView),/仅在私聊的秘密/);const work=await memory.context({characterId:'a',personaId:'p',workspaceId:'workspace-one',authorizedWorkspaceIds:['workspace-one'],query:'成果'});assert.doesNotMatch(JSON.stringify(work),/仅在私聊的秘密/);assert.match(JSON.stringify(work),/该项目的私有工作成果/);}finally{await memory.close();}
});
