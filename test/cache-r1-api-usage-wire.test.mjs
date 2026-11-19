import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiTransport} from '../src/api-transport.mjs';
import {PriceService} from '../src/pricing.mjs';
import {normalizedRequest} from '../src/usage-query.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const chat='chat-completions';
const kimi={kind:'kimi',baseUrl:'https://api.moonshot.ai/v1',model:'kimi-k3.1-pro',kimiCacheTtl:'1h',protocol:chat};
const deepseek={kind:'deepseek',baseUrl:'https://api.deepseek.com/v1',protocol:chat};
const custom={kind:'custom',baseUrl:'https://proxy.example.test/v1',protocol:chat};
const scoped={version:1,kind:'private',sessionUuid:'b869f312-d170-4a64-a214-4ad239d44fda',scopeKey:'fixture'};
const json=(usage,protocol)=>Response.json(protocol==='responses'?{output:[{content:[{type:'output_text',text:'ok'}]}],usage}:protocol==='anthropic'?{content:[{type:'text',text:'ok'}],usage}:protocol==='gemini'?{candidates:[{content:{parts:[{text:'ok'}]},finishReason:'STOP'}],usageMetadata:usage}:{choices:[{message:{content:'ok'},finish_reason:'stop'}],usage});
function sse(events,headers={}){
  return new Response(events.map(event=>'data: '+(event==='[DONE]'?event:JSON.stringify(event))+'\n\n').join(''),{headers:{'content-type':'text/event-stream',...headers}});
}
async function request(profile,response,{failure,options={},onRecord,onAudit,onFetch}={}){
  const records=[];
  const transport=new ApiTransport({fetchImpl:async(_url,init)=>{onFetch?.(JSON.parse(init.body));return response;},onUsage:row=>records.push(row),audit:onAudit});
  const call=async()=>{for await(const _ of transport.stream({id:'fixture',key:'fixture',model:'fixture',...profile},{messages:[{role:'user',content:'hi'}],...options})){}};
  if(failure)await assert.rejects(call,failure);else await call();
  assert.equal(records.length,1);
  onRecord?.(records[0]);
  return records[0].usage;
}

// Vendor usage excerpts verified in RESEARCH-API-CACHE.md on 2026-11-16.
// A transport envelope adds only synthetic text and terminal fields.
const docs=[
  ['DeepSeek','https://api-docs.deepseek.com/api/create-chat-completion',deepseek,{prompt_tokens:7,completion_tokens:11,total_tokens:18,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:7,prompt_tokens_details:{cached_tokens:0}},[7,0,null]],
  ['Kimi','https://platform.kimi.ai/docs/api/chat.md',kimi,{prompt_tokens:373,completion_tokens:112,total_tokens:485,completion_tokens_details:{reasoning_tokens:90},prompt_tokens_details:{cache_write_tokens:256}},[373,0,256]],
  ['Qwen','https://help.aliyun.com/zh/model-studio/context-cache',custom,{prompt_tokens:3019,completion_tokens:104,total_tokens:3123,prompt_tokens_details:{cached_tokens:2048}},[3019,2048,null]],
  ['MiniMax','https://platform.minimax.io/docs/api-reference/text-chat-openai.md',custom,{prompt_tokens:172,prompt_tokens_details:{cached_tokens:159}},[172,159,null]],
  ['GLM','https://docs.z.ai/guides/capabilities/cache.md',custom,{prompt_tokens:1075,prompt_tokens_details:{cached_tokens:1024}},[1075,1024,null]],
  ['OpenAI','https://developers.openai.com/api/docs/guides/prompt-caching',{...custom,protocol:'responses'},{input_tokens:15000,input_tokens_details:{cached_tokens:12000,cache_write_tokens:3000}},[15000,12000,3000]],
  ['SiliconFlow','https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions',custom,{prompt_tokens:1383,completion_tokens:205,total_tokens:1588,prompt_tokens_details:{cached_tokens:0},prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:1383},[1383,0,null]]
];
for(const [label,url,profile,wire,expected] of docs)test(label+' usage excerpt from '+url,async()=>{
  const result=await request(profile,json(wire,profile.protocol));
  assert.deepEqual([result.input,result.cacheRead,result.cacheWrite],expected);
});

