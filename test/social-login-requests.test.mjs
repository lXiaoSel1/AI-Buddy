import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSocialLoginRequests,LOGIN_REQUEST_LIMIT,LOGIN_REQUEST_TTL} from '../src/social-login-requests.mjs';

function fixture(){let clock=1000;const opened=[],acked=[],closed=[],requests=createSocialLoginRequests({now:()=>clock,open:(value,pulled)=>opened.push({...value,pulled}),ack:id=>acked.push(id),close:()=>closed.push(true)});return{requests,opened,acked,closed,setTime:value=>clock=value,take:(id,platform='qq',at=clock,pulled=false)=>requests.take({requestId:id,platform,at},pulled)};}
test('event then late status consumes one request once, even after close',async()=>{
 const f=fixture();assert.equal(f.take('one'),true);assert.equal(f.requests.close('one'),true);
 assert.equal(f.take('one','qq',1000,true),false);await Promise.resolve();assert.equal(f.opened.length,1);assert.deepEqual(f.acked,['one']);assert.equal(f.closed.length,1);
});
test('same-millisecond requests have distinct requestId component keys',()=>{
 const f=fixture();assert.equal(f.take('a','bilibili'),true);assert.equal(f.take('b','qq'),true);
 assert.deepEqual(f.opened.map(v=>v.requestId),['a','b']);assert.equal(f.requests.close('a'),false,'old modal cannot close the newer request');assert.equal(f.requests.close('b'),true);
 const source=readFileSync(new URL('../src/dashboard.mjs',import.meta.url),'utf8');assert.match(source,/key:loginFor\.requestId/);assert.doesNotMatch(source,/key:loginFor\.at/);
});
test('processed IDs stay bounded without evicting a live consumed request',()=>{
 const f=fixture();for(let i=0;i<LOGIN_REQUEST_LIMIT;i++)assert.equal(f.take('r'+i),true);
 for(let i=0;i<20;i++)assert.equal(f.take('overflow'+i),false);assert.equal(f.take('r0'),false);assert.equal(f.opened.length,LOGIN_REQUEST_LIMIT);
 f.setTime(1000+LOGIN_REQUEST_TTL);assert.equal(f.take('r0','qq',1000),false,'expired status cannot reopen after pruning');assert.equal(f.take('new'),true);
});
test('invalid, expired and disposed deliveries never open or acknowledge',async()=>{
 const f=fixture();for(const value of [{requestId:'x',platform:'other',at:1000},{requestId:'',platform:'qq',at:1000},{requestId:'x'.repeat(101),platform:'qq',at:1000},{requestId:'x',platform:'qq'},{requestId:'x',platform:'qq',at:999999}])assert.equal(f.requests.take(value),false);
 f.requests.dispose();assert.equal(f.take('valid'),false);assert.equal(f.requests.close('valid'),false);await Promise.resolve();assert.deepEqual(f.opened,[]);assert.deepEqual(f.acked,[]);
});
test('failed acknowledgement does not replay a consumed request',async()=>{
 let count=0;const f=createSocialLoginRequests({open:()=>count++,ack:async()=>{throw Error('offline');},now:()=>10});const request={requestId:'once',platform:'qq',at:10};f.take(request);await Promise.resolve();assert.equal(f.take(request,true),false);assert.equal(count,1);
});
test('a capacity refusal is not acknowledged as consumed before it can be remembered',async()=>{
 const f=fixture();for(let i=0;i<LOGIN_REQUEST_LIMIT;i++)f.take('r'+i);
 f.setTime(2000);assert.equal(f.take('overflow','qq',2000),false);await Promise.resolve();assert.ok(!f.acked.includes('overflow'));
 f.setTime(121001);assert.equal(f.take('overflow','qq',2000,true),true);await Promise.resolve();assert.equal(f.acked.filter(id=>id==='overflow').length,1);
});
