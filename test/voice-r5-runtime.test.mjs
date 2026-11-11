import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVoiceRuntime} from '../src/voice/runtime.mjs';
import {createSpeechRuntime} from '../src/voice/speech-runtime.mjs';
import {createVoiceController} from '../src/voice/controller.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';
import {createCardSpeech} from '../src/voice/card-speech.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const packageId='ai-buddy.voice-breeze';
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
async function fixture(mode='normal',options={}){
  const root=await mkdtemp(join(tmpdir(),'voice-r5-runtime-')),script=join(root,'worker.mjs');
  await writeFile(script,`import {createInterface} from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
for await(const text of createInterface({input:process.stdin,crlfDelay:Infinity})){
 const row=JSON.parse(text);
 if(row.op==='initialize'){send({id:row.id,type:'result',state:'ready'});continue;}
 if(row.op==='speak'){
  ${mode==='delayed'?"await new Promise(resolve=>setTimeout(resolve,60));":""}
  send({id:row.id,type:'pcm',sample_rate:24000,pcm:Buffer.alloc(${mode==='blocked'?262144:4}).toString('base64')});
  ${mode==='blocked'?"for(let i=0;i<200;i++)send({id:row.id,type:'pcm',sample_rate:24000,pcm:Buffer.alloc(262144).toString('base64')});await new Promise(()=>{});":mode==='hung'?"await new Promise(()=>{});":mode==='slow'?"if(row.text==='slow'){await new Promise(resolve=>setTimeout(resolve,2300));send({id:row.id,type:'pcm',sample_rate:24000,pcm:'CAAAAA=='});}send({id:row.id,type:'done'});":"await new Promise(resolve=>setTimeout(resolve,80));send({id:row.id,type:'done'});"}
 }
}`);
  const owned=new Map(),counts={starts:0,releases:0};let rejectStop=options.rejectStop??false;
  const local=createVoiceRuntime({
    ...options,
    resolveAssets:async()=>({python:process.execPath,script,root,assetRoot:root,cacheRoot:root,proof:'fixture-v1'}),
    resolveProfile:async()=>({path:script,text:'fixture',language:'zh'}),
    supervisor:{async registerRoot({runtimeId,pid}){owned.set(runtimeId,pid);counts.starts++;},async releaseRoot({runtimeId}){
      const pid=owned.get(runtimeId);assert.ok(pid,'only the registered exact fixture PID may be stopped');counts.releases++;
      if(rejectStop)return {stopped:false};
      if(alive(pid))process.kill(pid);
      for(let n=0;n<400&&alive(pid);n++)await delay(5);
      return {stopped:!alive(pid)};
    }},
  });
  return {local,counts,setRejectStop:value=>rejectStop=value,async close(){for(const pid of owned.values())if(alive(pid))process.kill(pid);await local.close().catch(()=>{});assert.ok([...owned.values()].every(pid=>!alive(pid)));await rm(root,{recursive:true,force:true});}};
}
const request=characterId=>({engine:'breeze',packageId,characterId,profileId:characterId,profileVersion:1,text:'fixture'});

test('OS-confirmed stop closes blocked PCM pipes promptly',async()=>{
  const f=await fixture('blocked');let iterator;
  try{
    await f.local.prepare({engine:'breeze',packageId});iterator=f.local.speak(request('a'));
    while((await iterator.next()).value.type!=='pcm'){}
    const started=performance.now();await f.local.stopEngine();
    assert.ok(performance.now()-started<1800,'pipe close must not undo the exact OS stop proof');
    await iterator.return();assert.equal(f.counts.releases,1);
  }finally{await f.close();}
});

