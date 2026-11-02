import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {observeDshMessagesUsage,installDshJobToolPolicy} from '../src/dsh-platform/native-bridge-host.mjs';
import {createDshBackend} from '../src/dsh-platform/backend.mjs';

const event=(type,fields={})=>'event: '+type+'\r\ndata: '+JSON.stringify({type,...fields})+'\r\n\r\n';
const wire=(model='deepseek-flash')=>event('message_start',{message:{id:'msg_actual_provider_17',model,usage:{input_tokens:7,output_tokens:0,cache_read_input_tokens:2}}})+event('content_block_delta',{delta:{type:'text_delta',text:'PRIVATE CONTENT MUST NEVER ENTER USAGE'}})+event('message_delta',{usage:{output_tokens:4}})+event('message_stop');
test('actual SSE metadata observer forwards exact bytes across arbitrary chunks, keeps IDs/counters only',async()=>{
 const bytes=new TextEncoder().encode(wire()),record={};let cursor=0;
 const response=new Response(new ReadableStream({pull(controller){if(cursor===bytes.length)return controller.close();const end=Math.min(cursor+7,bytes.length);controller.enqueue(bytes.slice(cursor,end));cursor=end;}}),{headers:{'content-type':'text/event-stream','request-id':'req_actual_provider_17'}});
 const wrapped=observeDshMessagesUsage(response,record);assert.deepEqual(new Uint8Array(await wrapped.arrayBuffer()),bytes);
 assert.equal(record.providerMessageId,'msg_actual_provider_17');assert.equal(record.providerRequestId,'req_actual_provider_17');assert.equal(record.actualModel,'deepseek-flash');assert.equal(record.inputTokens,7);assert.equal(record.outputTokens,4);assert.equal(record.cacheReadTokens,2);assert.equal(record.messageStopped,true);assert.doesNotMatch(JSON.stringify(record),/PRIVATE CONTENT/);
});
test('malformed counters or oversized metadata remain explicit, never silently become known usage',async()=>{
 const invalid={};await observeDshMessagesUsage(new Response(event('message_start',{message:{usage:{input_tokens:-1,output_tokens:'4'}}})+event('message_stop'),{headers:{'content-type':'text/event-stream'}}),invalid).text();assert.equal(invalid.metadataInvalid,true);assert.equal(invalid.inputTokens,undefined);
 const large={};await observeDshMessagesUsage(new Response('data: '+('x'.repeat(1024*1024+1)),{headers:{'content-type':'text/event-stream'}}),large).text();assert.equal(large.metadataOverflow,true);
});
test('original native dispatcher yields unchanged chunks and reports each actual transport once with true model',async()=>{
 const original=globalThis.fetch,scope=new AsyncLocalStorage(),trusted=new Map(),handlers=new Map(),cleanup=[],receipts=[],controller=new AbortController(),row={execution:{callId:'actual-call-17',token:Symbol('native'),signal:controller.signal}};trusted.set(row.execution.callId,row);
 let transportHeaders,admitted;globalThis.fetch=async(_url,init)=>{transportHeaders=new Headers(init.headers);assert.equal(transportHeaders.get('x-ai-buddy-native-stream-id'),admitted.nativeStreamId);assert.equal(transportHeaders.get('x-ai-buddy-native-request-id'),admitted.nativeRequestId);return new Response(wire('provider-actual-model'),{headers:{'content-type':'text/event-stream','x-request-id':'req17'}});};
 const chunks=[{type:'usage',usage:{inputTokens:7,outputTokens:4,cacheReadTokens:2,totalTokens:13}},{type:'finish',reason:{kind:'stop'}}],llm={streamWithRegistration(options){return handlers.get('llm/stream')(options,async function*(){const response=await fetch('http://127.0.0.1:12345/v1/messages',{method:'POST'});await response.text();yield* chunks;});}};
 try{installDshJobToolPolicy({llm,on:(name,fn)=>handlers.set(name,fn),effect:fn=>cleanup.push(fn())},{trusted,executionScope:scope,pendingAgentIds:new Set(),task:{modelSelection:{provider:'deepseek-official',model:'deepseek-flash'},modelEndpoint:'http://127.0.0.1:12345'},authorize:async(_row,_selection,_signal,transport)=>{admitted=transport;return {allowed:true};},recordUsage:async(actual,value)=>{assert.equal(actual,row);receipts.push(value);}});const output=await scope.run(row,async()=>{const output=[];for await(const chunk of llm.streamWithRegistration({provider:'deepseek-official',model:'deepseek-flash'}))output.push(chunk);return output;});assert.deepEqual(output,chunks);assert.equal(receipts.length,1);assert.equal(receipts[0].transportRequestId,admitted.nativeRequestId);assert.equal(receipts[0].requestId,'msg_actual_provider_17');assert.equal(receipts[0].model,'provider-actual-model');assert.equal(receipts[0].bindingMatched,false);assert.equal(receipts[0].usageKnown,true);assert.equal(receipts[0].totalTokens,13);assert.equal(receipts[0].origin,'managed-receipt');assert.equal(receipts[0].accounting,'independent');assert.doesNotMatch(JSON.stringify(receipts),/PRIVATE CONTENT/);}
 finally{for(const fn of cleanup.reverse())fn?.();globalThis.fetch=original;}
});
test('paid native AI cannot start without a host usage sink',()=>{
 assert.throws(()=>createDshBackend({runtimeLockPath:'x',dshHome:'y',stateDir:'z',profileId:'private-task',purpose:'job-tools',taskMode:{jobId:'job',runId:'run',modelBinding:{}},onProcessStart:()=>{},onProcessStop:()=>{}}),{code:'DSH_NATIVE_MODEL_USAGE_REQUIRED'});
});
