import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {copyFile,mkdtemp,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as tick} from 'node:timers/promises';
import {CodexProvider} from '../src/codex-provider.mjs';
import {codexHistoryHash} from '../src/codex-thread-wire.mjs';
import {CodexOwnedProcesses} from '../src/codex-owned-process.mjs';

const scope={connectionId:'private-model',characterId:'char',lifeId:'life',personaId:'identity',conversationId:'private-conversation'};
const user=content=>({role:'user',content});
const assistant=content=>({role:'assistant',content});

async function fixture(t,extra={}){
  const {handleRequest,storeHook,pid,holdStdin=false,earlyExit=false,...providerOptions}=extra;
  const root=await mkdtemp(join(tmpdir(),'review-r3-')),requests=[],children=[],rows=new Map();
  let nextThread=0,nextTurn=0;
  const nativeStore={
    async read(key){const value=structuredClone(rows.get(key));await storeHook?.('read',key);return value;},
    async list(){return [...rows].map(([key,value])=>({key,value:structuredClone(value)}));},
    async write(key,value){rows.set(key,structuredClone(value));return true;},
    async remove(key){return rows.delete(key);},
    async close(){},
  };
  const options={
    binary:'fixture.exe',defaultModel:'fixture-model',dataRoot:join(root,'data'),
    env:{USERPROFILE:root,CODEX_HOME:join(root,'empty-home')},
    nativeStore,handshakeTimeoutMs:2000,turnTimeoutMs:2000,
    osProcesses:{async inspect(){return null;},async killTree(){return false;}},
    spawnImpl(binary,args){
      const child=new EventEmitter();
      const index=children.length;
      Object.assign(child,{pid,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exited:false,kill(){child.emit('exit',1);}});
      children.push({binary,args,child});
      child.once('exit',()=>{child.exited=true;});
      if(!holdStdin)child.stdin.once('end',()=>child.emit('exit',0));
      const notify=(method,params)=>child.stdout.write(JSON.stringify({method,params})+'\n');
      const reply=(id,result)=>child.stdout.write(JSON.stringify({id,result})+'\n');
      child.stdin.on('data',data=>{
        const message=JSON.parse(String(data));message.child=index;requests.push(message);
        if(message.id===undefined)return;
        const override=handleRequest?.(message,notify,reply,index);
        if(override==='defer')return;
        if(override instanceof Error){child.stdout.write(JSON.stringify({id:message.id,error:{message:override.message}})+'\n');return;}
        let result={};
        if(message.method==='account/read')result={account:{type:'chatgpt'}};
        if(message.method==='model/list')result={data:[{id:'fixture-model',defaultReasoningEffort:'low'}],nextCursor:null};
        if(message.method==='thread/start')result={thread:{id:'thread-'+(++nextThread),modelProvider:'openai'}};
        if(message.method==='thread/resume')result={thread:{id:message.params.threadId,modelProvider:'openai'}};
        if(message.method==='turn/start'){
          const threadId=message.params.threadId,id='turn-'+(++nextTurn);
          result={turn:{id}};
          queueMicrotask(()=>{
            const itemId='m-'+id,text='reply-'+id;
            notify('item/completed',{threadId,turnId:id,item:{id:itemId,type:'agentMessage',text}});
            notify('turn/completed',{threadId,turn:{id,status:'completed'}});
          });
        }
        reply(message.id,override??result);
      });
      queueMicrotask(()=>{
        child.emit('spawn');
        if(earlyExit)child.emit('exit',0);
      });
      return child;
    },
    ...providerOptions,
  };
  const providers=[];
  const open=()=>{const provider=new CodexProvider(options);providers.push(provider);provider.setEnabled(true);return provider;};
  const byMethod=method=>requests.filter(row=>row.method===method);
  t.after(async()=>{await Promise.all(providers.map(provider=>provider.close()));await rm(root,{recursive:true,force:true});});
  return {open,byMethod,requests,children,rows};
}