test('idle role changes cancel the old scope and retain one healthy engine',async()=>{
  const f=await fixture(),runtime=createSpeechRuntime({local:f.local}),chat=runtime.channel('chat');
  let scope={characterId:'a',lifeId:'life',operationId:'op',personaId:'persona',conversationId:'chat-a',channel:'app-private'};
  const settings=createVoiceSettings();await settings.update({enabled:true});
  const controller=createVoiceController({settings,getScope:()=>scope,submit:()=>{throw Error('no model');},listPackages:()=>[{id:packageId,engine:'breeze',installed:true,enabled:true,usable:true}],
    profiles:{current:async({characterId,engine})=>({id:characterId,version:1,characterId,engine})},assets:{status:async()=>({state:'ready'})},runtime:chat});
  try{
    for(const characterId of ['a','b','a']){
      if(characterId!==scope.characterId){scope={...scope,characterId,conversationId:'chat-'+characterId};await controller.invalidate('scope-changed');}
      await controller.action('prepare',{target:'speech'});
    }
    assert.equal(f.counts.starts,1,'A to B to A must retain the identical worker');assert.equal(f.counts.releases,0);
    await chat.stopEngine();assert.equal(f.counts.releases,1,'explicit stop still physically releases the engine');
  }finally{await runtime.close();await f.close();}
});

test('saving unchanged configuration keeps a healthy engine but disabling voice releases it',async()=>{
  const f=await fixture(),runtime=createSpeechRuntime({local:f.local}),settings=createVoiceSettings();await settings.update({enabled:true});
  const scope={characterId:'a',lifeId:'life',operationId:'op',personaId:'persona',conversationId:'chat',channel:'app-private'};
  const controller=createVoiceController({settings,getScope:()=>scope,runtime:runtime.channel('chat'),submit:()=>{},listPackages:()=>[{id:packageId,engine:'breeze',installed:true,enabled:true,usable:true}],
    profiles:{current:async()=>({id:'a',version:1,characterId:'a',engine:'breeze'})},assets:{status:async()=>({state:'ready'})}});
  try{
    await controller.action('prepare',{target:'speech'});await controller.action('configure',{enabled:true});
    assert.equal(f.counts.releases,0);assert.equal(f.local.ready({engine:'breeze'}).ready,true);
    await controller.action('configure',{enabled:false});assert.equal(f.counts.releases,1);
  }finally{await runtime.close();await f.close();}
});

test('controller recovery keeps an unknown stop sealed and clears its gate only after fresh runtime proof',async()=>{
  const f=await fixture('normal',{rejectStop:true}),runtime=createSpeechRuntime({local:f.local}),settings=createVoiceSettings();await settings.update({enabled:true});
  const scope={characterId:'a',lifeId:'life',operationId:'op',personaId:'persona',conversationId:'chat',channel:'app-private'};
  const controller=createVoiceController({settings,getScope:()=>scope,runtime:runtime.channel('chat'),submit:()=>{},listPackages:()=>[{id:packageId,engine:'breeze',installed:true,enabled:true,usable:true}],
    profiles:{current:async()=>({id:'a',version:1,characterId:'a',engine:'breeze'})},assets:{status:async()=>({state:'ready'})}});
  try{
    // No worker existed at provider selection, so preparation is admitted.
    await controller.action('prepare',{target:'speech'});
    await assert.rejects(controller.invalidate('user-stop'),{code:'VOICE_CLEANUP_FAILED'});
    await assert.rejects(controller.recoverStop(),{code:'VOICE_CLEANUP_FAILED'});
    await assert.rejects(controller.action('prepare'),{code:'VOICE_STOPPING'});
    f.setRejectStop(false);assert.equal((await controller.recoverStop()).recovered,true);
    await controller.action('prepare',{target:'speech'});assert.equal(f.counts.starts,2);
  }finally{f.setRejectStop(false);await runtime.close();await f.close();}
});

test('busy owner cancellation drains serial worker before a new owner starts and hides old PCM',async()=>{
  const f=await fixture(),runtime=createSpeechRuntime({local:f.local}),chat=runtime.channel('chat'),cards=runtime.channel('card-table');let old;
  try{
    old=chat.speak(request('a'));
    while((await old.next()).value.type!=='pcm'){}
    const started=performance.now();await chat.cancelCurrent();
    assert.ok(performance.now()-started>=30,'cancel must await the previous terminal instead of concurrently submitting a new request');
    await assert.rejects(old.next(),{code:'VOICE_OWNER_STOPPED'},'revoked output cannot reach the next owner');
    const packets=await Array.fromAsync(cards.speak(request('b')));
    assert.equal(packets.filter(row=>row.type==='pcm').length,1);assert.equal(f.counts.starts,1);assert.equal(f.counts.releases,0);
  }finally{await runtime.close();await f.close();}
});

