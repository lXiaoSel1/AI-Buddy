import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexProvider} from '../src/codex-provider.mjs';

const DEFER=Symbol('defer'),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function latch(){let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};}
async function until(predicate,message='condition not reached'){const end=Date.now()+2500;while(!predicate()){if(Date.now()>end)throw Error(message);await delay(5);}}
function peer(handler=()=>{}){
 const child=new EventEmitter(),requests=[];let nextThread=0,nextTurn=0;
 Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),killed:false,kill(){this.killed=true;}});
 const notify=(method,params)=>{if(!child.killed)child.stdout.write(JSON.stringify({method,params})+'\n');};
 const respond=(id,result,error)=>{if(!child.killed)child.stdout.write(JSON.stringify({id,...(error?{error}:{result})})+'\n');};
 const server={child,requests,notify,respond,exit(){child.emit('exit',1);}};
 child.stdin.on('data',bytes=>{for(const line of String(bytes).trim().split('\n')){
  if(!line)continue;const message=JSON.parse(line);requests.push(message);if(message.id==null)continue;
  queueMicrotask(()=>{if(child.killed)return;try{const value=handler(message,server);if(value===DEFER)return;const result=value===undefined?(message.method==='account/read'?{account:{type:'chatgpt'},requiresOpenaiAuth:true}:message.method==='thread/start'?{thread:{id:'thread-'+(++nextThread)}}:message.method==='turn/start'?{turn:{id:'turn-'+(++nextTurn)}}:{}):value;respond(message.id,result);}catch(error){respond(message.id,null,{message:error.message});}});
 }});queueMicrotask(()=>child.emit('spawn'));return server;
}
async function fixture(t,handler,extra={}){
 const root=await mkdtemp(join(tmpdir(),'buddy-codex-stream-')),servers=[],spawns=[];
 const provider=new CodexProvider({binary:'fixture.exe',defaultModel:'fixture-model',dataRoot:join(root,'data'),env:{USERPROFILE:root,CODEX_HOME:join(root,'isolated-home')},handshakeTimeoutMs:500,turnTimeoutMs:1500,requestTimeoutMs:1000,poolIdleMs:100000,spawnImpl:(binary,args,options)=>{spawns.push({binary,args,options});const server=peer(handler);servers.push(server);return server.child;},...extra});provider.setEnabled(true);t.after(()=>{provider.close();return rm(root,{recursive:true,force:true});});return {provider,servers,spawns};
}
const observe=promise=>promise.then(value=>({value}),error=>({error}));
async function collect(stream){const chunks=[];for await(const chunk of stream)chunks.push(chunk);return chunks;}
const text=chunks=>chunks.filter(chunk=>chunk.type==='text-delta').map(chunk=>chunk.text).join('');
function finish(server,threadId,turnId,value='done'){server.notify('item/agentMessage/delta',{threadId,turnId,itemId:'message',delta:value});server.notify('item/completed',{threadId,turnId,item:{id:'message',type:'agentMessage',text:value}});server.notify('turn/completed',{threadId,turn:{id:turnId,status:'completed'}});}

test('first text arrives before model completion and timing phases reflect actual protocol readiness',async t=>{
 const submitted=latch(),timings=[];const {provider,servers,spawns}=await fixture(t,message=>{if(message.method==='turn/start')submitted.resolve(message);});const iterator=provider.stream({messages:[{role:'user',content:'hello'}],onTiming:event=>timings.push(event.name)})[Symbol.asyncIterator](),first=iterator.next();const turn=await submitted.promise;await delay(5);const server=servers[0];server.notify('item/agentMessage/delta',{threadId:turn.params.threadId,turnId:'turn-1',itemId:'message',delta:'first'});assert.equal((await first).value.text,'first');assert.ok(!timings.includes('model-complete'));
 server.notify('item/completed',{threadId:turn.params.threadId,turnId:'turn-1',item:{id:'message',type:'agentMessage',text:'first tail'}});server.notify('turn/completed',{threadId:turn.params.threadId,turn:{id:'turn-1',status:'completed'}});let rest='';for await(const chunk of iterator)if(chunk.type==='text-delta')rest+=chunk.text;assert.equal(rest,' tail');assert.deepEqual(timings,['process-ready','thread-ready','turn-submitted','first-delta','model-complete']);assert.equal(timings.filter(value=>value==='first-delta').length,1);assert.equal(spawns.length,1);const thread=server.requests.find(row=>row.method==='thread/start');assert.notEqual(thread.params.cwd,spawns[0].options.cwd);assert.equal(thread.params.ephemeral,true);assert.equal(thread.params.config.web_search,'disabled');assert.equal(thread.params.config['skills.include_instructions'],false);assert.equal(thread.params.sandbox,'read-only');
});

