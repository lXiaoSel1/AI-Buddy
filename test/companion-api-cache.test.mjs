import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {apply} from '../src/adapted/game-core.ts';
import {createDeferredSaves} from '../src/deferred-saves.mjs';
import {restrictedFileService} from '../src/storage.mjs';
import {openCompanionStore} from '../src/companion-store.mjs';
import {ApiTransport} from '../src/api-transport.mjs';
import {createCompanionService} from '../src/companion-service.mjs';
import {estimatePrivateMessageTokens} from '../src/private-token-budget.mjs';
import {tmpDir} from './support/audit-harness.mjs';

async function fixture(t, {kind='deepseek', protocol=kind==='codex'?'codex':'chat-completions', tokens=131072, wire=false, corruptSidecar=false, rejectCompaction=false, truncateCompaction=false,blockSidecar=false,official=false,onChat,onChatInFlight,onCompact}={}){
 const root=tmpDir('private-api-cache',{t,beforeRemove:async()=>dispose()});
 const sidecar=join(root,'companion-cache-r1.sqlite');
 if(corruptSidecar)writeFileSync(sidecar,'Synthetic corrupt cache evidence');
 if(blockSidecar)mkdirSync(sidecar);
 const requests=[], wireRequests=[], audits=[], nativeEvents=[];
 let minute=0, service, store, failCommit=false, latestChat=null, style;
 const now=()=>Date.parse('2026-11-17T14:30:00Z')+minute*60000;
 const profile={id:'fixture',kind,protocol,baseUrl:official?'https://api.deepseek.com/v1':'http://localhost:1/v1',model:official?'deepseek-flash':'synthetic',key:'synthetic-local-only'};
 const replies={
  'chat-completions':{choices:[{message:{content:'Synthetic wire reply'},finish_reason:'stop'}]},
  anthropic:{content:[{type:'text',text:'Synthetic wire reply'}]},
  responses:{output:[{content:[{type:'output_text',text:'Synthetic wire reply'}]}]},
  gemini:{candidates:[{content:{parts:[{text:'Synthetic wire reply'}]},finishReason:'STOP'}]},
 };
 const partialSummary='SYNTHETIC_TRUNCATED_SUMMARY_MARKER';
 const truncatedResponse=()=>{
  if(protocol==='chat-completions')return Response.json({choices:[{message:{content:partialSummary},finish_reason:'length'}]});
  const events=[
   {type:'response.output_text.delta',delta:partialSummary},
   {type:'response.incomplete',response:{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}},
  ];
  return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
 };
 const provider={
  async commitPrivateThread(requestId,metadata){nativeEvents.push({type:'commit',requestId,...metadata});},
  async discardPrivateThread(requestId){nativeEvents.push({type:'discard',requestId});},
  async deletePrivateThreads(selector){nativeEvents.push({type:'delete',selector});},
  enabled:true,currentSelection:()=>({provider:profile.id,model:profile.model}),captureConnection:()=>profile,
  resolveContextCapacity:()=>({tokens,verified:true}),runCaptured:async (_profile,run)=>run(),
  resolveModelInfo:()=>({}),outputLimit:()=>1600,
  async *stream(options){
   const {system,messages,cacheContext,purpose,incremental,maxTokens}=options;
   if(incremental){latestChat=options;options.observeWireSystemMode?.('plain',true);}
   if(wire){
    const transport=new ApiTransport({fetchImpl:async(_url,{body})=>{
     if(incremental)wireRequests.push(JSON.parse(body));
     if(purpose==='chat-window-compact'){
      requests.push({purpose});
      if(truncateCompaction)return truncatedResponse();
     }
     return Response.json(replies[protocol]);
    }});
    yield* transport.stream(profile,options);
    return;
   }
   if(purpose==='memory-query-compress-segment'){
    const {coverageHash,events}=JSON.parse(messages[0].content[0].text);
    yield {type:'text-delta',text:JSON.stringify({coverageHash,eventIds:[...new Set(events.map(event=>event.id))],text:'Bounded synthetic source summary.'})};
    return;
   }
   if(incremental){await onChat?.({store,service,options});if(!options.signal?.aborted)await options.checkModelSubmit?.();}
   if(incremental||purpose==='chat-window-compact')requests.push({system,messages:structuredClone(messages),cacheContext,purpose,maxTokens});
   if(incremental)await onChatInFlight?.({store,service,options});
   if(purpose==='chat-window-compact'){
    if(rejectCompaction)return;
    if(onCompact){yield* onCompact(options);return;}
   }
   yield {type:'text-delta',text:purpose==='chat-window-compact'?'Synthetic compacted history.':'[[emotion:温柔]]Synthetic reply '+requests.length};
  },
 };
 const workspace=root;
 const header={id:'whale-companion-local',cwd:workspace,events:[]};
 const services={fs:restrictedFileService(workspace),sandboxPolicy:{resolve:()=>({workspaceRoot:workspace})},sessions:{list:()=>[header]},workspaceRegistry:{list:()=>[{path:workspace}]},agentDefaultModel:provider,sessionQuery:{listSessions:async()=>[header],listEvents:async()=>[]}};
 const effects=[];
 const ctx={
  deferredSaveRegistry:createDeferredSaves(),deferredSaveScope:root,llm:provider,language:()=> 'en',
  dshHomePath:(...parts)=>join(root,'galgame',...parts),inject:(_keys,fn)=>fn(services),on(){},emit(){},
  effect(fn){const cleanup=fn();if(typeof cleanup==='function')effects.push(cleanup);},
  companionSignal:id=>service?.signalFor(id),captureCompanionDelta:value=>service?.captureDelta(value),
 };
 const engine=apply(ctx,{enabled:true,singleChatSelection:true,chatModel:profile.model,strictModelErrors:true});
 await engine.handleAction('settings-get',{});
 const start=async()=>{
  store=await openCompanionStore(root);
  const mutate=store.mutate.bind(store);
  store.mutate=(fn,options)=>mutate(async(state,tx)=>{
   const result=await fn(state,tx);
   const first=latestChat?.messages.at(-1)?.content[0].text.split('\n')[0];
   if(failCommit&&first===failCommit&&tx.messages.recent('private',state.activeConversationId,1).at(-1)?.request?.inputUserText===first){
    failCommit=false;
    throw Error('Synthetic host commit failure');
   }
   return result;
  },options);
  service=await createCompanionService({store,engine,provider,dataRoot:root,now,getLanguage:()=> 'en',getReplyStyle:()=>style,audit:event=>audits.push(event),automaticWorkAllowed:()=>false,r95Options:{tickAllowed:()=>false}});
 };
 async function dispose(){await service?.close();await store?.close();await engine.flushSaves();engine.releaseDeferredSaves();for(const cleanup of effects)cleanup();}
 await start();
 return {
  profile,setStyle(value){style=value;},requests,wireRequests,sidecar,partialSummary,audits,nativeEvents,
  failNextHostCommit(text){failCommit=text;},
  get store(){return store;},
  async send(text){
   minute++;
   const result=await service.chat({text});
   const reply=result.companion.messages.at(-1);
   await service.action('companion-private-present',{conversationId:result.companion.activeConversationId,id:reply.id,occurrenceId:reply.occurrenceId});
   return result;
  },
  async restart(){await service.close();await store.close();await start();},
  get service(){return service;},
 };
}
const hash=text=>createHash('sha256').update(text).digest('hex');
function cachedPayloads(sidecar){
 const reader=new DatabaseSync(sidecar,{readOnly:true});
 try{return reader.prepare('SELECT payload FROM api_windows').all().map(row=>row.payload);}
 finally{reader.close();}
}

