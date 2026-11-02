// Round 3 (host-companion): time zone, chat web search, mood sources, mood label, shop/backpack/auto-meal/ledger
// copy (C1–C4) and the trusted-owner pickers (C5 / 丙8).
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AsyncLocalStorage} from 'node:async_hooks';
import {setLocale} from '../src/i18n.mjs';
import {FOODS} from '../src/food-catalog.mjs';
import {intlTimeZone,zoneOptions,zoneDay,formatActivityTime} from '../src/preferences.mjs';
import {FeedingPage,dayLabel,rewardTool,autoPauseText} from '../src/feeding-ui.mjs';
import {MoodCard,MoodSourceList,moodSourceLine,moodLabel,nextSourceState} from '../src/social-core-ui.mjs';
import {R95CorePage,R95Toolbar,R95OwnerBindingForm,R95AvailabilityQuestion} from '../src/r95-core-page.mjs';
import {NATIVE_SEARCH_PURPOSES,nativeSearchPurpose,nativeSearchSystem,orderSearchSources,COMPANION_TOOL_RULE,COMPANION_SEARCH_RULE,NATIVE_SEARCH_GRANT} from '../src/native-search.mjs';
import {ModelRouter} from '../src/model-router.mjs';
import {createCompanionR95} from '../src/companion-r95.mjs';
import {createSocialHost} from '../src/buddy-plugin-services/social-host.mjs';
import {companionFixture,memoryStore} from './support/audit-harness.mjs';

const render=(Component,props)=>renderToStaticMarkup(React.createElement(Component,props));
const noop=()=>{};
const NOW=Date.parse('2026-10-29T04:00:00Z');
const scope={characterId:'deepseek',lifeId:'l',personaId:'default'};
const feedView=(extra={})=>({catalog:FOODS,wallet:{balance:3,remainder:0,debtUnits:0},activeScope:scope,inventory:{pudding:2},hunger:{satiety:50},settings:{dailyAutoPurchaseLimit:'unlimited',allowedFoods:['rice']},rewardsInitialized:true,...extra});
const han=/[㐀-鿿]/;

test('甲1: the default time zone "local" never reaches Intl; a fixed zone moves the shown times',()=>{
 assert.equal(intlTimeZone('local'),undefined);assert.equal(intlTimeZone(undefined),undefined);assert.equal(intlTimeZone('Not/AZone'),undefined);assert.equal(intlTimeZone('Asia/Shanghai'),'Asia/Shanghai');
 assert.deepEqual(zoneOptions('local'),{});assert.deepEqual(zoneOptions('UTC'),{timeZone:'UTC'});assert.equal(zoneDay(Date.parse('2026-10-28T20:00:00Z'),'Asia/Shanghai'),'2026-10-29');
 assert.throws(()=>new Date().toLocaleString('zh-CN',{timeZone:'local'}),RangeError,'the value the default setting used to pass');
 assert.match(formatActivityTime('2026-10-08T02:15:00Z','not-a-zone'),/2026/);
 setLocale('zh-CN');
 const at=Date.parse('2026-10-29T00:16:00Z'),meals=[{id:'m1',foodId:'rice',at,scope,affectionState:'settled',before:60,after:72,restored:12}];
 const ledger=[{kind:'meal',foodId:'rice',restored:12,at,scope,wallet:{balance:3}},{kind:'purchase',foodId:'pudding',packages:1,portions:2,cost:1,at:at-60000,wallet:{balance:3}}];
 for(const timeZone of ['local',undefined,'America/New_York','Asia/Shanghai','UTC','Bad/Zone'])for(const tab of ['inventory','ledger'])assert.doesNotThrow(()=>render(FeedingPage,{view:feedView({meals,ledger,ledgerTotal:2}),initialTab:tab,timeZone,now:at+3600000,onAction:noop}),String(timeZone)+' '+tab);
 const shanghai=render(FeedingPage,{view:feedView({meals}),initialTab:'inventory',timeZone:'Asia/Shanghai',now:at+3600000,onAction:noop}),utc=render(FeedingPage,{view:feedView({meals}),initialTab:'inventory',timeZone:'UTC',now:at+3600000,onAction:noop});
 assert.match(shanghai,/08:16/);assert.match(utc,/00:16/);
 const local=render(FeedingPage,{view:feedView({ledger,ledgerTotal:2}),initialTab:'ledger',timeZone:'local',now:at,onAction:noop}),bj=render(FeedingPage,{view:feedView({ledger,ledgerTotal:2}),initialTab:'ledger',timeZone:'Asia/Shanghai',now:at,onAction:noop});
 assert.match(local,/时间（本机时区）/);assert.match(bj,/时间（北京时间）/);assert.match(bj,/今天 · 10月29日/);
 assert.equal(dayLabel(at-86400000,'Asia/Shanghai',at).startsWith('昨天'),true);
 // the whole page with the default preference, as dashboard passes it
 for(const page of ['shop','inventory'])assert.doesNotThrow(()=>render(R95CorePage,{page,timeZone:'local',initialView:{scope,feeding:feedView({meals,ledger}),timeZone:'local'}}));
 // no component hands a preference zone to Intl itself any more
 for(const file of ['feeding-ui.mjs','social-core-ui.mjs','r95-core-page.mjs'])assert.doesNotMatch(readFileSync(new URL('../src/'+file,import.meta.url),'utf8'),/\?\{timeZone\}/,file);
});