test('accepted turn ID filters wrong-thread and wrong-turn messages even when notifications precede the acceptance response',async t=>{
 const {provider}=await fixture(t,(message,server)=>{if(message.method==='turn/start'){
  const threadId=message.params.threadId;server.notify('item/agentMessage/delta',{threadId:'other-thread',turnId:'wrong',itemId:'bad',delta:'wrong thread'});server.notify('item/agentMessage/delta',{threadId,turnId:'wrong-turn',itemId:'bad',delta:'wrong turn'});server.notify('turn/completed',{threadId,turn:{id:'wrong-turn',status:'completed'}});server.notify('item/agentMessage/delta',{threadId,turnId:'accepted-turn',itemId:'good',delta:'right'});server.notify('turn/completed',{threadId,turn:{id:'accepted-turn',status:'completed'}});return {turn:{id:'accepted-turn'}};
 }});assert.equal(text(await collect(provider.stream({messages:[]}))),'right');assert.equal(provider.notifications.size,0);assert.equal(provider.pending.size,0);
});

test('explicit event IDs and final item snapshots dedupe while legitimate equal text deltas remain',async t=>{
 const {provider}=await fixture(t,(message,server)=>{if(message.method==='turn/start')queueMicrotask(()=>{
  const scope={threadId:message.params.threadId,turnId:'turn-1',itemId:'item'};server.notify('item/agentMessage/delta',{...scope,eventId:'delta-a',delta:'ha'});server.notify('item/agentMessage/delta',{...scope,eventId:'delta-a',delta:'ha'});server.notify('item/agentMessage/delta',{...scope,delta:'ha'});server.notify('item/completed',{threadId:scope.threadId,turnId:scope.turnId,item:{id:'item',type:'agentMessage',text:'haha!'}});server.notify('item/completed',{threadId:scope.threadId,turnId:scope.turnId,item:{id:'item',type:'agentMessage',text:'haha!'}});server.notify('turn/completed',{threadId:scope.threadId,turn:{id:scope.turnId,status:'completed'}});
 });});assert.equal(text(await collect(provider.stream({messages:[]}))),'haha!');
});

test('contradictory final text fails without replacing already visible text or claiming success',async t=>{
 const chunks=[],{provider}=await fixture(t,(message,server)=>{if(message.method==='turn/start')queueMicrotask(()=>{const threadId=message.params.threadId;server.notify('item/agentMessage/delta',{threadId,turnId:'turn-1',itemId:'item',delta:'visible original'});server.notify('item/completed',{threadId,turnId:'turn-1',item:{id:'item',type:'agentMessage',text:'replacement'}});server.notify('turn/completed',{threadId,turn:{id:'turn-1',status:'completed'}});});});const result=await observe((async()=>{for await(const chunk of provider.stream({messages:[]}))chunks.push(chunk);})());assert.equal(result.error.code,'CODEX_STREAM_MISMATCH');assert.equal(text(chunks),'visible original');assert.ok(chunks.every(chunk=>chunk.type!=='finish'));
});

test('active cancellation interrupts the exact thread and turn and never reports interrupted output as success',async t=>{
 const submitted=latch(),controller=new AbortController(),{provider,servers}=await fixture(t,message=>{if(message.method==='turn/start')submitted.resolve(message);});const result=observe(collect(provider.stream({messages:[],signal:controller.signal}))),turn=await submitted.promise;await delay(5);controller.abort();assert.equal((await result).error.code,'ABORT_ERR');await until(()=>servers[0].requests.some(row=>row.method==='turn/interrupt'));const interrupt=servers[0].requests.find(row=>row.method==='turn/interrupt');assert.deepEqual(interrupt.params,{threadId:turn.params.threadId,turnId:'turn-1'});assert.equal(provider.notifications.size,0);
});

test('cancel before turn/start acknowledgement closes only the uncertain owned process and future turns can start fresh',async t=>{
 let first=true;const began=latch(),controller=new AbortController(),{provider,servers}=await fixture(t,(message,server)=>{if(message.method==='turn/start'){if(first){first=false;began.resolve(message);return DEFER;}queueMicrotask(()=>finish(server,message.params.threadId,'turn-1','fresh'));}});const result=observe(collect(provider.stream({messages:[],signal:controller.signal})));await began.promise;controller.abort();assert.equal((await result).error.code,'ABORT_ERR');assert.equal(servers[0].child.killed,true);assert.equal(provider.pending.size,0);assert.equal(text(await collect(provider.stream({messages:[]}))),'fresh');assert.equal(servers.length,2);
});