test('API private chat keeps static instructions stable and adds runtime context after the user text',async t=>{
 const f=await fixture(t);
 await f.send('Synthetic question A');
 await f.send('Synthetic question B');
 const [first,second]=f.requests;
 assert.equal(hash(first.system),hash(second.system),'static instructions must survive clock and relationship changes');
 assert.doesNotMatch(first.system,/当前等级|好感度|当前自己的心情|logicalDay/);
 assert.match(first.messages.at(-1).content[0].text,/^Synthetic question A[\s\S]*当前等级[\s\S]*当前自己的心情[\s\S]*Current/);
});

test('Codex private chat shares the stable window and exposes its exact host parent',async t=>{
 const f=await fixture(t,{kind:'codex'});
 await f.send('Synthetic Codex question');
 await f.send('Synthetic Codex followup');
 const [first,second]=f.requests;
 assert.equal(first.cacheContext?.kind,'private');
 assert.equal(first.cacheContext.native.parentMessageId,null);
 assert.match(first.cacheContext.native.requestId,/^[0-9a-f-]{36}$/);
 assert.equal(first.cacheContext.native.scope.conversationId,f.store.state.activeConversationId);
 assert.equal(second.cacheContext.native.parentMessageId,first.cacheContext.native.requestId+':reply');
 assert.equal(hash(first.system),hash(second.system));
 assert.doesNotMatch(first.system,/当前等级|当前自己的心情/);
 assert.match(first.messages.at(-1).content[0].text,/^Synthetic Codex question[\s\S]*Current/);
 assert.deepEqual(second.messages.slice(0,first.messages.length),first.messages);
});
test('API private chat replays five append-only requests and keeps its random identity across restart',async t=>{
 const f=await fixture(t);
 for(let turn=1;turn<=5;turn++){
  if(turn===3)await f.restart();
  await f.send('Synthetic stable question '+turn);
 }
 assert.equal(f.requests.length,5);
 for(let index=1;index<f.requests.length;index++){
  const prior=f.requests[index-1], current=f.requests[index];
  assert.equal(hash(JSON.stringify(current.messages.slice(0,prior.messages.length))),hash(JSON.stringify(prior.messages)),'previous wire input must replay byte for byte');
  assert.equal(current.messages.length,prior.messages.length+2);
  assert.equal(current.cacheContext.sessionUuid,prior.cacheContext.sessionUuid);
 }
 assert.match(f.requests[0].cacheContext.sessionUuid,/^[0-9a-f-]{36}$/);
});