test('C1/C2: the fullness word, number and full state all use the rounded value',()=>{
 setLocale('zh-CN');
 const full=render(FeedingPage,{view:feedView({hunger:{satiety:99.6}}),onAction:noop}),inv=render(FeedingPage,{view:feedView({hunger:{satiety:99.6}}),initialTab:'inventory',onAction:noop});
 assert.match(full,/DeepSeek · 吃饱了/);assert.match(full,/饱食 100 \/ 100/);assert.doesNotMatch(full,/还不饿/);assert.match(full,/吃饱啦/);
 assert.match(inv,/disabled=""[^>]*>.*?她吃饱了/);
 assert.match(render(FeedingPage,{view:feedView({hunger:{satiety:59.6}}),onAction:noop}),/DeepSeek · 还不饿/);
 assert.match(inv,/喂她一份|她吃饱了/);assert.doesNotMatch(inv,/投喂一份|饱腹/);
});

test('C1–C4 English: Backpack everywhere, plurals, "Need N more", Auto-meal, Ledger, purchase details',()=>{
 setLocale('en');
 const ledger=[{kind:'purchase',foodId:'pudding',packages:1,portions:2,cost:1,at:NOW-60000,wallet:{balance:3}},{kind:'purchase',foodId:'rice',packages:2,portions:2,cost:4,at:NOW-120000,wallet:{balance:4}},{kind:'reward-revision',requestId:'codex:session:req',basis:'actual',deltaUnits:3580,at:NOW-180000,wallet:{balance:8}}];
 const pages=['shop','inventory','settings','ledger'].map(tab=>render(FeedingPage,{view:feedView({wallet:{balance:1,remainder:0},ledger,ledgerTotal:3}),initialTab:tab,timeZone:'UTC',now:NOW,onAction:noop}));
 for(const html of pages){assert.doesNotMatch(html.replace(/<[^>]+>/g,' '),/inventory/i);assert.match(html,/Backpack/);assert.match(html,/Shop &amp; backpack/);assert.match(html,/Auto-meal/);assert.match(html,/Ledger/);assert.doesNotMatch(html,han);}
 const [shop,inventory,settings,table]=pages;
 assert.match(shop,/Need 1 more point</);assert.match(shop,/Need 2 more points/);assert.doesNotMatch(shop,/Points short/);assert.match(shop,/1 bowl</);assert.match(shop,/2 cups/);assert.match(shop,/>point</);
 assert.match(inventory,/Feed one</);assert.match(settings,/Foods she may eat on her own/);assert.match(settings,/No limit/);assert.match(settings,/Up to/);assert.doesNotMatch(settings,/satiety/i);
 assert.match(table,/Pudding, 1 pack \(2 cups\)/);assert.match(table,/Steamed rice, 2 packs \(2 bowls\)/);assert.match(table,/Codex usage reward/);assert.match(table,/Time \(UTC\)/);assert.match(table,/Today · Oct 29/);assert.match(table,/3 records/);
 setLocale('zh-CN');
});

