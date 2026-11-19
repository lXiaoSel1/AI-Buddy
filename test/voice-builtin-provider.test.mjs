import test from 'node:test';
import assert from 'node:assert/strict';
import {minimaxBusinessError} from '../src/voice/minimax-speech-errors.mjs';
import {createCloudProviderRegistry} from '../src/voice/cloud-providers/index.mjs';

const key='synthetic-test-token';
const systemVoiceId='Chinese (Mandarin)_Reliable_Executive';

test('MiniMax distinguishes account, voice and one-line failures for the latest status codes',()=>{
  const codeCategories=[
    [2067,'balance'],[2056,'quota'],[2057,'auth'],[1039,'rate_limit'],
    [2061,'parameters'],[2068,'parameters'],[2069,'parameters'],[1042,'moderation'],
  ];
  assert.deepEqual(
    codeCategories.map(([status_code])=>minimaxBusinessError({base_resp:{status_code}})?.category),
    codeCategories.map(([,category])=>category),
  );
});

test('connecting to MiniMax verifies synthesis on the selected region without a voice plugin',async()=>{
  const calls=[];
  const registry=createCloudProviderRegistry({fetchImpl:async(url,options)=>{
    calls.push([url,JSON.parse(options.body)]);
    assert.equal(new Headers(options.headers).get('authorization'),'Bearer '+key);
    return Response.json({base_resp:{status_code:0},data:{status:2,audio:'0100'}});
  }});
  assert.deepEqual(await registry.get('minimax-cn').probe({key}),{state:'ready'});
  assert.deepEqual(await registry.get('minimax-global').probe({key}),{state:'ready'});
  assert.deepEqual(calls.map(([url])=>url),['https://api.minimax.cn/v1/t2a_v2','https://api.minimax.io/v1/t2a_v2']);
  for(const [,body] of calls){
    assert.equal(body.stream,false);
    assert.equal(body.voice_setting.voice_id,systemVoiceId);
    assert.ok(body.text.length>0 && body.text.length<=5);
  }
});

for(const [status_code,state,category,code] of [
  [2057,'key_invalid','auth','CLOUD_MINIMAX_AUTH'],
  [2067,'balance_insufficient','balance','CLOUD_MINIMAX_BALANCE'],
  [2056,'unavailable','quota','CLOUD_MINIMAX_QUOTA'],
])test('connection check reports safe '+category+' details',async()=>{
  const result=await createCloudProviderRegistry({fetchImpl:async()=>Response.json({
    base_resp:{status_code,status_msg:key+' '+systemVoiceId},
  })}).get('minimax-cn').probe({key});
  assert.deepEqual([result.state,result.category,result.code,result.providerCode],[state,category,code,status_code]);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-test-token|Reliable_Executive|status_msg/);
});

test('connection check reports network failure without exposing inputs from the transport',async()=>{
  const provider=createCloudProviderRegistry({fetchImpl:async()=>{throw Error(key);}}).get('minimax-cn');
  const result=await provider.probe({key});
  assert.deepEqual([result.state,result.category,result.code],['unavailable','network','CLOUD_NETWORK']);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-test-token/);
});

test('voice settings can list system and account voices with provider IDs intact',async()=>{
  const fixture={
    system_voice:[{voice_id:systemVoiceId,voice_name:'Steady Executive'},{voice_id:'contains\nnewline'}],
    voice_cloning:[{voice_id:'synthetic-clone'}],
    voice_generation:[{voice_id:'synthetic-design',name:'Designed'}],
    base_resp:{status_code:0},
  };
  const calls=[];
  const provider=createCloudProviderRegistry({fetchImpl:async(url,options)=>{
    calls.push([url,JSON.parse(options.body).voice_type]);
    return Response.json(fixture);
  }}).get('minimax-global');
  assert.deepEqual(await provider.listVoices({key},{kind:'all'}),[
    {voiceId:systemVoiceId,name:'Steady Executive',category:'system_voice',kind:'system'},
    {voiceId:'synthetic-clone',name:'synthetic-clone',category:'voice_cloning',kind:'clone'},
    {voiceId:'synthetic-design',name:'Designed',category:'voice_generation',kind:'account'},
  ]);
  assert.deepEqual((await provider.listVoices({key},{kind:'cloned'})).map(row=>row.voiceId),['synthetic-clone']);
  assert.deepEqual(calls,[
    ['https://api.minimax.io/v1/get_voice','all'],
    ['https://api.minimax.io/v1/get_voice','voice_cloning'],
  ]);
});

