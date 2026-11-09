import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createSocialLogin} from '../src/social-login.mjs';
import {createQqLoginRuntime} from '../src/qq-login-runtime.mjs';
import {SocialLoginDialog} from '../src/social-login-ui.mjs';
import {setLocale} from '../src/i18n.mjs';
const tick=()=>new Promise(done=>setImmediate(done));
test('QQ preparation exposes its mirror failure and only explicit retry uses the official component route',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'audit213-qq-mirror-')),calls=[],accounts={list:()=>[],commitLogin:()=>assert.fail('No login can complete in this preparation fixture')};
 const driver=createQqLoginRuntime({dataRoot:directory,build:directory,accounts,component:{info:()=>({}),async ensure(options){calls.push(options.official===true);throw Object.assign(Error('fixture stops before QR/login'),{code:'NETWORK_MIRROR_MISMATCH',retryOfficial:true,host:'mirror.example'});}}});
 const service=createSocialLogin({accounts,drivers:{qq:driver}});t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});
 service.start('qq');for(let i=0;i<50&&service.status('qq').phase!=='failed';i++)await tick();let state=service.status('qq');assert.equal(state.retryOfficial,true);assert.equal(state.errorHost,'mirror.example');
 assert.throws(()=>service.start('qq',{official:true,retryAttemptId:'stale'}),{code:'SOCIAL_LOGIN_RETRY_STALE'});
 service.start('qq',{official:true,retryAttemptId:state.attemptId});for(let i=0;i<50&&service.status('qq').phase!=='failed';i++)await tick();
 service.start('qq');for(let i=0;i<50&&service.status('qq').phase!=='failed';i++)await tick();assert.deepEqual(calls,[false,true,false]);
});
test('QQ mirror retry has a local explanation and explicit button in both languages',()=>{
 for(const language of ['zh-CN','en']){setLocale(language);const state={phase:'failed',attemptId:'attempt',errorCode:'NETWORK_MIRROR_MISMATCH',retryOfficial:true};const login={stateOf:()=>state,snapshot:{states:[]},act(){},busy:false};
 const html=renderToStaticMarkup(React.createElement(SocialLoginDialog,{platform:'qq',login,onClose(){},autoStart:false}));assert.match(html,/data-social-login-official-retry/);assert.ok(html.includes(language==='en'?'Retry using official addresses':'改用官方地址重试'));assert.ok(html.includes(language==='en'?'The mirror returned a file':'镜像返回的文件'));
 state.retryOfficial=false;assert.doesNotMatch(renderToStaticMarkup(React.createElement(SocialLoginDialog,{platform:'qq',login,onClose(){},autoStart:false})),/data-social-login-official-retry/);
 }setLocale('zh-CN');
});
