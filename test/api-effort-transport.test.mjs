import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiTransport} from '../src/api-transport.mjs';

const messages=[{role:'user',content:'你好'}];
const usage={input_tokens:11,output_tokens:7,output_tokens_details:{reasoning_tokens:3},total_tokens:18};
const profile={id:'fixture-connection',kind:'custom',baseUrl:'https://model.example.test/v1',model:'fixture',key:'fixture-key',models:[{id:'fixture',supportedReasoningEfforts:['none','minimal','low','medium','high','xhigh','max','ultra']}]};
function reply(protocol){
  if(protocol==='responses')return {output:[{content:[{type:'output_text',text:'回复'}]}],usage};
  if(protocol==='anthropic')return {content:[{type:'text',text:'回复'}],usage};
  if(protocol==='gemini')return {candidates:[{content:{parts:[{text:'回复'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:11,candidatesTokenCount:7,thoughtsTokenCount:3,totalTokenCount:21}};
  return {choices:[{message:{content:'回复'},finish_reason:'stop'}],usage:{prompt_tokens:11,completion_tokens:7,completion_tokens_details:{reasoning_tokens:3},total_tokens:18}};
}
async function capture(protocol,reasoningEffort,options={}){
  const requests=[],usages=[],audit=[];
  const transport=new ApiTransport({fetchImpl:async(url,request)=>{
    requests.push({url,method:request.method,body:JSON.parse(request.body)});
    return Response.json(reply(protocol));
  },onUsage:value=>usages.push(value),audit:value=>audit.push(value)});
  const chunks=[];
  for await(const chunk of transport.stream({...profile,protocol,reasoningEffort},{system:'系统',messages,maxTokens:1024,...options}))chunks.push(chunk);
  assert.equal(requests.length,1);
  assert.deepEqual(chunks,[{type:'text-delta',text:'回复'},{type:'finish',reason:{kind:'stop'}}]);
  assert.equal(usages.length,1);assert.equal(usages[0].usage.input,11);assert.equal(usages[0].usage.output,7);assert.equal(usages[0].usage.reasoning,3);
  assert.equal(usages[0].usage.total,protocol==='gemini'?21:18);
  assert.equal(audit.length,1);assert.equal(audit[0].completed,true);
  return requests[0];
}
const baseline={
  responses:{model:'fixture',instructions:'系统',input:messages,max_output_tokens:1024,stream:true,store:false},
  'chat-completions':{model:'fixture',messages:[{role:'system',content:'系统'},...messages],max_tokens:1024,stream:true,stream_options:{include_usage:true}},
};
for(const protocol of ['responses','chat-completions'])test(protocol+' sends the selected profile effort using its protocol field and preserves the request',async()=>{
  for(const effort of ['none','minimal','low','medium','high','xhigh','max','ultra']){
    const request=await capture(protocol,effort,{reasoningEffort:'high'});
    assert.equal(request.url,profile.baseUrl+(protocol==='responses'?'/responses':'/chat/completions'));
    assert.equal(request.method,'POST');
    assert.deepEqual(request.body,{...baseline[protocol],...(protocol==='responses'?{reasoning:{effort}}:{reasoning_effort:effort})});
  }
});
test('default and automatic effort preserve legacy OpenAI requests; call options cannot override the profile',async()=>{
  for(const protocol of ['responses','chat-completions'])for(const effort of [undefined,null,'','default','auto']){
    assert.deepEqual((await capture(protocol,effort,{reasoningEffort:'high'})).body,baseline[protocol]);
  }
});
test('An unsupported or unverified effort fails before any API request',async()=>{
  let calls=0;const transport=new ApiTransport({fetchImpl:async()=>{calls++;return Response.json({});}});
  for(const p of [{...profile,reasoningEffort:'unsupported'},{...profile,models:[],reasoningEffort:'high'},{...profile,models:[{id:'fixture',supportedReasoningEfforts:['low']}],reasoningEffort:'high'}]){
    await assert.rejects(async()=>{for await(const _ of transport.stream({...p,protocol:'responses'},{messages})){};},/推理强度/);
  }
  assert.equal(calls,0);
});
test('Anthropic and Gemini never receive OpenAI effort fields, even when a profile sets effort',async()=>{
  const anthropic=await capture('anthropic','high');
  assert.deepEqual(anthropic.body,{model:'fixture',system:'系统',messages,max_tokens:1024,stream:true});
  const gemini=await capture('gemini','ultra');
  assert.deepEqual(gemini.body,{systemInstruction:{parts:[{text:'系统'}]},contents:[{role:'user',parts:[{text:'你好'}]}],generationConfig:{maxOutputTokens:1024}});
});
