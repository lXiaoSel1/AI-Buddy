import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {CodexProvider} from '../src/codex-provider.mjs';

function peer(handle=()=>undefined){
 const child=new EventEmitter(),requests=[];let thread=0;
 Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){this.killed=true;}});
 const notify=(method,params)=>child.stdout.write(JSON.stringify({method,params})+'\n');
 child.stdin.on('data',bytes=>{for(const line of String(bytes).trim().split('\n')){
  const message=JSON.parse(line);requests.push(message);if(message.id==null)continue;
  queueMicrotask(()=>{
   if(child.killed)return;
   const result=handle(message,{notify,child,requests});
   if(result?.error){child.stdout.write(JSON.stringify({id:message.id,error:result.error})+'\n');return;}
   const value=result===undefined?(message.method==='account/read'?{account:{type:'chatgpt'},requiresOpenaiAuth:true}:message.method==='thread/start'?{thread:{id:'thread-'+(++thread)}}:{}):result;
   child.stdout.write(JSON.stringify({id:message.id,result:value})+'\n');
  });
 }});
 queueMicrotask(()=>child.emit('spawn'));
 return {child,requests,notify};
}
function provider(spawnImpl){const root=mkdtempSync(join(tmpdir(),'buddy-models-'));return new CodexProvider({binary:'fixture.exe',defaultModel:'fixture',dataRoot:join(root,'data'),env:{USERPROFILE:root,CODEX_HOME:join(root,'home')},spawnImpl});}
const efforts=[{reasoningEffort:'low',description:'Fast'},{reasoningEffort:'high',description:'Detailed'}];
async function output(stream){let text='';for await(const part of stream)if(part.type==='text-delta')text+=part.text;return text;}
const finish=(notify,threadId,text='reply')=>{notify('item/agentMessage/delta',{threadId,delta:text});notify('turn/completed',{threadId,turn:{status:'completed'}});};

