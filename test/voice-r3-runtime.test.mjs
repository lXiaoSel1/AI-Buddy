import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createVoiceRuntime} from '../src/voice/runtime.mjs';
import {createSpeechRuntime} from '../src/voice/speech-runtime.mjs';
import {createVoiceHost} from '../src/voice/host.mjs';
import {createVoiceSettings} from '../src/voice/settings.mjs';
import {ensureVoiceOutput,voiceDialogueState} from '../src/voice/client.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const bounded=promise=>Promise.race([promise,delay(150,'still-waiting')]);
async function fixture(t,{preflightTimeoutMs=5000,initializeDelayMs=0}={}){
  const directory=await mkdtemp(join(tmpdir(),'buddy-r3-inert-')),script=join(directory,'inert.mjs'),log=join(directory,'ops.log');
  await writeFile(script,`import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
for await(const line of createInterface({input:process.stdin})){const request=JSON.parse(line);appendFileSync(${JSON.stringify(log)},request.op+'\\n');
if(request.op==='speak'){send({id:request.id,type:'pcm',sample_rate:24000,pcm:'ABAQEA=='});send({id:request.id,type:'done'});}
else {if(request.op==='initialize')await new Promise(resolve=>setTimeout(resolve,${initializeDelayMs}));send({id:request.id,type:'result',state:'ready'});}}`);
  const running=new Map(),spawns=[],gate={};let proofVersion=0;
  const pause=async kind=>{if(gate.kind===kind){gate.entered.resolve();await gate.release.promise;}};
  const runtime=createVoiceRuntime({preflightTimeoutMs,
    resolveAssets:async kind=>{await pause('assets');return {python:process.execPath,script,root:directory,assetRoot:directory,cacheRoot:directory,proof:kind+(proofVersion?'-'+proofVersion:'')};},
    resolveProfile:async()=>{await pause('profile');return {path:script,text:'INERT_REFERENCE',language:'zh',referenceStyle:'calm',referenceSource:'neutral-fallback'};},
    supervisor:{async registerRoot({runtimeId,pid}){running.set(runtimeId,pid);spawns.push(runtimeId);},async releaseRoot({runtimeId}){await pause('retire');running.delete(runtimeId);return {stopped:true};}}});
  t.after(async()=>{gate.release?.resolve();await runtime.close();await rm(directory,{recursive:true,force:true});});
  return {runtime,running,spawns,directory,changeProof(){proofVersion++;},async operations(){try{return (await readFile(log,'utf8')).trim().split('\n');}catch(error){if(error.code==='ENOENT')return [];throw error;}},
    arm(kind){gate.kind=kind;gate.entered=deferred();gate.release=deferred();return gate;}};
}

for(const kind of ['profile','assets'])test(`canceling a withheld ${kind} preflight settles and frees the real worker before its late result`,async t=>{
  const f=await fixture(t);await f.runtime.prepare({engine:'breeze'});const gate=f.arm(kind),controller=new AbortController();
  const pending=f.runtime.speak({engine:'breeze',characterId:'fixture',profileId:'profile',text:'INERT_TEXT',signal:controller.signal}).next();
  const outcome=pending.then(()=>null,error=>error);await gate.entered.promise;controller.abort();
  const stop=f.runtime.stopEngine(),stopped=stop.then(()=>true);
  const beforeRelease=await bounded(Promise.all([outcome,stopped]));gate.release.resolve();await outcome;await stop;
  assert.notEqual(beforeRelease,'still-waiting');assert.equal(beforeRelease[0]?.name,'AbortError');
  assert.equal(f.running.size,0);assert.equal(f.spawns.length,1);assert.deepEqual(await f.operations(),['initialize']);
});

test('a withheld component preflight expires without sending speak and cannot revive on a late result',async t=>{
  const f=await fixture(t,{preflightTimeoutMs:35});await f.runtime.prepare({engine:'breeze'});const gate=f.arm('assets');
  const pending=f.runtime.speak({engine:'breeze',characterId:'fixture',profileId:'profile',text:'INERT_TEXT'}).next();
  const outcome=pending.then(()=>null,error=>error);await gate.entered.promise;
  const beforeRelease=await bounded(outcome);gate.release.resolve();await outcome;
  assert.notEqual(beforeRelease,'still-waiting');assert.equal(beforeRelease?.code,'VOICE_PREFLIGHT_TIMEOUT');
  await f.runtime.stopEngine();assert.equal(f.running.size,0);assert.equal(f.spawns.length,1);assert.deepEqual(await f.operations(),['initialize']);
});