test('API private chat compacts bounded prior history, then resumes appending',async t=>{
 const contextCapacity=131072;
 const f=await fixture(t,{tokens:contextCapacity});
 for(let index=0;index<16&&!f.requests.some(request=>request.purpose==='chat-window-compact');index++)
  await f.send('Synthetic segment '+index+' '+String.fromCharCode(65+index).repeat(2200));
 const compactIndex=f.requests.findIndex(request=>request.purpose==='chat-window-compact');
 assert.ok(compactIndex>1,'crossing the window budget must request one summary');
 const before=f.requests[compactIndex-1],compact=f.requests[compactIndex],after=f.requests[compactIndex+1];
 assert.equal(hash(compact.system),hash(before.system));
 const replay=compact.messages.slice(0,-1);
 const tokenCost=messages=>messages.reduce((total,message)=>total+estimatePrivateMessageTokens(message),0);
 const priorReplayTokens=tokenCost(before.messages);
 const summaryHistoryTokens=tokenCost(replay.slice(0,-1).filter(row=>!row.content[0].text.startsWith('[Current memoryState]')));
 const summaryInputBytes=Buffer.byteLength(JSON.stringify(compact.messages))+Buffer.byteLength(compact.system)+compact.maxTokens+192;
 t.diagnostic(JSON.stringify({priorReplayTokens,summaryHistoryTokens,summaryInputBytes,prefixRows:replay.length}));
 assert.ok(priorReplayTokens>8000,'complete prefix includes independently budgeted prior current input');
 assert.ok(summaryHistoryTokens<=8000,'optional summary history fits the custom gateway tier');
 assert.ok(summaryInputBytes<=contextCapacity,'physical request budget includes the whole prefix and reserve');
 assert.equal(hash(JSON.stringify(replay)),hash(JSON.stringify(before.messages)));
 assert.match(compact.messages.at(-1).content[0].text,/summari[sz]e|摘要/i);
 assert.match(after.messages[0].content[0].text,/Synthetic compacted history/);
 assert.match(after.messages[1].content[0].text,/Current memoryState.*[\s\S]*"core".*"guide".*"corrections"/);
 assert.equal(after.messages.filter(row=>row.content[0].text.includes('[Current memoryState]')).length,1);
 assert.equal(compact.maxTokens,4096);
 assert.ok(after.messages.length<before.messages.length);
 assert.ok(after.messages.some(message=>message.role==='assistant'&&message.content[0].text.startsWith('[[emotion:温柔]]')));
 await f.send('Short continuation after compaction');
 const next=f.requests.at(-1);
 assert.equal(f.requests.filter(request=>request.purpose==='chat-window-compact').length,1);
 assert.equal(hash(JSON.stringify(next.messages.slice(0,after.messages.length))),hash(JSON.stringify(after.messages)));
});

test('failed host commit does not replay the unknown turn or advance the committed API window',async t=>{
 const f=await fixture(t);
 await f.send('Synthetic known anchor');
 f.failNextHostCommit('Synthetic failed turn marker');
 await assert.rejects(f.send('Synthetic failed turn marker'),/Synthetic host commit failure/);
 await f.restart();
 await f.send('Synthetic next explicit turn');
 assert.equal(f.requests.length,3,'only the three explicit chat requests may reach the provider');
 assert.match(JSON.stringify(f.requests[2].messages),/Synthetic known anchor/);
 assert.doesNotMatch(JSON.stringify(f.requests[2].messages),/failed turn marker|Synthetic reply 2/);
});

test('edited recall sources invalidate their frozen tails while the authorized prefix survives',async t=>{
 const f=await fixture(t);
 const source=await f.send('Quantum telescope calibration SECRET_RECALL_MARKER.');
 const conversationId=source.companion.activeConversationId;
 const sourceUser=source.companion.messages.find(message=>message.role==='user');
 await f.service.action('companion-conversation-new');
 await f.send('Synthetic clean anchor');
 await f.send('Remind me about the calibration of the telescope.');
 assert.ok(f.requests[2].messages.at(-1).content[0].text.includes('SECRET_RECALL_MARKER'));
 assert.ok(cachedPayloads(f.sidecar).some(payload=>payload.includes('SECRET_RECALL_MARKER')));
 await f.service.action('companion-settings',{allowUserMessageEdit:true});
 await f.service.action('companion-message-edit',{conversationId,id:sourceUser.id,occurrenceId:sourceUser.occurrenceId,text:'The instrument was updated.'});
 assert.ok(cachedPayloads(f.sidecar).every(payload=>!payload.includes('SECRET_RECALL_MARKER')),'the source edit must immediately remove affected cached rows');
 await f.send('Another question on a separate topic.');
 const rebuilt=f.requests[3];
 assert.equal(hash(JSON.stringify(rebuilt.messages[0])),hash(JSON.stringify(f.requests[1].messages[0])));
 assert.ok(!JSON.stringify(rebuilt.messages).includes('SECRET_RECALL_MARKER'));
});

test('R5 private chat inserts an evicted required original before a retained row outside the recent seed',async t=>{
 const f=await fixture(t);
 const earlier='R5 synthetic earlier anchor',retained='R5 synthetic retained anchor';
 const first=await f.send(earlier);
 const conversationId=first.companion.activeConversationId;
 const earlierId=first.companion.messages.find(row=>row.role==='user').id;
 const second=await f.send(retained);
 const retainedId=second.companion.messages.find(row=>row.role==='user'&&row.text===retained).id;
 for(let turn=0;turn<6;turn++)await f.send('R5 synthetic filler '+turn);
 await f.service.deletePrivateCache({conversationId});
 await f.send('R5 synthetic cold window');
 const filteredOrder=request=>request.messages.slice(0,-1).flatMap(message=>{
  const firstLine=message.content[0].text.split('\n',1)[0];
  return firstLine===earlier?['A']:firstLine===retained?['B']:[];
 });
 assert.deepEqual(filteredOrder(f.requests.at(-1)),['B'],'cold seed has B and has evicted A');

 // Request the original through the real memory store contract. The private
 // chat entry point does not currently expose required message IDs as inputs.
 const readMemory=f.store.readMemory.bind(f.store);
 let seedIds=[];
 t.mock.method(f.store,'readMemory',async(method,args,...options)=>{
  const requested=method==='context'&&args.privateCache&&!args.privateCache.validateOnly;
  const result=await readMemory(method,requested?{...args,requiredMessageIds:[earlierId]}:args,...options);
  if(requested)seedIds=result.value.privateCache.seed.map(row=>row.source.messageId);
  return result;
 });
 await f.send('R5 synthetic request for earlier original');
 assert.equal(seedIds.length,15,'one required original and fourteen recent source occurrences');
 assert.ok(seedIds.includes(earlierId));
 assert.ok(!seedIds.includes(retainedId),'B is retained by the cache beyond the recent seed');
 assert.deepEqual(filteredOrder(f.requests.at(-1)),['A','B'],'the old original must precede the retained standalone row');
});

