import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SocialLoginDialog} from '../src/social-login-ui.mjs';
import {SocialAccounts} from '../src/social-accounts-ui.mjs';
import {setLocale} from '../src/i18n.mjs';

for(const language of ['zh-CN','en'])for(const platform of ['bilibili','qq'])test(`${platform} login guidance stays within its platform in ${language}`,()=>{
 setLocale(language);try{for(const phase of ['failed','waiting-qr']){
  const login={stateOf:()=>({phase,qr:phase==='waiting-qr'?'data:image/png;base64,AA==':null}),snapshot:{states:[]},act:async()=>{},busy:false,error:'',errorCode:''};
  const html=renderToStaticMarkup(React.createElement(SocialLoginDialog,{platform,login,autoStart:false,onClose:()=>{}}));
  if(platform==='bilibili'){
   assert.doesNotMatch(html,/看视频不需要账号|Watching needs no account|日常 QQ|everyday QQ/);
   assert.match(html,language==='en'?/official Bilibili login window/:/B站官方登录窗口/);
   assert.match(html,language==='en'?/separate permission/:/单独授权/);
   assert.match(html,language==='en'?/Scanning does not post comments or call a model/:/扫码本身不会自动发表评论或调用模型/);
  }else{
   assert.match(html,language==='en'?/does not read your everyday QQ data/:/不会读取你日常 QQ 的资料/);
   assert.match(html,language==='en'?/Scanning does not send messages/:/扫码本身不会自动发消息/);
  }
 }}finally{setLocale('zh-CN');}
});
for(const language of ['zh-CN','en'])test(`the Bilibili account card agrees with login guidance in ${language}`,()=>{
 setLocale(language);try{const html=renderToStaticMarkup(React.createElement(SocialAccounts,{api:{action:async()=>{throw Error('SSR must not call the host');}}}));assert.doesNotMatch(html,/只看视频不需要账号|Watching needs no account/);assert.match(html,language==='en'?/official Bilibili login window/:/B站官方登录窗口/);assert.match(html,language==='en'?/separate permission/:/单独授权/);}finally{setLocale('zh-CN');}
});
