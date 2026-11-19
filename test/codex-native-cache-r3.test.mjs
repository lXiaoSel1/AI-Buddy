import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as tick} from 'node:timers/promises';
import {CodexProvider} from '../src/codex-provider.mjs';
import {codexHistoryHash} from '../src/codex-thread-wire.mjs';
import {LocalMonitor} from '../src/monitor.mjs';

const scope={connectionId:'private-model',characterId:'char',lifeId:'life',personaId:'identity',conversationId:'private-conversation'};
const user=content=>({role:'user',content});
const assistant=content=>({role:'assistant',content});

async function fixture(t,extra={}){
  const {handleRequest,turnText=id=>'reply-'+id,...providerOptions}=extra;
  const root=await mkdtemp(join(tmpdir(),'buddy-native-r3-')),requests=[],children=[],rows=new Map();
  let nextThread=0,nextTurn=0;
  const nativeStore={
    async read(key){return structuredClone(rows.get(key));},
    async list(){return [...rows].map(([key,value])=>({key,value:structuredClone(value)}));},
    async write(key,value){rows.set(key,structuredClone(value));return true;},
    async remove(key){return rows.delete(key);},
    async close(){},
  };
  const options={
    binary:'fixture.exe',defaultModel:'fixture-model',dataRoot:join(root,'data'),
    env:{USERPROFILE:root,CODEX_HOME:join(root,'empty-home')},
    nativeStore,handshakeTimeoutMs:150,turnTimeoutMs:500,
    spawnImpl(binary,args){
      const child=new EventEmitter();
      Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),
        exited:false,kill(){child.emit('exit',1);}});
      children.push({binary,args,child});
      child.once('exit',()=>{child.exited=true;});
      child.stdin.once('end',()=>child.emit('exit',0));
      const notify=(method,params)=>child.stdout.write(JSON.stringify({method,params})+'\n');
      child.stdin.on('data',data=>{
        const message=JSON.parse(String(data));requests.push(message);
        if(message.id===undefined)return;
        const override=handleRequest?.(message,notify);
        if(override instanceof Error){
          child.stdout.write(JSON.stringify({id:message.id,error:{message:override.message}})+'\n');
          return;
        }
        let result={};
        if(message.method==='account/read')result={account:{type:'chatgpt'}};
        if(message.method==='thread/start')result={thread:{id:'thread-'+(++nextThread),modelProvider:'openai'}};
        if(message.method==='thread/resume')result={thread:{id:message.params.threadId,modelProvider:'openai'}};
        if(message.method==='turn/start'){
          const threadId=message.params.threadId,id='turn-'+(++nextTurn);
          result={turn:{id}};
          queueMicrotask(()=>{
            const itemId='message-'+id,text=turnText(id);
            notify('item/agentMessage/delta',{threadId,turnId:id,itemId,delta:text.slice(0,3)});
            notify('item/completed',{threadId,turnId:id,item:{id:itemId,type:'agentMessage',text}});
            notify('turn/completed',{threadId,turn:{id,status:'completed'}});
          });
        }
        child.stdout.write(JSON.stringify({id:message.id,result:override??result})+'\n');
      });
      queueMicrotask(()=>child.emit('spawn'));
      return child;
    },
    ...providerOptions,
  };
  const providers=[];
  const open=()=>{const provider=new CodexProvider(options);providers.push(provider);provider.setEnabled(true);return provider;};
  const byMethod=method=>requests.filter(row=>row.method===method).map(row=>row.params);
  t.after(async()=>{await Promise.all(providers.map(provider=>provider.close()));await rm(root,{recursive:true,force:true});});
  return {open,byMethod,requests,children,nativeStore};
}

async function chat(provider,number,retained=[],parentMessageId=null,extra={}){
  const current=user('current-'+number+'\n[time: fixed]');
  let receipt;
  const options={
    system:'private instructions',
    messages:[...retained,current],
    cacheContext:{native:{scope,requestId:'request-'+number,parentMessageId,historyHash:codexHistoryHash(retained)}},
    onNativeThread:value=>{receipt=value;},
    ...extra,
  };
  let output='';
  for await(const part of provider.streamForConnection(scope.connectionId,options)){
    if(part.type==='text-delta')output+=part.text;
  }
  return {output,receipt,completed:[...retained,current,assistant(output)]};
}