test('API message prefixes survive Chat Completions, Responses, Gemini and Anthropic serialization',async t=>{
 for(const protocol of ['chat-completions','responses','gemini','anthropic']){
  const f=await fixture(t,{kind:'custom',protocol,wire:true});
  for(let index=1;index<=5;index++)await f.send('Synthetic wire question '+index);
  assert.equal(f.wireRequests.length,5);
  const payload=body=>body.messages??body.input??body.contents;
  const system=body=>body.system??body.instructions??body.systemInstruction;
  for(let index=1;index<f.wireRequests.length;index++){
   const prev=f.wireRequests[index-1],next=f.wireRequests[index];
   const stable=payload(prev),replay=payload(next);
   assert.equal(hash(JSON.stringify(replay.slice(0,stable.length))),hash(JSON.stringify(stable)),protocol);
   if(system(prev))assert.deepEqual(system(next),system(prev),protocol);
  }
 }
});

test('invalid sidecar preserves evidence while private chat continues with an empty cache',async t=>{
 const f=await fixture(t,{corruptSidecar:true});
 await f.send('Synthetic chat after corrupt sidecar');
 assert.equal(f.requests.length,1);
 const evidence=readdirSync(dirname(f.sidecar)).find(name=>name.startsWith(basename(f.sidecar)+'.corrupt-'));
 assert.ok(evidence);
 assert.equal(readFileSync(join(dirname(f.sidecar),evidence),'utf8'),'Synthetic corrupt cache evidence');
 assert.equal(cachedPayloads(f.sidecar).length,1);
});

test('the r21 reader opens cached data and deleting a covered occurrence invalidates its summary',async t=>{
 const f=await fixture(t);
 const first=await f.send('I am the only message containing DELETION_SENTINEL. '+'A'.repeat(2200));
 const owner=first.companion.activeConversationId,user=first.companion.messages.find(message=>message.role==='user');
 for(let index=0;index<16&&!f.requests.some(request=>request.purpose==='chat-window-compact');index++)
  await f.send('Synthetic archived segment '+index+' '+String.fromCharCode(65+index).repeat(2200));
 assert.ok(f.requests.at(-1).messages[0].content[0].text.includes('Synthetic compacted history'));
 await f.restart();
 // Storage reader and writer are unchanged from r21. Delete in the authoritative
 // writer just as its maintenance path does, leaving the newer sidecar intact.
 await f.store.mutate((_state,tx)=>assert.ok(tx.messages.delete('private',owner,user.id,{occurrenceId:user.occurrenceId})));
 await f.send('Synthetic question after authoritative deletion');
 const request=f.requests.at(-1);
 assert.ok(!JSON.stringify(request.messages).includes('DELETION_SENTINEL'));
 assert.ok(!JSON.stringify(request.messages).includes('Synthetic compacted history'));
});

test('rebuilding uses exact duplicate message occurrences and a separate Persona session',async t=>{
 const f=await fixture(t);
 const state=f.service.viewState(),owner=state.activeConversationId,firstPersona=state.activePersonaId;
 await f.store.mutate((next,tx)=>{
  const convo=next.conversations[owner];
  const at=Date.parse('2026-11-16T12:00:00Z');
  for(const [index,word] of ['OCCURRENCE_ONE','OCCURRENCE_TWO'].entries())
   tx.messages.append('private',owner,{id:'synthetic-repeated-id',role:'user',text:word,createdAt:at+index,status:'sent',lifeId:convo.lifeId},{preserveDuplicate:true});
 });
 await f.send('Synthetic occurrence inspection');
 const first=f.requests.at(-1);
 assert.equal(first.messages.filter(message=>message.content[0].text==='OCCURRENCE_ONE').length,1);
 assert.equal(first.messages.filter(message=>message.content[0].text==='OCCURRENCE_TWO').length,1);
 const {persona}=await f.service.action('companion-persona-save',{name:'Another synthetic identity'});
 assert.notEqual(persona.id,firstPersona);
 await f.service.action('companion-persona-select',{id:persona.id});
 await f.send('Synthetic new Persona chat');
 const second=f.requests.at(-1);
 assert.notEqual(second.cacheContext.sessionUuid,first.cacheContext.sessionUuid);
 assert.ok(!JSON.stringify(second.messages).includes('OCCURRENCE_'));
});

test('empty compaction is not resubmitted for the same old half after restart',async t=>{
 const f=await fixture(t,{rejectCompaction:true});
 for(let index=0;index<16&&!f.requests.some(request=>request.purpose==='chat-window-compact');index++){
  const run=f.send('Synthetic segment '+index+' '+String.fromCharCode(65+index).repeat(2200));
  try{await run;}catch(error){
   assert.match(error.message,/容量|produced no text/);
   break;
  }
 }
 assert.equal(f.requests.filter(request=>request.purpose==='chat-window-compact').length,1);
 await f.restart();
 await assert.doesNotReject(f.send('Synthetic manual question after a failed summary'));
 assert.equal(f.requests.filter(request=>request.purpose==='chat-window-compact').length,1);
});