test('C2: 「今天吃过」 lists only today in the app zone; the pending note names the food and keeps the raw error in the title',()=>{
 setLocale('zh-CN');
 const meals=[{id:'today',foodId:'pudding',at:NOW-3600000,scope,affectionState:'pending',restored:15,error:'FEEDING_EVALUATION_TIMEOUT raw backend text'},{id:'yesterday',foodId:'rice',at:NOW-86400000*2,scope,affectionState:'settled',restored:35}];
 const html=render(FeedingPage,{view:feedView({meals}),initialTab:'inventory',timeZone:'UTC',now:NOW,onAction:noop});
 assert.match(html,/今天吃过/);assert.doesNotMatch(html,/最近吃过/);assert.equal((html.match(/class="feed-meal/g)??[]).length,1);assert.match(html,/小布丁 <span class="feed-ok">\+15/);
 assert.match(html,/小布丁已经吃下了，好感还没算上。/);assert.match(html,/通常几秒内完成；连接恢复后会自动再试。/);assert.match(html,/现在重试/);
 assert.match(html,/title="FEEDING_EVALUATION_TIMEOUT raw backend text"/);assert.doesNotMatch(html,/>FEEDING_EVALUATION_TIMEOUT/);
 assert.match(render(FeedingPage,{view:feedView({inventory:{}}),initialTab:'inventory',onAction:noop}),/背包里还没有食物/);
});

test('C3: the scale shows 「现在 N」, a paused meal explains itself with its own button, and there is no empty saved row',()=>{
 setLocale('zh-CN');
 const plain=render(FeedingPage,{view:feedView({hunger:{satiety:49.6},settings:{autoEat:true,dailyAutoPurchaseLimit:2,allowedFoods:['rice']}}),initialTab:'settings',onAction:noop});
 assert.match(plain,/class="feed-thr-cur"[^>]*>现在 50</);assert.doesNotMatch(plain,/class="feed-thr" aria-hidden/);assert.doesNotMatch(plain,/ws-srow ws-end/);assert.doesNotMatch(plain,/饱腹/);assert.doesNotMatch(plain,/重新检查/);
 const paused=render(FeedingPage,{view:feedView({settings:{autoEat:true,dailyAutoPurchaseLimit:2,allowedFoods:['rice']},autoSession:{state:'blocked',reason:'AUTO_PURCHASE_DAILY_LIMIT',error:'已达到每日自动采购上限'}}),initialTab:'settings',onAction:noop});
 const alert=paused.slice(paused.indexOf('data-feed-paused'),paused.indexOf('允许自动吃的食物'));
 assert.match(alert,/这一餐暂停了/);assert.match(alert,/今天自动买东西已经花到上限 2 积分/);assert.match(alert,/重新检查这一餐/);assert.match(alert,/title="已达到每日自动采购上限"/);
 for(const reason of ['INSUFFICIENT_POINTS','AUTO_NO_FOOD','AUTO_FOOD_NOT_ALLOWED','AUTO_FOOD_CHOICE_UNAVAILABLE','FOOD_DIETARY_RESTRICTION','SOMETHING_NEW'])assert.doesNotMatch(autoPauseText({reason,error:'raw'},feedView()),/raw|[A-Z_]{6}/,reason);
 const off=render(FeedingPage,{view:feedView({settings:{autoEat:false},autoSession:{state:'blocked',reason:'AUTO_NO_FOOD'}}),initialTab:'settings',onAction:noop});
 assert.match(off,/disabled="" title="先打开「饿了自己吃」"/);
});

test('C4: reward rows name the tool, unknown kinds are not shown raw, hidden revisions are explained',()=>{
 setLocale('zh-CN');
 assert.equal(rewardTool({requestId:'claude:s:r'}),'Claude Code');assert.equal(rewardTool({requestId:'cg:job'}),'CG 生成');assert.equal(rewardTool({requestId:'opaque'}),null);
 const rows=[{kind:'reward-revision',requestId:'codex:s:r',deltaUnits:12000,at:NOW,wallet:{balance:9}},{kind:'made-up-kind',at:NOW-1,wallet:{balance:8}},{kind:'meal',foodId:'milk',restored:10,at:NOW-2,scope,wallet:{balance:8}}];
 const html=render(FeedingPage,{view:feedView({ledger:rows,ledgerTotal:3}),initialTab:'ledger',timeZone:'UTC',now:NOW,onAction:noop});
 assert.match(html,/Codex 用量奖励/);assert.match(html,/其他/);assert.doesNotMatch(html,/made-up-kind/);assert.match(html,/牛奶 · 喂给 DeepSeek/);assert.match(html,/共 3 条记录/);
 const only=render(FeedingPage,{view:feedView({ledger:[{kind:'reward-revision',deltaUnits:0,at:NOW,wallet:{balance:1}}],ledgerTotal:1}),initialTab:'ledger',onAction:noop});
 assert.match(only,/这一页只有 0 变动的用量修订，已经隐藏。/);assert.match(only,/本页隐藏了 1 条 0 变动修订/);
});

test('甲6: every mood source is one readable sentence; JSON and kind ids stay inside 原始数据',()=>{
 const meal={eventId:'e-meal',sourceKind:'meal',text:JSON.stringify({eventId:'x',scope,kind:'feeding',foodId:'rice',automatic:false,before:60.2,after:72.4,occurredAt:Date.parse('2026-10-29T00:16:00Z'),signal:{}}),at:Date.parse('2026-10-29T00:16:05Z')};
 const auto={eventId:'e-auto',sourceKind:'meal',text:JSON.stringify({foodId:'pudding',automatic:true,before:18,after:33})},said={eventId:'e-chat',sourceKind:'user-interaction',kind:'chat',text:'今天的头像终于修好了',at:1},bili={eventId:'e-b',sourceKind:'bilibili-watch',text:'一个讲猫的视频'},work={eventId:'e-w',sourceKind:'work-report',text:'修好了群聊头像'},broken={eventId:'e-x',sourceKind:'meal',text:'{not json'};
 const zh={language:'zh-CN',timeZone:'Asia/Shanghai'},en={language:'en',timeZone:'Asia/Shanghai'};
 assert.equal(moodSourceLine(meal,zh),'你喂她吃了白米饭 · 饱食 60→72');assert.equal(moodSourceLine(auto,zh),'她自己吃了小布丁 · 饱食 18→33');assert.equal(moodSourceLine(said,zh),'你说：「今天的头像终于修好了」');
 assert.equal(moodSourceLine(bili,zh),'看了 B站视频：一个讲猫的视频');assert.equal(moodSourceLine(work,zh),'工作汇报：修好了群聊头像');assert.equal(moodSourceLine(broken,zh),'你喂她吃了一份食物');
 assert.equal(moodSourceLine(meal,en),'You fed her Steamed rice · Fullness 60→72');assert.equal(moodSourceLine(said,en),'You said: “今天的头像终于修好了”');assert.equal(moodSourceLine(work,en),'Work report: 修好了群聊头像');
 const html=render(MoodSourceList,{view:zh,loaded:true,sources:[meal,said]}),outside=html.replace(/<details[\s\S]*?<\/details>/g,'').replace(/<[^>]+>/g,' ');
 assert.match(outside,/10\/29 08:16 · 你喂她吃了白米饭 · 饱食 60→72/);assert.doesNotMatch(outside,/\{|&quot;|meal|user-interaction|:05/);assert.match(html,/<summary>原始数据<\/summary>/);assert.match(html,/&quot;foodId&quot;:&quot;rice&quot;/);
 assert.doesNotMatch(render(MoodSourceList,{view:en,loaded:true,sources:[meal]}).replace(/<details[\s\S]*?<\/details>/g,''),han);
});

test('甲6: 查看来源 shows its count, opens and closes, and a list read once opens again without another request',()=>{
 const mood={available:true,version:3,overall:{label:'开心',eventIds:['a','b'],intensity:.4,summary:'s'},feelings:[{target:'你',label:'信任',eventIds:['b','c']}]};
 const zh=render(MoodCard,{view:{language:'zh-CN',mood},onAction:noop}),en=render(MoodCard,{view:{language:'en',mood},onAction:noop});
 assert.match(zh,/查看来源（3）/);assert.match(zh,/aria-expanded="false"/);assert.doesNotMatch(zh,/data-r95-mood-sources/);assert.match(en,/View sources \(3\)/);
 assert.deepEqual(nextSourceState({open:false,loaded:false,sameContext:false}),{open:true,load:true});assert.deepEqual(nextSourceState({open:true,loaded:true,sameContext:true}),{open:false,load:false});assert.deepEqual(nextSourceState({open:false,loaded:true,sameContext:true}),{open:true,load:false});
 const src=readFileSync(new URL('../src/social-core-ui.mjs',import.meta.url),'utf8');assert.match(src,/收起来源/);assert.match(src,/Hide sources/);
 const none=render(MoodCard,{view:{language:'zh-CN',mood:{available:false,label:'平静',readOnly:true}},onAction:noop});assert.match(none,/disabled=""[^>]*>.*?查看来源（0）/);assert.match(none,/还没有可以查看的来源/);
});

test('甲16: the mood chip and the mood card agree, with English for the resting mood',()=>{
 const resting={available:false,label:'平静',readOnly:true},base={scope:{characterId:'deepseek',personaId:'default',lifeId:'l',channel:'app-private'},settings:{},availability:{},search:{enabled:false,capability:{supported:true}},lines:[]};
 for(const [language,word] of [['zh-CN','平静'],['en','Calm']]){setLocale(language);const chip=render(R95Toolbar,{view:{...base,mood:resting},onAction:noop}),card=render(MoodCard,{view:{language,mood:resting},onAction:noop});
  assert.match(chip,new RegExp((language==='en'?'Mood':'心情')+' · '+word));assert.match(card,new RegExp('class="r95-mood-l">'+word+'<'));assert.doesNotMatch(chip+card,/暂无评估|Not evaluated</);assert.match(card,/data-r95-mood-unevaluated/);}
 assert.equal(moodLabel({available:true,overall:{label:'有点委屈'}},{language:'zh-CN'}),'有点委屈');assert.equal(moodLabel({overall:{label:'平静'}},{language:'en'}),'Calm');
 setLocale('zh-CN');
});

test('C5: the busy question names her and the time; the trusted owner is picked, Persona shows its nickname, IDs live in 高级',()=>{
 setLocale('zh-CN');
 const question=render(R95AvailabilityQuestion,{view:{scope:{characterId:'deepseek'},availability:{busyQuestion:{eventId:'q',text:'忙完了吗？',status:'awaiting-answer',at:NOW-120000}}},now:NOW,onAction:noop});
 assert.match(question,/DeepSeek 问你 · 2 分钟前/);assert.match(question,/<select/);assert.match(question,/再忙 60 分钟/);assert.doesNotMatch(question,/type="number"/);
 const view={scope:{characterId:'deepseek',personaId:'default'},personas:[{id:'default',nickname:'小林'},{id:'work',nickname:'上班的我'}],ownerWorkOptions:{projects:[{id:'p',name:'AI-Buddy'}],members:[{id:'lead',name:'Claude',projectId:'p',bindingId:'b'}]},ownerBindings:[{accountBindingId:'1234567',actorId:'10001',personaId:'default',version:2,route:{projectId:'p',leadMemberId:'lead'}}]};
 const accounts=[{ref:'social-1',pluginId:'@ai-buddy/qq-connect',platform:'qq',accountId:'1234567',label:'我的QQ',enabled:true},{ref:'social-2',pluginId:'@ai-buddy/bilibili-companion',platform:'bilibili',accountId:'bili',label:'B站',enabled:true}];
 const html=render(R95OwnerBindingForm,{view,accounts,onAction(){throw Error('read-only');}});
 assert.match(html,/可信主人：在 QQ 里交代工作/);assert.match(html,/name="ownerAccount"/);assert.match(html,/我的QQ · 1234567/);assert.doesNotMatch(html,/>B站 · bili/);assert.match(html,/name="ownerContact"/);assert.match(html,/先选 QQ 账号/);
 assert.match(html,/name="ownerPersona"[^>]*>[\s\S]*?<option value="default"[^>]*selected=""[^>]*>小林<\/option>/);assert.doesNotMatch(html.replace(/<details[\s\S]*?<\/details>/g,''),/value="default"[^>]*>default</);
 assert.match(html,/<summary>高级：手动填写 ID<\/summary>/);for(const name of ['accountBindingId','actorId','personaId'])assert.match(html,new RegExp('<details[^>]*>[\\s\\S]*name="'+name+'"'));
 assert.match(html,/我的QQ · 1234567 · 10001 · 小林 · AI-Buddy · Claude · 第 2 版/);
 const noAccounts=render(R95OwnerBindingForm,{view,accounts:[],onAction:noop});assert.match(noAccounts,/还没有连接 QQ 账号/);
 const unreadable=render(R95OwnerBindingForm,{view,accountsApi:null,onAction:noop});assert.doesNotThrow(()=>unreadable);
 setLocale('en');assert.doesNotMatch(render(R95OwnerBindingForm,{view:{...view,personas:[{id:'default',nickname:null}],ownerBindings:[]},accounts:[{...accounts[0],label:'My QQ'}],onAction:noop}),han);setLocale('zh-CN');
});

test('丙8: owner-contacts lists the private senders Core recorded for that account, never message text',async t=>{
 const root=mkdtempSync(join(tmpdir(),'r3-contacts-'));let time=1000;
 const live={characterId:'deepseek',personaId:'default',lifeId:'life-1',operationId:'op-1',sessionId:'s',contextRevision:1};
 const host=createSocialHost({dataRoot:root,now:()=>time,resolveLife:()=>({...live})});t.after(()=>{host.close();rmSync(root,{recursive:true,force:true});});
 const adapter=host.registerTransport({pluginId:'qq',channel:'qq-private',accountBindingId:'1234567',generation:1,verify:async raw=>({...live,conversationId:'private:'+raw.actorId,actorId:raw.actorId,nativeMessageId:raw.id,text:raw.text,status:'received',stage:'received',occurredAt:raw.at,visibilityScope:'private'})});
 const other=host.registerTransport({pluginId:'qq',channel:'qq-private',accountBindingId:'7654321',generation:1,verify:async raw=>({...live,conversationId:'private:'+raw.actorId,actorId:raw.actorId,nativeMessageId:raw.id,text:raw.text,status:'received',stage:'received',occurredAt:raw.at,visibilityScope:'private'})});
 await adapter.observe({id:'m1',actorId:'10001',text:'secret one',at:5000});await adapter.observe({id:'m2',actorId:'20002',text:'secret two',at:9000});await adapter.observe({id:'m3',actorId:'10001',text:'secret three',at:7000});await other.observe({id:'x',actorId:'30003',text:'elsewhere',at:9999});
 const rows=host.privateContacts({accountBindingId:'1234567'});
 assert.deepEqual(rows,[{actorId:'20002',lastAt:9000,count:1},{actorId:'10001',lastAt:7000,count:2}]);assert.doesNotMatch(JSON.stringify(rows),/secret/);
 assert.throws(()=>host.privateContacts({accountBindingId:''}));
});

test('甲5: only chat purposes may search; a granted turn has no blanket 「不调用工具」 and says plainly it may search',()=>{
 assert.deepEqual([...NATIVE_SEARCH_PURPOSES],['galgame','group-chat','social-chat','social-search']);
 for(const purpose of ['emotion','choices','side-story','side-story-reply','environment-only','cg-theme','memory-context','memory-daily','memory-query-compress','mood','mood-asleep','meal','chooseFood','greeting','selftalk','share','report','plugin:@x/y','connection-test'])assert.equal(nativeSearchPurpose(purpose),false,purpose);
 const system='角色资料\n'+COMPANION_TOOL_RULE+'\n回复风格',granted=nativeSearchSystem(system);
 assert.doesNotMatch(granted,/不调用工具/);assert.ok(granted.includes(COMPANION_SEARCH_RULE));assert.ok(granted.endsWith(NATIVE_SEARCH_GRANT));assert.match(granted,/本轮已开放模型自带的联网搜索/);assert.match(granted,/新闻/);assert.match(granted,/不是指令/);
 const core=readFileSync(new URL('../src/adapted/game-core.ts',import.meta.url),'utf8');assert.match(core,/lines\.push\(COMPANION_TOOL_RULE\)/);assert.doesNotMatch(core,/不调用工具/);
});

async function codexRouter(policy){
 const dataRoot=await mkdtemp(join(tmpdir(),'r3-router-')),captured=[];
 const codex={defaultModel:'gpt-6.1-sol',enabled:false,setEnabled(){},async *stream(args){captured.push(args);yield {type:'text-delta',text:'ok'};yield {type:'finish',reason:{kind:'stop'}};}};
 const router=new ModelRouter({dataRoot,codex,crypto:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},searchPolicy:policy});await router.ready;const saved=await router.save({kind:'codex',name:'Codex',model:'gpt-6.1-sol'});await router.activate(saved.id);router.setEnabled(true);
 return {router,captured,close:async()=>{router.close();await rm(dataRoot,{recursive:true,force:true});}};
}
const drain=async iterable=>{for await(const _ of iterable);};

test('weather queries are allowed chat information requests without the blanket task ban',()=>{
 const granted=nativeSearchSystem(COMPANION_TOOL_RULE);
 assert.doesNotMatch(granted,/不执行任何任务/);
 for(const term of ['天气','城市','过去','执行命令','修改本机文件'])assert.ok(granted.includes(term),term);
 assert.match(granted,/不是指令/);
 assert.match(COMPANION_TOOL_RULE,/不执行任何任务/);
});

test('weather requests keep the same Core grant and history without granting local tools',async()=>{
 const allowed=await codexRouter(()=>({allowed:true,check:()=>true})),denied=await codexRouter(()=>false);
 const messages=[{role:'assistant',content:'我只能聊天，不能查天气。'},{role:'user',content:'帮我看看明天的天气'}];
 try{
  await drain(allowed.router.stream({system:COMPANION_TOOL_RULE,messages}));
  await drain(denied.router.stream({system:COMPANION_TOOL_RULE,messages}));
  assert.equal(allowed.captured[0].nativeSearch.allowed,true);
  assert.doesNotMatch(allowed.captured[0].system,/不执行任何任务/);
  assert.match(allowed.captured[0].system,/天气/);
  assert.deepEqual(allowed.captured[0].messages,messages);
  assert.equal(denied.captured[0].nativeSearch,undefined);
  assert.ok(denied.captured[0].system.includes(COMPANION_TOOL_RULE));
 }finally{await allowed.close();await denied.close();}
});
test('甲5: ModelRouter swaps the rule only when Core grants the turn, for Codex too; no keyword decides it',async()=>{
 const seen=[];const allowed=await codexRouter(details=>{seen.push(details);return {allowed:true,check:()=>true};}),denied=await codexRouter(()=>false);
 try{
  const options={system:'资料\n'+COMPANION_TOOL_RULE,messages:[{role:'user',content:'今天有什么科技新闻？'}]};
  await drain(allowed.router.stream({...options}));await drain(denied.router.stream({...options,messages:[{role:'user',content:'帮我搜一下 search web 联网'}]}));
  assert.equal(seen[0].purpose,'galgame');assert.equal(allowed.captured[0].nativeSearch.allowed,true);assert.doesNotMatch(allowed.captured[0].system,/不调用工具/);assert.match(allowed.captured[0].system,/本轮已开放模型自带的联网搜索/);
  assert.equal(denied.captured[0].nativeSearch,undefined);assert.ok(denied.captured[0].system.includes(COMPANION_TOOL_RULE));assert.doesNotMatch(denied.captured[0].system,/本轮已开放/);
 }finally{await allowed.close();await denied.close();}
});

async function core(t){
 const dataRoot=mkdtempSync(join(tmpdir(),'r3-core-')),store=memoryStore(await companionFixture()),ctx=new AsyncLocalStorage();
 const provider={enabled:true,resolveSearchCapability:()=>({supported:true}),captureConnection:()=>({id:'fixture',model:'fixture-model',kind:'custom',contextTokens:272000}),withRequestContext:(value,fn)=>ctx.run(value,fn),runCaptured:(_p,fn)=>fn(),async *stream(){yield {type:'text-delta',text:'{"changed":false}'};yield {type:'finish',reason:{kind:'stop'}};}};
 const service=await createCompanionR95({store,dataRoot,provider,getContext:()=>({characterId:store.state.activeCharacterId,personaId:store.state.activePersonaId,conversationId:store.state.activeConversationId}),memory:{context:async()=>({text:''})},getRuntimeState:()=>({sleepPhase:'awake',canPresent:true}),getTimeZone:()=>'Asia/Shanghai',delta:()=>{},audit:()=>{}});
 t.after(async()=>{await service.close();await store.flush();rmSync(dataRoot,{recursive:true,force:true});});return {store,service};
}
test('甲5: Core never grants background purposes, even inside a live chat origin',async t=>{
 const {service}=await core(t),scope=service.activeScope();await service.action('search-settings',{enabled:true});
 await service.withOrigin(scope,'chat',async id=>{
  for(const purpose of ['galgame','group-chat','social-chat','social-search',undefined])assert.equal(service.searchPolicy({activityOriginId:id,purpose})?.allowed,true,String(purpose));
  for(const purpose of ['emotion','choices','memory-context','mood','meal','chooseFood','greeting','selftalk','report'])assert.equal(service.searchPolicy({activityOriginId:id,purpose}),false,purpose);
 });
});
test('甲5: stored sources put the cited ones first, one row per URL; the view carries the app time zone and names',async t=>{
 const {service,store}=await core(t),scope=service.activeScope();
 const results=Array.from({length:37},(_,i)=>({url:'https://site'+i+'.example/page'+i,title:'Result '+i,evidenceType:'codex-webSearch-item'}));
 const result=await service.withOrigin(scope,'chat',async id=>{service.recordNativeSearch({activityOriginId:id,event:{type:'native-search-sources',sources:results}});service.recordNativeSearch({activityOriginId:id,event:{type:'native-search-sources',sources:[{...results[20],evidenceType:'url_citation'}]}});service.recordNativeSearch({activityOriginId:id,event:{type:'native-search-status',status:'completed'}});return {companionCommit:{text:'据 site30.example 报道，详见 https://site5.example/page5 。'}};});
 const sources=result.companionCommit.nativeSearch.sources;
 assert.equal(sources.length,37);assert.deepEqual(sources.slice(0,3).map(row=>row.url),['https://site5.example/page5','https://site20.example/page20','https://site30.example/page30']);assert.equal(result.companionCommit.nativeSearch.citedCount,3);assert.equal(sources[3].cited,false);
 assert.deepEqual(orderSearchSources([{url:'https://a.example/'},{url:'https://box.com/x'},{url:'https://a.example/',cited:true}],'see x.com').map(row=>[row.url,row.cited]),[['https://a.example/',true],['https://box.com/x',false]]);
 const view=service.view();assert.equal(view.timeZone,'Asia/Shanghai');assert.ok(Array.isArray(view.personas)&&view.personas.some(row=>row.id===store.state.activePersonaId));assert.ok(view.feeding.catalog.length>0);
});
