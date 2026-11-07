import {t,setLocale,localizedTitle,locale} from './i18n.mjs';
import {applyAppearance,themeAsset} from './appearance.mjs';
import {Icon} from './ui-icons.mjs';
import {StatusPill} from './ui-controls.mjs';
import React,{useState,useEffect,useRef,useCallback} from 'react';
import {createRoot} from 'react-dom/client';
import {GalgameApp,GalgameCSS} from './adapted/galgame-client.ts';
import {GeneralSettings} from './general-settings.mjs';
import {formatActivityTime} from './preferences.mjs';
import {ActionGallery} from './action-gallery.mjs';
import {SafeModePage} from './safe-mode-page.mjs';
import {TokenSettings} from './token-settings.mjs';
import {TOOL_NAMES,PROVIDER_NAMES,providerLabel,providerFor} from './token-types.mjs';
import {ApiSettings} from './api-settings.mjs';
import {AnalyticsPage} from './analytics-ui.mjs';
import {APP_ICON_PNG} from './app-brand.mjs';
import {CommunityCenter as PluginCenter,hostComponentIntent} from './community-center.mjs';
import {DataImportPanel} from './data-import-ui.mjs';
import {R95CorePage} from './r95-core-page.mjs';
import {normalizeDashboardPage} from './dashboard-pages.mjs';
import {pluginClientResult} from './plugin-client-result.mjs';
import {pluginResult} from './plugin-center-helpers.mjs';
import {petCharacterName} from './pet-characters.mjs';
import {EmbedBar,EmbedArea,useEmbedState,embedView,embedName,embedPill,startEmbedCover} from './plugin-embed-page.mjs';
import {EMBED_TARGETS,embedCapable,embedTargetFor,embedSlotKind,pluginPageEntries} from './plugin-embed-targets.mjs';
import {SocialLoginRequest} from './social-login-ui.mjs';
import {createSocialLoginRequests} from './social-login-requests.mjs';
import {PageBoundary} from './page-boundary.mjs';
import {useGalgameUnread} from './chat-r95-ui.mjs';
import {useVoiceOutput} from './voice/client.mjs';
// Keep native caption controls and their safe area outside the scrolling app.
const overlay=navigator.windowControlsOverlay;
function syncWindowChrome(){document.documentElement.classList.toggle('desktop-titlebar',!!overlay?.visible);}
overlay?.addEventListener('geometrychange',syncWindowChrome);syncWindowChrome();
// Paint the first frame in the resolved theme the main process passed along (?theme=).
const initialTheme=new URLSearchParams(location.search).get('theme');if(initialTheme)applyAppearance({theme:initialTheme,themeMode:'fixed'});
const h=React.createElement;
const fmt=n=>new Intl.NumberFormat('en-US').format(n || 0);
const compact=n=>n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':fmt(n);
const labels={get running(){return t("运行中")},get waiting(){return t("等待回应")},get completed(){return t("已完成")},get failed(){return t("日志错误")},get paused(){return t("已中断")},get unknown(){return t("状态未知")}};
const names=TOOL_NAMES;
const totalOf=row=>Object.values(row||{}).filter(v=>v&&typeof v==='object'&&typeof v.total==='number').reduce((n,u)=>n+u.total,0);
// Work tasks entry (approved design A3): one card per plugin state; installing, enabling and opening keep the plugin host's own checks.
// Installed, enabled and not mid-close: the work page itself shows here (approved design G4).
const workReady=state=>!!state?.installed&&!!state.enabled&&!['closing-idle','stop-unconfirmed'].includes(state.state);
function WorkTasks({onCommunity,onStatus,face,renderEmbedded}){const [state,setState]=useState(null),[error,setError]=useState(null),[pending,setPending]=useState(false);useEffect(()=>{let active=true;const refresh=()=>window.whale.work.status().then(value=>active&&setState(value),e=>active&&setError({message:e.message,code:e.code}));void refresh();const remove=window.whale.plugins.onUpdate(refresh);return()=>{active=false;remove();};},[]);
 useEffect(()=>{if(state)onStatus?.({work:{installed:!!state.installed,enabled:!!state.enabled,jobs:(state.jobs??[]).length,ready:workReady(state)}});},[state]);
 const open=async()=>{setPending(true);setError(null);try{pluginClientResult(await window.whale.work.open());}catch(e){setError({message:e.message,code:e.code});}finally{setPending(false);}};
 const enable=async()=>{setPending(true);setError(null);try{pluginResult(await window.whale.plugins.action({action:'dsh-enable',packageKey:state.packageKey}));setState(await window.whale.work.status());}catch(e){setError({message:e.message,code:e.code});}finally{setPending(false);}};
 const icon=on=>h('span',{className:'work-entry-ico'+(on?' on':'')},Icon('nav-work',{size:22}));
 const top=(mark,title,sub,pill)=>h('div',{className:'work-entry-top'},mark,h('div',null,h('b',{className:'work-entry-t'},title),h('small',null,sub)),pill);
 const technical=code=>code&&h('details',{className:'work-entry-tech'},h('summary',null,t('技术详情')),h('code',null,code));
 const failure=error&&h('div',{className:'ui-alert warn',role:'alert'},Icon('alert',{size:16}),h('div',null,h('b',null,t('工作窗口没有打开')),h('p',null,error.message),technical(error.code)));
 let body;
 if(!state)body=h(React.Fragment,null,h('div',{className:'work-entry-loading',role:'status'},h('span',{className:'ui-spinner','aria-hidden':true}),t('正在读取插件状态…')),h('span',{className:'ui-skel','aria-hidden':true,style:{height:14,width:'60%'}}),h('span',{className:'ui-skel','aria-hidden':true,style:{height:14,width:'40%'}}));
 else if(!state.installed)body=h(React.Fragment,null,top(h('img',{className:'work-entry-face',src:face,alt:''}),t('装上「工作与协作」，让角色帮你做项目'),t('官方插件 · 安装后不会自动启用')),
  h('ul',{className:'work-entry-list'},...[['nav-work',t('按项目整理工作：选一个文件夹，任务和记录都归到这个项目下')],['users',t('几位角色一起做一件事，主 Agent 分工，你看得到每一步')],['shield',t('每次都先给你看计划，你批准了才开始改文件')]].map(([i,text])=>h('li',{key:i},Icon(i,{size:18}),h('span',null,text)))),
  h('div',{className:'ws-row-btns'},h('button',{type:'button',className:'ui-btn primary',onClick:()=>onCommunity({install:'@ai-buddy/work-collaboration'})},Icon('download',{size:16}),t('查看安装计划')),h('button',{type:'button',className:'ui-btn ghost',onClick:()=>onCommunity({})},t('在扩展中心查看'))),
  h('p',{className:'work-entry-note'},t('你原来的工作记录和人生存档都还在。装好并启用后，可以在插件里核对后迁入。')));
 else if(!state.enabled)body=h(React.Fragment,null,top(icon(false),t('「工作与协作」已停用'),(state.version??'')+' · '+t('已安装。停用期间不会运行任何任务，记录都保留。'),h(StatusPill,{tone:'idle'},t('已停用'))),
  failure,h('div',{className:'ws-row-btns'},h('button',{type:'button',className:'ui-btn primary',disabled:pending||!state.packageKey,onClick:enable},pending?t('正在启用…'):t('启用工作与协作')),h('button',{type:'button',className:'ui-btn ghost',onClick:()=>onCommunity({tab:'installed'})},t('在扩展中心管理'))));
 else if(state.state==='closing-idle')body=h(React.Fragment,null,top(icon(true),t('工作与协作'),state.version??''),h('div',{className:'ws-row-btns'},h('button',{type:'button',className:'ui-btn primary','aria-disabled':true,disabled:true},h('span',{className:'ui-spinner','aria-hidden':true}),t('正在打开工作区…'))),h('p',{className:'work-entry-note'},t('上一个工作窗口正在安全关闭，关好后自动打开。')));
 else if(state.state==='stop-unconfirmed')body=h(React.Fragment,null,top(icon(false),t('工作与协作'),state.version??''),h('div',{className:'ui-alert warn',role:'status'},Icon('alert',{size:16}),h('div',null,h('b',null,t('上次关闭还没确认完成')),h('p',null,t('等它结束后再试一次，不会丢失任务。')),technical('stop-unconfirmed'))),h('div',{className:'ws-row-btns'},h('button',{type:'button',className:'ui-btn primary',disabled:pending,onClick:open},Icon('refresh',{size:16}),t('再试一次'))));
 else{const jobs=(state.jobs??[]).length;body=h(React.Fragment,null,top(icon(true),t('工作与协作'),(state.version??'')+' · '+t('在单独的窗口里打开'),jobs?h(StatusPill,{tone:'busy'},t('{n} 个任务进行中').replace('{n}',jobs)):h(StatusPill,{tone:'ok'},t('可以打开'))),
  failure,h('div',{className:'ws-row-btns'},h('button',{type:'button',className:'ui-btn primary',disabled:pending||state.state==='loading',onClick:open},pending||state.state==='loading'?h('span',{className:'ui-spinner','aria-hidden':true}):Icon('external',{size:16}),pending||state.state==='loading'?t('正在打开工作区…'):t('打开工作与协作'))));}
 if(renderEmbedded&&workReady(state))return renderEmbedded();
 return h('div',{className:'ws-page work-entry'},h('div',{className:'ws-page-head'},h('div',null,h('h2',{className:'ws-ptitle'},t('工作任务')),h('p',{className:'ws-meta'},t('项目、工作任务和引擎历史都由「工作与协作」插件管理。')))),h('section',{className:'ws-card work-entry-card'},body));}