test('oversized current API input still uses the existing query compression budget',async t=>{
 const capacity=12288,f=await fixture(t,{tokens:capacity});
 const source='SYNTHETIC_UNCOMPRESSED_MARKER '+'a'.repeat(36000);
 await f.send(source);
 const [request]=f.requests;
 const inputBytes=Buffer.byteLength(JSON.stringify([request.system,request.messages]),'utf8');
 assert.ok(inputBytes+1600<=capacity);
 assert.ok(request.messages.at(-1).content[0].text.includes('Bounded synthetic source summary.'));
 assert.ok(!JSON.stringify(request.messages).includes('SYNTHETIC_UNCOMPRESSED_MARKER'));
 assert.equal(f.service.viewState().messages.find(message=>message.role==='user').text.length,source.length);
});

test('a locked sidecar falls back and keeps the next ordinary private chat online',async t=>{
 const f=await fixture(t);
 await f.send('Synthetic chat creates the sidecar');
 const sha=hash(readFileSync(f.sidecar));
 const locker=new DatabaseSync(f.sidecar);
 locker.exec('BEGIN EXCLUSIVE');
 try{
  await f.send('Synthetic chat while the cache is locked');
  assert.equal(f.requests.length,2);
 }finally{
  locker.exec('ROLLBACK');
  locker.close();
 }
 assert.equal(hash(readFileSync(f.sidecar)),sha);
});

test('a non-persistent cache degrades to bounded history without submitting paid compaction',async t=>{
 const f=await fixture(t,{blockSidecar:true});
 for(let wave=0;wave<2;wave++){
  if(wave)await f.restart();
  for(let index=0;index<9;index++)await f.send('Synthetic capacity-limited '+index+' '+String.fromCharCode(65+index).repeat(2200));
 }
 assert.equal(f.requests.length,18);
 assert.ok(f.requests.every(request=>request.purpose!=='chat-window-compact'));
});

for(const protocol of ['chat-completions','responses']){
 test('truncated nonempty '+protocol+' summary is discarded and the same old half is not resubmitted after restart',async t=>{
  const f=await fixture(t,{kind:'custom',protocol,wire:true,truncateCompaction:true});
  for(let index=0;index<16&&!f.requests.length;index++){
   const result=await f.send('Synthetic capacity segment '+index+' '+String.fromCharCode(65+index).repeat(2200));
   assert.match(result.companion.messages.at(-1).text,/Synthetic wire reply/);
  }
  assert.equal(f.requests.length,1,'one summary reached the HTTP boundary');
  assert.ok(cachedPayloads(f.sidecar).every(payload=>!payload.includes(f.partialSummary)));
  assert.ok(f.audits.some(event=>event.type==='companion-cache-compaction-failed'));
  await f.restart();
  await f.send('Synthetic explicit chat after truncation');
  assert.equal(f.requests.length,1);
  assert.ok(!JSON.stringify(f.wireRequests.at(-1)).includes(f.partialSummary));
 });
}

test('a logically corrupt SQLite window is removed and does not break private chat',async t=>{
 const f=await fixture(t);
 await f.send('Synthetic chat creates a valid window');
 const editor=new DatabaseSync(f.sidecar);
 try{editor.exec("UPDATE api_windows SET payload=json_set(payload,'$.entries',json('[null]'))");}
 finally{editor.close();}
 await f.restart();
 await f.send('Synthetic fallback after invalid window');
 assert.equal(f.requests.length,2);
 assert.ok(f.audits.some(event=>event.type==='companion-cache-bad-row'));
 assert.ok(cachedPayloads(f.sidecar).every(payload=>!payload.includes('"entries":[null]')));
});

test('an empty API summary leaves the current reply online and audits compaction failure',async t=>{
 const f=await fixture(t,{rejectCompaction:true});
 for(let index=0;index<16&&!f.requests.some(request=>request.purpose==='chat-window-compact');index++){
  const result=await f.send('Synthetic segment '+index+' '+String.fromCharCode(65+index).repeat(2200));
  assert.match(result.companion.messages.at(-1).text,/Synthetic reply/);
 }
 assert.ok(f.requests.some(request=>request.purpose==='chat-window-compact'));
 assert.ok(f.audits.some(event=>event.type==='companion-cache-compaction-failed'&&event.code==='SUMMARY_REQUEST_FAILED'));
});

test('unchanged API memory blocks are omitted from the next frozen user message',async t=>{
 const f=await fixture(t);
 await f.send('Synthetic memory baseline');
 await f.send('Synthetic memory continuation');
 assert.match(f.requests[0].messages.at(-1).content[0].text,/"core"/);
 assert.doesNotMatch(f.requests[1].messages.at(-1).content[0].text,/"core"|"guide"|"corrections"/);
 assert.deepEqual(f.requests[1].messages.slice(0,f.requests[0].messages.length),f.requests[0].messages);
});

test('API cancellation retains the saved user anchor and preceding prefix across restart',async t=>{
 let stop=false;
 const f=await fixture(t,{onChat:async({store,service})=>{
  if(stop)await service.action('companion-chat-cancel',{conversationId:store.state.activeConversationId});
 }});
 await f.send('Synthetic confirmed anchor');
 stop=true;
 await assert.rejects(f.send('Synthetic interrupted anchor'));
 stop=false;
 await f.restart();
 await f.send('Synthetic next anchor');
 assert.equal(f.requests[2].cacheContext.sessionUuid,f.requests[0].cacheContext.sessionUuid);
 assert.deepEqual(f.requests[2].messages.slice(0,f.requests[0].messages.length),f.requests[0].messages);
 assert.match(JSON.stringify(f.requests[2].messages),/Synthetic interrupted anchor/);
 assert.doesNotMatch(JSON.stringify(f.requests[2].messages),/Synthetic reply 2/);
});

