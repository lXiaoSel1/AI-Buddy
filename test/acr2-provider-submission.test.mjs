import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexProvider} from '../src/codex-provider.mjs';
import {ApiTransport} from '../src/api-transport.mjs';
import {runR95Model,withR95ModelLifecycle} from '../src/r95-model-request.mjs';
import {getModelSubmissionState} from '../src/model-submission.mjs';

const DEFER=Symbol('defer');
async function fixture(t,handler=()=>{},extra={}){
 const root=await mkdtemp(join(tmpdir(),'buddy-acr2-submit-')),requests=[];let child;
 const provider=new CodexProvider({binary:'fixture.exe',defaultModel:'fixture-model',dataRoot:join(root,'data'),env:{USERPROFILE:root,CODEX_HOME:join(root,'home')},handshakeTimeoutMs:35,turnTimeoutMs:500,spawnImpl:()=>{
  child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),killed:false,kill(){this.killed=true;}});
  const notify=(method,params)=>{if(!child.killed)child.stdout.write(JSON.stringify({method,params})+'\n');};
  child.stdin.on('data',bytes=>{for(const line of String(bytes).trim().split('\n')){const message=JSON.parse(line);requests.push(message);if(message.id==null)continue;queueMicrotask(()=>{if(child.killed)return;try{const custom=handler(message,{notify,child}),result=custom===undefined?(message.method==='account/read'?{account:{type:'chatgpt'}}:message.method==='thread/start'?{thread:{id:'thread-one'}}:message.method==='turn/start'?{turn:{id:'turn-one'}}:{}):custom;if(result!==DEFER)child.stdout.write(JSON.stringify({id:message.id,result})+'\n');}catch(error){child.stdout.write(JSON.stringify({id:message.id,error:{message:error.message}})+'\n');}});}});queueMicrotask(()=>child.emit('spawn'));return child;
 },...extra});provider.setEnabled(true);t.after(async()=>{provider.close();await rm(root,{recursive:true,force:true});});return {provider,requests,get child(){return child;}};
}
async function collect(stream){const chunks=[];try{for await(const chunk of stream)chunks.push(chunk);return {chunks};}catch(error){return {error,chunks};}}
const output=chunks=>chunks.filter(part=>part.type==='text-delta').map(part=>part.text).join('');
function terminal(server,request,{turnId='turn-one',requestId=null,text='{"ok":true}'}={}){
 const meta=requestId===null?{}:{requestId},threadId=request.params.threadId;
 server.notify('item/completed',{threadId,turnId,...meta,item:{id:'message-one',type:'agentMessage',text}});
 server.notify('turn/completed',{threadId,...meta,turn:{id:turnId,status:'completed'}});
}

test('ACR2 initialization failure is trusted not-sent and never claims the business request',async t=>{
 const f=await fixture(t,message=>{if(message.method==='initialize')throw Error('initialization failed');}),events=[];let claimed=0;
 const router={enabled:true,supportsSubmissionLifecycle:true,currentSelection:()=>({provider:'codex',model:'fixture-model'}),selected:()=>({}),stream:options=>f.provider.stream(options)};
 const result=await runR95Model({provider:router,card:{id:'claude'},scope:{characterId:'claude'},system:'JSON',input:{kind:'reading'},withOrigin:(_scope,_kind,operation)=>operation('origin'),beforeModelSubmit:()=>{claimed++;},onModelLifecycle:event=>events.push(event)}).then(value=>({value}),error=>({error}));
 assert.match(result.error.message,/initialization failed/);assert.equal(claimed,0);assert.ok(!f.requests.some(row=>row.method==='turn/start'));assert.equal(events.at(-1).phase,'not-sent');assert.equal(result.error.modelSubmission.phase,'not-sent');
});

test('ACR2 final authorization is checked after awaited claim and before the actual write',async t=>{
 const f=await fixture(t),events=[];let allowed=true,claimed=0;
 const result=await collect(f.provider.stream({messages:[],beforeModelSubmit:async()=>{claimed++;allowed=false;},checkModelSubmit:()=>{if(!allowed)throw Object.assign(Error('origin revoked'),{code:'REVOKED'});},onModelLifecycle:event=>events.push(event)}));
 assert.equal(result.error.code,'REVOKED');assert.equal(claimed,1);assert.ok(!f.requests.some(row=>row.method==='turn/start'));assert.equal(events.at(-1).phase,'not-sent');assert.equal(result.error.modelSubmission.phase,'not-sent');
});