const OFFICIAL_PLUGIN_NAMES={'@ai-buddy/qq-connect':'QQ连接','@ai-buddy/bilibili-companion':'B站陪伴','@ai-buddy/work-collaboration':'工作与协作'};
const pluginDisplayName=record=>OFFICIAL_PLUGIN_NAMES[record.packageName]?t(OFFICIAL_PLUGIN_NAMES[record.packageName]):record.displayName??record.name??record.packageName;
// A2: what each installed plugin is doing now: account connection for QQ / Bilibili, running tasks for Work, and its latest activity today.
const SOCIAL_STATUS={'@ai-buddy/qq-connect':{on:'已连接 · 只回复允许的人',setup:'已连接 · 还没完成设置',none:'还没连接账号'},'@ai-buddy/bilibili-companion':{on:'已连接 · 可以发评论',setup:'已连接 · 还没完成设置',none:'还没连接账号'}};
function pluginStatusRow(record,{accounts=null,activity=null,work=null,now=Date.now()}={}){
 if(!record.enabled)return ['off',t('已停用')];if(record.runtimeFailure||record.runtimeState==='failed')return ['warn',t('加载失败')];
 const loading=!record.runtimeVerified,social=SOCIAL_STATUS[record.packageName];let dot=loading?'busy':'ok',text=t('运行中');
 if(social&&Array.isArray(accounts)){const account=accounts.find(row=>row.pluginId===record.packageName&&row.enabled);text=t(account?account.activityApprovalRequired?social.setup:social.on:social.none);if(account?.activityApprovalRequired||!account&&record.packageName==='@ai-buddy/qq-connect')dot='warn';}
 else if(record.packageName==='@ai-buddy/work-collaboration'&&work){text=work.jobs?t('{n} 个任务进行中').replace('{n}',work.jobs):t('没有进行中的任务');if(work.jobs&&!loading)dot='busy';}
 const recent=activity?.[record.pluginId];if(recent?.title&&new Date(recent.at).toDateString()===new Date(now).toDateString())text+=' · '+t('最近：{title}').replace('{title}',recent.title);
 return [dot,loading?t('加载中')+' · '+text:text];
}
const EMBED_FOOT={waiting:{any:'插件正在处理另一项操作，空闲后会自动重试。'},run:{any:'在独立沙盒里运行'},start:{any:'等 DSH 后台准备好'},off:{bilibili:'停用期间不观看、不发评论',qq:'停用期间不回复消息',any:'停用期间不会运行'},err:{any:'DSH 后台没有响应'},none:{any:'重新安装后接着用原来的记录'},popped:{any:'在单独窗口里运行'},unsupported:{any:'更新到 2.0.1 后可以放进主窗口'}};
// Sidebar footer (approved design A2): one honest line per page instead of a fixed "zero model calls".
function SidebarStatus({page,status,character,settings,chat,onPage,activity}){
 const [open,setOpen]=useState(false),[plugins,setPlugins]=useState(null),[accounts,setAccounts]=useState(null),box=useRef(null);
 useEffect(()=>{if(!open)return;let alive=true;window.whale.plugins.action({action:'community-status'}).then(value=>{if(alive)setPlugins(pluginResult(value)?.dsh?.installed??[]);},()=>alive&&setPlugins([]));window.whale.plugins.action({action:'social-accounts-list'}).then(value=>{if(alive)setAccounts(pluginResult(value)?.accounts??[]);},()=>{});const away=e=>{if(!box.current?.contains(e.target))setOpen(false);},key=e=>{if(e.key==='Escape')setOpen(false);};document.addEventListener('pointerdown',away);document.addEventListener('keydown',key);return()=>{alive=false;document.removeEventListener('pointerdown',away);document.removeEventListener('keydown',key);};},[open]);
 let name=character;try{name=petCharacterName(character);}catch{}
 const connections=settings?.modelConnections,active=connections?.profiles?.find(p=>p.id===connections.activeId);
 let tone='ok',line,sub;
 if(page==='galgame'||page==='safe-mode'){line=t('陪伴中 · {name}').replace('{name}',name);sub=active?t('全局默认连接：{name}').replace('{name}',active.name):t('还没有选聊天连接');if(!active)tone='warn';}
 else if((page==='r95-shop'||page==='r95-inventory')&&status.feeding){line=t('积分 {n}').replace('{n}',status.feeding.points);sub=t('{name} 饱食 {n} / 100').replace('{name}',name).replace('{n}',status.feeding.fullness);}
 else if(page==='r95-social'&&status.social){line=status.social.proactive?t('主动行为已开启'):t('主动行为已关闭');sub=status.social.quiet?t('免打扰 · 开'):t('免打扰 · 关');if(!status.social.proactive)tone='off';}
 else if(page==='agent-tasks'&&status.work){const w=status.work;if(!w.installed){tone='off';line=t('工作与协作未安装');sub=t('安装后在这里打开');}else if(!w.enabled){tone='off';line=t('工作与协作已停用');sub=t('停用期间不会运行任务');}else{if(w.jobs)tone='busy';line=w.jobs?t('工作与协作 · {n} 个任务进行中').replace('{n}',w.jobs):t('工作与协作 · 没有进行中的任务');sub=t('按每个任务绑定的引擎调用模型');}}
 else if(page.startsWith('plugin-')&&status.embed?.target&&EMBED_TARGETS[status.embed.target].page===page){const {target,view}=status.embed,[pill,label]=embedPill(view);tone={ok:'ok',busy:'busy',err:'warn',warn:'warn',info:'busy'}[pill]??'off';line=embedName(target)+' · '+t(label);sub=t(EMBED_FOOT[view]?.[target]??EMBED_FOOT[view]?.any??'');}
 else if(page==='plugins'&&status.plugins){line=t('已装 {n} 个插件').replace('{n}',status.plugins.installed);sub=status.plugins.updates==null?t('还没检查更新'):status.plugins.updates?t('{n} 个可以更新').replace('{n}',status.plugins.updates):t('都是最新版本');if(status.plugins.updates)tone='warn';}
 else{line=t('本机监控');sub=t('只读本机日志，不调用模型');}
 // footer lines and status rows keep their full text on hover (both are cut off when long)
 const row=(dot,label,value,key)=>h('div',{className:'side-status-row',key,title:label+' · '+value},h('span',null,h('span',{className:'offline-dot '+dot}),label),h('small',null,value));
 return h('div',{className:'side-status',ref:box},
  open&&h('div',{className:'side-status-pop',role:'dialog','aria-label':t('现在在做什么')},h('b',null,t('现在在做什么')),row('ok',t('本机监控'),t('运行中 · 不调用模型'),'monitor'),row(chat?.enabled?'ok':'off',t('联网聊天'),chat?.enabled?t('开'):t('关'),'chat'),
   plugins===null?h('small',{role:'status'},t('正在读取插件状态…')):plugins.map(record=>{const [dot,label]=pluginStatusRow(record,{accounts,activity,work:status.work});return row(dot,pluginDisplayName(record),label,record.packageKey);}),
   h('button',{type:'button',className:'ui-btn ghost sm',onClick:()=>{setOpen(false);onPage('plugins');}},t('打开扩展中心'))),
  h('button',{type:'button',className:'sidebar-bottom','aria-expanded':open,'aria-label':line+' · '+sub+' · '+t('查看现在在做什么'),title:line+'\n'+sub,onClick:()=>setOpen(value=>!value)},h('b',null,h('span',{className:'offline-dot '+tone}),h('span',{className:'side-status-line'},line)),h('small',null,sub)));
}
function App(){
 useVoiceOutput();
 const [data,setData]=useState(null),[page,setPage]=useState(normalizeDashboardPage(location.hash.slice(1))),[chat,setChat]=useState({enabled:false}),[query,setQuery]=useState(''),[filter,setFilter]=useState('all'),[vendor,setVendor]=useState('all'),[purpose,setPurpose]=useState('all'),[source,setSource]=useState('all'),[chosen,setChosen]=useState(null),[date,setDate]=useState('');
 const [settings,setSettings]=useState(null),[settingsError,setSettingsError]=useState('');
 setLocale(settings?.preferences.language||'zh-CN');
 useEffect(()=>{document.title=localizedTitle();},[settings?.preferences.language]);
 const [character,setCharacter]=useState('deepseek'),[gameMode,setGameMode]=useState('private');
 useEffect(()=>{applyAppearance(settings?.preferences,character);},[settings?.preferences.theme,settings?.preferences.themeMode,character]);
 const [apiTab,setApiTab]=useState('model');
 const [attributionSource,setAttributionSource]=useState(null);
 const manage=type=>{setApiTab(type);setPage('api');};
 useEffect(()=>{window.whale.game('view',{}).then(v=>{if(v?.current)setCharacter(v.current);}).catch(()=>{});window.whale.status().then(setData);window.whale.chatStatus().then(setChat);window.whale.settings().then(setSettings).catch(e=>setSettingsError(e.message));const a=window.whale.onUpdate(setData),b=window.whale.onPage(p=>setPage(normalizeDashboardPage(p))),c=window.whale.onSettings(setSettings);const hashChanged=()=>setPage(normalizeDashboardPage(location.hash.slice(1)));window.addEventListener('hashchange',hashChanged);return()=>{a();b();c();window.removeEventListener('hashchange',hashChanged);};},[]);
 const time=value=>formatActivityTime(value,settings?.preferences.displayTimeZone||'America/New_York');
 useEffect(()=>{window.scrollTo(0,0);document.querySelector('.content')?.scrollTo(0,0);},[page]);
 const toggleChat=async()=>{try{setChat(await window.whale.chat(!chat.enabled));setSettingsError('');}catch(error){setSettingsError(error.message);}};
 useEffect(()=>{if(settings?.modelConnections)setChat(settings.modelConnections);},[settings]);
 // Three groups (approved design A1). Shop and backpack are one page with two tabs, so one entry lit on both.
 // English uses the design's short sidebar names (A1); the page titles keep their longer ones.
 const nav=(zh,en)=>locale()==='en'?en:t(zh);
 const navGroups=[[nav('工作','Work'),[['overview','nav-overview',nav('工作概览','Overview')],['projects','nav-usage',nav('项目用量','Projects')],['history','nav-history',nav('历史统计','History')],['agent-tasks','nav-work',nav('工作任务','Work tasks')]]],[nav('陪伴','Companion'),[['galgame','nav-galgame','Galgame'],['r95-shop','nav-shop',nav('商店与背包','Shop & backpack')],['r95-social','nav-social',nav('社交与心情','Social & mood')],['actions','nav-actions',nav('动作展示','Actions')]]],[nav('系统','System'),[['plugins','nav-plugins',nav('扩展中心','Extensions')],['api','nav-api',nav('API 配置','API')],['tokens','nav-token',nav('Token 检测','Token check')],['settings','nav-settings',nav('通用设置','Settings')]]]];
 const navOn=id=>page===id||id==='galgame'&&page==='safe-mode'||id==='r95-shop'&&page==='r95-inventory';
 const [shellStatus,setShellStatus]=useState({}),reportStatus=useCallback(patch=>setShellStatus(value=>({...value,...patch})),[]);
 const [communityIntent,setCommunityIntent]=useState(null);
 const toCommunity=intent=>{setCommunityIntent({...intent,at:Date.now()});setPage('plugins');};
 // Approved design C8: while she has an unread line, Galgame in the sidebar shows a dot; hover says who and how many.
 const unread=useGalgameUnread(),navDot=id=>id==='galgame'&&!settings?.safeMode?unread:null;
 const [pluginRecords,setPluginRecords]=useState([]);
 useEffect(()=>{let alive=true;window.whale.plugins.action({action:'community-status'}).then(value=>{if(alive)setPluginRecords(pluginResult(value)?.dsh?.installed??[]);},()=>{});const off=window.whale.plugins.onUpdate(value=>{const list=value?.dsh?.installed;if(Array.isArray(list))setPluginRecords(list);});return()=>{alive=false;off?.();};},[]);
 useEffect(()=>startEmbedCover(),[]);
 // A2: each plugin's latest activity today (the same notices the desktop pet shows), for the footer status card
 const [pluginActivity,setPluginActivity]=useState({});
 useEffect(()=>window.whale.plugins.onNotification?.(value=>{const intent=hostComponentIntent(value);if(intent){toCommunity(intent);return;}if(value?.kind==='social-activity'&&!value.clear&&typeof value.title==='string'&&typeof value.pluginId==='string')setPluginActivity(old=>({...old,[value.pluginId]:{title:value.title.slice(0,80),at:Date.now()}}));}),[]);
 // C-4 / B7: 「扫码连接」 on a plugin page shows the scan dialog here, over the page the user is on (the plugin area
 // turns into its picture while the dialog is open). Each request is taken once; one made before this page loaded
 // (the main window was opened for it) is read on start, and then opens on the Extension Center's 账号连接 tab.
 const [loginFor,setLoginFor]=useState(null),loginRequests=useRef(null);
 useEffect(()=>{const api=window.whale.plugins,requests=createSocialLoginRequests({ack:requestId=>api.action({action:'social-login-ack',requestId}),open:(value,pulled)=>{setLoginFor(value);if(pulled&&page==='plugins')setCommunityIntent({tab:'accounts',at:Date.now()});},close:()=>setLoginFor(null)});loginRequests.current=requests;
  const off=api.onSocialLogin?.(value=>requests.take(value));
  api.action({action:'social-login-status'}).then(value=>{const state=pluginResult(value);if(state?.requestId)requests.take({platform:state.requestedPlatform,requestId:state.requestId,at:state.requestedAt},true);}).catch(()=>{});
  return()=>{requests.dispose();if(loginRequests.current===requests)loginRequests.current=null;off?.();};},[]);
 const recordOf=target=>pluginRecords.find(record=>record.packageName===EMBED_TARGETS[target].packageName);
 // after a login, 「去设置」 goes back to that plugin's page and loads it again so it reads the new account
 const openAfterLogin=packageName=>{const target=embedTargetFor(packageName),record=target&&recordOf(target);if(!record?.enabled){toCommunity({tab:'installed',packageName});return;}if(!embedCapable(target,record.exactVersion)){void window.whale.plugins.action({action:'dsh-open-client',packageKey:record.packageKey}).catch(()=>{});return;}setPage(EMBED_TARGETS[target].page);setChosen(null);void window.whale.plugins.embed({op:'reload',target}).catch(()=>{});};
 const embedStates={community:useEmbedState('community'),work:useEmbedState('work'),card:useEmbedState('card')},embedStateOf=target=>embedStates[embedSlotKind(target,recordOf(target))],viewOf=target=>embedView(target,recordOf(target),embedStateOf(target));
 const pluginTargetForPage=id=>Object.keys(EMBED_TARGETS).find(target=>EMBED_TARGETS[target].kind!=='work'&&EMBED_TARGETS[target].page===id);
 const pluginTarget=pluginTargetForPage(page);
 const embedTarget=pluginTarget??(page==='agent-tasks'&&!settings?.safeMode&&shellStatus.work?.ready?'work':null);
 const logPath=settings?.dataRoot?String(settings.dataRoot).replace(/[\\/]+$/,'')+'\\runtime-audit.jsonl':null;
 const embedArea=target=>h(EmbedArea,{key:target,target,record:recordOf(target),view:viewOf(target),state:embedStateOf(target),onCommunity:toCommunity,onStatus:reportStatus,logPath});
 // Plugin group (approved design G1): installed, enabled plugins that have their own page, between Companion and System.
 const pluginNav=pluginPageEntries(pluginRecords,pluginDisplayName).map(([id,icon,record])=>{const target=embedTargetFor(record.packageName);return [id,icon,target?embedName(target):pluginDisplayName(record)];});
 if(pluginNav.length)navGroups.splice(2,0,[nav('插件','Plugins'),pluginNav]);
 // a plugin version that cannot sit in the main window yet keeps opening its own window
 const goTo=id=>{if(id.startsWith('ext:')){const record=pluginRecords.find(value=>value.packageKey===id.slice(4));if(record)void window.whale.plugins.action({action:'dsh-open-client',packageKey:record.packageKey}).catch(()=>{});return;}
  const target=pluginTargetForPage(id),record=target&&recordOf(target);if(record&&!embedCapable(target,record.exactVersion)){void window.whale.plugins.action({action:'dsh-open-client',packageKey:record.packageKey}).catch(()=>{});return;}setPage(id);setChosen(null);};
 // The sidebar avatar, title-bar icon and overview portrait follow the current desktop pet.
 const pet=settings?.effectivePetCharacter||settings?.petCharacterId||'deepseek',head='./'+themeAsset(pet,'head.webp');
 let content;
 if(['overview','history','projects'].includes(page))content=h(AnalyticsPage,{page,settings,revision:data?.usageRevision,onManage:manage,onSaved:setSettings,monitor:data,onPage:setPage,onAttribution:id=>{setAttributionSource(id);setPage('tokens');}});
 else if(page==='data-import')content=h(DataImportPanel,{onComplete:()=>location.reload(),onClose:()=>setPage('settings')});
 else if(page==='settings')content=settings?h(GeneralSettings,{view:settings,onSaved:setSettings,onPage:setPage,onManage:manage,onPlugins:()=>toCommunity({tab:'installed'})}):h('p',{className:'settings-error',role:'alert'},settingsError||t("正在读取设置…"));
 else if(page==='tokens')content=h(TokenSettings,{sourceId:attributionSource,timeZone:settings?.preferences.statisticsTimeZone});
 else if(page==='api')content=h(ApiSettings,{view:settings,tab:apiTab,onTab:setApiTab});
  else if(page==='agent-tasks')content=settings?.safeMode?h(SafeModePage,{settings,onPage:setPage,time}):h(WorkTasks,{face:head,onStatus:reportStatus,onCommunity:toCommunity,renderEmbedded:()=>embedArea('work')});
 else if(['r95-shop','r95-inventory','r95-social'].includes(page))content=settings?.safeMode?h(SafeModePage,{settings,onPage:setPage,time}):h(R95CorePage,{page:page.slice(4),language:settings?.preferences.language,onPage:setPage,onStatus:reportStatus,timeZone:settings?.preferences.statisticsTimeZone||settings?.preferences.displayTimeZone});
 else if(pluginTarget)content=embedArea(pluginTarget);
 else if(page==='plugins')content=h(PluginCenter,{onManage:()=>manage('model'),onStatus:reportStatus,onPage:setPage,intent:communityIntent});
 else if(page==='actions')content=h(ActionGallery,{settings});
 else if(page==='safe-mode'||page==='galgame'&&settings?.safeMode)content=h(SafeModePage,{settings,onPage:setPage,time});
 else content=h('div',{className:'game-shell'},settingsError&&h('p',{className:'settings-error',role:'alert'},settingsError),h('style',null,GalgameCSS),h(GalgameApp,{variant:'tab',useSessions:null,hideSpriteOnCg:settings?.preferences.hideSpriteOnCg,onCharacter:setCharacter,onDisplayMode:setGameMode,chat,onToggleChat:toggleChat,onManage:manage}));
 const actionsPage=page==='actions',galgamePage=page==='galgame',hideDiagnostics=actionsPage||galgamePage||!!embedTarget||page.startsWith('plugin-')||['overview','projects','history'].includes(page);
 return h(React.Fragment,null,h('div',{className:'window-titlebar'},h('span',{className:'titlebar-face'},h('img',{src:settings?head:'./'+APP_ICON_PNG,alt:'',draggable:false})),h('span',{className:'titlebar-title'},localizedTitle())),h('div',{className:'layout'+(actionsPage?' actions-page':'')+(galgamePage?' galgame-page':'')+(embedTarget?' embed-page':'')},
   h('aside',null,h('div',{className:'brand'},h('div',{className:'brand-mark'},h('span',{className:'brand-face'},h('img',{src:head,alt:'',width:40,height:40}))),h('div',null,h('strong',null,settings?.preferences.language==='en'?'AI Buddy':'AI 酱'),h('small',null,'AI Buddy'))),
     h('nav',{className:'nav-groups','aria-label':t('主导航')},...navGroups.flatMap(([title,items])=>[h('p',{key:'g-'+title,className:'nav-h'},title),...items.map(([id,icon,name])=>h('button',{key:id,className:navOn(id)?'active':'','aria-current':navOn(id)?'page':undefined,title:navDot(id)?.title??name,onClick:()=>goTo(id)},Icon(icon,{size:18}),h('span',{className:'nav-l'},name),navDot(id)&&h('i',{className:'nav-dot',role:'img','aria-label':navDot(id).title,'data-nav-unread':navDot(id).count})))])),
     !actionsPage&&h(SidebarStatus,{page,status:shellStatus,character:galgamePage?character:pet,settings,chat,onPage:setPage,activity:pluginActivity})),
   h('main',null,!actionsPage&&embedTarget&&h(EmbedBar,{target:embedTarget,record:recordOf(embedTarget),view:viewOf(embedTarget),onCommunity:toCommunity}),!actionsPage&&!embedTarget&&h('header',null,h('span',null,t("你的本地工作空间")),h('div',null,h(StatusPill,{tone:data?.indexing?'busy':'ok','data-live-pill':true},data?.indexing?(data.indexPhase==='checking'?t("核对新增记录…"):t("整理历史记录…")):t("监控中")),h('span',{className:'header-date'},data?.today||''))),
     h('div',{className:'content'},settings?.safeMode&&!['safe-mode','galgame'].includes(page)&&h('div',{className:'index-banner safe-mode-banner',role:'status'},h('span',null,t("陪伴功能已停用（安全模式），桌宠和用量监控照常可用。")),h('button',{onClick:()=>setPage('safe-mode')},t("查看原因"))),!hideDiagnostics&&data?.indexing&&h('div',{className:'index-banner'},(data.indexPhase==='checking'?t("正在核对新增记录 · 已检查 "):t("正在建立本地历史索引 · 已读取 "))+(data.progress?.scanned||0)+' / '+(data.progress?.total||'—')+t(" 个文件。完成前用量为部分结果。")),
       page==='tokens'&&data?.missingRequests>0&&h('p',{className:'settings-note'},data.missingRequests+t(" 条请求缺少完整用量，合计为已记录部分。")),!hideDiagnostics&&!data&&h('p',null,t("正在读取本地记录…")),h(PageBoundary,{page},content),
       !hideDiagnostics&&data?.errors?.length>0&&h('details',{className:'read-errors'},h('summary',null,data.errors.length+t(" 个日志读取问题")),...data.errors.slice(0,10).map(e=>h('p',{key:e.path},e.path+' · '+e.message)))))),
   loginFor&&h(SocialLoginRequest,{key:loginFor.requestId,api:window.whale.plugins,platform:loginFor.platform,onClose:()=>loginRequests.current?.close(loginFor.requestId),onOpenPlugin:openAfterLogin}));
}
// A first launch must not mount App's settings/game/monitor requests until the
// user has selected a profile. The main process chooses this hash before load.
function DataImportWelcome(){return h('main',{className:'data-import-welcome'},h(DataImportPanel,{onboarding:true,onComplete:()=>{location.hash='overview';location.reload();}}));}
createRoot(document.getElementById('app')).render(h(location.hash.slice(1)==='data-import'?DataImportWelcome:App));