test('cancelling while the parser is awaiting first PCM consumes that pending read before reusing the worker',async()=>{
  const f=await fixture('delayed'),runtime=createSpeechRuntime({local:f.local}),chat=runtime.channel('chat'),cards=runtime.channel('card-table');
  try{
    const old=chat.speak(request('a'));assert.equal((await old.next()).value.type,'reference');
    const pending=old.next().then(value=>({value}),error=>({error}));await delay(10);
    await chat.cancelCurrent();assert.equal((await pending).error.code,'VOICE_OWNER_STOPPED');
    assert.equal((await Array.fromAsync(cards.speak(request('b')))).filter(row=>row.type==='pcm').length,1);
    assert.equal(f.counts.starts,1);assert.equal(f.counts.releases,0);
  }finally{await runtime.close();await f.close();}
});

test('a slow cancelled reply drains without replacing the worker or playing its remaining PCM',async()=>{
  const f=await fixture('slow'),runtime=createSpeechRuntime({local:f.local}),chat=runtime.channel('chat');
  try{
    await chat.prepare({engine:'breeze',packageId});
    const signal=new AbortController(),old=chat.speak({...request('a'),text:'slow',signal:signal.signal});
    while((await old.next()).value.type!=='pcm'){}
    signal.abort();
    const stopped=assert.rejects(old.next(),{name:'AbortError'});
    const next=Array.fromAsync(chat.speak(request('b')));
    const [,packets]=await Promise.all([stopped,next]);
    assert.equal((await chat.ready({engine:'breeze'})).ready,true);
    assert.deepEqual(packets.filter(row=>row.type==='pcm').map(row=>row.pcm),[Buffer.alloc(4)]);
    assert.deepEqual(f.counts,{starts:1,releases:0});
  }finally{await runtime.close();await f.close();}
});

test('explicit engine stop preempts a pending drain for a silent worker',async()=>{
  const f=await fixture('hung',{drainTimeoutMs:2500}),runtime=createSpeechRuntime({local:f.local}),chat=runtime.channel('chat');
  try{
    const old=chat.speak(request('a'));
    while((await old.next()).value.type!=='pcm'){}
    const drain=chat.cancelCurrent();
    await delay(20);
    const started=performance.now();
    await Promise.all([runtime.stopEngine(),drain]);
    assert.ok(performance.now()-started<1800,'explicit stop must preempt the in-progress drain');
    assert.deepEqual(f.counts,{starts:1,releases:1});
    assert.equal((await chat.ready({engine:'breeze'})).ready,false);
  }finally{await runtime.close();await f.close();}
});

test('a drain timeout with unknown OS stop gates every owner until a fresh proof confirms cleanup',async()=>{
  const f=await fixture('hung',{drainTimeoutMs:30,rejectStop:true}),runtime=createSpeechRuntime({local:f.local}),cards=runtime.channel('card-table'),chat=runtime.channel('chat');
  try{
    const old=cards.speak(request('a'));while((await old.next()).value.type!=='pcm'){}
    await assert.rejects(cards.cancelCurrent(),{code:'VOICE_STOP_UNCONFIRMED'});
    await assert.rejects(Array.fromAsync(chat.speak(request('b'))),{code:'VOICE_STOP_UNCONFIRMED'});
    await assert.rejects(Array.fromAsync(f.local.speak(request('b'))),{code:'VOICE_STOP_UNCONFIRMED'});
    f.setRejectStop(false);await cards.stopEngine();
    await chat.prepare({engine:'breeze',packageId});assert.equal((await chat.ready({engine:'breeze'})).ready,true);assert.equal(f.counts.starts,2);
  }finally{f.setRejectStop(false);await runtime.close();await f.close();}
});

