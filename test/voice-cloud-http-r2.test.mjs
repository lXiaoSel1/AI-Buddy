import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVoiceCloud} from '../src/voice/cloud.mjs';
import {t as translate} from '../src/i18n.mjs';

const key='synthetic-test-only';
const params={engine:'breeze',characterId:'fixture-speaker',profileId:'fixture-profile',profileVersion:1,text:'Fixture text.'};
const sse=row=>new TextEncoder().encode('data: '+JSON.stringify(row)+'\r\n\r\n');
const audio=(status,hex)=>({base_resp:{status_code:0},data:{status,...(hex===undefined?{}:{audio:hex})}});

async function fixture(t,{fetch,provider='minimax',authorizeSpeech,transport}={}) {
  const dataRoot=await mkdtemp(join(tmpdir(),'voice-cloud-http-r2-'));
  const accountScope=createHash('sha256').update(provider+'\0'+key).digest('hex');
  const attempts=[];
  let currentKey=key;
  const cloud=createVoiceCloud({
    dataRoot,
    resolveRuntime: async()=>{if(transport)return {};throw Object.assign(Error('Local ASR runtime is absent'),{code:'VOICE_FIXTURE_ASR_ABSENT'});},
    authorizeSpeech: authorizeSpeech??(async request=>{assert.equal(request.packageId,'ai-buddy.voice-breeze');}),
    resolveConnection: async()=>({provider,model:'speech-2.8-turbo',keyRef:'fixture-ref'}),
    resolveSecret: async()=>currentKey,
    resolveProfile: async()=>({id:params.profileId,version:params.profileVersion,characterId:params.characterId,
      cloudBinding:{accountScope,provider,voiceId:'fixture-voice'}}),
    transport,
    network:{fetch:async (url,init)=>{attempts.push({url,init});return fetch(url,init);},childNetworkConfig:async()=>null},
  });
  t.after(async()=>{await cloud.close();await rm(dataRoot,{recursive:true,force:true});});
  return {cloud,attempts,changeKey:()=>{currentKey='synthetic-other-account';}};
}

test('ordinary MiniMax synthesis delivers real PCM from one controlled HTTP request without local ASR',async t=>{
  const {cloud,attempts}=await fixture(t,{fetch:async()=>new Response(new ReadableStream({
    start(control){
      control.enqueue(sse(audio(1,'010002')));
      control.enqueue(sse(audio(1,'000300')));
      control.enqueue(sse(audio(2,'0100020003000400')));
      control.close();
    },
  }),{headers:{'content-type':'text/event-stream'}})});
  const events=await Array.fromAsync(cloud.speak({...params,performance:{emotion:'neutral'},speechParts:['Fixture ','text.']}));
  assert.deepEqual(events.map(row=>row.type),['reference','pcm','pcm','pcm','done']);
  assert.deepEqual(Buffer.concat(events.filter(row=>row.type==='pcm').map(row=>row.pcm)),Buffer.from([1,0,2,0,3,0,4,0]));
  assert.ok(events.filter(row=>row.type==='pcm').every(row=>row.sampleRate===32000));
  const {metrics}=events.at(-1);
  assert.equal(metrics.voice_id,'fixture-voice');
  assert.equal(metrics.audio_seconds,0.000125);
  assert.equal(metrics.input_text_chunks,1);
  assert.ok(metrics.first_pcm_seconds>=0 && metrics.generation_seconds>=metrics.first_pcm_seconds);

  assert.equal(attempts.length,1);
  const [{url,init}]=attempts;
  assert.equal(url,'https://api.minimax.cn/v1/t2a_v2');
  assert.equal(init.method,'POST');
  assert.equal(init.redirect,'error');
  assert.equal(init.credentials,'omit');
  assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+key);
  assert.deepEqual(JSON.parse(init.body),{
    model:'speech-2.8-turbo',text:params.text,stream:true,stream_options:{exclude_aggregated_audio:true},
    language_boost:'Chinese',output_format:'hex',
    voice_setting:{voice_id:'fixture-voice',speed:1,vol:1,pitch:0,emotion:'calm'},
    audio_setting:{format:'pcm',sample_rate:32000,channel:1},
  });
});

