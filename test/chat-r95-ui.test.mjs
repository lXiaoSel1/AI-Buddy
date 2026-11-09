import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale} from '../src/i18n.mjs';
import {autoProgress,AutoChip,GroupAutoPanel,AutoRoundStrip,MoodChip,chatMoodLabel,MessageSources,sourceView,SOURCE_LIMIT,ChatSpeechLines,notePetLine,speechHistory,galgameUnread,MoreMenu,clock} from '../src/chat-r95-ui.mjs';
import {fullTextLabel,fullMessageMeta,needsFullView,FullMessageButton} from '../src/full-message-viewer.mjs';
import {GroupHeader} from '../src/group-header.mjs';
import {CompanionGroupDialogue} from '../src/companion-ui.mjs';
import {normalizeDashboardPage} from '../src/dashboard-pages.mjs';
const render=(Component,props)=>renderToStaticMarkup(React.createElement(Component,props));
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
const han=/[㐀-鿿]/,noop=async()=>{};
const names={claude:'Claude',deepseek:'DeepSeek',chatgpt:'GPT'},nameOf=id=>names[id];
const auto=(extra={})=>({status:'active',mode:'rounds',roundLimit:6,roundIndex:1,opportunityIndex:0,members:['claude','deepseek'],pending:{characterId:'claude'},...extra});
const r95=(extra={})=>({scope:{characterId:'deepseek',personaId:'default',channel:'app-group',conversationId:'g'},groupId:'g',mood:{available:false,label:'平静'},settings:{auto:true},search:{enabled:false,capability:{supported:true}},members:['claude','deepseek'],lines:[],...extra});

test('Auto progress counts round n of the limit and names the speaker and who is next (C6 / 丙9)',()=>{
 assert.deepEqual((({round,total,speaking,next})=>({round,total,speaking,next}))(autoProgress(auto())),{round:2,total:6,speaking:'claude',next:'deepseek'});
 // the last member of a round hands over to the first of the next round; after the last round nobody is next
 assert.equal(autoProgress(auto({opportunityIndex:1,pending:{characterId:'deepseek'}})).next,'claude');
 assert.equal(autoProgress(auto({roundIndex:5,opportunityIndex:1,pending:{characterId:'deepseek'}})).next,null);
 // waiting between turns: the member at the current opportunity is next
 assert.equal(autoProgress(auto({pending:null,opportunityIndex:1})).next,'deepseek');
 assert.equal(autoProgress(auto({mode:'until-stopped',roundLimit:null})).total,null);
 assert.equal(autoProgress(auto({status:'ended'})),null);assert.equal(autoProgress(null),null);
});