test('native private wire freezes reasoning, disables memory generation and sends only current input',async t=>{
  const fixtureRun=await fixture(t),provider=fixtureRun.open();
  await chat(provider,1,[user('earlier user'),assistant('earlier assistant')],null,{reasoningEffort:'high',serviceTier:'priority'});
  const [thread]=fixtureRun.byMethod('thread/start'),[turn]=fixtureRun.byMethod('turn/start');
  assert.equal(Object.hasOwn(thread,'ephemeral'),false);
  assert.equal(thread.config.model_reasoning_effort,'high');
  assert.equal(thread.config.model_reasoning_summary,'concise');
  assert.equal(thread.config['memories.generate_memories'],false);
  assert.equal(thread.serviceTier,'priority');
  assert.equal(turn.serviceTier,'priority');
  assert.equal(turn.effort,'high');
  assert.equal(turn.summary,'concise');
  assert.equal(Object.hasOwn(turn,'config'),false);
  assert.equal(Object.hasOwn(turn,'developerInstructions'),false);
  assert.equal(Object.hasOwn(turn,'additionalContext'),false);
  assert.equal(turn.input[0].text,'[user] current-1\n[time: fixed]');
});

test('three host-committed private rounds use one native thread and one process',async t=>{
  const fixtureRun=await fixture(t),provider=fixtureRun.open();
  let retained=[],parent=null;
  for(let number=1;number<=3;number++){
    const round=await chat(provider,number,retained,parent);
    assert.deepEqual(round.receipt,{threadId:'thread-1',requestId:'request-'+number});
    retained=round.completed;
    parent='reply-id-'+number;
    assert.equal(await provider.commitPrivateThread('request-'+number,{lastMessageId:parent,historyHash:codexHistoryHash(retained)}),true);
  }
  assert.equal(fixtureRun.byMethod('thread/start').length,1);
  assert.equal(fixtureRun.byMethod('thread/resume').length,0);
  assert.equal(fixtureRun.byMethod('thread/inject_items').length,0);
  assert.equal(fixtureRun.children.length,1);
  assert.deepEqual(fixtureRun.byMethod('turn/start').map(turn=>turn.threadId),['thread-1','thread-1','thread-1']);
});

test('a new provider resumes the archived private thread with the same pinned fields',async t=>{
  const fixtureRun=await fixture(t),first=fixtureRun.open();
  const round=await chat(first,1,[],null,{reasoningEffort:'high'});
  await first.commitPrivateThread('request-1',{lastMessageId:'reply-id-1',historyHash:codexHistoryHash(round.completed)});
  await first.close();
  const second=fixtureRun.open();
  const next=await chat(second,2,round.completed,'reply-id-1',{reasoningEffort:'high'});
  assert.equal(next.receipt.threadId,round.receipt.threadId);
  assert.deepEqual(fixtureRun.byMethod('thread/archive'),[{threadId:'thread-1'}]);
  assert.deepEqual(fixtureRun.byMethod('thread/unarchive'),[{threadId:'thread-1'}]);
  const [start]=fixtureRun.byMethod('thread/start');
  const [{threadId,excludeTurns,...resume}]=fixtureRun.byMethod('thread/resume');
  assert.deepEqual(resume,start);
  assert.equal(excludeTurns,true);
  assert.equal(threadId,'thread-1');
  assert.equal(fixtureRun.children.length,2);
});

test('editing and compacting private history archives each superseded thread and injects the legal retained window',async t=>{
  const fixtureRun=await fixture(t),provider=fixtureRun.open();
  const first=await chat(provider,1);
  await provider.commitPrivateThread('request-1',{lastMessageId:'reply-id-1'});
  const edited=[user('edited question'),first.completed[1]];
  const second=await chat(provider,2,edited,'reply-id-1');
  assert.equal(second.receipt.threadId,'thread-2');
  await provider.commitPrivateThread('request-2',{lastMessageId:'reply-id-2'});
  const compacted=[user('historical summary'),user('complete memory state'),assistant('retained answer')];
  const third=await chat(provider,3,compacted,'reply-id-2');
  assert.equal(third.receipt.threadId,'thread-3');
  assert.deepEqual(fixtureRun.byMethod('thread/archive'),[{threadId:'thread-1'},{threadId:'thread-2'}]);
  const injected=fixtureRun.byMethod('thread/inject_items');
  assert.deepEqual(injected.map(value=>value.threadId),['thread-2','thread-3']);
  assert.deepEqual(injected[0].items.map(value=>value.content[0].text),['edited question','reply-turn-1']);
  assert.deepEqual(injected[1].items,[
    {role:'user',type:'message',content:[{type:'input_text',text:'historical summary'}]},
    {role:'user',type:'message',content:[{type:'input_text',text:'complete memory state'}]},
    {role:'assistant',type:'message',content:[{type:'output_text',text:'retained answer'}]},
  ]);
  const methods=fixtureRun.requests.map(row=>row.method);
  assert.ok(methods.indexOf('thread/archive')<methods.indexOf('thread/start',methods.indexOf('thread/start')+1));
});

