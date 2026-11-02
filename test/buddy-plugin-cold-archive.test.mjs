import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,stat,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AgentTaskStore} from '../src/agent-task-store.mjs';
import {openCompanionStore,makeCard} from '../src/companion-store.mjs';
import {ensureLives} from '../src/companion-life.mjs';
import {appendWorkExperience} from '../src/companion-memory.mjs';
import {createCompanionLives} from '../src/companion-life-service.mjs';
import {workEvidenceHash} from '../src/companion-life-archive.mjs';
import {createColdWorkArchiveBridge} from '../src/buddy-plugin-services/index.mjs';

const executionRoot=resolve(process.env.AI_BUDDY_PLUGIN_TEST_ROOT??resolve(import.meta.dirname,'../local/test-fixtures'));
async function fixture(t){
  await mkdir(join(executionRoot,'test-data'),{recursive:true});const root=await mkdtemp(join(executionRoot,'test-data','buddy-bridge-archive-')),legacyRoot=join(root,'legacy-tasks'),pendingRoot=join(root,'pending-life-restores'),project=join(root,'external-project');await mkdir(project);await writeFile(join(project,'valuable.txt'),'current user data');
  const tasks=await new AgentTaskStore({root:legacyRoot}).init(),scope={characterId:'a',personaId:'p',lifeId:'life-a',operationId:'operation-a'},workspace={id:'workspace-one',path:project};
  await tasks.create({id:'task-existing',scope,workspace,binding:{connectionId:'old',provider:'deepseek',model:'old-model',harness:'codex'},title:'old task',instruction:'historical command',status:'running'});await tasks.append('task-existing',{type:'tool',requestId:'request-old',payload:{command:'do not replay'}});await tasks.patch('task-existing',{sessionId:'native-old',turnCount:1});await tasks.flush();
  const bridge=createColdWorkArchiveBridge({legacyRoot,pendingRoot});return {root,legacyRoot,pendingRoot,project,tasks,scope,workspace,bridge};
}

test('cold bridge construction and missing-data snapshot create no directories, runtime, recovery queue or journal patch',async t=>{
  const base=join(executionRoot,'test-data');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'buddy-bridge-empty-')),bridge=createColdWorkArchiveBridge({legacyRoot:join(root,'absent-old'),pendingRoot:join(root,'absent-pending')});
  assert.equal(await bridge.snapshot({characterId:'a',lifeId:'la'}),null);assert.deepEqual(await readdir(root),[]);assert.deepEqual(await bridge.pending(),[]);assert.deepEqual(await readdir(root),[]);
});

test('legacy hash-chain records remain byte-identical; cold restore only stores paused evidence and is idempotent after reopening',async t=>{
  const f=await fixture(t),path=join(f.legacyRoot,'task-existing','events.jsonl'),before=await readFile(path),snapshot=await f.bridge.snapshot(f.scope);assert.equal(snapshot.sha256,workEvidenceHash(snapshot));assert.equal(snapshot.tasks[0].status,'running');assert.equal(snapshot.tasks[0].sessionId,'native-old');assert.deepEqual(await readFile(path),before);
  const spec={...f.scope,operationId:'new-operation',transactionId:'life-switch-1',evidence:snapshot},first=await f.bridge.restore(spec),second=await f.bridge.restore(spec);assert.deepEqual(first,second);assert.equal(first.executionAllowed,false);assert.equal(first.externalFilesChanged,false);assert.equal((await readdir(f.pendingRoot)).length,1);
  const reopened=createColdWorkArchiveBridge({legacyRoot:f.legacyRoot,pendingRoot:f.pendingRoot}),third=await reopened.restore(spec);assert.deepEqual(first,third);const pending=await reopened.pending();assert.equal(pending[0].executionAllowed,false);assert.equal(pending[0].tasks[0].status,'paused-recoverable');assert.equal(pending[0].tasks[0].sessionId,null);assert.equal(pending[0].tasks[0].archivedNativeSessionId,'native-old');assert.equal(pending[0].tasks[0].outcomeUnknown,true);
  const current=await reopened.snapshot({...f.scope,operationId:'new-operation'});assert.deepEqual(current.tasks.map(t=>t.id),first.restoredTaskIds);assert.deepEqual(await readFile(path),before);assert.equal(await readFile(join(f.project,'valuable.txt'),'utf8'),'current user data');
  const changed=structuredClone(snapshot);changed.tasks[0].instruction='changed';changed.sha256=workEvidenceHash(changed);await assert.rejects(reopened.restore({...spec,evidence:changed}),{code:'BUDDY_ARCHIVE_CONFLICT'});
});

test('damaged journals or linked task paths fail without silently dropping history or writing the source',async t=>{
  const f=await fixture(t),path=join(f.legacyRoot,'task-existing','events.jsonl');await writeFile(path,(await readFile(path,'utf8'))+'{"partial":');const before=await readFile(path);await assert.rejects(f.bridge.snapshot(f.scope),{code:'BUDDY_ARCHIVE_CORRUPT'});assert.deepEqual(await readFile(path),before);
  const outside=join(f.root,'outside'),linked=join(f.root,'linked-old');await mkdir(outside);try{await symlink(outside,linked,'junction');}catch(error){if(['EPERM','ENOTSUP','EACCES'].includes(error.code))return;throw error;}
  const bridge=createColdWorkArchiveBridge({legacyRoot:linked,pendingRoot:f.pendingRoot});await assert.rejects(bridge.snapshot(f.scope),{code:'BUDDY_ARCHIVE_PATH_DENIED'});assert.deepEqual(await readdir(outside),[]);
});

test('actual companion v2 life archive saves and restores work evidence while execution plugin is absent',async t=>{
  const f=await fixture(t),store=await openCompanionStore(f.root);await store.mutate(state=>{state.cards={a:makeCard({id:'a',name:'A'}),b:makeCard({id:'b',name:'B'})};state.personas={p:{id:'p',name:'P',relationships:{}}};state.activeCharacterId='a';state.activePersonaId='p';state.conversations={};state.groups={};state.relationships={};ensureLives(state,Date.now());state.lives.a.id=f.scope.lifeId;state.lives.a.operationId=f.scope.operationId;state.accountLedger={tokens:77};});
  await appendWorkExperience(store,{id:'old-report',kind:'work',taskId:'task-existing',workspaceId:f.workspace.id,...f.scope,presented:true,createdAt:Date.now(),text:'historical completed report',sourceVersion:1});
  const before=store.snapshot(),raw=await readFile(join(f.legacyRoot,'task-existing','events.jsonl'));
  const lives=await createCompanionLives({store,dataRoot:f.root,workBridge:f.bridge,imageCodec:()=>false,call:async action=>action==='companion-life-content'?{ok:true,content:{}}:{ok:true},syncCard:async()=>{},projectPersona:async()=>{},enableGrowth:()=>{}});
  const saved=await lives.save('a'),preview=lives.preview(saved.id);assert.equal(preview.version,2);assert.equal(preview.workEvidence.tasks[0].id,'task-existing');await lives.restore(saved.id);
  assert.equal((await f.bridge.pending()).length,1);assert.equal((await f.bridge.pending())[0].tasks[0].status,'paused-recoverable');assert.deepEqual(await readFile(join(f.legacyRoot,'task-existing','events.jsonl')),raw);assert.deepEqual(store.state.accountLedger,before.accountLedger);assert.deepEqual(store.state.lives.b,before.lives.b);assert.equal(await readFile(join(f.project,'valuable.txt'),'utf8'),'current user data');await store.flush();
});