test('card failure before voice resolution emits stable request identity and a useful message',async()=>{
  const events=[],bridge=createCardSpeech({isScopeValid:()=>true,resolveVoice:async()=>{throw Object.assign(Error('cloud voice is not bound'),{code:'CLOUD_VOICE_REQUIRED'});},emit:value=>events.push(value)});
  try{
    await bridge.accept({eventId:'unbound',kind:'table-chat',text:'hello',scope:{channel:'card-table',tableId:'table',handId:'hand',characterId:'a',personaId:'persona',lifeId:'life',operationId:'op'}});
    for(let n=0;n<100&&!events.some(value=>value.state==='failed');n++)await delay(5);
    const failure=events.find(value=>value.state==='failed');assert.equal(failure.requestId,'card:unbound');assert.equal(failure.envelope.requestId,'card:unbound');assert.equal(failure.message,'cloud voice is not bound');
  }finally{await bridge.close();}
});

test('a card stop failure stays sealed until the same captured runtime confirms cleanup',async()=>{
  let unknown=true,stops=0;const events=[];
  const runtime={async *speak(){yield {type:'pcm',pcm:Buffer.alloc(4),sampleRate:24000};},async stopEngine(){stops++;if(unknown)throw Object.assign(Error('unknown stop'),{code:'VOICE_STOP_UNCONFIRMED'});}};
  const bridge=createCardSpeech({isScopeValid:()=>true,resolveVoice:async()=>({runtime,engine:'breeze',packageId,profileId:'a',profileVersion:1,speechProvider:'local'}),emit:value=>events.push(value)});
  const event=eventId=>({eventId,kind:'table-chat',text:'hello',scope:{channel:'card-table',tableId:'table',handId:'hand',characterId:'a',personaId:'persona',lifeId:'life',operationId:'op'}});
  try{
    await bridge.accept(event('before'));for(let n=0;n<100&&!events.some(value=>value.phase==='end');n++)await delay(5);
    await assert.rejects(bridge.invalidate('scope-changed'),{code:'VOICE_CARD_STOP_FAILED'});
    await assert.rejects(bridge.recoverStop(),{code:'VOICE_CARD_STOP_FAILED'});
    assert.equal((await bridge.accept(event('blocked'))).reason,'stop-failed');
    unknown=false;await bridge.recoverStop();assert.equal(stops,3);assert.equal((await bridge.accept(event('after'))).accepted,true);
  }finally{unknown=false;await bridge.close();}
});

test('an idle card receipt write failure can recover by saving again without inventing a runtime',async()=>{
  const dataRoot=await mkdtemp(join(tmpdir(),'voice-r5-card-write-')),events=[];
  const bridge=createCardSpeech({dataRoot,isScopeValid:()=>true,resolveVoice:async()=>{throw Error('idle recovery must not resolve or create a runtime');},emit:value=>events.push(value)});
  try{
    await bridge.reconcile();await writeFile(join(dataRoot,'voice'),'temporary directory obstruction');
    await assert.rejects(bridge.invalidate('scope-changed'),{code:'VOICE_CARD_RECEIPTS_WRITE_FAILED'});
    assert.equal(events.find(value=>value.type==='error').code,'VOICE_CARD_RECEIPTS_WRITE_FAILED');
    await assert.rejects(bridge.recoverStop(),{code:'VOICE_CARD_RECEIPTS_WRITE_FAILED'});
    assert.equal(bridge.busy(),true);
    await rm(join(dataRoot,'voice'));assert.equal((await bridge.recoverStop()).recovered,true);assert.equal(bridge.busy(),false);
    assert.equal(JSON.parse(await readFile(join(dataRoot,'voice/card-speech.json'),'utf8')).schemaVersion,1);
  }finally{await rm(join(dataRoot,'voice'),{recursive:true,force:true});await bridge.close().catch(()=>{});await rm(dataRoot,{recursive:true,force:true});}
});