test('one-shot tasks unsubscribe their ephemeral thread before the next model request',async t=>{
  const fixtureRun=await fixture(t),provider=fixtureRun.open();
  for(let index=0;index<2;index++)for await(const part of provider.stream({messages:[user('title task')]}))assert.ok(part.type);
  assert.equal(fixtureRun.children.length,1);
  assert.ok(fixtureRun.byMethod('thread/start').every(thread=>thread.ephemeral===true));
  assert.deepEqual(fixtureRun.byMethod('thread/unsubscribe'),[{threadId:'thread-1'},{threadId:'thread-2'}]);
  const methods=fixtureRun.requests.map(row=>row.method);
  assert.ok(methods.indexOf('thread/unsubscribe')<methods.indexOf('thread/start',methods.indexOf('thread/start')+1));
});

test('unrelated connection keys and ordinary native search share one executable process',async t=>{
  const fixtureRun=await fixture(t,{binary:async()=> 'same-fixture.exe'}),provider=fixtureRun.open();
  await chat(provider,1);
  for(const [connectionId,nativeSearch] of [['background',undefined],['other-chat',{allowed:true}]]){
    for await(const part of provider.streamForConnection(connectionId,{messages:[user('separate request')],nativeSearch}))assert.ok(part.type);
  }
  assert.equal(fixtureRun.children.length,1);
  assert.equal(fixtureRun.byMethod('initialize').length,1);
});

test('private idle time archives the thread after 30 minutes and closes the empty process 60 seconds later',async t=>{
  let now=0,nextId=0;
  const timers=new Map();
  const clock={
    setTimeout(run,delay){const id=++nextId;timers.set(id,{due:now+delay,run});return id;},
    clearTimeout(id){timers.delete(id);},
    async advance(ms){
      now+=ms;
      for(const [id,timer] of timers)if(timer.due<=now){timers.delete(id);timer.run();}
      await tick();
    },
  };
  const fixtureRun=await fixture(t,{clock}),provider=fixtureRun.open();
  await chat(provider,1);
  const [{child,args}]=fixtureRun.children;
  const halfHour=30*60*1000;
  await clock.advance(halfHour-1);
  assert.deepEqual(fixtureRun.byMethod('thread/archive'),[]);
  await clock.advance(1);
  assert.deepEqual(fixtureRun.byMethod('thread/archive'),[{threadId:'thread-1'}]);
  assert.equal(child.exited,false);
  await clock.advance(59999);
  assert.equal(child.exited,false);
  await clock.advance(1);
  assert.equal(child.exited,true);
  assert.ok(args.includes('thread_unload_delay_secs=0'));
});

test('startup only terminates exact stale app-owned process identities before recovering private threads',async t=>{
  const inspected=[],killed=[];
  const pidBase=420000;
  const processRows=[
    {pid:pidBase+1,creationTime:'111',executable:'C:\\Fixture\\codex.exe',ownerSid:'owner-a',hostPid:pidBase+10},
    {pid:pidBase+2,creationTime:'111',executable:'C:\\Fixture\\codex.exe',ownerSid:'owner-a',hostPid:pidBase+11},
  ];
  const osProcesses={
    async inspect(pid){
      inspected.push(pid);
      const record=processRows.find(row=>row.pid===pid);
      return record?{...record,ownerSid:record.pid===pidBase+1?'other-user':record.ownerSid}:null;
    },
    async killTree(record){killed.push(record.pid);return true;},
  };
  const fixtureRun=await fixture(t,{osProcesses});
  for(const row of processRows)await fixtureRun.nativeStore.write('process:'+row.pid,{owner:'ai-buddy-codex-app-server',...row});
  await fixtureRun.nativeStore.write('thread:crash-thread',{threadId:'crash-thread',scope,state:'confirmed',archived:false});
  await fixtureRun.nativeStore.write('calibration:1',{threadId:'unrelated-user-thread',scope,archived:false});
  const provider=fixtureRun.open();
  await provider.recoverOwnedState();
  assert.deepEqual(killed,[pidBase+2]);
  assert.ok(inspected.includes(pidBase+1)&&inspected.includes(pidBase+2));
  assert.deepEqual(fixtureRun.byMethod('thread/archive'),[{threadId:'crash-thread'}]);
  assert.deepEqual(fixtureRun.byMethod('thread/list'),[]);
  assert.equal(fixtureRun.children[0].child.exited,true);
  await provider.recoverOwnedState();
  assert.equal(fixtureRun.children.length,1);
});

