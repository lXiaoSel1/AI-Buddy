import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {petContextTemplate,trayMenuTemplate} from '../src/pet-menu.mjs';
import {bubbleView} from '../src/pet-badge.mjs';
import {FeedingPage,foodCategory} from '../src/feeding-ui.mjs';
import {FOODS} from '../src/food-catalog.mjs';
import {capabilityView,officialProfile} from '../src/community-capabilities.mjs';
import {setLocale} from '../src/i18n.mjs';
const noop=()=>{},han=/[㐀-鿿]/;
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');

test('pet menu adds Feed and Recent plugin messages only when it has that data, and Feed feeds the chosen food',()=>{
 const base={open:noop,sleep:noop,wake:noop,setStatusBadge:noop,hidePet:noop};
 assert.equal(petContextTemplate(base).some(item=>item.label==='投喂'),false);
 const fed=[],opened=[],menu=petContextTemplate({...base,open:page=>opened.push(page),foods:[{id:'pudding',label:'小布丁 ×2'}],feedTarget:'DeepSeek',feed:id=>fed.push(id),recent:[{pluginId:'p',title:'看完了一个视频'}],openRecent:row=>opened.push('recent:'+row.pluginId)});
 const feed=menu.find(item=>item.label==='投喂');assert.ok(feed);assert.equal(feed.submenu[0].enabled,false);feed.submenu.find(item=>item.label==='小布丁 ×2').click();assert.deepEqual(fed,['pudding']);
 feed.submenu.find(item=>item.label==='去商店买…').click();menu.find(item=>item.label==='最近的插件消息 · 1').submenu[0].click();assert.deepEqual(opened,['shop','recent:p']);
 const empty=petContextTemplate({...base,foods:[]}).find(item=>item.label==='投喂');assert.deepEqual(empty.submenu.map(item=>item.label),['去商店买…']);
 const tray=trayMenuTemplate({open:page=>opened.push(page),setPetVisible:noop,setGestureMode:noop,quit:noop});tray.find(item=>item.label==='工作任务').click();tray.find(item=>item.label==='扩展中心').click();assert.deepEqual(opened.slice(-2),['agent-tasks','plugins']);
 for(const item of petContextTemplate({...base,language:'en',foods:[],recent:[{pluginId:'p',title:'x'}]}))if(item.label)assert.doesNotMatch(item.label,han,item.label);
});

test('plugin and speech bubbles carry a source tag; English has no Chinese',()=>{
 assert.deepEqual(bubbleView({source:'plugin',pluginId:'ai-buddy.bilibili-companion',text:'看完了'}),{kind:'say',name:'B站陪伴',tagIcon:'tv',title:'看完了',detail:'点一下打开'});
 assert.equal(bubbleView({source:'social-line',mode:'dream',text:'……布丁……'}).name,'梦话');
 for(const value of [{source:'plugin',pluginId:'qq-connect',text:'x'},{source:'social-line',mode:'proactive',text:'x'},{source:'social-line',mode:'selftalk',text:'x'}]){const view=bubbleView(value,{language:'en'});assert.doesNotMatch([view.name,view.detail].join(' '),han);}
});