test('ACR2 exactly correlated terminal before missing ACK is complete and preserves the original events',async t=>{
 const events=[],f=await fixture(t,(message,server)=>{if(message.method==='turn/start'){terminal(server,message,{requestId:message.id});return DEFER;}});
 const result=await collect(f.provider.stream({messages:[],onModelLifecycle:event=>events.push(event)}));
 assert.equal(result.error,undefined);assert.equal(output(result.chunks),'{"ok":true}');assert.equal(events.at(-1).phase,'complete');const receipt=events.find(event=>event.phase==='terminal-evidence');assert.equal(receipt.evidence.correlation,'request-id');assert.deepEqual(receipt.evidence.events.map(event=>event.method),['item/completed','turn/completed']);assert.equal(receipt.evidence.events[0].params.item.text,'{"ok":true}');assert.equal(f.requests.filter(row=>row.method==='turn/start').length,1);assert.equal(f.provider.pending.size,0);
});

test('ACR2 same-thread terminal without exact correlation is preserved as unknown and never published',async t=>{
 const events=[],f=await fixture(t,(message,server)=>{if(message.method==='turn/start'){terminal(server,message,{turnId:'unverified-turn'});return DEFER;}});
 const result=await collect(f.provider.stream({messages:[],onModelLifecycle:event=>events.push(event)}));
 assert.equal(result.error.code,'CODEX_REQUEST_TIMEOUT');assert.equal(output(result.chunks),'');assert.equal(events.at(-1).phase,'unknown');assert.equal(result.error.modelSubmission.phase,'unknown');const receipt=events.find(event=>event.phase==='terminal-evidence');assert.equal(receipt.evidence.correlation,'unverified');assert.equal(receipt.evidence.events[0].params.item.text,'{"ok":true}');assert.equal(f.child.killed,true);
});

test('ACR2 wrong-turn terminal cannot be adopted after exact ACK and complete evidence uses only the accepted turn',async t=>{
 const events=[],f=await fixture(t,(message,server)=>{if(message.method==='turn/start'){terminal(server,message,{turnId:'wrong-turn',text:'wrong'});terminal(server,message,{text:'right'});return {turn:{id:'turn-one'}};}});
 const result=await collect(f.provider.stream({messages:[],onModelLifecycle:event=>events.push(event)}));assert.equal(result.error,undefined);assert.equal(output(result.chunks),'right');const receipt=events.find(event=>event.phase==='terminal-evidence');assert.equal(receipt.evidence.turnId,'turn-one');assert.equal(receipt.evidence.correlation,'ack');assert.ok(receipt.evidence.events.every(event=>(event.params.turnId??event.params.turn?.id)==='turn-one'));
});

test('ACR2 request-correlated terminal with incomplete item evidence stays unknown',async t=>{
 const events=[],f=await fixture(t,(message,server)=>{if(message.method==='turn/start'){server.notify('turn/completed',{threadId:message.params.threadId,requestId:message.id,turn:{id:'turn-one',status:'completed'}});return DEFER;}});
 const result=await collect(f.provider.stream({messages:[],onModelLifecycle:event=>events.push(event)}));assert.equal(result.error.code,'CODEX_REQUEST_TIMEOUT');assert.equal(output(result.chunks),'');assert.equal(events.at(-1).phase,'unknown');assert.equal(events.find(event=>event.phase==='terminal-evidence').evidence.complete,false);
});