test('resume waits for its own closing notification and retries exactly once',async t=>{
  let attempts=0;
  const fixtureRun=await fixture(t,{handleRequest:(message,notify)=>{
    if(message.method==='thread/resume'&&++attempts===1){
      const {threadId}=message.params;
      queueMicrotask(()=>{
        notify('thread/closed',{threadId:'different-thread'});
        notify('thread/closed',{threadId});
      });
      return Error('thread '+threadId+' is closing; retry thread/resume after the thread is closed');
    }
  }});
  const first=fixtureRun.open();
  const round=await chat(first,1);
  await first.commitPrivateThread('request-1',{lastMessageId:'reply-id-1'});
  await first.close();
  const second=fixtureRun.open();
  const next=await chat(second,2,round.completed,'reply-id-1');
  assert.equal(next.receipt.threadId,round.receipt.threadId);
  assert.equal(attempts,2);
  assert.equal(fixtureRun.byMethod('thread/start').length,1);
});

test('only a genuinely different search executable starts a second chat process',async t=>{
  const fixtureRun=await fixture(t,{binary:async({requireSearchHost})=>requireSearchHost?'search-fixture.exe':'ordinary-fixture.exe'});
  const provider=fixtureRun.open();
  await chat(provider,1);
  for(let number=0;number<2;number++){
    for await(const part of provider.streamForConnection('search-'+number,{messages:[user('search')],nativeSearch:{allowed:true}}))assert.ok(part.type);
  }
  assert.deepEqual(fixtureRun.children.map(child=>child.binary),['ordinary-fixture.exe','search-fixture.exe']);
  assert.ok(fixtureRun.children.every(child=>!child.child.exited));
});

test('a rejected injection falls back before submitting one full-window turn',async t=>{
  const fixtureRun=await fixture(t,{handleRequest:message=>message.method==='thread/inject_items'?Error('injection unsupported'):undefined});
  const provider=fixtureRun.open();
  const result=await chat(provider,1,[user('retained question'),assistant('retained answer')]);
  assert.equal(result.receipt.threadId,'thread-2');
  assert.deepEqual(fixtureRun.byMethod('thread/archive'),[{threadId:'thread-1'}]);
  const [turn,...rest]=fixtureRun.byMethod('turn/start');
  assert.deepEqual(rest,[]);
  assert.match(turn.input[0].text,/retained question.*retained answer.*current-1/s);
});

test('explicit private deletion fences recovery and retries its own thread after restart',async t=>{
  let rejectDelete=true;
  const fixtureRun=await fixture(t,{handleRequest:message=>message.method==='thread/delete'&&rejectDelete?Error('delete temporarily unavailable'):undefined});
  const provider=fixtureRun.open();
  const first=await chat(provider,1);
  await provider.commitPrivateThread('request-1',{lastMessageId:'reply-id-1'});
  await provider.deletePrivateThreads({conversationId:scope.conversationId});
  assert.equal((await fixtureRun.nativeStore.read('thread:'+first.receipt.threadId)).state,'delete-pending');
  await provider.close();
  assert.deepEqual(fixtureRun.byMethod('thread/delete'),[{threadId:'thread-1'},{threadId:'thread-1'}]);
  rejectDelete=false;
  const second=fixtureRun.open();
  await second.start();
  await tick();
  assert.deepEqual(fixtureRun.byMethod('thread/delete'),[{threadId:'thread-1'},{threadId:'thread-1'},{threadId:'thread-1'}]);
  assert.equal(await fixtureRun.nativeStore.read('thread:thread-1'),undefined);
  const next=await chat(second,2,first.completed,'reply-id-1');
  assert.notEqual(next.receipt.threadId,first.receipt.threadId);
});