const sse=row=>'data: '+JSON.stringify(row)+'\r\n\r\n';
const speechRequest={model:'speech-2.8-turbo',voiceId:systemVoiceId,text:'Synthetic speech example.'};

test('cloud speech streams usable PCM before the provider sends the confirmed tail',async()=>{
  const encoder=new TextEncoder();
  let stream,request;
  const provider=createCloudProviderRegistry({fetchImpl:async(url,options)=>{
    request=[url,JSON.parse(options.body)];
    return new Response(new ReadableStream({
      start(controller){
        stream=controller;
        const first=sse({data:{status:1,audio:'010002'}});
        stream.enqueue(encoder.encode(first.slice(0,2)));
        stream.enqueue(encoder.encode(first.slice(2)));
      },
    }),{headers:{'content-type':'application/json'}});
  }}).get('minimax-cn');
  const audio=provider.synthesize({key},speechRequest);
  assert.deepEqual(Buffer.from((await audio.next()).value),Buffer.from([1,0]));
  stream.enqueue(encoder.encode(sse({
    base_resp:{status_code:0},data:{status:2,audio:'01000200'},
    extra_info:{usage_characters:42,usage_voice_count:1,trace_id:key},
  })));
  stream.close();
  assert.deepEqual((await Array.fromAsync(audio)).map(bytes=>Buffer.from(bytes)),[Buffer.from([2,0])]);
  assert.deepEqual(await audio.usage,{characters:42,voices:1});
  assert.equal(request[0],'https://api.minimax.cn/v1/t2a_v2');
  assert.deepEqual(request[1].stream_options,{exclude_aggregated_audio:true});
  assert.deepEqual(request[1].audio_setting,{format:'pcm',sample_rate:32000,channel:1});
});

test('SSE business errors preserve partial PCM and expose no request or response text',async()=>{
  const secretText=speechRequest.text;
  const rows=sse({data:{status:1,audio:'0100'}})+sse({base_resp:{status_code:2054,status_msg:key+' '+secretText}});
  const provider=createCloudProviderRegistry({fetchImpl:async()=>new Response(rows)}).get('minimax-global');
  const audio=provider.synthesize({key},speechRequest);
  assert.deepEqual(Buffer.from((await audio.next()).value),Buffer.from([1,0]));
  await assert.rejects(audio.next(),error=>{
    assert.deepEqual([error.code,error.category,error.providerCode],['CLOUD_MINIMAX_PARAMETERS','parameters',2054]);
    assert.doesNotMatch(error.message,new RegExp(key+'|'+secretText));
    assert.equal(error.cause,undefined);
    return true;
  });
  assert.equal(await audio.usage,undefined);
});

const ownedVoiceId='synthetic-owned-voice';
const reference={bytes:Uint8Array.of(82,73,70,70),format:'wav',text:'Synthetic reference transcript.'};

