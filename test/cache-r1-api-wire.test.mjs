import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiTransport} from '../src/api-transport.mjs';

const sessionUuid='b869f312-d170-4a64-a214-4ad239d44fda';
const privateCache={version:1,kind:'private',sessionUuid,scopeKey:'fixture-private-scope'};
const kimi={kind:'kimi',protocol:'chat-completions',baseUrl:'https://api.moonshot.ai/v1',model:'kimi-k3.1-pro'};
const openai={kind:'openai',protocol:'responses',baseUrl:'https://api.openai.com/v1',model:'gpt-5.5'};
const grok={kind:'grok',protocol:'chat-completions',baseUrl:'https://api.x.ai/v1',model:'grok-4.7'};
const claude={kind:'claude',protocol:'anthropic',baseUrl:'https://api.anthropic.com/v1',model:'claude-sonnet-4-6'};
const replies={responses:{output:[{content:[{type:'output_text',text:'ok'}]}]},anthropic:{content:[{type:'text',text:'ok'}]},'chat-completions':{choices:[{message:{content:'ok'},finish_reason:'stop'}]}};
async function wire(profile,cacheContext=privateCache,nativeSearch){
  let wireRequest;
  const transport=new ApiTransport({fetchImpl:async(url,{body,headers})=>{
    wireRequest={url,body:JSON.parse(body),headers:new Headers(headers)};
    return Response.json(replies[profile.protocol]);
  }});
  for await(const _ of transport.stream({...profile,id:'fixture',key:'fixture'},{messages:[{role:'user',content:'hi'}],cacheContext,nativeSearch})){}
  return wireRequest;
}

test('official cache options are stable per private session and scoped to the supported wire',async()=>{
  assert.equal((await wire(kimi)).body.prompt_cache_key,sessionUuid);
  assert.equal((await wire(kimi)).body.prompt_cache_key,sessionUuid);
  const other='d869f312-d170-4a64-a214-4ad239d44fda';
  assert.equal((await wire(kimi,{...privateCache,sessionUuid:other})).body.prompt_cache_key,other);
  const ttl=(await wire({...kimi,kimiCacheTtl:'1h'})).body;
  assert.deepEqual(ttl.prompt_cache_options,{mode:'implicit',ttl:'1h'});
  assert.equal(ttl.prompt_cache_breakpoint,undefined);
  assert.deepEqual((await wire({...kimi,model:'kimi-k3.1-pro-highspeed',kimiCacheTtl:'1h'})).body.prompt_cache_options,{mode:'implicit',ttl:'1h'});
  assert.equal((await wire({...kimi,model:'unknown',kimiCacheTtl:'1h'})).body.prompt_cache_options,undefined);
  assert.equal((await wire(kimi)).body.prompt_cache_options,undefined);
  assert.equal((await wire(openai)).body.prompt_cache_key,sessionUuid);

  assert.equal((await wire(grok)).headers.get('x-grok-conv-id'),sessionUuid);
  assert.deepEqual((await wire(claude)).body.cache_control,{type:'ephemeral'});
  for(const profile of [{...kimi,kind:'custom'},{...kimi,baseUrl:'https://proxy.example.test/v1'},{...kimi,baseUrl:'https://api.moonshot.ai/v1/proxy'},{...kimi,protocol:'responses'},kimi]){
    const request=await wire(profile,profile===kimi?{...privateCache,sessionUuid:'my-name'}:privateCache);
    assert.equal(request.body.prompt_cache_key,undefined);
  }
  assert.equal((await wire(grok,null)).headers.get('x-grok-conv-id'),null);
  assert.equal((await wire(claude,{...privateCache,kind:'group'})).body.cache_control,undefined);
});

for(const model of ['gpt-5.6','gpt-future-fixture'])test(model+' uses the private session key on official OpenAI Responses',async()=>{
  const profile={...openai,model};
  assert.equal((await wire(profile)).body.prompt_cache_key,sessionUuid);
  assert.equal((await wire({...profile,kind:'custom'})).body.prompt_cache_key,undefined);
  assert.equal((await wire({...profile,baseUrl:'https://proxy.example.test/v1'})).body.prompt_cache_key,undefined);
  assert.equal((await wire(profile,null)).body.prompt_cache_key,undefined);
});

test('native-search private chats retain the cache key and the existing tools',async()=>{
  const request=await wire(kimi,privateCache,{allowed:true});
  assert.equal(request.body.prompt_cache_key,sessionUuid);
  assert.ok(request.body.tools.length>0);
  const shared=await wire(kimi,null,{allowed:true});
  assert.equal(shared.body.prompt_cache_key,undefined);
  assert.deepEqual(shared.body.tools,request.body.tools);
});