test('automatic private effort resolves from the catalog then stays frozen across a new process',async t=>{
  let defaultReasoningEffort='high';
  const fixtureRun=await fixture(t,{handleRequest:message=>message.method==='model/list'?
    {data:[{id:'fixture-model',defaultReasoningEffort}],nextCursor:null}:undefined});
  const first=fixtureRun.open();
  const round=await chat(first,1,[],null,{reasoningEffort:'auto'});
  await first.commitPrivateThread('request-1',{lastMessageId:'reply-id-1'});
  await first.close();
  defaultReasoningEffort='medium';
  const second=fixtureRun.open();
  const resumed=await chat(second,2,round.completed,'reply-id-1',{reasoningEffort:'auto'});
  assert.equal(resumed.receipt.threadId,round.receipt.threadId);
  assert.equal(fixtureRun.byMethod('model/list').length,1);
  assert.deepEqual(fixtureRun.byMethod('turn/start').map(turn=>[turn.effort,turn.summary,turn.serviceTier]),
    [['high','concise',null],['high','concise',null]]);
  const [start]=fixtureRun.byMethod('thread/start');
  assert.equal(start.config.model_reasoning_effort,'high');
  assert.equal(start.config.model_reasoning_summary,'concise');
  assert.equal(start.serviceTier,null);
});

test('host trimming of streamed outer whitespace preserves the committed private thread',async t=>{
  const fixtureRun=await fixture(t,{turnText:id=>' \n reply-'+id+' \t'}),provider=fixtureRun.open();
  const first=await chat(provider,1);
  assert.equal(first.output,' \n reply-turn-1 \t');
  const retained=[...first.completed.slice(0,-1),assistant(first.output.trim())];
  assert.equal(await provider.commitPrivateThread('request-1',{lastMessageId:'reply-id-1',historyHash:codexHistoryHash(retained)}),true);
  const next=await chat(provider,2,retained,'reply-id-1');
  assert.equal(next.receipt.threadId,first.receipt.threadId);
  assert.deepEqual(fixtureRun.byMethod('thread/inject_items'),[]);
  assert.match(fixtureRun.byMethod('turn/start')[1].input[0].text,/^\[user\] current-2\n/);
  const altered=[...next.completed.slice(0,-1),assistant('different reply')];
  assert.equal(await provider.commitPrivateThread('request-2',{lastMessageId:'reply-id-2',historyHash:codexHistoryHash(altered)}),false);
  assert.deepEqual(fixtureRun.byMethod('thread/archive'),[{threadId:first.receipt.threadId}]);
});

function nativeUsagePeer(samples){
  let index=0;
  return (message,notify)=>{
    if(message.method!=='turn/start')return;
    const {threadId}=message.params;
    const tokenUsage=samples[index++];
    notify('thread/tokenUsage/updated',{threadId,turnId:'turn-'+index,tokenUsage});
  };
}

test('private native streaming yields finish before starting calibration and returns while calibration is pending',{timeout:2000},async t=>{
  const calibration=Promise.withResolvers(),finish=Promise.withResolvers(),release=Promise.withResolvers(),events=[];
  const usage={inputTokens:42,outputTokens:3,totalTokens:45};
  const run=await fixture(t,{handleRequest:nativeUsagePeer([{total:usage,last:usage}]),audit:event=>events.push(event)});
  const provider=run.open();
  let returned=false;
  const consuming=(async()=>{
    for await(const part of provider.streamForConnection(scope.connectionId,{
      messages:[user('private calibration fixture')],
      cacheContext:{native:{scope,requestId:'calibration',historyHash:codexHistoryHash([])}},
      async onPromptUsage(tokens){
        calibration.resolve(tokens);
        await release.promise;
        throw Error('synthetic calibration rejection');
      },
    })){
      if(part.type==='finish'){finish.resolve();break;}
    }
    returned=true;
  })();
  try{
    const first=await Promise.race([finish.promise.then(()=>'finish'),calibration.promise.then(()=>'calibration')]);
    assert.equal(first,'finish');
    await tick();
    assert.equal(returned,true);
    assert.equal(await calibration.promise,42);
  }finally{
    release.resolve();
    await consuming;
  }
  await tick();
  assert.equal(events.filter(event=>event.type==='codex-native-prompt-usage-failed').length,1);
});