test('the inert child pipe exposes reference, component, sent and first-PCM boundaries without text or paths',async t=>{
  const f=await fixture(t),phases=[];
  await f.runtime.prepare({engine:'breeze'});
  const rows=await Array.fromAsync(f.runtime.speak({engine:'breeze',characterId:'fixture',profileId:'profile',text:'INERT_SECRET_TEXT',onPhase:value=>phases.push(value)}));
  assert.deepEqual(phases.map(row=>row.stage),['reference-check','component-check','speak-sent','first-pcm']);
  assert.deepEqual(rows.map(row=>row.type),['reference','pcm','done']);assert.deepEqual(await f.operations(),['initialize','speak']);
  assert.doesNotMatch(JSON.stringify(phases),/INERT_SECRET_TEXT|INERT_REFERENCE|inert\.mjs|[A-Z]:\\/);
});

test('cold worker initialization keeps its independent loading allowance beyond the short preflight deadline',async t=>{
  const f=await fixture(t,{preflightTimeoutMs:35,initializeDelayMs:110}),phases=[];
  const rows=await Array.fromAsync(f.runtime.speak({engine:'breeze',characterId:'fixture',profileId:'profile',text:'INERT_TEXT',onPhase:value=>phases.push(value)}));
  assert.deepEqual(rows.map(row=>row.type),['reference','pcm','done']);
  assert.deepEqual(phases.map(row=>row.stage),['reference-check','component-check','model-loading','component-check','speak-sent','first-pcm']);
  assert.ok(phases.find(row=>row.stage==='speak-sent').elapsedMs>=100);
});

test('stopping preparation at withheld package resolution returns before release and never starts a late worker',async t=>{
  const f=await fixture(t),gate=f.arm('assets'),pending=f.runtime.prepare({engine:'breeze'});
  const outcome=pending.then(()=>null,error=>error);await gate.entered.promise;
  const stop=f.runtime.stopEngine(),beforeRelease=await bounded(Promise.all([outcome,stop.then(()=>true)]));gate.release.resolve();await outcome;await stop;
  assert.notEqual(beforeRelease,'still-waiting');assert.equal(beforeRelease[0]?.name,'AbortError');assert.equal(f.spawns.length,0);assert.deepEqual(await f.operations(),[]);
  gate.kind=null;assert.equal((await f.runtime.prepare({engine:'breeze'})).ready,true);
});

test('canceling preparation while an old worker retires cannot spawn its changed-proof replacement',async t=>{
  const f=await fixture(t);await f.runtime.prepare({engine:'breeze'});f.changeProof();
  const gate=f.arm('retire'),controller=new AbortController();
  const outcome=f.runtime.prepare({engine:'breeze',signal:controller.signal}).then(()=>null,error=>error);
  await gate.entered.promise;controller.abort();gate.release.resolve();
  assert.equal((await outcome)?.name,'AbortError');await f.runtime.stopEngine();
  assert.equal(f.spawns.length,1,'canceled replacement must not spawn or register after retirement returns');assert.equal(f.running.size,0);
  assert.deepEqual(await f.operations(),['initialize']);
});

test('a timed out shared-runtime waiter does not bypass its active chat owner or cancel that owner',async()=>{
  const release=deferred(),entered=deferred();let stopped=0;
  const local={async *speak({text,signal,onPhase}){onPhase?.({stage:'speak-sent'});if(text==='active'){entered.resolve();await release.promise;}signal.throwIfAborted();yield {type:'pcm',pcm:new Uint8Array([0,0]),sampleRate:24000};},async stopEngine(){stopped++;},async close(){release.resolve();}};
  const runtime=createSpeechRuntime({local,preflightTimeoutMs:35}),chat=runtime.channel('chat'),cards=runtime.channel('card-table');
  const first=chat.speak({text:'active'}),active=first.next();await entered.promise;const before=stopped;
  const pending=cards.speak({text:'waiting'}).next().then(()=>null,error=>error),beforeRelease=await bounded(pending);
  release.resolve();await active;await first.return();const outcome=await pending;
  assert.notEqual(beforeRelease,'still-waiting');assert.equal(outcome?.code,'VOICE_PREFLIGHT_TIMEOUT');assert.equal(stopped,before);
  await runtime.close();
});