test('a private API reply proceeds across an unrelated conversation write',async t=>{
 let change=false,other;
 const f=await fixture(t,{onChat:async({store})=>{
  if(!change)return;
  change=false;
  await store.mutate((state,tx)=>tx.messages.append('private',other,{id:'unrelated-synthetic',role:'user',text:'Unrelated conversation update',createdAt:Date.now(),status:'sent',lifeId:state.conversations[other].lifeId}));
 }});
 const first=await f.send('Synthetic current conversation');
 const current=first.companion.activeConversationId;
 await f.service.action('companion-conversation-new');
 other=f.service.viewState().activeConversationId;
 await f.service.action('companion-conversation-select',{id:current});
 change=true;
 const result=await f.send('Synthetic private reply during background update');
 assert.match(result.companion.messages.at(-1).text,/Synthetic reply/);
 assert.deepEqual(f.requests.at(-1).messages.slice(0,f.requests[0].messages.length),f.requests[0].messages);
});

test('a soft thinking-only summary failure keeps the key and a bounded suffix during cooldown',async t=>{
 const thought='SYNTHETIC_THOUGHT_MARKER';
 const f=await fixture(t,{onCompact:async function*(){
  yield {type:'text-delta',text:'<think>'+thought+'</think>'};
 }});
 let question,deliveredReply,previousReply;
 for(let index=0;index<16&&!f.requests.some(request=>request.purpose==='chat-window-compact');index++){
  question='Synthetic segment '+index+' '+String.fromCharCode(65+index).repeat(2200);
  const result=await f.send(question);
  previousReply=deliveredReply;
  deliveredReply=result.companion.messages.at(-1).text;
  assert.match(deliveredReply,/Synthetic reply/);
 }
 const attempt=f.requests.findIndex(request=>request.purpose==='chat-window-compact');
 assert.ok(attempt>0);
 const before=f.requests[attempt-1],after=f.requests[attempt+1];
 assert.ok(f.audits.some(event=>event.type==='companion-cache-compaction-failed'&&event.code==='EMPTY_SUMMARY'&&!event.hard));
 assert.equal(after.cacheContext.sessionUuid,before.cacheContext.sessionUuid);
 assert.equal(after.purpose,before.purpose);
 assert.ok(after.messages.at(-1).content[0].text.startsWith(question+'\n'),'the original user still gets an ordinary request');
 const history=after.messages.slice(0,-1);
 const historyTokens=history.reduce((total,message)=>total+estimatePrivateMessageTokens(message),0);
 assert.ok(history.length>=2&&history.length<before.messages.length);
 assert.ok(historyTokens<=3200,'the fallback reaches the tier compression target');
 const priorSuffix=history.slice(0,-1);
 assert.equal(hash(JSON.stringify(priorSuffix)),hash(JSON.stringify(before.messages.slice(-priorSuffix.length))));
 assert.ok(history.at(-1).role==='assistant'&&history.at(-1).content[0].text.endsWith(previousReply));
 assert.ok(!JSON.stringify(after.messages).includes(thought));

 const followup='Synthetic followup during cooldown';
 const requestsBeforeFollowup=f.requests.length;
 const continued=await f.send(followup);
 assert.match(continued.companion.messages.at(-1).text,/Synthetic reply/);
 assert.equal(f.requests.length,requestsBeforeFollowup+1,'cooldown allows only the next ordinary request');
 const subsequent=f.requests.at(-1);
 assert.equal(subsequent.cacheContext.sessionUuid,before.cacheContext.sessionUuid);
 assert.equal(hash(JSON.stringify(subsequent.messages.slice(0,after.messages.length))),hash(JSON.stringify(after.messages)));
 assert.ok(subsequent.messages.at(-1).content[0].text.startsWith(followup+'\n'));
 assert.ok(!JSON.stringify(subsequent.messages).includes(thought));
 assert.ok(cachedPayloads(f.sidecar).every(payload=>!payload.includes(thought)));
 t.diagnostic(JSON.stringify({historyTokens,retainedRows:history.length,summaryAttempts:f.requests.filter(row=>row.purpose==='chat-window-compact').length,followupRequests:f.requests.length-requestsBeforeFollowup}));
});

test('an oversized API summary is sentence-clipped and preserves a normal answer',async t=>{
 const f=await fixture(t,{official:true,tokens:262144,onCompact:async function*(){
  yield {type:'text-delta',text:'Synthetic leading sentence. '+ '数据过长。'.repeat(600)+'SYNTHETIC_LONG_TAIL'};
 }});
 for(let index=0;index<30&&!f.requests.some(request=>request.purpose==='chat-window-compact');index++){
  const result=await f.send('合成历史对话 '+index+' '+String.fromCodePoint(20320+index).repeat(2200));
  assert.match(result.companion.messages.at(-1).text,/Synthetic reply/);
 }
 const attempt=f.requests.findIndex(request=>request.purpose==='chat-window-compact');
 assert.ok(attempt>10);
 const summary=f.requests[attempt+1].messages[0].content[0].text;
 assert.match(summary,/Synthetic leading sentence/);
 assert.match(summary,/。 \[Summary shortened\]$/);
 assert.doesNotMatch(summary,/SYNTHETIC_LONG_TAIL/);
 assert.ok(Buffer.byteLength(summary)<=4096+128);
});