test('clone creation uploads the bundled reference and requires a separate first synthesis',async()=>{
  const calls=[];
  const fileId='439254716950954123';
  const provider=createCloudProviderRegistry({fetchImpl:async(url,{body})=>{
    calls.push([url,body]);
    if(url.endsWith('/upload')){
      assert.equal(body.get('purpose'),'voice_clone');
      const audio=body.get('file');
      assert.equal(audio.name,'voice-reference.wav');
      assert.equal(audio.type,'audio/wav');
      assert.deepEqual(new Uint8Array(await audio.arrayBuffer()),reference.bytes);
      return new Response('{"file":{"file_id":'+fileId+'},"base_resp":{"status_code":0}}');
    }
    if(url.endsWith('/voice_clone')){
      assert.match(body,new RegExp('"file_id":'+fileId+'[,}]'));
      const parsed=JSON.parse(body);
      assert.deepEqual([parsed.voice_id,parsed.text_validation],[ownedVoiceId,reference.text]);
      assert.equal(parsed.text,undefined);
      return Response.json({base_resp:{status_code:0}});
    }
    assert.equal(JSON.parse(body).voice_setting.voice_id,ownedVoiceId);
    return Response.json({base_resp:{status_code:0},data:{status:2,audio:'0100'}});
  }}).get('minimax-global');
  assert.deepEqual(await provider.cloneVoice({key},{voiceId:ownedVoiceId,reference}),{
    voiceId:ownedVoiceId,state:'pending-activation',
  });
  assert.deepEqual(calls.map(([url])=>url),[
    'https://api.minimax.io/v1/files/upload','https://api.minimax.io/v1/voice_clone',
  ]);
  assert.equal(await provider.activateVoice({key},{voiceId:ownedVoiceId,model:'speech-2.8-hd'}),undefined);
  assert.equal(calls[2][0],'https://api.minimax.io/v1/t2a_v2');
  assert.equal(JSON.parse(calls[2][1]).model,'speech-2.8-hd');
});

test('a clone-slot error is actionable only while creating a clone',async()=>{
  const provider=createCloudProviderRegistry({fetchImpl:async(url)=>{
    if(url.endsWith('/upload'))return Response.json({file:{file_id:12345},base_resp:{status_code:0}});
    return Response.json({base_resp:{status_code:2052,status_msg:key+' '+reference.text}});
  }}).get('minimax-cn');
  await assert.rejects(provider.cloneVoice({key},{voiceId:ownedVoiceId,reference}),error=>{
    assert.deepEqual([error.code,error.providerCode],['CLOUD_MINIMAX_CLONE_SLOTS',2052]);
    assert.doesNotMatch(error.message,/synthetic-test-token|Synthetic reference transcript/);
    assert.equal(provider.classifyError(error).code,'CLOUD_MINIMAX_CLONE_SLOTS');
    return true;
  });
  const body={base_resp:{status_code:2052,status_msg:key}};
  assert.equal(provider.classifyError(body).code,'CLOUD_MINIMAX_UNKNOWN');
});

test('a cloned voice can be explicitly deleted on its own account',async()=>{
  const calls=[];
  const provider=createCloudProviderRegistry({fetchImpl:async(url,{body})=>{
    calls.push([url,JSON.parse(body)]);
    return Response.json({base_resp:{status_code:0}});
  }}).get('minimax-cn');
  await provider.deleteVoice({key},ownedVoiceId);
  assert.deepEqual(calls,[['https://api.minimax.cn/v1/delete_voice',{voice_type:'voice_cloning',voice_id:ownedVoiceId}]]);
});

test('closing a cloud speech iterator cancels a request waiting for its first audio and settles usage',async()=>{
  const started=Promise.withResolvers();
  const provider=createCloudProviderRegistry({fetchImpl:async(_url,{signal})=>{
    started.resolve(signal);
    return new Promise(()=>{});
  }}).get('minimax-cn');
  const audio=provider.synthesize({key},speechRequest);
  const first=audio.next();
  const signal=await started.promise;
  const close=audio.return();
  await assert.rejects(first,{name:'AbortError'});
  assert.deepEqual(await close,{done:true,value:undefined});
  assert.equal(signal.aborted,true);
  assert.equal(await audio.usage,undefined);
});