async function chat(provider,number,retained=[],parentMessageId=null){
  const current=user('current-'+number);
  let receipt,output='';
  for await(const part of provider.streamForConnection(scope.connectionId,{
    system:'private instructions',messages:[...retained,current],
    cacheContext:{native:{scope,requestId:'request-'+number,parentMessageId,historyHash:codexHistoryHash(retained)}},
    onNativeThread:value=>{receipt=value;},
  }))if(part.type==='text-delta')output+=part.text;
  return {output,receipt,completed:[...retained,current,assistant(output)]};
}

test('idle archive and the next private turn stay serialized',async t=>{
  let now=0,nextId=0,armed=false;
  const timers=new Map();
  const clock={
    setTimeout(run,delay){const id=++nextId;timers.set(id,{due:now+delay,run});return id;},
    clearTimeout(id){timers.delete(id);},
    fire(ms){now+=ms;for(const [id,timer] of timers)if(timer.due<=now){timers.delete(id);timer.run();}},
  };
  const run=await fixture(t,{clock,storeHook:async(op,key)=>{
    if(armed&&op==='read'&&key==='thread:thread-1'){armed=false;clock.fire(30*60*1000);}
  }});
  const provider=run.open();
  const first=await chat(provider,1);
  assert.equal(await provider.commitPrivateThread('request-1',{lastMessageId:'reply-1',historyHash:codexHistoryHash(first.completed)}),true);
  armed=true; // the 30-minute timer fires while prepare re-reads the matched record
  const second=await chat(provider,2,first.completed,'reply-1');
  const methods=run.requests.filter(r=>r.method?.startsWith('thread/')||r.method==='turn/start').map(r=>r.method+':'+(r.params.threadId??''));
  const archiveAt=methods.indexOf('thread/archive:thread-1'),turnAt=methods.lastIndexOf('turn/start:thread-1');
  if(archiveAt>=0&&turnAt>archiveAt){
    assert.deepEqual(methods.slice(archiveAt+1,turnAt),['thread/unarchive:thread-1','thread/resume:thread-1']);
  }
  assert.equal(second.receipt.threadId,'thread-1');
  assert.equal(run.rows.get('thread:thread-1').archived,false);
});

test('model discovery cannot archive a private thread during chat resume',async t=>{
  let provider2,release;
  const run=await fixture(t,{handleRequest:(message,notify,reply,child)=>{
    if(message.method==='thread/resume'&&!release){
      // Hold the cold resume (as a long rollout would) and let the catalog client start meanwhile.
      release=()=>reply(message.id,{thread:{id:message.params.threadId,modelProvider:'openai'}});
      void provider2.fetchModels().then(release,release);
      return 'defer';
    }
  }});
  const provider1=run.open();
  const first=await chat(provider1,1);
  await provider1.commitPrivateThread('request-1',{lastMessageId:'reply-1',historyHash:codexHistoryHash(first.completed)});
  await provider1.close();
  provider2=run.open();
  const second=await chat(provider2,2,first.completed,'reply-1');
  const foreignArchive=run.requests.find(r=>r.method==='thread/archive'&&r.child===2&&r.params.threadId==='thread-1');
  assert.equal(foreignArchive,undefined);
  assert.equal(second.receipt.threadId,'thread-1');
});

test('replaced threads are deleted in bounded idle batches and failed rows retry',async t=>{
  let failDelete=true;
  let now=0,nextId=0;
  const timers=new Map();
  const clock={
    setTimeout(run,delay){const id=++nextId;timers.set(id,{due:now+delay,run});return id;},
    clearTimeout(id){timers.delete(id);},
    async advance(ms){
      now+=ms;
      for(const [id,timer] of [...timers])if(timer.due<=now&&timers.delete(id))timer.run();
      await tick();
    },
  };
  const run=await fixture(t,{clock,threadIdleMs:1000,poolIdleMs:100,
    handleRequest:message=>message.method==='thread/delete'&&failDelete&&message.params.threadId==='thread-1'?
      Error('temporary fixture failure'):undefined,
  });
  const provider=run.open();
  for(let index=1;index<=7;index++){
    await chat(provider,index);
    await provider.commitPrivateThread('request-'+index,{lastMessageId:'reply-'+index});
  }
  assert.equal(run.byMethod('thread/delete').length,0);
  assert.equal(run.rows.get('thread:thread-1').state,'delete-pending');
  await clock.advance(100);
  await clock.advance(100);
  assert.deepEqual(run.byMethod('thread/delete').map(row=>row.params.threadId),['thread-1','thread-2','thread-3','thread-4']);
  assert.equal(run.rows.get('thread:thread-1').state,'delete-pending');
  assert.equal(run.byMethod('thread/archive').some(row=>row.params.threadId==='thread-7'),false);
  failDelete=false;
  await chat(provider,8);
  await clock.advance(100);
  await clock.advance(100);
  assert.deepEqual(run.byMethod('thread/delete').slice(4).map(row=>row.params.threadId),['thread-1','thread-5','thread-6','thread-7']);
  assert.equal(run.byMethod('thread/list').length,0);
});