test('cancel during initialization returns promptly and cannot submit a late thread or turn',async t=>{
 const began=latch(),controller=new AbortController();let pendingInitialize;const {provider,servers}=await fixture(t,message=>{if(message.method==='initialize'){pendingInitialize=message;began.resolve();return DEFER;}});const result=observe(collect(provider.stream({messages:[],signal:controller.signal})));await began.promise;controller.abort();assert.equal((await result).error.code,'ABORT_ERR');servers[0].respond(pendingInitialize.id,{});await until(()=>provider.starting===null);assert.ok(!servers[0].requests.some(row=>row.method==='thread/start'||row.method==='turn/start'));
});

test('cancel a queued request without waiting for the active turn and never send its text',async t=>{
 const began=latch(),controller=new AbortController(),{provider,servers}=await fixture(t,message=>{if(message.method==='turn/start')began.resolve(message);});const first=observe(collect(provider.stream({messages:[{role:'user',content:'first'}]}))),turn=await began.promise;const queued=observe(collect(provider.stream({messages:[{role:'user',content:'never send queued'}],signal:controller.signal})));controller.abort();assert.equal((await queued).error.code,'ABORT_ERR');assert.equal(servers[0].requests.filter(row=>row.method==='turn/start').length,1);finish(servers[0],turn.params.threadId,'turn-1','first done');assert.equal(text((await first).value),'first done');await provider.chatTail;assert.ok(!servers[0].requests.some(row=>JSON.stringify(row).includes('never send queued')));
});

test('unexpected process exit rejects live output, clears listeners and restarts cleanly',async t=>{
 const began=latch();let first=true;const {provider,servers}=await fixture(t,(message,server)=>{if(message.method==='turn/start'){if(first){first=false;began.resolve(message);}else queueMicrotask(()=>finish(server,message.params.threadId,'turn-1','restarted'));}});const run=observe(collect(provider.stream({messages:[]})));await began.promise;servers[0].exit();assert.match((await run).error.message,/已结束/);assert.equal(provider.pending.size,0);assert.equal(provider.notifications.size,0);assert.equal(text(await collect(provider.stream({messages:[]}))),'restarted');assert.equal(servers.length,2);
});

test('response timeout is distinct from cancellation, interrupts its known turn and retains delivered text',async t=>{
 const chunks=[],{provider,servers}=await fixture(t,(message,server)=>{if(message.method==='turn/start')queueMicrotask(()=>server.notify('item/agentMessage/delta',{threadId:message.params.threadId,turnId:'turn-1',itemId:'item',delta:'partial'}));},{turnTimeoutMs:40});const result=await observe((async()=>{for await(const chunk of provider.stream({messages:[]}))chunks.push(chunk);})());assert.equal(result.error.code,'CODEX_TURN_TIMEOUT');assert.equal(text(chunks),'partial');assert.ok(servers[0].requests.some(row=>row.method==='turn/interrupt'&&row.params.turnId==='turn-1'));assert.equal(provider.notifications.size,0);
});

test('turn submission timeout kills the uncertain process without leaving a chargeable background turn',async t=>{
 const {provider,servers}=await fixture(t,message=>message.method==='turn/start'?DEFER:undefined,{handshakeTimeoutMs:30,turnTimeoutMs:500});const result=await observe(collect(provider.stream({messages:[]})));assert.equal(result.error.code,'CODEX_REQUEST_TIMEOUT');assert.equal(servers[0].child.killed,true);assert.equal(provider.pending.size,0);assert.equal(provider.notifications.size,0);
});

test('native interrupted turn is an error rather than a successful finish',async t=>{
 const {provider}=await fixture(t,(message,server)=>{if(message.method==='turn/start')queueMicrotask(()=>server.notify('turn/completed',{threadId:message.params.threadId,turn:{id:'turn-1',status:'interrupted'}}));});const result=await observe(collect(provider.stream({messages:[]})));assert.equal(result.error.code,'ABORT_ERR');
});