const syntheticResponse=rows=>new Response(new ReadableStream({
  start(control){for(const row of rows)control.enqueue(sse(row));control.close();},
}),{headers:{'content-type':'text/event-stream'}});

test('ordinary MiniMax streams the first samples before terminal confirmation and accepts an empty final packet',async t=>{
  let control,cancelled=false;
  const {cloud,attempts}=await fixture(t,{provider:'minimax-global',fetch:async()=>new Response(new ReadableStream({
    start(value){
      control=value;
      const split=sse(audio(1,'0100'));
      control.enqueue(split.subarray(0,8));
      control.enqueue(split.subarray(8));
    },
    cancel(){cancelled=true;},
  }))});
  const iterator=cloud.speak(params);
  assert.equal((await iterator.next()).value.type,'reference');
  assert.deepEqual((await iterator.next()).value.pcm,Buffer.from([1,0]));
  control.enqueue(sse(audio(2)));
  assert.equal((await iterator.next()).value.type,'done');
  assert.equal(cancelled,true,'terminal confirmation releases the HTTP response even if it stays open');
  assert.equal((await iterator.next()).done,true);
  assert.equal(attempts[0].url,'https://api.minimax.io/v1/t2a_v2');
});

test('ordinary MiniMax stops an in-flight stream, discards late delivery and permits the next segment',async t=>{
  let calls=0,cancelled=false;
  const {cloud,attempts}=await fixture(t,{fetch:async()=>{
    if(calls++===0)return new Response(new ReadableStream({
      start(control){control.enqueue(sse(audio(1,'0100')));},
      cancel(){cancelled=true;},
    }));
    return syntheticResponse([audio(2,'0200')]);
  }});
  const active=cloud.speak(params);
  await active.next();
  assert.deepEqual((await active.next()).value.pcm,Buffer.from([1,0]));
  const rejected=assert.rejects(active.next(),{name:'AbortError'});
  await cloud.stopEngine();
  await rejected;
  assert.equal(attempts[0].init.signal.aborted,true);
  assert.equal(cancelled,true);
  const next=await Array.fromAsync(cloud.speak(params));
  assert.deepEqual(next.find(row=>row.type==='pcm').pcm,Buffer.from([2,0]));
  assert.equal(next.at(-1).type,'done');
  assert.equal(attempts.length,2);
});

test('ordinary MiniMax cancellation reaches a fetch waiting for response headers',async t=>{
  const started=Promise.withResolvers();
  const lateResponse=Promise.withResolvers();
  t.after(()=>lateResponse.resolve(new Response(null)));
  const {cloud,attempts}=await fixture(t,{fetch:async()=>{started.resolve();return lateResponse.promise;}});
  const stop=new AbortController();
  const pending=Array.fromAsync(cloud.speak({...params,signal:stop.signal}));
  const rejected=assert.rejects(pending,{name:'AbortError'});
  await started.promise;
  stop.abort(Error(key));
  await rejected;
  assert.equal(attempts[0].init.signal.aborted,true);
  const disposed=Promise.withResolvers();
  lateResponse.resolve(new Response(new ReadableStream({
    cancel(){disposed.resolve();},
  })));
  await disposed.promise;
});

test('ordinary MiniMax never submits an unauthorized package or binding',async t=>{
  const denied=await fixture(t,{authorizeSpeech:async()=>{throw Object.assign(Error('Untrusted package'),{code:'VOICE_PACKAGE_TRUST'});}});
  await assert.rejects(Array.fromAsync(denied.cloud.speak(params)),{code:'VOICE_PACKAGE_TRUST'});
  assert.equal(denied.attempts.length,0);
  const account=await fixture(t);
  await assert.rejects(Array.fromAsync(account.cloud.speak({...params,profileVersion:2})),{code:'CLOUD_PROFILE_SCOPE'});
  account.changeKey();
  await assert.rejects(Array.fromAsync(account.cloud.speak(params)),{code:'CLOUD_VOICE_REQUIRED'});
  assert.equal(account.attempts.length,0);
});