// These counts are synthetic. Each fixture uses the field names in the linked vendor reference.
const shapes=[
  ['Grok Responses','https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing.md','responses',{input_tokens:10,input_tokens_details:{cached_tokens:3}}],
  ['Anthropic','https://platform.claude.com/docs/en/build-with-claude/prompt-caching','anthropic',{input_tokens:10,cache_read_input_tokens:3,cache_creation_input_tokens:2}],
  ['Gemini','https://aistudio.google.com/api-reference/generate-content','gemini',{promptTokenCount:10,cachedContentTokenCount:3}],
  ['Doubao','https://www.volcengine.com/docs/82379/1396490',chat,{prompt_tokens:10,prompt_tokens_details:{cached_tokens:3}}]
];
for(const [label,url,protocol,wire] of shapes)test(label+' usage shape from '+url,async()=>{
  const result=await request({...custom,protocol},json(wire,protocol));
  assert.deepEqual([result.input,result.cacheRead],[10,3]);
  if(protocol==='anthropic')assert.deepEqual([result.cacheIncluded,result.cacheWriteIncluded,result.inputBasis],[false,false,'uncached']);
});

test('cache aliases preserve zero, retain primary values, and flag conflicting values',async()=>{
  const wire={prompt_tokens:20,completion_tokens:8,prompt_tokens_details:{cached_tokens:0,cache_creation_input_tokens:2},prompt_cache_hit_tokens:9,prompt_cache_miss_tokens:20,cached_tokens:7};
  const result=await request(custom,json(wire));
  assert.equal(result.cacheRead,0);
  assert.equal(result.cacheWrite,2);
  assert.equal(result.cacheWriteIncluded,true);
  assert.ok(result.usageQuality.includes('conflict'));
  assert.deepEqual(result.rawUsage,wire);
  const alias=await request(custom,json({prompt_cache_hit_tokens:3,prompt_cache_miss_tokens:7,completion_tokens:2}));
  assert.deepEqual([alias.cacheRead,alias.input],[3,10]);
  assert.ok(alias.usageQuality.includes('calculated'));
  assert.equal((await request(custom,json({prompt_tokens:10,cached_tokens:3,cache_write_tokens:2}))).cacheWrite,2);
});

test('only complete valid official usage defaults missing cache reads to zero',async()=>{
  const missing={prompt_tokens:12,completion_tokens:2}, chunk={choices:[{delta:{content:'ok'}}],usage:missing};
  const terminal={choices:[{finish_reason:'stop'}]}, last={choices:[],usage:missing};
  assert.equal((await request(kimi,sse([{choices:[{delta:{content:'ok'}}]},terminal,last,'[DONE]']))).cacheRead,0);
  assert.equal((await request(kimi,sse([chunk]),{failure:/中断/})).cacheRead,null);
  assert.equal((await request(kimi,sse([chunk,terminal,{error:{message:'fixture'}}]),{failure:/失败/})).cacheRead,null);
  assert.equal((await request(kimi,new Response('{}',{status:400}),{failure:/API/})).cacheRead,null);
  assert.equal((await request(kimi,json(undefined))).cacheRead,null);
  assert.equal((await request(kimi,json({...missing,cached_tokens:-1}))).cacheRead,null);
  assert.equal((await request({...kimi,baseUrl:custom.baseUrl},json(missing))).cacheRead,null);
  assert.equal((await request(custom,sse([{choices:[{delta:{content:'ok'}}]},terminal,last,'[DONE]']))).cacheRead,null);
  const assumed=await request(deepseek,json(missing));
  assert.equal(assumed.cacheRead,0);
  assert.ok(assumed.usageQuality.includes('assumed-zero-required-field'));
});

const textChunk={choices:[{delta:{content:'ok'}}]};
const stopChunk={choices:[{finish_reason:'stop'}]};
const billingUsage={prompt_tokens:10,completion_tokens:2,prompt_tokens_details:{cache_write_tokens:5}};

