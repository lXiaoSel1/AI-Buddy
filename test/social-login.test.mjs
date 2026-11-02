import test from 'node:test';
import assert from 'node:assert/strict';
import {createSocialLogin} from '../src/social-login.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 let finish,starts=0,stops=0;const commits=[];
 const drivers={qq:{start:async({update})=>{starts++;update({phase:'waiting-qr',qr:'data:image/svg+xml;base64,WA=='});return new Promise(resolve=>{finish=resolve;});},stop:async()=>{stops++;}},bilibili:{start:async()=>{throw Object.assign(Error('secret-cookie'),{code:'NETWORK_ERROR'});},stop:async()=>{}}};
 const accounts={commitLogin:input=>{commits.push(input);return {ref:'ref',accountId:input.accountId,label:input.label};},list:()=>[]};
 const service=createSocialLogin({accounts,drivers});
 return {service,commits,get starts(){return starts;},get stops(){return stops;},finish:()=>finish({accountId:'123',label:'Test',secret:{accessToken:'private'},resourceId:'owned'})};
}
test('duplicate start is coalesced and only verified identity is committed',async()=>{
 const f=fixture();f.service.start('qq');f.service.start('qq');await tick();assert.equal(f.starts,1);assert.equal(f.commits.length,0);
 f.finish();await tick();assert.equal(f.commits.length,1);const publicState=f.service.status('qq');assert.equal(publicState.phase,'connected');assert.equal(JSON.stringify(publicState).includes('private'),false);assert.equal(publicState.qr,undefined);await f.service.close();
});
test('cancel invalidates late identity and QR, even if driver ignores abort',async()=>{
 const f=fixture();f.service.start('qq');await tick();await f.service.cancel('qq');f.finish();await tick();assert.equal(f.commits.length,0);assert.equal(f.service.status('qq').phase,'cancelled');assert.equal(f.service.status('qq').qr,undefined);await f.service.close();
});
test('errors are structured and never expose upstream error text',async()=>{
 const f=fixture();f.service.start('bilibili');await tick();assert.equal(f.service.status('bilibili').phase,'failed');assert.equal(JSON.stringify(f.service.status('bilibili')).includes('secret-cookie'),false);await f.service.close();
});
test('closing prevents starts and invalidates pending commit',async()=>{
 const f=fixture();f.service.start('qq');await tick();await f.service.close();f.finish();await tick();assert.equal(f.commits.length,0);assert.throws(()=>f.service.start('qq'),{code:'SOCIAL_LOGIN_CLOSED'});
});
test('unsupported platforms cannot dispatch a driver',()=>{const f=fixture();assert.throws(()=>f.service.start('__proto__'),{code:'SOCIAL_LOGIN_PLATFORM_INVALID'});});

test('a retry cannot race cancellation cleanup of the same private profile',async()=>{
 let release,starts=0;const accounts={list:()=>[],commitLogin:()=>assert.fail('cancelled')};
 const driver={start:async()=>{starts++;return new Promise(()=>{});},stop:()=>new Promise(resolve=>{release=resolve;})};
 const service=createSocialLogin({accounts,drivers:{qq:driver}});service.start('qq');await tick();
 const cancelling=service.cancel('qq');await tick();service.start('qq');await tick();assert.equal(starts,1);release();await cancelling;service.start('qq');await tick();assert.equal(starts,2);
});

test('connection checks reject success from an account changed during the request',async()=>{
 let finish;let account={ref:'r',platform:'qq',enabled:true,generation:1};
 const service=createSocialLogin({accounts:{get:()=>account,secret:()=>({})},drivers:{qq:{check:()=>new Promise(resolve=>{finish=resolve;})}}});
 const checking=service.check('r');account={...account,generation:2};finish();await assert.rejects(checking,{code:'SOCIAL_LOGIN_CONNECTION_CHANGED'});
});