test('Disabled model discovery paginates app-server metadata without guessing IDs or starting a turn',async()=>{
 let server;const p=provider(()=>{server=peer(message=>{
  if(message.method!=='model/list')return;
  if(!message.params.cursor)return {data:[{id:'catalog-id',model:'available-small',displayName:'Small',description:'Available to this account',supportedReasoningEfforts:efforts,defaultReasoningEffort:'low',isDefault:true},{id:'hidden',hidden:true}],nextCursor:'page-two'};
  assert.equal(message.params.cursor,'page-two');return {data:[{id:'duplicate',model:'available-small'},{id:'available-other',displayName:'Other',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Balanced'}],defaultReasoningEffort:'medium'},{id:''}],nextCursor:null};
 });return server.child;});
 try{
  assert.deepEqual(p.listModels(),[]);const models=await p.fetchModels();
  assert.deepEqual(models.map(value=>value.id),['available-small','available-other']);
  assert.equal(models[0].model,'available-small');assert.equal(models[0].name,'Small');assert.equal(models[0].description,'Available to this account');assert.equal(models[0].isDefault,true);
  assert.deepEqual(models[0].supportedReasoningEfforts,efforts);assert.equal(models[0].defaultReasoningEffort,'low');
  assert.deepEqual(p.resolveModelInfo('available-other').reasoningEfforts,['medium']);
  models[0].supportedReasoningEfforts[0].reasoningEffort='changed';assert.equal(p.listModels()[0].supportedReasoningEfforts[0].reasoningEffort,'low');
  assert.equal(p.enabled,false);assert.equal(p.child,null);assert.equal(server.child.killed,true);
  assert.equal(server.requests.filter(value=>value.method==='model/list').length,2);assert.ok(server.requests.every(value=>!['thread/start','turn/start'].includes(value.method)));
 }finally{p.close();}
});

test('Catalog refresh errors preserve the last successful metadata and release only the catalog process',async()=>{
 let failed=false,spawned=0;const servers=[],p=provider(()=>{spawned++;const server=peer(message=>message.method==='model/list'?(failed?{error:{code:-32601,message:'Method not found'}}:{data:[{id:'available',supportedReasoningEfforts:efforts}],nextCursor:null}):undefined);servers.push(server);return server.child;});
 try{
  await Promise.all([p.fetchModels(),p.fetchModels()]);assert.equal(spawned,1);failed=true;
  await assert.rejects(p.fetchModels(),/Method not found/);assert.equal(spawned,2);assert.deepEqual(p.listModels().map(value=>value.id),['available']);assert.ok(servers.every(value=>value.child.killed));assert.equal(p.enabled,false);assert.equal(p.catalogRequest,null);
 }finally{p.close();}
});

test('Malformed or repeated catalog pagination fails without publishing a partial list',async()=>{
 for(const response of [{data:'bad',nextCursor:null},{data:[{id:'partial'}],nextCursor:'repeat'}]){
  let server;const p=provider(()=>{server=peer(message=>message.method==='model/list'?response:undefined);return server.child;});
  try{await assert.rejects(p.fetchModels(),/格式无效|分页无效/);assert.deepEqual(p.listModels(),[]);assert.equal(server.child.killed,true);assert.ok(!server.requests.some(value=>value.method==='turn/start'));}finally{p.close();}
 }
});

test('Catalog reads during an active chat use an independent process and never terminate the turn',async()=>{
 let chat,catalog,turnStarted;const started=new Promise(resolve=>turnStarted=resolve);let count=0;
 const p=provider(()=>{
  if(count++===0){chat=peer(message=>{if(message.method==='turn/start')turnStarted(message);});return chat.child;}
  catalog=peer(message=>message.method==='model/list'?{data:[{id:'fixture',supportedReasoningEfforts:efforts,defaultReasoningEffort:'low'}],nextCursor:null}:undefined);return catalog.child;
 });p.setEnabled(true);
 try{
  const work=output(p.stream({reasoningEffort:'high',messages:[{role:'user',content:'hello'}]}));const turn=await started;
  await p.fetchModels();assert.equal(p.child,chat.child);assert.equal(p.enabled,true);assert.ok(!chat.child.killed);assert.equal(catalog.child.killed,true);assert.ok(!catalog.requests.some(value=>value.method==='thread/start'||value.method==='turn/start'));
  finish(chat.notify,turn.params.threadId);assert.equal(await work,'reply');assert.equal(turn.params.effort,'high');
 }finally{p.close();}
});

test('Each new turn honors configured effort; automatic does not inherit a previous explicit effort',async()=>{
 let server;const p=provider(()=>{server=peer((message,{notify})=>{if(message.method==='turn/start')queueMicrotask(()=>finish(notify,message.params.threadId));});return server.child;});p.setEnabled(true);
 try{
  for(const reasoningEffort of [undefined,'high',null,'auto','low'])assert.equal(await output(p.stream({reasoningEffort,messages:[{role:'user',content:'hi'}]})),'reply');
  const turns=server.requests.filter(value=>value.method==='turn/start'),threads=server.requests.filter(value=>value.method==='thread/start');
  assert.deepEqual(turns.map(value=>value.params.effort),['low','high',undefined,undefined,'low']);assert.ok(!Object.hasOwn(turns[2].params,'effort'));assert.ok(!Object.hasOwn(turns[3].params,'effort'));
  assert.equal(new Set(turns.map(value=>value.params.threadId)).size,5);assert.ok(threads.every(value=>value.params.ephemeral));
 }finally{p.close();}
});

test('Unsupported cached effort and invalid effort fail before creating a thread or turn',async()=>{
 let spawned=0;const p=provider(()=>{spawned++;return peer().child;});p.setEnabled(true);p.models=[{id:'fixture',supportedReasoningEfforts:[{reasoningEffort:'low',description:''}],defaultReasoningEffort:'low'}];
 try{
  await assert.rejects(()=>output(p.stream({reasoningEffort:'high'})),/不支持/);await assert.rejects(()=>output(p.stream({reasoningEffort:'invented'})),/无效/);assert.equal(spawned,0);
 }finally{p.close();}
});

test('Known empty effort support rejects explicit levels while unknown models keep legacy and automatic behavior',()=>{
 const p=provider(()=>{throw Error('No process should start for validation');});p.models=[{id:'no-reasoning',supportedReasoningEfforts:[]}];
 assert.throws(()=>p.reasoningEffort('no-reasoning','high'),/不支持/);assert.throws(()=>p.reasoningEffort('no-reasoning',undefined),/不支持/);
 assert.equal(p.reasoningEffort('no-reasoning',null),null);assert.equal(p.reasoningEffort('no-reasoning','auto'),null);
 assert.equal(p.reasoningEffort('unlisted-model',undefined),'low');assert.equal(p.reasoningEffort('unlisted-model','high'),'high');assert.equal(p.reasoningEffort('unlisted-model',null),null);
 p.close();
});