test('Kimi later body usage is billed at the requested TTL without headers or DONE',async t=>{
  const root=await mkdtemp(join(tmpdir(),'kimi-price-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const prices=new PriceService({dataRoot:root});await prices.ready;
  const cases=[
    [kimi,scoped,'1h',0.00005,'USD'],
    [kimi,undefined,'5m',0.00004,'USD'],
    [{...kimi,baseUrl:'https://api.moonshot.cn/v1'},scoped,'1h',0.000331,'CNY'],
  ];
  for(const [profile,cacheContext,ttl,amount,currency] of cases){
    let record,body;
    const usage=await request(profile,sse([textChunk,stopChunk,{choices:[],usage:billingUsage}]),{
      options:{cacheContext},onRecord:row=>record=row,onFetch:value=>body=value,
    });
    assert.equal(body.stream_options.include_usage,true);
    assert.equal(body.prompt_cache_options?.ttl??'5m',ttl);
    assert.deepEqual([usage.requestedCacheTtl,usage.cacheWrite5m,usage.cacheWrite1h,usage.cacheRead],
      [ttl,ttl==='5m'?5:0,ttl==='1h'?5:0,0]);
    const estimate=prices.estimate(normalizedRequest({...record,...usage,usage}));
    assert.equal(estimate.currency,currency);
    assert.ok(Math.abs(estimate.amount-amount)<1e-12);
  }
});

test('Kimi header mismatches are audited without changing the body or request bill',async()=>{
  const audits=[];
  const reply=sse([textChunk,stopChunk,{choices:[],usage:billingUsage},'[DONE]'],{
    'Msh-Usage-Cache-Write-Tokens-5m':'5','Msh-Usage-Cache-Write-Tokens-1h':'0',
  });
  const result=await request(kimi,reply,{options:{cacheContext:scoped},onAudit:entry=>audits.push(entry)});
  assert.deepEqual([result.cacheWrite5m,result.cacheWrite1h,result.cacheWriteIncluded],[0,5,true]);
  assert.ok(!result.usageQuality.includes('conflict'));
  assert.ok(audits.some(entry=>entry.type==='api-cache-write-header-mismatch'));
});

test('Kimi zero cache counters and usage object remain known at normal EOF',async()=>{
  const usage={prompt_tokens:0,completion_tokens:0,total_tokens:0,prompt_tokens_details:{}};
  const withUsage=await request(kimi,sse([textChunk,stopChunk,{choices:[],usage}]));
  assert.deepEqual([withUsage.total,withUsage.cacheRead,withUsage.cacheWrite],[0,0,0]);
  assert.ok(!withUsage.usageQuality.includes('incomplete-usage'));
  const noUsage=await request(kimi,sse([textChunk,stopChunk]));
  assert.deepEqual([noUsage.total,noUsage.cacheRead,noUsage.cacheWrite],[null,null,null]);
});

test('usage on the DeepSeek terminal chunk survives normal EOF without DONE',async()=>{
  const usage={prompt_tokens:9,completion_tokens:3,prompt_cache_hit_tokens:2,prompt_cache_miss_tokens:7};
  const result=await request(deepseek,sse([textChunk,{...stopChunk,usage}]));
  assert.deepEqual([result.input,result.output,result.cacheRead],[9,3,2]);
  assert.ok(!result.usageQuality.includes('incomplete-usage'));
  await request(deepseek,sse([textChunk,'[DONE]']),{failure:/中断/});
});

test('keep-alives cannot hold an already finished chat stream open',async t=>{
  const encoder=new TextEncoder();
  let heartbeats,guard,cancelled=false;
  t.after(()=>{clearInterval(heartbeats);clearTimeout(guard);});
  const body=new ReadableStream({
    start(controller){
      controller.enqueue(encoder.encode([textChunk,{...stopChunk,usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0,prompt_cache_hit_tokens:0}}]
        .map(chunk=>'data: '+JSON.stringify(chunk)+'\n\n').join('')));
      heartbeats=setInterval(()=>controller.enqueue(encoder.encode(': keep-alive\n\n')),80);
      guard=setTimeout(()=>{clearInterval(heartbeats);controller.close();},5600);
    },
    cancel(){cancelled=true;clearInterval(heartbeats);clearTimeout(guard);},
  });
  const result=await request(deepseek,new Response(body,{headers:{'content-type':'text/event-stream'}}));
  assert.equal(cancelled,true);
  assert.equal(result.total,0);
  assert.ok(!result.usageQuality.includes('incomplete-usage'));
});

test('only official summary requests override reasoning',async()=>{
  const bodyFor=async(profile,purpose)=>{
    let body;
    await request(profile,json(undefined),{options:{purpose,maxTokens:4096},onFetch:value=>body=value});
    return body;
  };
  const compact='chat-window-compact';
  assert.deepEqual((await bodyFor(deepseek,compact)).thinking,{type:'disabled'});
  assert.equal((await bodyFor(kimi,compact)).reasoning_effort,'low');
  assert.equal((await bodyFor(deepseek,'galgame')).thinking,undefined);
  assert.equal((await bodyFor({...kimi,baseUrl:custom.baseUrl},compact)).reasoning_effort,undefined);
});

test('native-search chat accepts normal EOF after the final Kimi usage event',async()=>{
  const options={cacheContext:scoped,nativeSearch:{allowed:true}};
  const result=await request(kimi,sse([textChunk,stopChunk,{choices:[],usage:billingUsage}]),{options});
  assert.equal(result.cacheWrite1h,5);
  assert.equal(result.cacheRead,0);
  assert.ok(!result.usageQuality.includes('incomplete-usage'));
});

test('a filtered summary rejects its text but records usage on or after the terminal',async()=>{
  const options={purpose:'chat-window-compact',cacheContext:scoped};
  const terminal={choices:[{delta:{content:'filtered text'},finish_reason:'content_filter'}]};
  for(const chunks of [
    [{...terminal,usage:billingUsage}],
    [terminal,{choices:[],usage:billingUsage}],
  ]){
    const result=await request(kimi,sse(chunks),{options,failure:/正文/});
    assert.equal(result.cacheWrite1h,5);
    assert.equal(result.cacheRead,0);
    assert.ok(!result.usageQuality.includes('incomplete-usage'));
  }
});

test('a socket error after finish and final usage retains authoritative billing data',async()=>{
  const encoder=new TextEncoder();
  for(const options of [{},{nativeSearch:{allowed:true}}]){
    const body=new ReadableStream({
      start(controller){
        controller.enqueue(encoder.encode([textChunk,stopChunk,{choices:[],usage:billingUsage}]
          .map(chunk=>'data: '+JSON.stringify(chunk)+'\n\n').join('')));
      },
      pull(controller){controller.error(Error('Synthetic socket reset'));},
    });
    const result=await request(kimi,new Response(body,{headers:{'content-type':'text/event-stream'}}),
      {options:{...options,cacheContext:scoped},failure:/连接/});
    assert.equal(result.cacheWrite1h,5);
    assert.equal(result.cacheRead,0);
    assert.ok(!result.usageQuality.includes('incomplete-usage'));
  }
});

for(const [label,search] of [['ordinary chat',{}],['native search',{nativeSearch:{allowed:true}}]]){
  test(label+' confirms early usage when finish is followed by clean EOF',async()=>{
    const early={...textChunk,usage:{prompt_tokens:12,completion_tokens:2,prompt_tokens_details:{}}};
    const result=await request(kimi,sse([early,stopChunk]),{options:search});
    assert.deepEqual([result.input,result.output,result.cacheRead,result.cacheWrite],[12,2,0,0]);
    assert.ok(!result.usageQuality.includes('incomplete-usage'));
  });
}

test('custom Chat Completions can end with a final usage-only event and explicit DONE',async()=>{
  const usage={choices:[],usage:{prompt_tokens:7,completion_tokens:2,total_tokens:9}};
  const result=await request(custom,sse([textChunk,usage,'[DONE]']));
  assert.equal(result.total,9);
  assert.ok(!result.usageQuality.includes('incomplete-usage'));
  for(const tail of [[usage],['[DONE]'],[{choices:[],usage:{}},'[DONE]']])
    await request(custom,sse([textChunk,...tail]),{failure:/中断/});
  await request(deepseek,sse([textChunk,usage,'[DONE]']),{failure:/中断/});
  await request(custom,sse([textChunk,usage,'[DONE]']),{
    options:{purpose:'image-capability-probe'},failure:/MODEL_IMAGE_PROBE_INCOMPLETE/,
  });
});


test('custom window compaction requires a real finish reason despite usage and DONE',async()=>{
  const usage={choices:[],usage:{prompt_tokens:7,completion_tokens:2,total_tokens:9}};
  await request(custom,sse([textChunk,usage,'[DONE]']),{
    options:{purpose:'chat-window-compact'},failure:/中断/,
  });
});