test('returning from a private native stream before finish skips calibration',async t=>{
  const usage={inputTokens:42,outputTokens:3,totalTokens:45};
  const run=await fixture(t,{handleRequest:nativeUsagePeer([{total:usage,last:usage}])});
  const provider=run.open();
  const calibration=[];
  let partial=false;
  for await(const part of provider.streamForConnection(scope.connectionId,{
    messages:[user('private calibration fixture')],
    cacheContext:{native:{scope,requestId:'truncated-calibration',historyHash:codexHistoryHash([])}},
    onPromptUsage:tokens=>calibration.push(tokens),
  })){
    if(part.type==='text-delta'){partial=true;break;}
  }
  await provider.close();
  assert.equal(partial,true);
  assert.deepEqual(calibration,[]);
});

test('companion monitor counts cumulative native usage as per-turn deltas and calibration receives only last input',async t=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'buddy-native-usage-r3-'));
  const monitor=new LocalMonitor({roots:[],dataRoot});
  t.after(async()=>{await monitor.close();await rm(dataRoot,{recursive:true,force:true});});
  const input=[100,180,45],output=[10,14,3],calibration=[];
  let cumulativeInput=0,cumulativeOutput=0;
  const samples=input.map((inputTokens,index)=>{
    const outputTokens=output[index];
    cumulativeInput+=inputTokens;cumulativeOutput+=outputTokens;
    return {
      total:{inputTokens:cumulativeInput,outputTokens:cumulativeOutput,totalTokens:cumulativeInput+cumulativeOutput},
      last:{inputTokens,outputTokens,totalTokens:inputTokens+outputTokens},
    };
  });
  const fixtureRun=await fixture(t,{handleRequest:nativeUsagePeer(samples),onUsage:row=>monitor.ingestCompanion(row)});
  const provider=fixtureRun.open();
  let retained=[],parent=null;
  for(let number=1;number<=samples.length;number++){
    const round=await chat(provider,number,retained,parent,{onPromptUsage:tokens=>calibration.push(tokens)});
    retained=round.completed;
    parent='reply-id-'+number;
    assert.equal(await provider.commitPrivateThread('request-'+number,{lastMessageId:parent,historyHash:codexHistoryHash(retained)}),true);
  }
  assert.deepEqual(calibration,input);
  assert.equal(fixtureRun.byMethod('thread/start').length,1);
  assert.equal(monitor.snapshot().totals.codex.total,352);
  const turns=monitor.ledger.requestRows('codex:thread-1');
  assert.deepEqual(turns.map(turn=>turn.usage.total),[110,194,48]);
});

test('companion monitor persists absent native cache counters as unknown and explicit zero as known',async t=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'buddy-native-cache-usage-r3-'));
  const monitorOptions={roots:[],dataRoot,persistentHistory:true};
  let monitor=new LocalMonitor(monitorOptions);
  t.after(async()=>{await monitor?.close();await rm(dataRoot,{recursive:true,force:true});});
  const noCache={inputTokens:30,outputTokens:5,totalTokens:35,cachedInputTokens:null};
  const zeroCache={inputTokens:30,outputTokens:5,totalTokens:35,cachedInputTokens:0,cacheWriteInputTokens:0};
  const fixtureRun=await fixture(t,{
    handleRequest:nativeUsagePeer([{total:noCache,last:noCache},{total:zeroCache,last:zeroCache}]),
    onUsage:row=>monitor.ingestCompanion(row),
  });
  const provider=fixtureRun.open();
  await provider.complete({messages:[user('first')]});
  await provider.complete({messages:[user('second')]});
  await monitor.close();
  monitor=new LocalMonitor(monitorOptions);
  await monitor.start();
  const [unknown]=monitor.ledger.requestRows('codex:thread-1');
  const [zero]=monitor.ledger.requestRows('codex:thread-2');
  assert.ok(!unknown.knownFields.includes('cacheRead'));
  assert.ok(!unknown.knownFields.includes('cacheWrite'));
  assert.ok(zero.knownFields.includes('cacheRead'));
  assert.ok(zero.knownFields.includes('cacheWrite'));
  assert.equal(zero.usage.cacheRead,0);
  assert.equal(zero.usage.cacheWrite,0);
});