test('a source revoked after request preparation is absent from the rebuilt API request',async t=>{
 let revoke=false,source;
 const f=await fixture(t,{onChat:async({store})=>{
  if(!revoke)return;
  revoke=false;
  await store.mutate((_state,tx)=>tx.messages.delete('private',source.conversationId,source.id,{occurrenceId:source.occurrenceId}));
 }});
 const old=await f.send('Quantum telescope calibration SYNTHETIC_REVOKE_MARKER.');
 source={conversationId:old.companion.activeConversationId,...old.companion.messages.find(row=>row.role==='user')};
 await f.service.action('companion-conversation-new');
 await f.send('Synthetic authorized prefix');
 revoke=true;
 await f.send('Remind me about the calibration of the telescope.');
 assert.equal(f.requests.length,3,'a stale pre-submit check must prevent its HTTP attempt');
 assert.doesNotMatch(JSON.stringify(f.requests.at(-1).messages),/SYNTHETIC_REVOKE_MARKER/);
 assert.match(JSON.stringify(f.requests.at(-1).messages),/Synthetic authorized prefix/);
});

test('a dependent source deleted during an in-flight request skips cache commit but preserves the answer',async t=>{
 let revoke=false,source;
 const f=await fixture(t,{onChatInFlight:async({store})=>{
  if(!revoke)return;
  revoke=false;
  await store.mutate((_state,tx)=>tx.messages.delete('private',source.conversationId,source.id,{occurrenceId:source.occurrenceId}));
 }});
 const old=await f.send('Quantum telescope calibration SYNTHETIC_INFLIGHT_MARKER.');
 source={conversationId:old.companion.activeConversationId,...old.companion.messages.find(row=>row.role==='user')};
 await f.service.action('companion-conversation-new');
 await f.send('Synthetic authorized prefix');
 revoke=true;
 const result=await f.send('Remind me about the calibration of the telescope.');
 assert.match(result.companion.messages.at(-1).text,/Synthetic reply/);
 assert.match(JSON.stringify(f.requests.at(-1).messages),/SYNTHETIC_INFLIGHT_MARKER/);
 assert.ok(f.audits.some(event=>event.type==='companion-cache-commit-error'&&event.code==='MEMORY_SOURCE_CHANGED'));
 await f.send('Synthetic next safe question');
 assert.doesNotMatch(JSON.stringify(f.requests.at(-1).messages),/SYNTHETIC_INFLIGHT_MARKER/);
});

test('an oversized custom summary is clipped to its tier and keeps a usable answer',async t=>{
 const f=await fixture(t,{onCompact:async function*(){
  yield {type:'text-delta',text:'SYNTHETIC_INSUFFICIENT_GAIN. '+ '审计摘要太长。'.repeat(600)};
 }});
 for(let index=0;index<16&&!f.requests.some(request=>request.purpose==='chat-window-compact');index++){
  const result=await f.send('Synthetic segment '+index+' '+String.fromCharCode(65+index).repeat(2200));
  assert.match(result.companion.messages.at(-1).text,/Synthetic reply/);
 }
 const summary=f.requests.at(-1).messages[0].content[0].text;
 assert.match(summary,/SYNTHETIC_INSUFFICIENT_GAIN/);
 assert.match(summary,/Summary shortened/);
 assert.ok(Buffer.byteLength(summary)<2200);
 assert.ok(!f.audits.some(event=>event.type==='companion-cache-compaction-failed'));
});

