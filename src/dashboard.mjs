import {t,setLocale,localizedTitle} from './i18n.mjs';
import {applyAppearance} from './appearance.mjs';
import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {GalgameApp,GalgameCSS} from './adapted/galgame-client.ts';
import {GeneralSettings} from './general-settings.mjs';
import {formatActivityTime} from './preferences.mjs';
import {ActionGallery} from './action-gallery.mjs';
import {TokenSettings} from './token-settings.mjs';
import {TOOL_NAMES,PROVIDER_NAMES,providerLabel,providerFor} from './token-types.mjs';
import {ApiSettings} from './api-settings.mjs';
import {AnalyticsPage} from './analytics-ui.mjs';
import {APP_NAME,PANEL_TITLE,APP_ICON_PNG} from './app-brand.mjs';
// Keep native caption controls and their safe area outside the scrolling app.
const overlay=navigator.windowControlsOverlay;
function syncWindowChrome(){document.documentElement.classList.toggle('desktop-titlebar',!!overlay?.visible);}
overlay?.addEventListener('geometrychange',syncWindowChrome);syncWindowChrome();
const h=React.createElement;
const fmt=n=>new Intl.NumberFormat('en-US').format(n || 0);
const compact=n=>n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':fmt(n);
const labels={get running(){return t("运行中")},get waiting(){return t("等待回应")},get completed(){return t("已完成")},get failed(){return t("日志错误")},get paused(){return t("已中断")},get unknown(){return t("状态未知")}};
const names=TOOL_NAMES;
const totalOf=row=>Object.values(row||{}).filter(v=>v&&typeof v==='object'&&typeof v.total==='number').reduce((n,u)=>n+u.total,0);
function App(){
 const [data,setData]=useState(null),[page,setPage]=useState(location.hash.slice(1)==='sessions'?'overview':location.hash.slice(1)||'overview'),[chat,setChat]=useState({enabled:false}),[query,setQuery]=useState(''),[filter,setFilter]=useState('all'),[vendor,setVendor]=useState('all'),[purpose,setPurpose]=useState('all'),[source,setSource]=useState('all'),[chosen,setChosen]=useState(null),[date,setDate]=useState('');
 const [settings,setSettings]=useState(null),[settingsError,setSettingsError]=useState('');
 setLocale(settings?.preferences.language||'zh-CN');
 useEffect(()=>{const title=localizedTitle();document.title=title;const node=document.querySelector('.window-titlebar span');if(node)node.textContent=title;},[settings?.preferences.language]);
 const [character,setCharacter]=useState('deepseek');
 useEffect(()=>{applyAppearance(settings?.preferences,character);},[settings?.preferences.theme,settings?.preferences.themeMode,character]);
 const [apiTab,setApiTab]=useState('model');
 const [attributionSource,setAttributionSource]=useState(null);
 const manage=type=>{setApiTab(type);setPage('api');};
 useEffect(()=>{window.whale.game('view',{}).then(v=>setCharacter(v.current)).catch(()=>{});window.whale.status().then(setData);window.whale.chatStatus().then(setChat);window.whale.settings().then(setSettings).catch(e=>setSettingsError(e.message));const a=window.whale.onUpdate(setData),b=window.whale.onPage(p=>setPage(p==='sessions'?'overview':p)),c=window.whale.onSettings(setSettings);return()=>{a();b();c();};},[]);
 const time=value=>formatActivityTime(value,settings?.preferences.displayTimeZone||'America/New_York');
 useEffect(()=>{window.scrollTo(0,0);document.querySelector('.content')?.scrollTo(0,0);},[page]);
 const toggleChat=async()=>{try{setChat(await window.whale.chat(!chat.enabled));setSettingsError('');}catch(error){setSettingsError(error.message);}};
 useEffect(()=>{if(settings?.modelConnections)setChat(settings.modelConnections);},[settings]);
 const nav=[['overview','◌',t("工作概览")],['projects','▦',t("项目用量")],['history','◷',t("历史统计")],['galgame','♡','Galgame'],['actions','✺',t("动作展示")],['api','⇄',t("API 配置")],['tokens','◎',t("Token 检测")],['settings','⚙',t("通用设置")]];
 let content;
 if(['overview','history','projects'].includes(page))content=h(AnalyticsPage,{page,settings,revision:data?.usageRevision,onManage:manage,onSaved:setSettings,monitor:data,onAttribution:id=>{setAttributionSource(id);setPage('tokens');}});
 else if(page==='settings')content=settings?h(GeneralSettings,{view:settings,onSaved:setSettings,onPage:setPage,onManage:manage}):h('p',{className:'settings-error',role:'alert'},settingsError||t("正在读取设置…"));
 else if(page==='tokens')content=h(TokenSettings,{sourceId:attributionSource,timeZone:settings?.preferences.statisticsTimeZone});
 else if(page==='api')content=h(ApiSettings,{view:settings,tab:apiTab,onTab:setApiTab});
 else if(page==='actions')content=h(ActionGallery,{settings});
 else content=h('div',{className:'game-shell'},h('div',{className:'game-mode'},h('span',null,chat.enabled?t("联网聊天已开启 · ")+t(chat.name)+' · '+chat.model:t("离线模式 · ")+(t(chat.name)||t("尚未选择模型"))),h('button',{className:chat.enabled?'':'accent',onClick:toggleChat},chat.enabled?t("关闭联网聊天"):t("开启联网聊天")),h('button',{onClick:()=>manage('model')},t("配置模型"))),settingsError&&h('p',{className:'settings-error',role:'alert'},settingsError),h('style',null,GalgameCSS),h(GalgameApp,{variant:'tab',useSessions:null,hideSpriteOnCg:settings?.preferences.hideSpriteOnCg,onCharacter:setCharacter}));
 const actionsPage=page==='actions',galgamePage=page==='galgame',hideDiagnostics=actionsPage||galgamePage||['overview','projects','history'].includes(page);
 return h('div',{className:'layout'+(actionsPage?' actions-page':'')+(galgamePage?' galgame-page':'')},
   h('aside',null,h('div',{className:'brand'},h('div',{className:'brand-mark'},h('img',{src:'./assets/branding/app.png',alt:'',width:35,height:35})),h('div',null,h('strong',null,settings?.preferences.language==='en'?'AI Buddy':'AI 酱'),h('small',null,'AI Buddy'))),
     h('nav',null,...nav.map(([id,icon,name])=>h('button',{key:id,className:page===id?'active':'',onClick:()=>{setPage(id);setChosen(null);}},h('span',null,icon),name))),
     !actionsPage&&h('div',{className:'sidebar-bottom'},h('span',{className:'offline-dot'}),t("离线监控"),h('small',null,t("本机数据 · 零模型调用")))),
   h('main',null,!actionsPage&&h('header',null,h('span',null,t("你的本地工作空间")),h('div',null,h('span',{className:'live-pill'},data?.indexing?(data.indexPhase==='checking'?t("核对新增记录…"):t("整理历史记录…")):t("● 监控中")),h('span',{className:'header-date'},data?.today||''))),
     h('div',{className:'content'},!hideDiagnostics&&data?.indexing&&h('div',{className:'index-banner'},(data.indexPhase==='checking'?t("正在核对新增记录 · 已检查 "):t("正在建立本地历史索引 · 已读取 "))+(data.progress?.scanned||0)+' / '+(data.progress?.total||'—')+t(" 个文件。完成前用量为部分结果。")),
       !hideDiagnostics&&data?.missingRequests>0&&h('p',{className:'settings-note'},data.missingRequests+t(" 条请求缺少完整用量，合计为已记录部分。")),!hideDiagnostics&&!data&&h('p',null,t("正在读取本地记录…")),content,
       !hideDiagnostics&&data?.errors?.length>0&&h('details',{className:'read-errors'},h('summary',null,data.errors.length+t(" 个日志读取问题")),...data.errors.slice(0,10).map(e=>h('p',{key:e.path},e.path+' · '+e.message))))));
}
createRoot(document.getElementById('app')).render(h(React.Fragment,null,
  h('div',{className:'window-titlebar'},h('img',{src:'./'+APP_ICON_PNG,alt:'',draggable:false}),h('span',null,PANEL_TITLE)),h(App)));