test('the Auto chip shows round n / total or 未开启, and its panel links to Social and joins names per language (C6)',()=>{
 setLocale('zh-CN');assert.match(render(AutoChip,{view:r95({auto:auto()}),onAction:noop,nameOf}),/Auto<\/span><small class="r95-chip-st">第 2 \/ 6 轮/);
 assert.match(render(AutoChip,{view:r95({settings:{auto:false}}),onAction:noop,nameOf}),/未开启/);
 const off=render(GroupAutoPanel,{view:r95({settings:{auto:false}}),onAction:noop,nameOf,onOpenSocial(){}});
 assert.match(off,/社交与心情里还没有允许群聊 Auto。/);assert.match(off,/data-open-social="auto"[^>]*>去开启/);assert.match(off,/本次成员：Claude、DeepSeek/);assert.match(off,/确认成员并开始<\/button>/);assert.match(off,/disabled=""[^>]*>确认成员并开始/);
 const running=render(GroupAutoPanel,{view:r95({auto:auto()}),onAction:noop,nameOf});
 assert.match(running,/<b>2<\/b> \/ 6 轮/);assert.match(running,/ws-meter"><b style="width:33%"/);assert.match(running,/下一位：DeepSeek/);assert.match(running,/暂停/);assert.match(running,/停止 Auto/);assert.doesNotMatch(running,/确认成员并开始/);
 setLocale('en');const en=render(GroupAutoPanel,{view:r95({settings:{auto:false}}),onAction:noop,nameOf,onOpenSocial(){}});
 assert.match(en,/Let AI end it/);assert.match(en,/Members: Claude, DeepSeek/);assert.match(en,/Turn it on/);assert.doesNotMatch(en.replace(/>[^<]*Claude[^<]*</g,'><'),han);
 assert.match(render(AutoChip,{view:r95({auto:auto()}),onAction:noop,nameOf}),/round 2 \/ 6/);setLocale('zh-CN');
});

test('the Auto strip says who is talking, round n / total, who is next and that your message waits (C6 / C9)',()=>{
 setLocale('zh-CN');const html=render(AutoRoundStrip,{view:r95({auto:auto()}),onAction:noop,nameOf,busy:true,speaker:'Claude',queued:2});
 assert.match(html,/<b>Claude<\/b> 正在说/);assert.match(html,/Auto · 第 2 \/ 6 轮 · 下一位 DeepSeek/);assert.match(html,/data-r95-queued-user="2"[^>]*>你的消息排在她后面/);assert.match(html,/暂停/);assert.match(html,/停止/);
 assert.equal(render(AutoRoundStrip,{view:r95(),onAction:noop,nameOf}),'');
 setLocale('en');const en=render(AutoRoundStrip,{view:r95({auto:auto({status:'paused',pending:null})}),onAction:noop,nameOf,queued:1});
 assert.match(en,/Auto paused/);assert.match(en,/Auto · round 2 \/ 6 · next Claude/);assert.match(en,/Yours is next/);assert.match(en,/Continue/);assert.doesNotMatch(en,han);setLocale('zh-CN');
});

test('the mood chip uses the same label as the read-only card, says read-only and links to Social (C6)',()=>{
 setLocale('zh-CN');assert.equal(chatMoodLabel(r95()),'平静');assert.equal(chatMoodLabel({mood:{overall:{label:'开心'}}}),'开心');assert.equal(chatMoodLabel({mood:{}}),'暂无评估');
 const open=render(MoodChip,{view:r95(),onAction:noop,onOpenSocial(){},initialOpen:true});
 assert.match(open,/心情 · 平静/);assert.match(open,/<small>只读<\/small>/);assert.match(open,/data-r95-mood="true"/);assert.match(open,/data-open-social="mood"[^>]*>在社交设置里看/);
 setLocale('en');assert.match(render(MoodChip,{view:r95(),onAction:noop}),/Mood · Calm/);setLocale('zh-CN');
});

test('sources: a footer chip that opens a popover with the first few, cited first, +N for the rest; none means not clickable (C7)',()=>{
 setLocale('zh-CN');const sources=Array.from({length:8},(_,i)=>({url:'https://site'+i+'.example.com/a',title:'Page '+i,cited:i===6}));
 const message={id:'m',nativeSearch:{status:'completed',sources:[...sources,{url:'javascript:alert(1)',title:'bad'},{url:'http://127.0.0.1/x',title:'local'},{url:sources[0].url,title:'dup'}]}};
 const view=sourceView(message);assert.equal(view.sources.length,8);assert.equal(view.sources[0].title,'Page 6','cited first');
 const closed=render(MessageSources,{message});assert.match(closed,/<button[^>]*class="r95-src-chip on"[^>]*>.*来源 8/);assert.doesNotMatch(closed,/<details|r95-src"/);
 const open=render(MessageSources,{message,initialOpen:true});assert.equal((open.match(/class="r95-src"/g)??[]).length,SOURCE_LIMIT);assert.match(open,/这次查了 8 个网页/);assert.match(open,/data-sources-more="3"[^>]*>\+3/);assert.doesNotMatch(open,/javascript:|127\.0\.0\.1/);
 const none=render(MessageSources,{message:{id:'n',nativeSearch:{status:'completed',sources:[]}}});assert.match(none,/^<span[^>]*class="r95-src-chip"[^>]*>.*查过了，没有可用来源/);assert.doesNotMatch(none,/<button/);
 assert.match(render(MessageSources,{message:{nativeSearch:{status:'failed',reason:'timeout'}}}),/class="r95-src-chip warn" title="timeout"[^>]*>.*联网检索失败/);
 assert.equal(render(MessageSources,{message:{nativeSearch:{status:'not-used'}}}),'');assert.equal(render(MessageSources,{message:{text:'x'}}),'');
 setLocale('en');assert.match(render(MessageSources,{message}),/8 sources/);assert.match(render(MessageSources,{message:{nativeSearch:{status:'completed',sources:[sources[0]]}}}),/1 source</);assert.match(render(MessageSources,{message,initialOpen:true}),/8 pages searched/);assert.match(render(MessageSources,{message:{nativeSearch:{status:'completed',sources:[]}}}),/Searched, no usable sources/);setLocale('zh-CN');
});

test('her line shows kind and time, reply options, waits for presentation before it can be read, and notes the pet (C8)',()=>{
 setLocale('zh-CN');const at=new Date(2026,9,29,21,40).getTime(),line={messageId:'s1',text:'主人还在加班吗？',status:'awaiting-presentation',mode:'proactive',at};
 const html=render(ChatSpeechLines,{view:{lines:[line,{...line,messageId:'s2'},{messageId:'old',text:'读过了',status:'read'}]},onAction:()=>{throw Error('SSR must not acknowledge');},inDialog:true});
 assert.match(html,/主动来找你 · 21:40/);assert.match(html,/还有 1 句/);assert.match(html,/data-speech-option="reply"[^>]*><kbd aria-hidden="true">1<\/kbd><span>回她/);assert.match(html,/disabled=""[^>]*title="台词完整显示出来以后才能点"[^>]*><kbd aria-hidden="true">2<\/kbd><span>知道了/);assert.doesNotMatch(html,/读过了|data-r95-speech="s2"/);
 assert.doesNotMatch(render(ChatSpeechLines,{view:{lines:[{...line,status:'presented'}]},onAction:noop}),/disabled/);
 notePetLine('s1');assert.match(render(ChatSpeechLines,{view:{lines:[line]},onAction:noop}),/桌宠上也说了这一句，在哪边回应都算读过/);
 const dream=render(ChatSpeechLines,{view:{lines:[{...line,messageId:'d',mode:'dream'}]},onAction:noop});assert.match(dream,/梦话/);assert.doesNotMatch(dream,/回她|接一句/);assert.match(dream,/收起/);
 setLocale('en');const self=render(ChatSpeechLines,{view:{lines:[{...line,messageId:'t',kind:'selftalk'}]},onAction:noop});assert.match(self,/To herself/);assert.match(self,/Answer/);assert.match(self,/Dismiss/);
 assert.match(render(ChatSpeechLines,{view:{lines:[line]},onAction:noop}),/She said this on the pet too/);assert.match(render(ChatSpeechLines,{view:{lines:[{...line,messageId:'x',mode:'dream'}]},onAction:noop}),/Sleep talk/);
 assert.equal(render(ChatSpeechLines,{view:{lines:[{...line,status:'read'}]},onAction:noop}),'');setLocale('zh-CN');
});

test('read lines stay in history with what you said next; the sidebar dot says who and how many (C8)',()=>{
 const lines=[{messageId:'a',text:'歇一会儿？',status:'read',at:100},{messageId:'b',text:'还在吗',status:'presented',at:300}],messages=[{role:'user',text:'先不了',createdAt:50},{role:'assistant',text:'好',createdAt:120},{role:'user',text:'好，歇一会儿',createdAt:150}];
 assert.deepEqual(speechHistory(lines,messages).map(row=>[row.line.messageId,row.reply,row.read]),[['a','好，歇一会儿',true],['b',null,false]]);
 setLocale('zh-CN');assert.deepEqual(galgameUnread({scope:{characterId:'deepseek'},lines}),{count:1,characterId:'deepseek',name:'DeepSeek',title:'DeepSeek 有 1 句话想跟你说'});assert.equal(galgameUnread({lines:[lines[0]]}),null);
 setLocale('en');assert.equal(galgameUnread({scope:{characterId:'claude'},lines:[lines[1],{...lines[1],messageId:'c'}]}).title,'Claude has 2 things to tell you');assert.equal(galgameUnread({scope:{characterId:'hunyuan'},lines:[lines[1]]}).title,'Hunyuan has 1 thing to tell you');setLocale('zh-CN');
});

test('the More menu lists what did not fit, with checked state for the pet (C6)',()=>{
 setLocale('en');const html=render(MoreMenu,{initialOpen:true,items:[{key:'history',icon:'clock',label:'History',onClick(){}},{key:'pet',icon:'paw',label:'Desktop pet',checked:true,onClick(){}},null]});
 assert.match(html,/data-toolbar-more="history pet"/);assert.match(html,/role="menu"/);assert.match(html,/role="menuitem"[^>]*data-more-item="history"/);assert.match(html,/role="menuitemcheckbox" aria-checked="true"[^>]*data-more-item="pet"/);assert.match(html,/>More</);
 assert.equal(render(MoreMenu,{items:[]}),'');setLocale('zh-CN');
});

test('Full text names the paragraphs, the time and a stop; it reads the kept partial text (C9)',async()=>{
 setLocale('zh-CN');const text='一\n\n二\n\n三',at=new Date(2026,9,29,21,42).getTime();
 assert.equal(fullTextLabel(text),'查看全文（3 段）');assert.equal(fullTextLabel('短'),'查看全文');
 assert.equal(fullMessageMeta({text,at,interrupted:true}),'21:42 · 3 段 · 已中断，保留了已生成的部分');assert.equal(fullMessageMeta({text:'x'}),'1 段');
 assert.match(render(FullMessageButton,{text,messageId:'m',name:'DeepSeek',interrupted:true}),/data-interrupted="true"[^>]*>查看全文（3 段）/);assert.equal(render(FullMessageButton,{text:'短',messageId:'m'}),'');
 setLocale('en');assert.equal(fullTextLabel(text),'Full text (3)');assert.equal(fullMessageMeta({text,at,interrupted:true}),clock(at)+' · 3 paragraphs · stopped, partial text kept');assert.equal(fullMessageMeta({text:'x'}),'1 paragraph');setLocale('zh-CN');
 const gal=await read('src/adapted/galgame-client.ts'),viewer=await read('src/full-message-viewer.mjs');
 // after a stop the button gets the kept text (liveText), not last.text, and says it was stopped
 assert.match(gal,/const fullText = stopped \? liveText : /);assert.match(gal,/interrupted: stopped \}/);assert.match(gal,/name: stopped \|\| last\?\.who === 'heroine' \? s\.name : undefined, at: fullAt/);
 assert.match(viewer,/t\('（这里中断了）'\)/);assert.match(viewer,/t\('已中断 · 不会自动续写'\)/);
 // one height rule for the box: 40% of the stage, the rest of the box measured by the page
 assert.ok(viewer.includes('max-height:var(--gx-line-room,3.1em)'));assert.doesNotMatch(viewer,/clamp\(70px,20vh,220px\)/);
 assert.match(gal,/root\.style\.setProperty\('--gx-stage-h'/);assert.match(gal,/root\.style\.setProperty\('--gx-dlg-rest'/);assert.match(gal,/root\.style\.setProperty\('--gx-pop-room'/);
});

test('private Galgame: toolbar in the approved order with More, thinking / paragraph / stop in the footer, reply reads her line (C6 / C8 / C9)',async()=>{
 const gal=await read('src/adapted/galgame-client.ts'),tools=gal.slice(gal.indexOf("'aria-label': t(\"Galgame 工具\")"),gal.indexOf('function stage()'));
 const at=label=>{const i=tools.indexOf(label);assert.ok(i>=0,label);return i;};
 assert.ok(at('t("背景图")')<at('t("角色立绘")')&&at('t("角色立绘")')<at('t("管理角色")')&&at('t("管理角色")')<at("t('我的身份')")&&at("t('我的身份')")<at('t("对话历史")')&&at('t("对话历史")')<at('t("CG 图鉴")')&&at('t("CG 图鉴")')<at('t("桌宠")')&&at('t("桌宠")')<at('React.createElement(MoodChip')&&at('React.createElement(MoodChip')<at("t('群聊')"));
 assert.match(tools,/toolsCollapsed \? \[React\.createElement\(MoreMenu/);assert.match(gal,/'data-fit': toolsCollapsed \? 'more' : 'full'/);assert.doesNotMatch(gal,/R95Toolbar|NativeSearchSources|R95SpeechLines/);
 assert.match(gal,/fill\(t\('\{name\} 正在想…'\), \{ name: s\.name \}\)/);assert.match(gal,/fill\(t\('第 \{n\} 段 · 正在说'\)/);assert.match(gal,/React\.createElement\('div', \{ className: 'gx-foot' \}, footStatus, React\.createElement\(MessageSources/);
 // the stopped note moved out of the line into the footer; Stop reply sits in the footer row
 assert.doesNotMatch(gal,/className:'gx-stopped'/);assert.match(gal,/stopButton,\s*\n?\s*fullText \?/);
 assert.match(gal,/say\(\{ text: t \}, t, shownSpeech\.current\?\.status === 'presented' \? shownSpeech\.current : null\)/);assert.match(gal,/if \(answered\?\.messageId\) void r95ClientRef\.current\('speech-read'/);
 assert.match(gal,/if \(page === 'galgame-reply'\)/);assert.equal(normalizeDashboardPage('galgame-reply'),'galgame');
 assert.match(gal,/if\(event\?\.type==='social\.updated'\)\{if\(event\.petMessageId\)notePetLine\(event\.petMessageId\)/);
});

test('group: mood, Auto and one Web control in the toolbar; the box keeps only the dialogue, the strip and Jump in (C6 / C9)',()=>{
 setLocale('zh-CN');const state={activeGroupId:'g',groups:[{id:'g',name:'G',memberIds:['claude','deepseek'],personaId:'default'}],characters:[{id:'claude',name:'Claude'},{id:'deepseek',name:'DeepSeek'}],personas:[],groupMessages:[],groupRuntime:{status:'generating',queue:['claude'],streaming:{text:'partial'},queuedUserMessages:1},r95:r95({auto:auto()})};
 const head=render(GroupHeader,{state,request(){},onBrowse(){},chat:{enabled:true},onToggleChat(){},r95Action:noop,onOpenSocial(){}});
 assert.match(head,/role="toolbar"[^>]*>.*data-chat-toolbar="group".*心情 · 平静.*data-r95-auto-menu="true".*第 2 \/ 6 轮/);assert.match(head,/data-galgame-net="true"[^>]*><button[^>]*aria-label="联网"/);assert.doesNotMatch(head,/联网群聊/);
 assert.match(render(GroupHeader,{state:{...state,r95:undefined},request(){},onBrowse(){},chat:{enabled:true},onToggleChat(){}}),/data-group-net="true"[^>]*>.*联网群聊/,'without the r95 view the old switch stays');
 const box=render(CompanionGroupDialogue,{state,request:async()=>({}),chat:{enabled:true}});
 assert.doesNotMatch(box,/data-r95-toolbar|data-chat-toolbar|data-r95-auto-menu/);assert.match(box,/data-auto-strip="g"/);assert.match(box,/下一位 DeepSeek/);assert.match(box,/你的消息排在她后面/);assert.match(box,/placeholder="插一句…（Auto 进行中也可以说话）"/);assert.match(box,/插话<\/button>/);assert.doesNotMatch(box,/data-group-round/,'while Auto runs the strip replaces the manual round row');
 const idle={...state,groupRuntime:{status:'idle',currentMessage:{id:'m',role:'assistant',characterId:'claude',text:'一\n\n二',nativeSearch:{status:'completed',sources:[{url:'https://example.com/a',title:'A'}]}}},r95:r95()};
 const done=render(CompanionGroupDialogue,{state:idle,request:async()=>({}),chat:{enabled:true}});assert.match(done,/class="gx-foot".*data-r95-search-sources="m".*查看全文（2 段）/);assert.doesNotMatch(done,/data-auto-strip/);
 setLocale('en');const enBox=render(CompanionGroupDialogue,{state,request:async()=>({}),chat:{enabled:true}});assert.match(enBox,/Jump in… \(you can talk during Auto\)/);assert.match(enBox,/Yours is next/);setLocale('zh-CN');
});

test('sidebar dot, kept lines on the pet, pet line notice and plugin detail are wired in the main process (C8 / C11)',async()=>{
 const dashboard=await read('src/dashboard.mjs'),main=await read('src/main.mjs'),broker=await read('src/buddy-plugin-services/social-plugin-broker.mjs'),css=await read('src/workspace.css');
 assert.match(dashboard,/const unread=useGalgameUnread\(\),navDot=id=>id==='galgame'&&!settings\?\.safeMode\?unread:null;/);assert.match(dashboard,/navDot\(id\)&&h\('i',\{className:'nav-dot',role:'img','aria-label':navDot\(id\)\.title/);assert.match(css,/nav button>\.nav-dot\{/);
 const speech=main.slice(main.indexOf('onSpeech:'),main.indexOf('onSleepIntent:'));assert.match(speech,/\(panel\.isVisible\(\)\|\|petShown\)\)panel\.webContents\.send\('game:output',\{type:'social\.updated',\.\.\.\(petShown\?\{petMessageId:value\.messageId\}:\{\}\)\}\)/);
 assert.match(main,/if\(visible\)\{pet\.showInactive\(\);if\(greet\)triggerPet\('wave','show'\);void deliverKeptLine\(\);\}/);assert.match(main,/petState\.characterId===view\.scope\?\.characterId\)petEvent\(\{kind:'social-line',value:\{\.\.\.line,scope:view\.scope\}\}\)/);
 assert.match(main,/fullness:feeding\?\.hunger\?\.satiety,canFeed/);
 assert.match(broker,/\.\.\.\(typeof payload\.detail==='string'&&payload\.detail\.trim\(\)\?\{detail:payload\.detail\.trim\(\)\.slice\(0,120\)\}:\{\}\)/);
});

test('pet bubbles: kind and time with an icon, quieter self-talk, plugin icon and its own detail line (C8 / C11)',async()=>{
 const {bubbleView,bubbleClock}=await import('../src/pet-badge.mjs'),at=new Date(2026,9,29,21,40).getTime();
 assert.deepEqual(bubbleView({source:'social-line',mode:'proactive',text:'歇五分钟？',at}),{kind:'say',speech:'proactive',tagIcon:'chats',name:'主动来找你 · 21:40',title:'歇五分钟？'});
 assert.equal(bubbleView({source:'social-line',mode:'selftalk',text:'x',at}).speech,'selftalk');assert.equal(bubbleView({source:'social-line',mode:'dream',text:'x'}).name,'梦话');
 assert.deepEqual(bubbleView({source:'plugin',pluginId:'ai-buddy.bilibili-companion',text:'看完了',detail:' 写了一条\n评论草稿 '}),{kind:'say',name:'B站陪伴',tagIcon:'tv',title:'看完了',detail:'点一下打开 · 写了一条 评论草稿'});
 assert.equal(bubbleView({source:'plugin',pluginId:'qq-connect',text:'x'}).tagIcon,'chats');assert.equal(bubbleView({source:'plugin',pluginId:'other',text:'x',detail:'d'.repeat(300)}).detail.length,'点一下打开 · '.length+120);
 const en=bubbleView({source:'social-line',mode:'selftalk',text:'x',at},{language:'en'});assert.equal(en.name,'To herself · '+bubbleClock(at,'en'));assert.doesNotMatch(bubbleView({source:'plugin',pluginId:'bilibili',text:'x',detail:'drafted a comment'},{language:'en'}).detail,han);
 const pet=await read('src/pet.mjs'),html=await read('src/pet.html');
 assert.match(pet,/make\(t\('回她',preferences\.language\),\(\)=>window\.whale\.open\('galgame-reply'\),true\)/);assert.match(pet,/make\(t\('接一句',preferences\.language\),\(\)=>window\.whale\.open\('galgame-reply'\)\)/);assert.match(pet,/preferences\.language==='en'\?'Dismiss':t\('收起',preferences\.language\)/);
 assert.match(pet,/bubbleBox\.append\(actions\);fitSocialBubble\(\);/);assert.match(pet,/if\(bubbleBox\.getBoundingClientRect\(\)\.bottom>petHeadTop\(\)-2\)bubble\.dataset\.tight=''/);assert.match(pet,/fillBubble\(\{source:'plugin',pluginId:value\.pluginId,text:value\.title,detail:value\.detail\?t\(value\.detail,preferences\.language\):value\.detail\}\)/);
 const style=html.slice(html.indexOf('approved designs C8 / C11'),html.indexOf('</style>'));assert.match(style,/\.bubble\[data-speech=selftalk\] \.bubble-box/);assert.match(style,/\.bubble\[data-tight\] \.bubble-box\{display:grid/);assert.doesNotMatch(style,/#[0-9a-f]{3,8}\b|rgba?\(/i);
});

test('pet menu: Feed names her fullness; Recent plugin messages shows how many (C11, native menu covered here)',async()=>{
 const {petContextTemplate}=await import('../src/pet-menu.mjs'),base={open(){},sleep(){},wake(){},setStatusBadge(){},hidePet(){}};
 const menu=petContextTemplate({...base,foods:[{id:'pudding',label:'小布丁 ×2'}],feedTarget:'DeepSeek',fullness:71.6,recent:[{pluginId:'a',title:'1'},{pluginId:'b',title:'2'}]});
 assert.equal(menu.find(item=>item.label==='投喂').submenu[0].label,'喂 DeepSeek · 饱食 72');assert.ok(menu.some(item=>item.label==='最近的插件消息 · 2'));
 assert.equal(petContextTemplate({...base,foods:[{id:'pudding',label:'小布丁'}],feedTarget:'DeepSeek'}).find(item=>item.label==='投喂').submenu[0].label,'喂给 DeepSeek','unknown fullness keeps the old title');
 const en=petContextTemplate({...base,language:'en',foods:[{id:'pudding',label:'Pudding'}],feedTarget:'Claude',fullness:30,recent:[{pluginId:'a',title:'x'}]});assert.equal(en.find(item=>item.label==='Feed').submenu[0].label,'Feed Claude · fullness 30');assert.ok(en.some(item=>item.label==='Recent plugin messages · 1'));for(const language of ['zh-CN','en']){const empty=petContextTemplate({...base,language,foods:[],feedTarget:'DeepSeek',fullness:30});assert.deepEqual(empty.find(item=>item.label===(language==='en'?'Feed':'投喂')).submenu.map(item=>item.label),[language==='en'?'Buy in shop…':'去商店买…']);}
});

test('restart unknown Auto exposes explicit next-member recovery in both languages',()=>{
 for(const language of ['zh-CN','en']){setLocale(language);const value=r95({auto:auto({status:'paused',pending:{requestId:'unknown-request',characterId:'claude',status:'unknown'}})});const label=language==='en'?'Continue with the next member':'从下一位继续';
 const panel=render(GroupAutoPanel,{view:value,onAction:noop,nameOf}),strip=render(AutoRoundStrip,{view:value,onAction:noop,nameOf});assert(panel.includes(label));assert(strip.includes(label));assert.doesNotMatch(panel,/<button[^>]*disabled[^>]*>[^<]*Continue with the next member/);
 assert.match(panel,language==='en'?/The previous turn did not finish/:/上一轮没有完成/);}
 setLocale('zh-CN');
});