test('a line goes to the pet and the main window together; a read anywhere reaches both; the first presentation counts once',async()=>{
 const main=await read('src/main.mjs'),r95=await read('src/companion-r95.mjs'),pet=await read('src/pet.mjs');
 const speech=main.slice(main.indexOf('onSpeech:'),main.indexOf('onSleepIntent:'));
 assert.match(speech,/petEvent\(\{kind:'social-line',value\}\);if\(panel/);assert.doesNotMatch(speech,/else if\(pet/);
 assert.match(main,/args\?\.action==='speech-read'&&result\?\.ok!==false\)\{petEvent\(\{kind:'social-line-read'/);
 assert.match(pet,/value\.kind==='social-line-read'&&pendingSocial\?\.messageId===value\.messageId/);
 assert.match(r95,/if\(row\.status!=='awaiting-presentation'\)return \{ok:true,alreadyPresented:true\};await proactive\.presented/);
 // presentation is still a two-frame DOM check and reading still needs speech-read
 assert.match(pet,/requestAnimationFrame\(\(\)=>requestAnimationFrame/);assert.match(pet,/action:'speech-read'/);
 // the bubble buttons follow the pet's language like its other labels
 for(const label of ['回她','接一句','知道了','收起'])assert.ok(pet.includes(`t('${label}',preferences.language)`),label);
});

test('shop shows the generated art for every food, sorted into the four approved groups',()=>{
 for(const food of FOODS)assert.ok(existsSync(new URL('../assets/food/'+food.id+'.webp',import.meta.url)),food.id);
 assert.deepEqual(Object.fromEntries(['rice','lanzhou-noodles','pudding','milk'].map(id=>[id,foodCategory(FOODS.find(f=>f.id===id))])),{rice:'main','lanzhou-noodles':'meal',pudding:'snack',milk:'drink'});
 setLocale('zh-CN');const view={catalog:FOODS,wallet:{balance:3,remainder:4200},activeScope:{characterId:'deepseek',lifeId:'l'},characterName:'DeepSeek',inventory:{},hunger:{satiety:72},settings:{},rewardsInitialized:true};
 const html=renderToStaticMarkup(React.createElement(FeedingPage,{view,onAction:noop}));
 for(const food of FOODS)assert.match(html,new RegExp('assets/food/'+food.id+'\\.webp'));
 assert.match(html,/还差 3 积分/);assert.match(html,/再攒 5,800 奖励量得下 1 积分/);
});

test('ledger names each kind, never the raw id, and keeps the wallet snapshot as the balance',()=>{
 setLocale('zh-CN');const rows=[{kind:'purchase',foodId:'rice',packages:1,cost:2,automatic:true,at:2,wallet:{balance:3}},{kind:'reward-revision',deltaUnits:0,at:1,wallet:{balance:5}},{kind:'meal',foodId:'rice',restored:35,at:0,wallet:{balance:5}}];
 const html=renderToStaticMarkup(React.createElement(FeedingPage,{view:{catalog:FOODS,wallet:{balance:3,remainder:0},inventory:{},settings:{},ledger:rows,ledgerTotal:3,rewardsInitialized:true},initialTab:'ledger',onAction:noop}));
 assert.doesNotMatch(html,/reward-revision|>purchase<|>meal</);assert.match(html,/购买/);assert.match(html,/吃饭/);assert.match(html,/自动/);assert.match(html,/-2/);assert.match(html,/本页隐藏了 1 条 0 变动修订/);
});

test('install pages describe each declared capability; unknown ids stay visible as they are',()=>{
 setLocale('zh-CN');assert.equal(capabilityView('connections.request').tag,'review');assert.equal(capabilityView('models.request').tag,'model');assert.deepEqual(capabilityView('made.up'),{id:'made.up',icon:'plug',label:'made.up',tag:null,tagLabel:null});
 setLocale('en');for(const name of ['@ai-buddy/bilibili-companion','@ai-buddy/qq-connect','@ai-buddy/work-collaboration']){const p=officialProfile(name);assert.ok(p.does.length&&p.need.length&&p.later.length);assert.doesNotMatch(JSON.stringify(p),han,name);}
 setLocale('zh-CN');
});

test('a streaming reply wears her name plate, and a stop the user asked for is not reported as a model failure',async()=>{
 const gal=await read('src/adapted/galgame-client.ts');
 assert.match(gal,/replyPlate = !!liveText \|\| speechShown, pWho = replyPlate \? 'heroine' : plateWho, pLabel = replyPlate \? s\.name : plateLabel/);
 assert.match(gal,/className: 'whg-plate gx-plate' \+ \(pWho === 'heroine'/);
 const say=gal.slice(gal.indexOf('function say(payload'),gal.indexOf('function dialogue()'));
 assert.match(say,/if \(!\/用户停止回复\$\/\.test\([^)]*\)\)\) \{ setApiError\([^;]*\); setFailedChat\(payload\) \}/);
 // the typed text still comes back after a stop, and other failures still show the alert with Retry
 assert.match(say,/if \(typed\) setText/);assert.match(gal,/t\("没连上模型"\)/);
});

test('reply style shows all three choices with a written sample, and still saves the same setting',async()=>{
 const src=await read('src/general-settings.mjs');
 assert.match(src,/h\(Segmented,\{value,size:'sm',label:t\('回复风格'\),'data-setting':'replyStyle',disabled:busy,options:Object\.entries\(labels\),onChange:next=>\{void save\(\{replyStyle:next\}\);\}\}\)/);
 assert.match(src,/labels=\{brief:t\('简短'\),natural:t\('自然'\),detailed:t\('详细'\)\}/);
 assert.doesNotMatch(src,/select\('replyStyle'/);
 // the sample is fixed text, so choosing a style never calls a model
 assert.doesNotMatch(src.slice(src.indexOf('function replyStyle'),src.indexOf('function select(')),/models|chat\(|game\(/);
});

test('backpack lists the newest meals first and keeps a retry for every pending meal',()=>{
 setLocale('zh-CN');const scope={characterId:'deepseek',lifeId:'l'};
 // view.meals is newest first, as companion-economy-store view() returns it
 const now=Date.parse('2026-10-29T12:00:00Z'),meals=Array.from({length:12},(_,i)=>({id:'m'+i,foodId:i===0?'pudding':'rice',at:now-60000*(i+1),scope,affectionState:i===0||i===11?'pending':'settled'}));
 const html=renderToStaticMarkup(React.createElement(FeedingPage,{view:{catalog:FOODS,wallet:{balance:3,remainder:0},activeScope:scope,inventory:{},hunger:{satiety:50},settings:{},meals,rewardsInitialized:true},initialTab:'inventory',timeZone:'UTC',now,onAction:noop}));
 const shown=[...html.matchAll(/class="feed-meal( pend)?"/g)].length;assert.equal(shown,8);
 assert.ok(html.indexOf('assets/food/pudding.webp')<html.indexOf('assets/food/rice.webp'),'newest meal first');
 assert.equal((html.match(/现在重试/g)??[]).length,2,'both pending meals, including the 12th, can be retried');
});

test('a line read elsewhere closes the pet bubble only if it shows that line; a user stop is not a chat failure',async()=>{
 const pet=await read('src/pet.mjs'),main=await read('src/main.mjs');
 assert.match(pet,/if\(value\.source==='social-line'&&value\.messageId\)bubble\.dataset\.social=value\.messageId;else delete bubble\.dataset\.social;/);
 assert.match(pet,/fillBubble\(\{source:'social-line',mode:kind,text:row\.text,messageId:row\.messageId,at:row\.at\?\?row\.receivedAt\}\)/);
 assert.match(pet,/pendingSocial=null;\/\*[^*]*\*\/if\(bubble\.dataset\.social===value\.messageId\)\{bubble\.hidden=true;geometry=null;\}render\(\);/);
 assert.match(main,/const userStopped=message=>\/用户停止回复\$\//);
 assert.equal((main.match(/!userStopped\(/g)??[]).length,2);
});

test('a line read while its presentation is being recorded stays read',async()=>{
 const r95=await read('src/companion-r95.mjs');
 assert.match(r95,/const line=state\.lives\[scope\.characterId\]\.r95\.lines\.find\(line=>line\.messageId===args\.messageId\);\/\*[^*]*\*\/if\(line\.status==='awaiting-presentation'\)line\.status='presented';line\.presentedAt\?\?=now\(\);/);
});