test('ACR2 API serialization and final guard failures are not-sent; a fetch rejection is unknown',async()=>{
 const profile={id:'api',kind:'custom',protocol:'responses',baseUrl:'https://fixture.invalid/v1',model:'fixture'};
 for(const mode of ['serialization','guard','fetch']){let calls=0,claims=0;const events=[],transport=new ApiTransport({fetchImpl:async()=>{calls++;throw Error('socket disconnected');}}),options={messages:[],beforeModelSubmit:()=>{claims++;},checkModelSubmit:()=>{if(mode==='guard')throw Object.assign(Error('revoked'),{code:'REVOKED'});},onModelLifecycle:event=>events.push(event)};if(mode==='serialization')options.messages=[{role:'user',content:[{type:'image',data:'invalid'}]}];const result=await collect(transport.stream(profile,options));assert.ok(result.error);assert.equal(calls,mode==='fetch'?1:0);assert.equal(claims,mode==='serialization'?0:1);assert.equal(events.at(-1).phase,mode==='fetch'?'unknown':'not-sent');assert.equal(result.error.modelSubmission.phase,mode==='fetch'?'unknown':'not-sent');}
});

test('ACR2 authorization revoked while persisting send-attempt prevents the final write',async t=>{
 const f=await fixture(t),events=[];let allowed=true;
 const result=await collect(f.provider.stream({messages:[],beforeModelSubmit:()=>{},checkModelSubmit:()=>{if(!allowed)throw Object.assign(Error('permission revoked during durable attempt'),{code:'REVOKED'});},onModelLifecycle:async event=>{events.push(event);if(event.phase==='send-attempt'){await Promise.resolve();allowed=false;}}}));
 assert.equal(result.error.code,'REVOKED');assert.ok(!f.requests.some(row=>row.method==='turn/start'));assert.deepEqual(events.map(event=>event.phase),['preparing','send-attempt','not-sent']);assert.equal(result.error.modelSubmission.source,'core-transport');
});

test('ACR2 uncorrelated terminal is persisted before unknown returns to the business caller',async t=>{
 let release,entered,settled=false;const gate=new Promise(resolve=>{release=resolve;}),enteredPromise=new Promise(resolve=>{entered=resolve;});
 const f=await fixture(t,(message,server)=>{if(message.method==='turn/start'){terminal(server,message,{requestId:message.id+100});return DEFER;}}),events=[];
 const pending=collect(f.provider.stream({messages:[],onModelLifecycle:async event=>{events.push(event);if(event.phase==='terminal-evidence'){entered();await gate;}}})).then(result=>{settled=true;return result;});
 await enteredPromise;assert.equal(settled,false);assert.equal(f.child.killed,true);release();const result=await pending;assert.equal(result.error.code,'CODEX_REQUEST_TIMEOUT');assert.equal(events.at(-1).phase,'unknown');assert.equal(output(result.chunks),'');assert.equal(events.find(event=>event.phase==='terminal-evidence').evidence.correlation,'unverified');
});

test('ACR2 private lifecycle scope and explicit observer both receive copied transport evidence',async t=>{
 const f=await fixture(t,(message,server)=>{if(message.method==='turn/start')terminal(server,message);}),observed=[],explicit=[],scope={characterId:'claude',lifeId:'life'},input={kind:'reading',source:'original'};
 const router={enabled:true,supportsSubmissionLifecycle:true,currentSelection:()=>({provider:'codex',model:'fixture-model'}),selected:()=>({}),stream:options=>f.provider.stream(options)};
 const result=await withR95ModelLifecycle(value=>{observed.push(value);value.scope.characterId='observer-copy';},()=>runR95Model({provider:router,card:{id:'claude'},scope,system:'JSON',input,withOrigin:(_scope,_kind,operation)=>operation('origin'),onModelLifecycle:event=>explicit.push(event)}));
 assert.deepEqual(result,{ok:true});assert.equal(scope.characterId,'claude');assert.deepEqual(observed[0].input,input);assert.ok(observed.some(value=>value.event.phase==='terminal-evidence'));assert.equal(explicit.at(-1).phase,'complete');assert.equal(explicit.length,observed.length);assert.equal(explicit[0].source,'core-transport');
});

