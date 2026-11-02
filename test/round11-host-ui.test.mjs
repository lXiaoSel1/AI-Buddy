import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale} from '../src/i18n.mjs';
import {petContextTemplate} from '../src/pet-menu.mjs';
import {bubbleView} from '../src/pet-badge.mjs';
import {FeedingPage} from '../src/feeding-ui.mjs';
import {SocialLoginDialog} from '../src/social-login-ui.mjs';
import {FOODS} from '../src/food-catalog.mjs';
for(const language of ['zh-CN','en']){
 test('empty feeding menu keeps only the approved shop action in '+language,()=>{const opened=[],menu=petContextTemplate({language,foods:[],feedTarget:'DeepSeek',fullness:40,open:p=>opened.push(p)}),feed=menu.find(r=>r.label===(language==='en'?'Feed':'投喂'));assert.equal(feed.submenu.length,1);assert.equal(feed.submenu[0].label,language==='en'?'Buy in shop…':'去商店买…');feed.submenu[0].click();assert.deepEqual(opened,['shop']);});
 test('plugin detail adds the open hint once across old and new payloads in '+language,()=>{const hint=language==='en'?'Click to open':'点一下打开';for(const detail of ['看完了','Finished watching',hint+' · detail','点一下打开 · detail','Click to open · detail',hint]){const v=bubbleView({source:'plugin',pluginId:'bilibili',text:'Synthetic title',detail},{language});assert.equal((v.detail.match(/点一下打开|Click to open/g)??[]).length,1);assert.ok(v.detail.startsWith(hint));if(detail.endsWith('detail'))assert.ok(v.detail.endsWith('detail'));}assert.equal(bubbleView({source:'plugin',detail:hint},{language}).detail,hint);});
 test('shop uses approved recent-food heading without fabricating a preference score in '+language,()=>{setLocale(language);try{const food=FOODS[0],view={activeScope:{characterId:'deepseek'},catalog:[food],meals:[{foodId:food.id,scope:{characterId:'deepseek'}}],wallet:{balance:100},rewardsInitialized:true};const html=renderToStaticMarkup(React.createElement(FeedingPage,{view,onAction:async()=>{}}));assert.match(html,language==='en'?/Her favourites lately/:/她最近爱吃/);assert.doesNotMatch(html,/她最近吃过|She recently ate/);}finally{setLocale('zh-CN');}});
 test('Bilibili guidance states the user-approved login requirement in '+language,()=>{setLocale(language);try{const login={stateOf:()=>({phase:'waiting-qr'}),snapshot:{states:[]},act:async()=>{},busy:false,error:'',errorCode:''};const html=renderToStaticMarkup(React.createElement(SocialLoginDialog,{platform:'bilibili',login,autoStart:false,onClose:()=>{}}));assert.match(html,language==='en'?/Connect a Bilibili account before watching/:/先连接一个 B站账号才能看/);assert.doesNotMatch(html,/Watching needs no account|看视频不需要账号/);}finally{setLocale('zh-CN');}});
}