test('the real inert pipe through host and player persists scoped phases through actual playback receipts',async t=>{
  const f=await fixture(t),settings=createVoiceSettings();await settings.update({enabled:true});await f.runtime.prepare({engine:'breeze'});
  const scope={characterId:'fixture',lifeId:'life',operationId:'operation',personaId:'persona',channel:'app-private',conversationId:'conversation'};
  const listeners=new Set(),audits=[],events=[],contexts=[];
  const shared=createSpeechRuntime({local:f.runtime});
  const host=createVoiceHost({dataRoot:f.directory,build:f.directory,getGame:()=>({voiceScope:()=>scope,voiceReceipt:async()=>({accepted:true}),voiceCancel(){}}),
    getPlatform:()=>({voicePackageStatus:()=>[{id:'ai-buddy.voice-breeze',engine:'breeze',installed:true,enabled:true,usable:true}]}),
    send:event=>{events.push(event);for(const listener of listeners)void listener(event);},audit:event=>audits.push(event),
    components:{settings,credentials:{},runtime:shared,local:f.runtime,cloud:{},supervisor:{async close(){}},
      assets:{status:async()=>({state:'ready'}),resolve:async()=>({proof:'breeze'}),async close(){}},
      profiles:{current:async()=>({id:'profile',version:1,characterId:'fixture',engine:'breeze'})}}});
  const api={action:(...args)=>host.action(...args),onEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
  const output=ensureVoiceOutput(api,{createContext:({sampleRate})=>{const context={sampleRate,currentTime:0,state:'running',destination:{},resume:async()=>{},close:async()=>{},createBuffer:(_,length,rate)=>({duration:length/rate,getChannelData:()=>new Float32Array(length)}),createBufferSource:()=>({connect(){},disconnect(){},start(){},stop(){}})};contexts.push(context);return context;}}),release=output.retain();
  let presentation;const off=output.subscribe(scope,value=>{presentation=value;});
  const until=async predicate=>{for(let i=0;i<250;i++){if(predicate())return;await delay(2);}assert.fail('inert host phase did not arrive');};
  try{
    const turn={...scope,requestId:'inert-request',messageId:'inert-message'},lease=await host.controller.admit(turn),envelope={...turn,...lease,index:0,segmentId:turn.requestId+':voice:0'};
    assert.equal(await host.controller.segment({envelope,text:'INERT_SECRET_TEXT'}),true);await host.controller.finish({requestId:turn.requestId});
    await until(()=>events.some(row=>row.type==='audio'&&row.phase==='end'));
    assert.equal(voiceDialogueState(presentation,turn.requestId).status,'已收到音频，等待播放…');
    contexts[0].currentTime=1;await until(()=>audits.some(row=>row.type==='voice-phase'&&row.stage==='done'));
    const phases=audits.filter(row=>row.type==='voice-phase');
    assert.deepEqual(phases.map(row=>row.stage),['queue','reference-check','component-check','model-loading','component-check','speak-sent','first-pcm','playback-start','done']);
    assert.ok(phases.every(row=>row.requestId===turn.requestId&&row.segmentId===envelope.segmentId&&row.index===0&&row.engine==='breeze'));
    assert.ok(phases.every(row=>Object.keys(row).every(key=>['type','requestId','segmentId','index','engine','stage','elapsedMs','code'].includes(key))));
    assert.doesNotMatch(JSON.stringify(phases),/INERT_SECRET_TEXT|INERT_REFERENCE|inert\.mjs|characterId|credential|[A-Z]:\\/);
  }finally{off();await release();await host.close();}
});