for(const [name,fetch,code] of [
  ['missing completion',async()=>syntheticResponse([audio(1,'0100')]),'CLOUD_INCOMPLETE'],
  ['missing audio',async()=>syntheticResponse([audio(2)]),'CLOUD_INCOMPLETE'],
  ['unfinished PCM sample',async()=>syntheticResponse([audio(1,'01'),audio(2)]),'CLOUD_INCOMPLETE'],
  ['invalid audio',async()=>syntheticResponse([audio(1,'01zz'),audio(2)]),'CLOUD_PROTOCOL'],
  ['uncorrelated full audio',async()=>syntheticResponse([audio(1,'0100'),audio(2,'02000300')]),'CLOUD_PROTOCOL'],
  ['provider rate limiting',async()=>syntheticResponse([{base_resp:{status_code:1002,status_msg:key}}]),'CLOUD_MINIMAX_RATE_LIMIT'],
  ['a redirect',async()=>new Response(key,{status:307,headers:{location:'https://fixture.invalid/?secret='+key}}),'CLOUD_MINIMAX_HTTP'],
  ['a network rejection',async()=>{throw new Error(key);},'CLOUD_NETWORK'],
])test('ordinary MiniMax reports '+name+' without replaying the request or leaking its contents',async t=>{
  const {cloud,attempts}=await fixture(t,{fetch});
  await assert.rejects(Array.fromAsync(cloud.speak(params)),error=>{
    assert.equal(error.code,code);
    assert.equal(error.message.includes(key),false);
    assert.equal(error.cause,undefined);
    return true;
  });
  assert.equal(attempts.length,1);
});

test('injected cloud transports continue to handle synthesis and catalog requests',async t=>{
  const operations=[];
  const {cloud,attempts}=await fixture(t,{
    authorizeSpeech:async()=>{throw Error('The HTTP package gate should not replace injected transport');},
    transport:async (_assets,request)=>{
      operations.push(request.op);
      return {events:(async function*(){
        if(request.op==='voices')yield {type:'result',voices:[{voice_id:'fixture-voice'}]};
        else {
          yield {type:'pcm',pcm:'AQA=',sample_rate:32000};
          yield {type:'done',metrics:{voice_id:'fixture-voice'}};
        }
      })(),cancel:async()=>{}};
    },
  });
  assert.equal((await cloud.listVoices(params))[0].voiceId,'fixture-voice');
  assert.equal((await Array.fromAsync(cloud.speak(params))).at(-1).type,'done');
  assert.deepEqual(operations,['voices','speak']);
  assert.equal(attempts.length,0);
});

test('ordinary MiniMax times out when the service does not send response headers',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const started=Promise.withResolvers(),lateResponse=Promise.withResolvers();
  t.after(()=>lateResponse.resolve(new Response(null)));
  const {cloud,attempts}=await fixture(t,{fetch:async()=>{started.resolve();return lateResponse.promise;}});
  const task=assert.rejects(Array.fromAsync(cloud.speak(params)),{code:'CLOUD_TIMEOUT'});
  await started.promise;
  t.mock.timers.tick(30000);
  await task;
  assert.equal(attempts[0].init.signal.aborted,true);
});

test('ordinary MiniMax transport errors have English UI messages',()=>{
  const messages=[
    ['MiniMax 返回了无效流式事件','MiniMax returned an invalid streaming event.'],
    ['MiniMax 云配音响应超时','MiniMax voice synthesis timed out.'],
    ['MiniMax 云配音连接失败','Could not connect to MiniMax voice synthesis.'],
    ['MiniMax 云配音网络尚未准备','The network connection for MiniMax voice synthesis is unavailable.'],
  ];
  assert.deepEqual(messages.map(([message])=>translate(message,'en')),messages.map(([,english])=>english));
});