test('handshake runs while owned-process registration waits for the OS',async t=>{
  const pid=420100,binary=join(tmpdir(),'fixture.exe');
  const inquiry=Promise.withResolvers(),release=Promise.withResolvers();
  const run=await fixture(t,{pid,binary,osProcesses:{
    async inspect(queriedPid,{timeoutMs=2400}={}){
      inquiry.resolve(timeoutMs);
      await release.promise;
      return {pid:queriedPid,creationTime:'1234',executable:binary,ownerSid:'fixture-sid',hostPid:process.pid};
    },
    async killTree(){return false;},
  }});
  const provider=run.open();
  const start=provider.start();
  try{
    const timeoutMs=await inquiry.promise;
    await tick();
    assert.equal(run.byMethod('account/read').length,1);
    assert.ok(timeoutMs>=5000);
  }finally{
    release.resolve();
    await start;
  }
});

test('an app-server exiting as it spawns leaves no process ownership record',async t=>{
  const pid=420101,binary=join(tmpdir(),'fixture.exe');
  const run=await fixture(t,{pid,binary,earlyExit:true,osProcesses:{
    async inspect(queriedPid){
      await tick();
      return {pid:queriedPid,creationTime:'1234',executable:binary,ownerSid:'fixture-sid',hostPid:process.pid};
    },
    async killTree(){assert.fail('the fixture already exited');},
  }});
  await assert.rejects(run.open().start());
  await tick();
  assert.equal([...run.rows.keys()].filter(key=>key.startsWith('process:')).length,0);
});

test('graceful stop reserves time for the app-server tree kill',async t=>{
  const pid=420102,binary=join(tmpdir(),'fixture.exe');
  let treeBudget;
  const run=await fixture(t,{pid,binary,holdStdin:true,osProcesses:{
    async inspect(queriedPid){return {pid:queriedPid,creationTime:'1234',executable:binary,ownerSid:'fixture-sid',hostPid:process.pid};},
    async killTree(record,{timeoutMs}){
      treeBudget=timeoutMs;
      run.children[0].child.emit('exit',0);
      return true;
    },
  }});
  const provider=run.open();
  await provider.start();
  await provider.close();
  assert.ok(treeBudget>=2350,'expected at least 2.4 seconds apart from timer jitter, received '+treeBudget);
});

test('Windows process ownership accepts a harmless smart-apostrophe executable path', {skip:process.platform!=='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'buddy-ownership-'));
  const binary=join(root,'fixture’s ping.exe');
  await copyFile(join(process.env.SystemRoot??'C:\\Windows','System32','ping.exe'),binary);
  const child=spawn(binary,['-t','127.0.0.1'],{stdio:'ignore',windowsHide:true});
  const spawned=once(child,'spawn'),exited=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null){child.kill();await exited;}await rm(root,{recursive:true,force:true});});
  const processes=new CodexOwnedProcesses({async write(){return true;}},()=>{});
  await spawned;
  processes.register(child,binary);
  const owned=await processes.ownedRecord(child);
  assert.equal(owned?.record.executable.toLowerCase(),binary.toLowerCase());
  assert.equal(await processes.killTree(child,5000),true);
  await exited;
});