test('ACR2 approved native tool loop rechecks every send and claims the business request exactly once',async()=>{
 let calls=0,claims=0,checks=0;const events=[],sse=value=>new Response('data: '+JSON.stringify(value)+'\n\n',{headers:{'content-type':'text/event-stream'}}),transport=new ApiTransport({fetchImpl:async url=>{
  calls++;if(url.endsWith('/tools/search'))return new Response(JSON.stringify({results:[{url:'https://example.com/source',title:'Source'}]}),{headers:{'content-type':'application/json'}});
  return calls===1?sse({choices:[{delta:{tool_calls:[{index:0,id:'call-one',type:'function',function:{name:'native_web_search',arguments:'{"query":"source"}'}}]},finish_reason:'tool_calls'}]}):sse({choices:[{delta:{content:'grounded'},finish_reason:'stop'}]});
 }});
 const result=await collect(transport.stream({id:'deepseek',kind:'deepseek',protocol:'chat-completions',baseUrl:'https://api.deepseek.com/v1',model:'deepseek-flash',reasoningEffort:null},{messages:[{role:'user',content:'source'}],nativeSearch:{allowed:true,check:()=>true},beforeModelSubmit:()=>{claims++;},checkModelSubmit:()=>{checks++;},onModelLifecycle:event=>events.push(event)}));
 assert.equal(result.error,undefined);assert.equal(output(result.chunks),'grounded');assert.equal(calls,3);assert.equal(claims,1);assert.equal(checks,6);assert.equal(events.filter(event=>event.phase==='send-attempt').length,3);assert.equal(new Set(events.map(event=>event.requestId)).size,1);assert.equal(events.at(-1).phase,'complete');
});

test('ACR2 contradictory complete item snapshots cannot recover a missing ACK',async t=>{
 const events=[],f=await fixture(t,(message,server)=>{if(message.method==='turn/start'){terminal(server,message,{requestId:message.id,text:'one'});terminal(server,message,{requestId:message.id,text:'two'});return DEFER;}});
 const result=await collect(f.provider.stream({messages:[],onModelLifecycle:event=>events.push(event)}));assert.equal(result.error.code,'CODEX_REQUEST_TIMEOUT');assert.equal(output(result.chunks),'');assert.equal(events.find(event=>event.phase==='terminal-evidence').evidence.complete,false);
});

test('ACR2 trusted not-sent classification cannot be forged or changed through serialized diagnostics',async()=>{
 const forged=Object.assign(Error('provider text'),{modelSubmission:{phase:'not-sent',source:'core-transport'}});assert.equal(getModelSubmissionState(forged),null);assert.equal(getModelSubmissionState(JSON.parse(JSON.stringify(forged))),null);
 const transport=new ApiTransport({fetchImpl:()=>{throw Error('must not fetch');}}),result=await collect(transport.stream({id:'api',kind:'custom',protocol:'responses',baseUrl:'https://fixture.invalid',model:'fixture'},{messages:[],checkModelSubmit:()=>{throw Object.assign(Error('revoked'),{code:'REVOKED'});}}));
 assert.equal(getModelSubmissionState(result.error).phase,'not-sent');result.error.modelSubmission.phase='unknown';const state=getModelSubmissionState(result.error);assert.equal(state.phase,'not-sent');state.phase='unknown';assert.equal(getModelSubmissionState(result.error).phase,'not-sent');
});

test('ACR2 attempted fetch cancellation keeps the public message and original AbortError cause',async()=>{
 const controller=new AbortController(),cause=new DOMException('This operation was aborted','AbortError'),transport=new ApiTransport({fetchImpl:async()=>{controller.abort();throw cause;}}),result=await collect(transport.stream({id:'api',kind:'custom',protocol:'responses',baseUrl:'https://fixture.invalid',model:'fixture'},{messages:[],signal:controller.signal}));
 assert.match(result.error.message,/取消或超时/);assert.equal(result.error.cause,cause);assert.equal(getModelSubmissionState(result.error).phase,'unknown');
});

test('ACR2 attempted coded network failure preserves its cause without changing the public model error code',async()=>{
 const cause=Object.assign(Error('controlled upstream failure'),{code:'CONTROLLED_CHAT_FAILURE'}),transport=new ApiTransport({fetchImpl:async()=>{throw cause;}}),result=await collect(transport.stream({id:'api',kind:'custom',protocol:'responses',baseUrl:'https://fixture.invalid',model:'fixture'},{messages:[]}));
 assert.match(result.error.message,/无法连接模型服务/);assert.equal(result.error.code,undefined);assert.equal(result.error.cause,cause);assert.equal(getModelSubmissionState(result.error).phase,'unknown');
});