test('a newly derived correction appends only its changed memory block',async t=>{
 const f=await fixture(t);
 await f.send('你的生日是五月。');
 await f.send('你记错了，实际上生日是六月。');
 await f.send('Synthetic followup about the birthday');
 const prior=f.requests[1],current=f.requests[2];
 assert.deepEqual(current.messages.slice(0,prior.messages.length),prior.messages);
 const tail=current.messages.at(-1).content[0].text;
 assert.match(tail,/"corrections":\[\{/);
 assert.doesNotMatch(tail,/"core"|"guide"/);
});

test('a revoked dependency blocks a provider follow-up without repeating its first submission',async t=>{
 let revoke=false,source,followups=0;
 const f=await fixture(t,{onChatInFlight:async({store,options})=>{
  if(!revoke)return;
  revoke=false;
  options.onTiming({name:'request-submitted'});
  await store.mutate((_state,tx)=>tx.messages.delete('private',source.conversationId,source.id,{occurrenceId:source.occurrenceId}));
  await options.checkModelSubmit();
  followups++;
 }});
 const old=await f.send('Quantum telescope calibration SYNTHETIC_FOLLOWUP_MARKER.');
 source={conversationId:old.companion.activeConversationId,...old.companion.messages.find(row=>row.role==='user')};
 await f.service.action('companion-conversation-new');
 await f.send('Synthetic authorized prefix');
 revoke=true;
 await assert.rejects(f.send('Remind me about the calibration of the telescope.'),/sources changed/);
 assert.equal(followups,0);
 assert.equal(f.requests.length,3,'the first provider submission was not repeated');
});

test('Codex thread advances only after host save and is discarded when host save fails',async t=>{
 const f=await fixture(t,{kind:'codex'});
 await f.send('Synthetic committed turn');
 assert.equal(f.nativeEvents.length,1);
 assert.equal(f.nativeEvents[0].type,'commit');
 assert.equal(f.nativeEvents[0].lastMessageId,f.requests[0].cacheContext.native.requestId+':reply');
 assert.match(f.nativeEvents[0].historyHash,/^[a-f0-9]{64}$/);
 f.failNextHostCommit('Synthetic failed host save');
 await assert.rejects(f.send('Synthetic failed host save'),/Synthetic host commit failure/);
 assert.deepEqual(f.nativeEvents.map(row=>row.type),['commit','discard']);
 assert.equal(f.nativeEvents[1].requestId,f.requests[1].cacheContext.native.requestId);
});

test('explicit deleted-scope cleanup forwards only that scope and resets its private window',async t=>{
 const f=await fixture(t,{kind:'codex'});
 await f.send('Synthetic private deletion boundary');
 const conversationId=f.store.state.activeConversationId;
 assert.equal(typeof f.service.deletePrivateCache,'function');
 await f.service.deletePrivateCache({conversationId});
 assert.deepEqual(f.nativeEvents.at(-1),{type:'delete',selector:{conversationId}});
 await f.send('Synthetic post-deletion window');
 assert.notEqual(f.requests[1].cacheContext.sessionUuid,f.requests[0].cacheContext.sessionUuid);
 await assert.rejects(f.service.deletePrivateCache({}),/Invalid private cache deletion scope/);
});

for(const transition of ['model before stop','model after stop','instructions','edited tail','failed host commit','r21 first API request'])test('R4 interrupted history stays complete and in local order: '+transition,async t=>{
 let stop=false;
 const f=await fixture(t,{onChatInFlight:async({store,service})=>{
  if(stop)await service.action('companion-chat-cancel',{conversationId:store.state.activeConversationId});
 }});
 if(transition==='r21 first API request')f.profile.protocol='legacy-fixture';
 const first=await f.send('R4 first user');
 await f.send('R4 second user');
 if(transition==='model before stop')f.profile.model='synthetic-2';
 if(transition==='instructions')f.setStyle('detailed');
 if(transition==='edited tail'){
  await f.service.action('companion-settings',{allowUserMessageEdit:true});
  const row=first.companion.messages.find(row=>row.text==='R4 first user');
  await f.service.action('companion-message-edit',{conversationId:first.companion.activeConversationId,id:row.id,occurrenceId:row.occurrenceId,text:'R4 edited first user'});
 }
 if(transition==='failed host commit'){
  f.failNextHostCommit('R4 unknown turn');
  await assert.rejects(f.send('R4 unknown turn'),/Synthetic host commit failure/);
  f.profile.protocol='legacy-fixture';
  await f.send('R4 local-only user');
  f.profile.protocol='chat-completions';
 }
 stop=true;
 await assert.rejects(f.send('R4 stopped user'),/用户停止回复/);
 stop=false;
 if(transition==='model after stop')f.profile.model='synthetic-2';
 if(transition==='r21 first API request'){
  await f.restart();
  f.profile.protocol='chat-completions';
 }
 await f.send('R4 last user');
 const texts=f.requests.at(-1).messages.map(row=>row.content[0].text.split('\n')[0].replace(/^\[\[emotion:[^\]]+\]\]/,''));
 assert.deepEqual(texts,[transition==='edited tail'?'R4 edited first user':'R4 first user','Synthetic reply 1','R4 second user','Synthetic reply 2',...(transition==='failed host commit'?['R4 local-only user','Synthetic reply 4']:[]),'R4 stopped user','R4 last user']);
});


test('R4 a synthetic summary taking 21 seconds stays inside the chat deadline',async t=>{
 const timeout=AbortSignal.timeout.bind(AbortSignal),timeouts=[];
 t.mock.method(AbortSignal,'timeout',duration=>{
  timeouts.push(duration);
  return duration===20000?AbortSignal.abort(new DOMException('Synthetic 21-second completion','TimeoutError')):timeout(duration);
 });
 const f=await fixture(t);
 for(let index=0;index<16&&!f.requests.some(row=>row.purpose==='chat-window-compact');index++)
  await f.send('R4 synthetic segment '+index+' '+String.fromCharCode(65+index).repeat(2200));
 assert.ok(timeouts.includes(110000));
 assert.ok(f.requests.some(row=>row.purpose==='chat-window-compact'));
 assert.match(f.requests.at(-1).messages[0].content[0].text,/Synthetic compacted history/);
});

test('R4 a summary timeout is a soft failure and the ordinary reply gets its own deadline',async t=>{
 const set=setTimeout,clear=clearTimeout;
 const tracked=new Map(),summaryClock=new AbortController();
 const timeout=AbortSignal.timeout.bind(AbortSignal);
 t.mock.method(globalThis,'setTimeout',(fn,duration,...args)=>{
  const timer=set(fn,duration,...args);
  if(duration===110000)tracked.set(timer,()=>fn(...args));
  return timer;
 });
 t.mock.method(globalThis,'clearTimeout',timer=>{tracked.delete(timer);clear(timer);});
 t.mock.method(AbortSignal,'timeout',duration=>duration===110000?summaryClock.signal:timeout(duration));
 const f=await fixture(t,{async *onCompact(){
  // The surrounding chat deadline would fire just before the summary's
  // deadline if it were allowed to run simultaneously.
  for(const expire of tracked.values())expire();
  summaryClock.abort(new DOMException('Synthetic summary timed out','TimeoutError'));
 }});
 for(let index=0;index<16&&!f.requests.some(row=>row.purpose==='chat-window-compact');index++){
  const result=await f.send('R4 synthetic slow segment '+index+' '+String.fromCharCode(65+index).repeat(2200));
  assert.match(result.companion.messages.at(-1).text,/Synthetic reply/);
 }
 assert.ok(f.audits.some(event=>event.type==='companion-cache-compaction-failed'&&!event.hard));
 assert.equal(f.requests.at(-1).purpose,undefined);
});
