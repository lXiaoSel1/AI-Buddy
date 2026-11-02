import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRouter} from '../src/model-router.mjs';
import {ApiTransport} from '../src/api-transport.mjs';

const searchModule=()=>import('../src/native-search.mjs');
const profile=(kind='openai',protocol='responses',baseUrl='https://api.openai.com/v1',model='gpt-6.1-sol')=>({id:'fixture',kind,protocol,baseUrl,model,key:'fixture-not-a-secret',reasoningEffort:null});
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const sse=values=>new Response(values.map(value=>'data: '+JSON.stringify(value)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
const answer=(text='answer')=>({type:'response.completed',response:{id:'response-1',model:'gpt-6.1-sol',output:[{type:'message',content:[{type:'output_text',text,annotations:[]}]}],usage:{input_tokens:10,output_tokens:2,total_tokens:12}}});
const collect=async iterable=>{const result=[];for await(const part of iterable)result.push(part);return result;};
async function routerFixture({policy=()=>false,fetchImpl}={}){const dataRoot=await mkdtemp(join(tmpdir(),'r95-native-search-')),activities=[],usage=[];const router=new ModelRouter({dataRoot,codex:{defaultModel:'gpt-6.1-sol',enabled:false,setEnabled(){}},crypto:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},searchPolicy:policy,onUsage:value=>usage.push(value),onActivity:value=>activities.push(value),fetchImpl});await router.ready;const draft={...profile(),key:'fixture-not-a-secret'};delete draft.id;const saved=await router.save(draft);await router.activate(saved.id);router.setEnabled(true);return {router,activities,usage,close:async()=>{router.close();await rm(dataRoot,{recursive:true,force:true});}};}

test('all ten presets have explicit native search decisions and third-party domains never inherit them',async()=>{
 const {nativeSearchCapability}=await searchModule();
 const cases=[profile('codex','codex','','gpt-6.1-sol'),profile('gemini','gemini','https://generativelanguage.googleapis.com/v1beta','gemini-2.5-flash'),profile('kimi','chat-completions','https://api.moonshot.ai/v1','kimi-k3'),profile('grok','responses','https://api.x.ai/v1','grok-4.6'),profile(),profile('claude','anthropic','https://api.anthropic.com/v1','claude-sonnet-4-5'),profile('deepseek','chat-completions','https://api.deepseek.com/v1','deepseek-flash'),profile('qwen','chat-completions','https://dashscope.aliyuncs.com/compatible-mode/v1','qwen-plus'),profile('minimax','responses','https://api.minimax.io/v1','MiniMax-M3.1-Flash'),profile('custom','responses','https://proxy.example/v1','gpt-6.1-sol')];
 assert.equal(cases.length,10);for(const item of cases){const value=nativeSearchCapability(item);assert.ok(['supported','unknown','unsupported'].includes(value.status));assert.equal(typeof value.reason,'string');assert.equal(value.supported,item.kind!=='custom',item.kind);}
 for(const url of ['https://api.openai.com.evil.example/v1','https://proxy.example/v1','https://api.openai.com/v1/other','http://api.openai.com/v1'])assert.equal(nativeSearchCapability({...profile(),baseUrl:url}).supported,false,url);
 assert.equal(nativeSearchCapability({...profile(),model:'future-unknown-model'}).status,'unknown');
});
test('default closed Core policy ignores caller requests to enable search',async()=>{
 const calls=[],f=await routerFixture({fetchImpl:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return sse([{type:'response.output_text.delta',delta:'plain'},answer()]);}});
 try{await collect(f.router.stream({messages:[{role:'user',content:'search'}],nativeSearch:{allowed:true},searchEnabled:true,incremental:true}));assert.equal(calls.length,1);assert.equal(calls[0].body.tools,undefined);}finally{await f.close();}
});
test('Core permitted search uses current Responses model, streams text and emits only tool-backed safe sources',async()=>{
 const calls=[],f=await routerFixture({policy:()=>({allowed:true,check:()=>true}),fetchImpl:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return sse([{type:'response.output_item.added',item:{id:'ws1',type:'web_search_call',status:'in_progress',action:{type:'search',query:'q'}}},{type:'response.output_text.delta',delta:'current answer'}, {type:'response.output_text.annotation.added',annotation:{type:'url_citation',url:'https://example.com/page#fragment',title:'Source'}},{type:'response.output_text.annotation.added',annotation:{type:'url_citation',url:'file:///C:/secret',title:'bad'}},answer()]);}});
 try{const parts=await collect(f.router.stream({messages:[{role:'user',content:'search'}],incremental:true,activityOriginId:'core-origin-1',purpose:'social-dream'}));assert.deepEqual(calls[0].body.tools,[{type:'web_search'}]);assert.equal(calls[0].body.model,'gpt-6.1-sol');assert.ok(parts.some(p=>p.type==='native-search-tool'));const sources=parts.filter(p=>p.type==='native-search-sources').flatMap(p=>p.sources);assert.equal(sources.length,1);assert.equal(sources[0].url,'https://example.com/page');assert.equal(sources[0].provenance,'provider-tool');assert.ok(f.activities.every(p=>p.activityOriginId==='core-origin-1'&&p.purpose==='social-dream'));assert.equal(f.usage[0].activityOriginId,'core-origin-1');}finally{await f.close();}
});
test('DeepSeek official search/fetch tool loop retains the exact model, history, effort and separate usage',async()=>{
 const calls=[],usage=[],transport=new ApiTransport({onUsage:value=>usage.push(value),fetchImpl:async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,body});if(url.endsWith('/tools/search'))return json({results:[{url:'https://example.com/source',title:'Evidence',summary:'found'}]});if(calls.filter(c=>c.url.endsWith('/chat/completions')).length===1)return sse([{id:'request-a',choices:[{delta:{reasoning_content:'private reasoning',tool_calls:[{index:0,id:'call1',type:'function',function:{name:'native_web_search',arguments:'{"query":"today"}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7}}]);assert.equal(body.messages.at(-2).reasoning_content,'private reasoning');return sse([{id:'request-b',choices:[{delta:{content:'answer'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:3,total_tokens:23}}]);}});
 const p=profile('deepseek','chat-completions','https://api.deepseek.com/v1','deepseek-flash');const parts=await collect(transport.stream(p,{messages:[{role:'user',content:'look up today'}],maxTokens:2048,nativeSearch:{allowed:true,check:()=>true},purpose:'chat',activityOriginId:'trusted-origin'}));assert.equal(calls.length,3);assert.equal(calls[1].url,'https://api.deepseek.com/v1/tools/search');assert.equal(calls[2].body.model,p.model);assert.equal(calls[2].body.messages.at(-1).tool_call_id,'call1');assert.ok(parts.some(p=>p.type==='native-search-sources'));assert.equal(usage.filter(u=>u.usage?.total!==null).length,2);assert.equal(usage.reduce((n,u)=>n+(u.usage?.total||0),0),30);assert.ok(!parts.some(p=>String(p.text??'').includes('private reasoning')));
});
test('revoking search before an actual client tool prevents the provider search call',async()=>{
 let allowed=true,fetches=0;const transport=new ApiTransport({fetchImpl:async()=>{fetches++;allowed=false;return sse([{choices:[{delta:{tool_calls:[{index:0,id:'c1',type:'function',function:{name:'native_web_search',arguments:'{"query":"q"}'}}]},finish_reason:'tool_calls'}]}]);}});
 await assert.rejects(()=>collect(transport.stream(profile('kimi','chat-completions','https://api.moonshot.ai/v1','kimi-k3'),{nativeSearch:{allowed:true,check:()=>allowed},messages:[{role:'user',content:'q'}]})),/权限|取消|联网/);assert.equal(fetches,1);
});
test('unknown client function calls do not become local shell, project access or arbitrary network requests',async()=>{
 let fetches=0;const transport=new ApiTransport({fetchImpl:async()=>{fetches++;return sse([{choices:[{delta:{tool_calls:[{index:0,id:'c1',type:'function',function:{name:'shell',arguments:'{"command":"dir"}'}}]},finish_reason:'tool_calls'}]}]);}});
 await assert.rejects(()=>collect(transport.stream(profile('kimi','chat-completions','https://api.moonshot.ai/v1','kimi-k3'),{nativeSearch:{allowed:true,check:()=>true},messages:[{role:'user',content:'q'}]})),/工具|权限/);assert.equal(fetches,1);
});
test('source URL normalizer rejects local, credential-bearing and executable references',async()=>{const {normalizeSearchSource}=await searchModule();for(const url of ['javascript:alert(1)','file:///x','http://127.0.0.1/a','http://localhost/a','http://[::1]/a','https://user:pass@example.com/a','http://10.1.2.3/a'])assert.equal(normalizeSearchSource({url}),null,url);assert.equal(normalizeSearchSource({url:'https://example.com/a#b',title:'Title'}).url,'https://example.com/a');});

test('Kimi K3 uses documented text_query and markdown REST schemas, never retired builtin search',async()=>{
 const calls=[],usage=[];let round=0;const transport=new ApiTransport({onUsage:v=>usage.push(v),fetchImpl:async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,body});if(url.endsWith('/tools/search_pro')){assert.deepEqual(body,{text_query:'real facts'});return json({search_results:[{url:'https://example.com/kimi',title:'Kimi result',chunks:[{text:'facts'}]}]});}if(url.endsWith('/tools/fetch'))return json({url:body.url,title:'Full page',markdown:'# Evidence'});round++;if(round<=2)return sse([{choices:[{delta:{reasoning_content:'hidden',tool_calls:[{index:0,id:'c'+round,type:'function',function:{name:round===1?'native_web_search_pro':'native_web_fetch',arguments:round===1?'{"query":"real facts"}':'{"url":"https://example.com/kimi"}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:1,total_tokens:11}}]);return sse([{choices:[{delta:{content:'grounded'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2,total_tokens:22}}]);}});
 const result=await collect(transport.stream(profile('kimi','chat-completions','https://api.moonshot.ai/v1','kimi-k3'),{nativeSearch:{allowed:true},messages:[{role:'user',content:'q'}],maxTokens:2048}));
 assert.equal(round,3);assert.equal(calls.length,5);assert.ok(calls.every(c=>!JSON.stringify(c.body).includes('$web_search')));assert.equal(calls[4].body.messages.filter(m=>m.role==='tool').length,2);assert.ok(calls[4].body.messages.at(-1).content.includes('# Evidence'));assert.equal(result.filter(p=>p.type==='text-delta').map(p=>p.text).join(''),'grounded');assert.equal(usage.filter(u=>u.serviceUsage).length,2);
});
test('Anthropic pause_turn preserves exact server content and records both request usages',async()=>{
 const calls=[],usages=[];const paused=[{type:'text',text:'lead '},{type:'server_tool_use',id:'srv1',name:'web_search',input:{query:'q'}},{type:'web_search_tool_result',tool_use_id:'srv1',content:[{type:'web_search_result',title:'Evidence',url:'https://example.com/a'}]}];const transport=new ApiTransport({onUsage:v=>usages.push(v),fetchImpl:async(url,options)=>{const body=JSON.parse(options.body);calls.push(body);return calls.length===1?json({id:'m1',model:'claude-sonnet-4-5-20250929',content:paused,usage:{input_tokens:10,output_tokens:2,cache_read_input_tokens:3},stop_reason:'pause_turn'}):json({id:'m2',model:'claude-sonnet-4-5-20250929',content:[{type:'text',text:'answer',citations:[{type:'web_search_result_location',url:'https://example.com/a',title:'Citation'}]}],usage:{input_tokens:20,output_tokens:3},stop_reason:'end_turn'});}});
 const parts=await collect(transport.stream(profile('claude','anthropic','https://api.anthropic.com/v1','claude-sonnet-4-5'),{nativeSearch:{allowed:true},messages:[{role:'user',content:'q'}],maxTokens:1000}));assert.equal(calls.length,2);assert.deepEqual(calls[1].messages.at(-1),{role:'assistant',content:paused});assert.deepEqual(calls[0].tools,[{type:'web_search_20250305',name:'web_search'},{type:'web_fetch_20250910',name:'web_fetch'}]);assert.equal(parts.filter(p=>p.type==='text-delta').map(p=>p.text).join(''),'lead answer');assert.equal(usages.length,2);assert.equal(usages[0].usage.total,15);assert.equal(usages[1].usage.total,23);
});
test('Gemini and Qwen use current native protocol and return their actual structured sources',async()=>{
 for(const kind of ['gemini','qwen']){
  let request;const p=kind==='gemini'?profile('gemini','gemini','https://generativelanguage.googleapis.com/v1beta','gemini-2.5-flash'):profile('qwen','chat-completions','https://dashscope.aliyuncs.com/compatible-mode/v1','qwen-plus');
  const transport=new ApiTransport({fetchImpl:async(url,options)=>{request={url,body:JSON.parse(options.body)};return kind==='gemini'?sse([{candidates:[{content:{parts:[{thought:true,text:'hidden'},{text:'gemini answer'}]},groundingMetadata:{groundingChunks:[{web:{uri:'https://example.com/gemini',title:'Gemini source'}}],webSearchQueries:['q']},finishReason:'STOP'}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:2,totalTokenCount:12}}]):sse([{choices:[{delta:{content:'qwen answer'},finish_reason:'stop'}],search_info:{search_results:[{title:'Qwen source',url:'https://example.com/qwen'}]},usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}}]);}});
  const parts=await collect(transport.stream(p,{nativeSearch:{allowed:true},messages:[{role:'user',content:'q'}],maxTokens:1000}));if(kind==='gemini'){assert.deepEqual(request.body.tools,[{googleSearch:{}},{urlContext:{}}]);assert.ok(request.url.endsWith(':streamGenerateContent?alt=sse'));}else{assert.equal(request.body.enable_search,true);assert.deepEqual(request.body.search_options,{enable_source:true});assert.equal(request.body.search_options.forced_search,undefined);}assert.ok(parts.some(p=>p.type==='native-search-sources'&&p.sources[0].url===`https://example.com/${kind}`));assert.ok(parts.every(p=>!String(p.text??'').includes('hidden')));
 }
});
test('server tools may be unused, and body URLs alone are never search evidence',async()=>{
 const transport=new ApiTransport({fetchImpl:async()=>sse([{type:'response.output_text.delta',delta:'Knowledge answer https://invented.example/page'},answer()])});const parts=await collect(transport.stream(profile(),{nativeSearch:{allowed:true},messages:[]}));assert.ok(parts.some(p=>p.type==='native-search-status'&&p.status==='not-used'));assert.equal(parts.filter(p=>p.type==='native-search-sources').length,0);
});
test('cancel while awaiting a streamed search answer releases reader and retains already-observed usage',async()=>{
 const controller=new AbortController(),usages=[];let bodyCancelled=false;const transport=new ApiTransport({onUsage:v=>usages.push(v),fetchImpl:async()=>new Response(new ReadableStream({start(stream){stream.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'response.created',response:{usage:{input_tokens:10,output_tokens:1,total_tokens:11}}})+'\n\n'));},cancel(){bodyCancelled=true;}}),{headers:{'content-type':'text/event-stream'}})});
 const pending=collect(transport.stream(profile(),{nativeSearch:{allowed:true},messages:[],signal:controller.signal}));setTimeout(()=>controller.abort(),15);await assert.rejects(()=>pending,/取消/);assert.equal(bodyCancelled,true);assert.equal(usages.length,1);assert.equal(usages[0].completionState,'cancelled');assert.equal(usages[0].usage.total,11);
});
test('401 and unexpected model do not retry or switch connections',async()=>{
 for(const mode of ['auth','model']){let calls=0;const transport=new ApiTransport({fetchImpl:async()=>{calls++;return mode==='auth'?new Response('{}',{status:401}):sse([{type:'response.completed',response:{model:'gpt-cheaper',output:[],usage:{input_tokens:1,output_tokens:0,total_tokens:1}}}]);}});await assert.rejects(()=>collect(transport.stream(profile(),{nativeSearch:{allowed:true},messages:[]})),mode==='auth'?/API Key/:/不同模型/);assert.equal(calls,1);}
});


test('explicit catalog denial and unverified Qwen model families stay unavailable',async()=>{
 const {nativeSearchCapability}=await searchModule();
 assert.equal(nativeSearchCapability({...profile(),models:[{id:'gpt-6.1-sol',supportsTools:false}]}).status,'unsupported');
 for(const model of ['qwen3-coder-plus','qwen3-embedding-8b','qwen3.8-omni-flash','qwen2.5-7b-instruct'])assert.equal(nativeSearchCapability(profile('qwen','chat-completions','https://dashscope.aliyuncs.com/compatible-mode/v1',model)).status,'unknown',model);
 for(const model of ['qwen-plus','qwen-plus-latest','qwen3-max','qwen3.5-plus-2026-02-15','qwen3.8-flash'])assert.equal(nativeSearchCapability(profile('qwen','chat-completions','https://dashscope.aliyuncs.com/compatible-mode/v1',model)).supported,true,model);
});

test('unavailable current endpoint emits explicit state and retains the same connection without silent substitution',async()=>{
 let calls=0,lastBody;const f=await routerFixture({policy:()=>({allowed:true}),fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://proxy.example/v1/responses');lastBody=JSON.parse(options.body);return sse([{type:'response.output_text.delta',delta:'unverified answer'},answer()]);}});
 try{const item=f.router.selected();await f.router.save({...item,key:'fixture-not-a-secret',baseUrl:'https://proxy.example/v1'});const parts=await collect(f.router.stream({messages:[],incremental:true}));assert.equal(calls,1);assert.equal(lastBody.model,'gpt-6.1-sol');assert.equal(lastBody.tools,undefined);assert.ok(lastBody.instructions.includes('不能声称已经联网核实'));assert.ok(parts.some(p=>p.type==='native-search-status'&&p.status==='unavailable'));f.router.searchPolicy=()=>({allowed:true,required:true});await assert.rejects(()=>collect(f.router.stream({messages:[]})),e=>e.code==='NATIVE_SEARCH_UNAVAILABLE');assert.equal(calls,1);}finally{await f.close();}
});

test('a truncated search request never automatically repeats paid tool work',async()=>{
 let calls=0;const f=await routerFixture({policy:()=>({allowed:true}),fetchImpl:async()=>{calls++;return sse([{type:'response.output_item.done',item:{id:'web1',type:'web_search_call',status:'completed'}},{type:'response.incomplete',response:{incomplete_details:{reason:'max_output_tokens'},usage:{input_tokens:10,output_tokens:2,total_tokens:12}}}]);}});
 try{await assert.rejects(()=>collect(f.router.stream({messages:[],incremental:true})),e=>e.code==='MODEL_OUTPUT_TRUNCATED');assert.equal(calls,1);assert.equal(f.usage.length,1);assert.equal(f.usage[0].usage.total,12);}finally{await f.close();}
});

test('server-side protocols reject unexpected executor calls without executing a local tool',async()=>{
 let calls=0;const transport=new ApiTransport({fetchImpl:async()=>{calls++;return sse([{type:'response.output_item.added',item:{id:'evil',type:'function_call',name:'shell',arguments:'{}'}}]);}});
 await assert.rejects(()=>collect(transport.stream(profile(),{nativeSearch:{allowed:true},messages:[]})),e=>e.code==='NATIVE_SEARCH_TOOL_DENIED');assert.equal(calls,1);
});

test('cancel while awaiting nonstreaming Fetch cancels the body and preserves separate unknown service usage',async()=>{
 const controller=new AbortController(),usage=[];let cancelled=false,fetchStarted;const started=new Promise(resolve=>{fetchStarted=resolve;});
 const transport=new ApiTransport({onUsage:v=>usage.push(v),fetchImpl:async url=>{if(url.endsWith('/tools/fetch')){fetchStarted();return new Response(new ReadableStream({start(stream){stream.enqueue(new TextEncoder().encode('{"markdown":"partial'));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}});}return sse([{choices:[{delta:{tool_calls:[{index:0,id:'fetch1',type:'function',function:{name:'native_web_fetch',arguments:'{"url":"https://example.com/page"}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:3,completion_tokens:1,total_tokens:4}}]);}});
 const pending=collect(transport.stream(profile('kimi','chat-completions','https://api.moonshot.ai/v1','kimi-k3'),{nativeSearch:{allowed:true},messages:[],signal:controller.signal,activityOriginId:'trusted-fetch-origin'}));await started;controller.abort();await assert.rejects(()=>pending,/取消/);assert.equal(cancelled,true);assert.equal(usage.length,2);assert.equal(usage[0].usage.total,4);assert.equal(usage[1].usage.total,null);assert.equal(usage[1].serviceUsage.state,'cancelled');assert.equal(usage[1].activityOriginId,'trusted-fetch-origin');
});


test('provider-specific search-only boundaries do not advertise URL context or code execution on unsupported combinations',async()=>{
 const {nativeSearchCapability,nativeSearchTools}=await searchModule();
 const oldGemini=nativeSearchCapability(profile('gemini','gemini','https://generativelanguage.googleapis.com/v1beta','gemini-2.0-flash'));assert.equal(oldGemini.supported,true);assert.equal(oldGemini.fetch,false);assert.deepEqual(nativeSearchTools(oldGemini),[{googleSearch:{}}]);
 assert.equal(nativeSearchCapability(profile('qwen','responses','https://dashscope.aliyuncs.com/compatible-mode/v1','qwen3.8-max')).status,'unknown');
 const qwenOnly=nativeSearchCapability(profile('qwen','responses','https://dashscope.aliyuncs.com/compatible-mode/v1','qwen3.8-omni-flash'));assert.equal(qwenOnly.supported,true);assert.deepEqual(nativeSearchTools(qwenOnly),[{type:'web_search'}]);
 const minimax=nativeSearchCapability(profile('minimax','anthropic','https://api.minimax.io/anthropic/v1','MiniMax-M3.1-Flash'));assert.deepEqual(nativeSearchTools(minimax),[{type:'web_search_20250305',name:'web_search'}]);
});

test('Qwen actual tool usage with empty results is distinguished from no search and tokens remain real',async()=>{
 let body;const usage=[],transport=new ApiTransport({onUsage:v=>usage.push(v),fetchImpl:async(url,options)=>{body=JSON.parse(options.body);return sse([{choices:[{delta:{content:'No reliable result'},finish_reason:'stop'}],search_info:{search_results:[]},usage:{prompt_tokens:8,completion_tokens:2,total_tokens:10,x_tools:{web_search:{count:1}}}}]);}});
 const parts=await collect(transport.stream(profile('qwen','chat-completions','https://dashscope.aliyuncs.com/compatible-mode/v1','qwen-plus'),{nativeSearch:{allowed:true},messages:[]}));assert.equal(body.include_tool_usage,true);assert.ok(parts.some(p=>p.type==='native-search-tool'));assert.ok(parts.some(p=>p.type==='native-search-status'&&p.status==='completed'&&p.sourceCount===0));assert.equal(parts.filter(p=>p.type==='native-search-sources').length,0);assert.equal(usage[0].usage.total,10);assert.deepEqual(usage[0].nativeSearchUsage,{web_search:{count:1}});
});
