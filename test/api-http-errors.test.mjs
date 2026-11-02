import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiTransport} from '../src/api-transport.mjs';

const collect=async stream=>{for await(const _ of stream){}};
const profile={id:'error-fixture',kind:'deepseek',protocol:'chat-completions',baseUrl:'https://api.deepseek.com/v1',model:'deepseek-flash',key:'sk-DO-NOT-LEAK-credential'};
for(const search of [false,true])test('HTTP400 '+(search?'native search':'ordinary')+' retains only safe metadata and the group trace without retry',async()=>{
 const audits=[],lifecycle=[];let calls=0;const secret=profile.key+' FULL_PRIVATE_PROMPT',transport=new ApiTransport({audit:row=>audits.push(row),fetchImpl:async()=>{calls++;return new Response(JSON.stringify({error:{code:'invalid_request_error',type:'invalid_request_error',param:'messages',message:secret},request_id:'body-private-id'}),{status:400,headers:{'x-request-id':'req-safe-400'}});}});
 let error;try{await collect(transport.stream(profile,{messages:[{role:'user',content:secret}],traceId:'group-trace-400',nativeSearch:{allowed:search,check:()=>true},onModelLifecycle:row=>lifecycle.push(row)}));}catch(value){error=value;}
 assert.ok(error);assert.equal(calls,1);assert.equal(error.httpError.status,400);assert.equal(error.httpError.code,'invalid_request_error');assert.equal(error.httpError.type,'invalid_request_error');assert.equal(error.httpError.param,'messages');assert.equal(error.httpError.requestId,'req-safe-400');assert.match(error.message,/400/);assert.equal(error.message.includes(secret),false);const serialized=JSON.stringify({error:{message:error.message,httpError:error.httpError},audits,lifecycle});assert.equal(serialized.includes('FULL_PRIVATE_PROMPT'),false);assert.equal(serialized.includes(profile.key),false);assert.ok(audits.some(row=>row.traceId==='group-trace-400'&&row.httpError?.status===400));
});

test('HTTP error parsing bounds streaming bytes and releases the remaining body',async()=>{
 let cancelled=false,pulls=0;const body=new ReadableStream({pull(controller){pulls++;controller.enqueue(new TextEncoder().encode('x'.repeat(8192)));},cancel(){cancelled=true;}}),transport=new ApiTransport({fetchImpl:async()=>new Response(body,{status:400})});let error;try{await collect(transport.stream(profile,{messages:[]}));}catch(value){error=value;}assert.equal(error.httpError.status,400);assert.equal(cancelled,true);assert.ok(pulls<=4,'must not drain an unbounded error body');assert.ok(JSON.stringify(error.httpError).length<1024);
});

test('HTTP error parsing never copies arbitrary identifiers or provider prose into safe diagnostics',async()=>{
 const secret=profile.key,events=[],transport=new ApiTransport({audit:row=>events.push(row),fetchImpl:async()=>new Response(JSON.stringify({error:{code:secret,type:'FULL_PRIVATE_PROMPT',param:'messages[0].content='+secret,message:'Invalid request: '+secret}}),{status:400,headers:{'x-request-id':secret}})});let error;try{await collect(transport.stream(profile,{messages:[]}));}catch(value){error=value;}assert.equal(error.httpError.status,400);assert.equal(JSON.stringify({message:error.message,metadata:error.httpError,events}).includes(secret),false);assert.equal(JSON.stringify(error.httpError).includes('FULL_PRIVATE_PROMPT'),false);assert.equal(error.httpError.message,undefined);
});

test('HTTP error body read follows abort and cancels a provider body that never completes',async()=>{
 const controller=new AbortController();let cancelled=false;const transport=new ApiTransport({fetchImpl:async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}}),{status:400})}),pending=collect(transport.stream(profile,{messages:[],signal:controller.signal}));setTimeout(()=>controller.abort(),15);await assert.rejects(pending,/取消/);assert.equal(cancelled,true);
});

test('HTTP error metadata read has its own deadline when the request signal stays active',async()=>{
 let cancelled=false;const started=Date.now(),transport=new ApiTransport({fetchImpl:async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}}),{status:400})});let error;try{await collect(transport.stream(profile,{messages:[]}));}catch(value){error=value;}assert.equal(error.httpError.status,400);assert.equal(cancelled,true);assert.ok(Date.now()-started<1500,'error metadata must not wait for the model timeout');
});
