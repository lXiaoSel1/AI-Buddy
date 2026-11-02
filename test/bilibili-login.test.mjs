import test from 'node:test';
import assert from 'node:assert/strict';
import {bilibiliLoginNavigation,bilibiliVerifiedAccount,createBilibiliLoginDriver} from '../src/bilibili-login.mjs';
test('official navigation excludes lookalikes, HTTP and credentials',()=>{
 for(const url of ['https://passport.bilibili.com/login','https://www.bilibili.com'])assert.equal(bilibiliLoginNavigation(url),true);
 for(const url of ['http://passport.bilibili.com','https://bilibili.com.evil.test','https://u:p@passport.bilibili.com','file:///x'])assert.equal(bilibiliLoginNavigation(url),false);
});
const nav={code:0,data:{isLogin:true,mid:123,uname:'name'}},cookies=[['SESSDATA','secret'],['bili_jct','csrf'],['DedeUserID','123']].map(([name,value])=>({name,value,domain:'.bilibili.com'}));
test('identity requires actual logged-in nav and matching cookie owner',()=>{
 assert.equal(bilibiliVerifiedAccount(nav,cookies).accountId,'123');
 assert.throws(()=>bilibiliVerifiedAccount({...nav,data:{...nav.data,isLogin:false}},cookies));
 assert.throws(()=>bilibiliVerifiedAccount(nav,cookies.map(c=>c.name==='DedeUserID'?{...c,value:'456'}:c)),{code:'SOCIAL_LOGIN_IDENTITY_MISMATCH'});
 assert.throws(()=>bilibiliVerifiedAccount(nav,cookies.map(c=>({...c,domain:'.evil.test'}))));
});

test('check distinguishes confirmed logout from network uncertainty and forwards cancellation',async()=>{
 const original=globalThis.fetch,driver=createBilibiliLoginDriver(),account={accountId:'123'},secret={cookie:'synthetic-session'};let response,seenSignal;
 globalThis.fetch=async(_url,options)=>{seenSignal=options.signal;return {ok:true,json:async()=>response};};
 try{for(const value of [{code:-101},{code:0,data:{isLogin:false}}]){response=value;await assert.rejects(driver.check(account,secret),{code:'SOCIAL_LOGIN_EXPIRED'});}for(const value of [{code:-500},{code:0,data:{}}]){response=value;await assert.rejects(driver.check(account,secret),{code:'SOCIAL_LOGIN_NETWORK_ERROR'});}response={code:0,data:{isLogin:true,mid:456}};await assert.rejects(driver.check(account,secret),{code:'SOCIAL_LOGIN_IDENTITY_MISMATCH'});response={code:0,data:{isLogin:true,mid:123}};assert.equal((await driver.check(account,secret)).connected,true);const controller=new AbortController();await driver.check(account,secret,{signal:controller.signal});assert.equal(seenSignal.aborted,false);controller.abort();assert.equal(seenSignal.aborted,true);await assert.rejects(driver.check(account,secret,{signal:controller.signal}),{name:'AbortError'});}finally{globalThis.fetch=original;}
});
