import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiTransport} from '../src/api-transport.mjs';
const profile={id:'retry-after-fixture',kind:'custom',protocol:'chat-completions',baseUrl:'https://model.example/v1',model:'stub',key:''};
async function failure(value,status=429){
  const api=new ApiTransport({fetchImpl:async()=>new Response(JSON.stringify({error:{code:'rate_limit_exceeded'}}),{status,headers:{'Retry-After':value,'x-request-id':'req-retry-after-fixture'}})});
  try{for await(const ignored of api.stream(profile,{messages:[{role:'user',content:'hello'}],purpose:'emotion'})){};assert.fail('must fail');}catch(error){return error;}
}
test('M1 ApiTransport retains a 429 Retry-After in milliseconds for background backoff',async()=>{
  const error=await failure('120');assert.equal(error.code,'API_HTTP_ERROR');assert.deepEqual(error.httpError,{status:429,code:'rate_limit_exceeded',requestId:'req-retry-after-fixture'});assert.equal(error.retryAfterMs,120000);
});
test('M1 HTTP-date Retry-After is a future nonnegative delay, never shortened by body parsing',async()=>{
  const target=Math.ceil(Date.now()/1000)*1000+120000,before=Date.now(),error=await failure(new Date(target).toUTCString()),after=Date.now();assert(error.retryAfterMs>=target-after);assert(error.retryAfterMs<=target-before);
});
test('M1 invalid Retry-After and other statuses do not manufacture a server delay',async()=>{
  for(const value of ['invalid','-10','1.5','Infinity'])assert.equal((await failure(value)).retryAfterMs,undefined);
  assert.equal((await failure('120',500)).retryAfterMs,undefined);assert.equal((await failure('0')).retryAfterMs,0);
});
