import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ensureVoiceSession,VoiceChatControls} from '../src/voice/client.mjs';
import {setLocale} from '../src/i18n.mjs';

const scope={channel:'app-private',characterId:'deepseek',personaId:'p',conversationId:'c'};
const cloud={route:'cloud:minimax-cn',providerId:'minimax-cn',enabled:true,status:'ready',account:{configured:true},characters:[{characterId:'deepseek',voiceId:'stub',kind:'clone',state:'ready'}],asr:{state:'downloading',received:42,total:100}};
function render(placement, patch={}, props={}){
  const snapshot={state:{scope,packages:[],settings:{enabled:true,packages:{}},builtinCloud:{...cloud,...patch}}};
  return renderToStaticMarkup(React.createElement(VoiceChatControls,{snapshot,scope,placement,open:true,galgame:true,...props}));
}

test('built-in cloud chat works without installed plugins and describes failures in the compact popover',()=>{
  setLocale('zh-CN');
  try{
    const ready=render('top');
    assert.match(ready,/云端就绪/);
    assert.match(ready,/在哪里配音/);
    assert.match(ready,/她的声音/);
    assert.match(ready,/打开云配音/);
    assert.doesNotMatch(ready,/配音插件|启动声音/);
    assert.match(render('top',{status:'balance_insufficient',category:'quota'}),/额度用完/);
  }finally{setLocale('en');}
});

test('the group voice popover describes every member’s reply in both locales',()=>{
  try{
    setLocale('zh-CN');
    assert.match(render('top',{}, {cloudMembers:['deepseek','chatgpt']}),/在场成员的回复都会读出来。/);
    assert.match(render('top'),/牌桌上她喊 All in/);
    setLocale('en');
    assert.match(render('top',{}, {cloudMembers:['deepseek','chatgpt']}),/Every member’s reply is read aloud/);
  }finally{setLocale('en');}
});

test('the built-in page reports resumable recognition, per-character voices, and a pending migration without local plugins',async()=>{
  setLocale('zh-CN');
  try {
    const {BuiltinCloudPage}=await import('../src/voice/builtin-cloud-page.mjs');
    const builtinCloud={...cloud,asr:{state:'paused'},migration:{accounts:1,characters:4,pending:true}};
    const page=renderToStaticMarkup(React.createElement(BuiltinCloudPage,{snapshot:{state:{builtinCloud}},characterId:'deepseek'}));
    assert.match(page,/角色的云端声音/);
    assert.match(page,/1 个账号、4 个角色/);
    assert.match(page,/需要准备/);
    assert.match(page,/云配音读她的回复不受影响/);
  }finally{setLocale('en');}
});

test('cloud recognition download leaves mic and Live as setup entry points with actual progress',()=>{
  setLocale('zh-CN');
  try {
    const mic=render('input-left');
    assert.match(mic,/42%/);
    assert.match(mic,/aria-haspopup="dialog"/);
    assert.doesNotMatch(mic,/<button[^>]*disabled/);
    assert.match(render('input-right'),/aria-haspopup="dialog"/);
    assert.match(render('input-left',{asr:{state:'ready'}}),/录音输入/);
  }finally{setLocale('en');}
});

test('a removed voice is marked for replacement without presenting it as usable',async()=>{
  setLocale('zh-CN');
  try {
    const missing={characterId:'deepseek',voiceId:'missing-stub',kind:'clone',state:'voice_missing'};
    const markup=render('top',{characters:[missing]});
    assert.match(markup,/声音已失效，请重新选择/);
    const {BuiltinCloudPage}=await import('../src/voice/builtin-cloud-page.mjs');
    const builtinCloud={...cloud,characters:[missing]};
    const page=renderToStaticMarkup(React.createElement(BuiltinCloudPage,{snapshot:{state:{builtinCloud}},characterId:'deepseek'}));
    assert.match(page,/声音已失效，请重新选择/);
  }finally{setLocale('en');}
});

test('a plugin update supersedes an in-flight read of the old reference availability',async()=>{
  const previous=globalThis.whale;
  let reads=0,notify;
  globalThis.whale={plugins:{onUpdate(cb){notify=cb;return()=>{};}}};
  let finishOld;
  const old=new Promise(resolve=>{finishOld=resolve;});
  const state=referenceAvailable=>({scope,settings:{enabled:true,packages:{}},packages:[],builtinCloud:{...cloud,characters:[{characterId:'deepseek',referenceAvailable}]}});
  const api={onEvent:()=>()=>{},action:async op=>op==='state'?(++reads===1?old:state(true)):null};
  const session=ensureVoiceSession(api,{captureOptions:{workletURL:'unused-fixture-worklet'}}),release=session.retain();
  try{
    const inflight=session.refresh();
    await Promise.resolve();
    notify();
    finishOld(state(false));
    await inflight;
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(session.snapshot().state?.builtinCloud?.characters[0]?.referenceAvailable,true);
  }finally{finishOld(state(false));await release();globalThis.whale=previous;}
});

test('an expired cloud cooldown is refreshed again when the first read fails',async t=>{
  let now=1000,reads=0,expire,retry;
  const timers=globalThis.setTimeout;
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'setTimeout',(fn,delay,...args)=>{
    if(delay===15000){expire=()=>fn(...args);return undefined;}
    if(delay===1000){retry=()=>fn(...args);return undefined;}
    return timers(fn,delay,...args);
  });
  const session=ensureVoiceSession({
    onEvent(){return ()=>{};},
    async action(op){
      if(op!=='state')return {};
      reads++;
      if(reads===2)throw Error('transient synthetic read failure');
      const state={scope,settings:{packages:{}},packages:[],builtinCloud:{...cloud}};
      if(reads===1)Object.assign(state.builtinCloud,{status:'unavailable',retryAt:16000});
      return state;
    },
  },{captureOptions:{workletURL:'unused-fixture-worklet'}});
  t.after(session.retain());
  await session.refresh();
  now=16000;expire();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof retry,'function');
  now=17000;retry();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(session.snapshot().state.builtinCloud.status,'ready');
  assert.equal(reads,3);
});

test('stage cloud failures distinguish automatic quota recovery and a key that needs the user',()=>{
  setLocale('zh-CN');
  try{
    assert.match(render('top',{status:'unavailable',category:'network'}),/vx-vst warn/);
    const snapshot={state:{scope,packages:[],settings:{enabled:true,packages:{}},builtinCloud:cloud}};
    const stage=category=>renderToStaticMarkup(React.createElement(VoiceChatControls,{
      scope,snapshot,reply:{replyId:'synthetic'},placement:'stage-alerts',
      presentation:{error:'合成错误',cloudFailure:true,cloudFailureCategory:category},
    }));
    assert.match(stage('quota'),/gx-dub-failure warn/);
    assert.doesNotMatch(stage('quota'),/<button/);
    assert.match(stage('auth'),/去填 Key/);
  }finally{setLocale('en');}
});

test('temporary cloud settings errors explain that a later read can retry without offering reset',async()=>{
 const {BuiltinCloudPage}=await import('../src/voice/builtin-cloud-page.mjs');
 setLocale('en');
 const storageIssue={code:'CLOUD_STORAGE_UNAVAILABLE',canReset:false};
 const state={builtinCloud:{...cloud,storageIssue}};
 const page=renderToStaticMarkup(React.createElement(BuiltinCloudPage,{snapshot:{state}}));
 assert.match(page,/Cloud voice settings are temporarily unavailable\. Try again shortly\./);
 assert.doesNotMatch(page,/newer version|Reset cloud voice settings/);
});