test('server request sharing a client request ID is declined without consuming the turn acceptance response',async t=>{
 const {provider,servers}=await fixture(t,(message,server)=>{if(message.method==='turn/start'){
  server.child.stdout.write(JSON.stringify({id:message.id,method:'item/commandExecution/requestApproval',params:{threadId:message.params.threadId,turnId:'turn-1',command:'must not execute'}})+'\n');queueMicrotask(()=>finish(server,message.params.threadId,'turn-1','safe response'));
 }});const chunks=await collect(provider.stream({messages:[]}));assert.equal(text(chunks),'safe response');assert.ok(servers[0].requests.some(row=>row.result?.decision==='decline'));assert.equal(provider.pending.size,0);
});

test('unacknowledged interrupt closes its own native process rather than leaving uncertain generation running',async t=>{
 const began=latch(),controller=new AbortController(),{provider,servers}=await fixture(t,message=>{if(message.method==='turn/start')began.resolve(message);if(message.method==='turn/interrupt')return DEFER;},{handshakeTimeoutMs:30});const result=observe(collect(provider.stream({messages:[],signal:controller.signal})));await began.promise;await delay(5);controller.abort();assert.equal((await result).error.code,'ABORT_ERR');await until(()=>servers[0].child.killed);assert.equal(provider.pending.size,0);assert.equal(provider.notifications.size,0);
});

test('connection pool allows two isolated processes, queues the third, and cancelling its wait spawns nothing',async t=>{
 const active=[],third=new AbortController(),{provider,servers}=await fixture(t,(message,server)=>{if(message.method==='turn/start')active.push({message,server});});const first=observe(collect(provider.streamForConnection('connection-a',{messages:[{role:'user',content:'A'}]}))),second=observe(collect(provider.streamForConnection('connection-b',{messages:[{role:'user',content:'B'}]})));await until(()=>active.length===2);assert.equal(servers.length,2);assert.notEqual(active[0].server,active[1].server);const queued=observe(collect(provider.streamForConnection('connection-c',{messages:[{role:'user',content:'C'}],signal:third.signal})));third.abort();assert.equal((await queued).error.code,'ABORT_ERR');assert.equal(servers.length,2);assert.equal(provider.listenerCount('connection-idle'),0);for(const row of active)finish(row.server,row.message.params.threadId,'turn-1',row.message.params.input[0].text);assert.match(text((await first).value),/A/);assert.match(text((await second).value),/B/);assert.equal(provider.connectionClients.size,2);
});

test('hot connection reuses its process but a fresh thread; idle eviction produces a genuinely cold next request',async t=>{
 const timings=[],{provider,servers}=await fixture(t,(message,server)=>{if(message.method==='turn/start'){const count=server.requests.filter(row=>row.method==='turn/start').length;queueMicrotask(()=>finish(server,message.params.threadId,'turn-'+count,'done'));}},{poolIdleMs:25});for(let index=0;index<2;index++)await collect(provider.streamForConnection('same-connection',{messages:[],onTiming:event=>timings.push(event.name)}));assert.equal(servers.length,1);const threads=servers[0].requests.filter(row=>row.method==='thread/start');assert.equal(threads.length,2);assert.equal(new Set(servers[0].requests.filter(row=>row.method==='turn/start').map(row=>row.params.threadId)).size,2);assert.equal(servers[0].requests.filter(row=>row.method==='initialize').length,1);await until(()=>provider.connectionClients.size===0);assert.equal(servers[0].child.killed,true);await collect(provider.streamForConnection('same-connection',{messages:[]}));assert.equal(servers.length,2);assert.equal(timings.filter(value=>value==='process-ready').length,2);
});

test('same connection serializes turns and repeated native usage snapshots are not re-emitted',async t=>{
 const usages=[],active=[],{provider}=await fixture(t,(message,server)=>{if(message.method==='turn/start')active.push({message,server});},{onUsage:usage=>usages.push(usage)});const a=observe(collect(provider.streamForConnection('same',{messages:[]}))),b=observe(collect(provider.streamForConnection('same',{messages:[]})));await until(()=>active.length===1);assert.equal(active.length,1);const first=active[0],usage={threadId:first.message.params.threadId,turnId:'turn-1',tokenUsage:{total:{inputTokens:10,outputTokens:2,totalTokens:12}}};first.server.notify('thread/tokenUsage/updated',usage);first.server.notify('thread/tokenUsage/updated',usage);finish(first.server,first.message.params.threadId,'turn-1');await until(()=>active.length===2);const second=active[1];finish(second.server,second.message.params.threadId,'turn-2');assert.ok((await a).value);assert.ok((await b).value);assert.equal(usages.length,1);assert.equal(usages[0].usage.total_tokens,12);
});
