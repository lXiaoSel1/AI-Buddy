// Plugin pages inside the main window (approved design G1–G6). The plugin's own page is a separate
// sandboxed view the main process lays over .embed-area; this page draws only what AI Buddy knows itself:
// the plugin bar, the states before the page exists (G5), and a still picture while one of AI Buddy's own
// dialogs or menus is open (G6), because nothing in this document can draw on top of that view.
import React,{useState,useEffect,useRef} from 'react';
import {t} from './i18n.mjs';
import {Icon} from './ui-icons.mjs';
import {StatusPill,Menu} from './ui-controls.mjs';
import {Dialog} from './ui-dialog.mjs';
import {PluginLogo} from './community-install-page.mjs';
import {pluginResult} from './plugin-center-helpers.mjs';
import {EMBED_TARGETS,embedCapable} from './plugin-embed-targets.mjs';
const h=React.createElement;
const plugins=()=>globalThis.window?.whale?.plugins;
const embed=request=>plugins()?.embed?.(request)??Promise.resolve(null);
// buttons: a refused request (e.g. during a data import) must not become an unhandled rejection
const send=request=>void embed(request).catch(()=>{});
const NAMES={bilibili:'B站陪伴',qq:'QQ连接',work:'工作与协作'};
export const embedName=target=>t(NAMES[target]);
// What stops while a plugin is disabled, in its own words (shown on the disabled screen and in the confirm dialog).
const PAUSED={bilibili:'停用期间不会自己去看视频，也不会发评论。观看记录和设置都还在。',qq:'停用期间不会回复 QQ 消息。聊天记录、允许名单和账号连接都还在。',work:'停用期间不会运行任何任务，记录都保留。'};
const DISABLE={bilibili:'停用后不会自己去看视频，也不会发评论。观看记录和设置都保留，之后在这里或扩展中心都能重新启用。',qq:'停用后不会再回复 QQ 消息。聊天记录、允许名单和账号连接都保留，之后在这里或扩展中心都能重新启用。',work:'停用后不会运行任何任务。项目和任务记录都保留，之后在这里或扩展中心都能重新启用。'};

/** The embedded page's state as the main process reports it (one shared page for Bilibili and QQ). */
export function useEmbedState(target){
  const [value,setValue]=useState(null);
  useEffect(()=>{
    if(!target)return;let alive=true;const kind=EMBED_TARGETS[target].kind;
    const off=plugins()?.onEmbed?.(next=>{if(alive&&next?.kind===kind)setValue(next);});
    embed({op:'state'}).then(list=>{const next=Array.isArray(list)?list.find(row=>row.kind===kind):null;if(alive&&next)setValue(next);}).catch(()=>{});
    return()=>{alive=false;off?.();};
  },[target]);
  return value;
}
/** none / off / unsupported come from the installed record; start / run / err / popped from the page itself. */
export function embedView(target,record,state){
  if(!record)return 'none';if(!record.enabled)return 'off';if(!embedCapable(target,record.exactVersion))return 'unsupported';
  if(state?.state==='popped')return 'popped';if(state?.state==='err'&&state.target===target)return state.code==='PLUGIN_BUSY'?'waiting':'err';
  return state?.state==='run'&&state.target===target?'run':'start';
}
const PILL={waiting:['busy','等待插件空闲'],run:['ok','运行中'],start:['busy','启动中'],off:['idle','已停用'],err:['err','打不开'],none:['idle','未安装'],popped:['info','在单独窗口里'],unsupported:['warn','需要更新']};
export const embedPill=view=>PILL[view]??PILL.start;

/** G2: the bar AI Buddy draws above the plugin page. */
export function EmbedBar({target,record,view,onCommunity}){
  const [menu,setMenu]=useState(false),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),more=useRef(null);
  // the menu closes on Esc (focus may still be on the button) and on a click anywhere else
  useEffect(()=>{if(!menu)return;const away=e=>{if(!more.current?.contains(e.target))setMenu(false);},key=e=>{if(e.key==='Escape')setMenu(false);};document.addEventListener('pointerdown',away);document.addEventListener('keydown',key);return()=>{document.removeEventListener('pointerdown',away);document.removeEventListener('keydown',key);};},[menu]);
  const [tone,label]=embedPill(view),name=embedName(target);
  const disable=async()=>{setBusy(true);setError('');try{pluginResult(await plugins().action({action:'dsh-disable',packageKey:record.packageKey}));setConfirm(false);}catch(e){setError(e.message);}finally{setBusy(false);}};
  const items=[{label:t('重新载入插件页'),icon:'retry',disabled:!['run','err'].includes(view),onSelect:()=>send({op:'reload',target})},
    {label:t('在扩展中心看设置和权限'),icon:'nav-plugins',onSelect:()=>onCommunity?.({tab:'installed',packageName:EMBED_TARGETS[target].packageName})},'separator',
    {label:t('停用插件…'),icon:'power',danger:true,disabled:!record?.enabled,onSelect:()=>{setError('');setConfirm(true);}}];
  return h('header',{className:'embed-bar'},
    h(PluginLogo,{packageName:EMBED_TARGETS[target].packageName,size:26}),h('b',{className:'embed-bar-n'},name),h(StatusPill,{tone},t(label)),h('span',{className:'embed-grow'}),
    !['none','off','popped'].includes(view)&&h('button',{type:'button',className:'ui-btn ghost sm',onClick:()=>send({op:'popout',target})},Icon('external',{size:16}),t('在单独窗口打开')),
    h('span',{className:'embed-more',ref:more},h('button',{type:'button',className:'ui-icon-btn','aria-label':t('更多'),title:t('更多'),'aria-expanded':menu,onClick:()=>setMenu(value=>!value)},Icon('more',{size:18})),
      menu&&h(Menu,{label:t('更多'),items,onClose:()=>setMenu(false),style:{position:'absolute',right:0,top:'calc(100% + 6px)',minWidth:240,zIndex:5}})),
    confirm&&h(Dialog,{title:t('停用 {name}？').replace('{name}',name),onClose:()=>setConfirm(false),busy,footer:[h('button',{key:'c',type:'button',className:'ui-btn ghost',disabled:busy,onClick:()=>setConfirm(false)},t('取消')),h('button',{key:'d',type:'button',className:'ui-btn danger',disabled:busy,onClick:()=>void disable()},busy?t('正在停用…'):t('停用'))]},
      h('p',null,t(DISABLE[target])),error&&h('p',{className:'ui-alert warn',role:'alert'},error)));
}
function StateCard({target,title,text,actions=null,extra=null,progress=false}){
  return h('div',{className:'embed-state',role:'status'},h('div',{className:'embed-state-c'},h(PluginLogo,{packageName:EMBED_TARGETS[target].packageName,size:56}),h('h3',null,title),h('p',null,text),
    progress&&h('span',{className:'ws-meter embed-indet','aria-hidden':true},h('b')),extra,actions&&h('div',{className:'ws-row-btns'},actions)));
}
/** G2–G5: the placeholder the page is laid over, and the screens shown before it is there. */
export function EmbedArea({target,record,view,state,onCommunity,onStatus,logPath=null}){
  const area=useRef(null),[snap,setSnap]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[shown,setShown]=useState(()=>globalThis.document?.visibilityState!=='hidden'),[refused,setRefused]=useState(null);
  const name=embedName(target),live=['start','run','err'].includes(view);
  // the host refused to open the page (e.g. a data import is running): say so, with Retry, instead of spinning
  useEffect(()=>setRefused(null),[target,state?.state]);
  if(refused&&view==='start')view=refused==='PLUGIN_BUSY'?'waiting':'err';
  useEffect(()=>{onStatus?.({embed:{target,view}});},[target,view]);
  useEffect(()=>{const on=()=>setShown(document.visibilityState!=='hidden');document.addEventListener('visibilitychange',on);return()=>document.removeEventListener('visibilitychange',on);},[]);
  // ask for the page whenever it should exist here and does not yet; never while the window is hidden
  useEffect(()=>{if(shown&&live&&!refused&&(!state||state.state==='idle'||state.target!==target&&EMBED_TARGETS[target].kind==='community'))void embed({op:'open',target}).catch(e=>setRefused(e?.code??'PLUGIN_EMBED_FAILED'));},[target,live,shown,refused,state?.state,state?.target]);
  // report where the page goes while it is starting or showing; null otherwise, so a disabled or failed page never
  // stays over its own screen. Reported again whenever this changes or the window comes back.
  const waiting=view==='waiting';
  useEffect(()=>{
    if(!waiting||!shown)return;
    let active=true,pending=false;const retry=async()=>{if(pending)return;pending=true;try{await embed({op:'reload',target});if(active)setRefused(null);}catch(e){if(active)setRefused(e?.code??'PLUGIN_EMBED_FAILED');}finally{pending=false;}};
    const timer=setInterval(retry,5000);return()=>{active=false;clearInterval(timer);};
  },[waiting,shown,target]);
  const placed=view==='run'||view==='start';
  useEffect(()=>{
    const node=area.current;if(!node)return;
    const report=()=>{const r=node.getBoundingClientRect();void embed({op:'slot',target,rect:placed&&r.width>0&&r.height>0?{x:r.left,y:r.top,width:r.width,height:r.height}:null}).catch(()=>{});};
    const observer=new ResizeObserver(report);observer.observe(node);window.addEventListener('resize',report);report();
    return()=>{observer.disconnect();window.removeEventListener('resize',report);void embed({op:'slot',target,rect:null}).catch(()=>{});};
  },[target,placed,shown,!!state]);
  useEffect(()=>{const on=event=>setSnap(event.detail?.image??null);window.addEventListener('buddy-embed-cover',on);return()=>window.removeEventListener('buddy-embed-cover',on);},[]);
  const act=async work=>{setBusy(true);setError('');try{await work();}catch(e){setError(e.message);}finally{setBusy(false);}};
  const enable=()=>act(async()=>pluginResult(await plugins().action({action:'dsh-enable',packageKey:record.packageKey})));
  const failure=error&&h('p',{className:'ui-alert warn',role:'alert'},error);
  let screen=null;
  if(view==='start')screen=h(StateCard,{target,title:t('正在准备 {name}').replace('{name}',name),text:t('DSH 后台正在启动。AI 酱启动后第一次打开要先核验运行组件，可能要等一分钟左右；准备好后这里直接显示插件页。'),progress:true});
  else if(view==='off')screen=h(StateCard,{target,title:t('{name}已停用').replace('{name}',name),text:t(PAUSED[target]),extra:failure,actions:[h('button',{key:'e',type:'button',className:'ui-btn primary',disabled:busy,onClick:()=>void enable()},Icon('power',{size:16}),busy?t('正在启用…'):t('启用')),h('button',{key:'v',type:'button',className:'ui-btn ghost',onClick:()=>onCommunity?.({tab:'installed',packageName:EMBED_TARGETS[target].packageName})},t('在扩展中心查看'))]});
  else if(waiting)screen=h(StateCard,{target,title:t('等待插件空闲'),text:t('插件正在处理另一项操作，空闲后会自动重试。'),progress:true});
  else if(view==='err')screen=h(StateCard,{target,title:t('插件页打不开'),text:t('DSH 后台没有响应。可以先重试；还不行就在单独窗口打开，或者去扩展中心看维护记录。'),
    extra:(refused??state?.code??logPath)&&h('details',{className:'work-entry-tech'},h('summary',null,t('技术详情：错误代码和日志位置')),...[(refused??state?.code)&&t('错误代码：{code}').replace('{code}',refused??state.code),logPath&&t('日志：{path}').replace('{path}',logPath)].filter(Boolean).map((line,i)=>h('code',{key:i},line))),
    actions:[h('button',{key:'r',type:'button',className:'ui-btn primary',onClick:()=>{setRefused(null);send({op:'reload',target});}},Icon('retry',{size:16}),t('重试')),h('button',{key:'w',type:'button',className:'ui-btn ghost',onClick:()=>send({op:'popout',target})},Icon('external',{size:16}),t('在单独窗口打开'))]});
  else if(view==='none')screen=h(StateCard,{target,title:t('还没装 {name}').replace('{name}',name),text:t('卸载时留下的记录和设置，重新安装后还能接着用。'),actions:[h('button',{key:'i',type:'button',className:'ui-btn primary',onClick:()=>onCommunity?.({install:EMBED_TARGETS[target].packageName})},Icon('download',{size:16}),t('去安装'))]});
  else if(view==='popped')screen=h(StateCard,{target,title:t('{name}已在单独窗口打开').replace('{name}',name),text:t('关掉那个窗口，或者点「放回这里」，就回到主窗口。'),actions:[h('button',{key:'d',type:'button',className:'ui-btn primary',onClick:()=>send({op:'dock',target})},t('放回这里'))]});
  else if(view==='unsupported')screen=h(StateCard,{target,title:t('这个版本的{name}还不能放进主窗口').replace('{name}',name),text:t('插件更新到 2.0.1 以后就能在这里打开。现在可以先在单独窗口里用。'),actions:[h('button',{key:'w',type:'button',className:'ui-btn primary',onClick:()=>void plugins().action({action:'dsh-open-client',packageKey:record.packageKey}).catch(()=>{})},Icon('external',{size:16}),t('在单独窗口打开'))]});
  return h('div',{className:'embed-area',ref:area,'data-embed-target':target},screen,view==='run'&&snap&&h('img',{className:'embed-snap',src:snap,alt:''}));
}
const OVERLAYS='dialog[open],.ui-menu,.side-status-pop';
/**
 * G6: while any of AI Buddy's own dialogs, menus or the footer card is open, the plugin view (a native layer)
 * is swapped for a picture of itself so the overlay shows on top. The picture lives only in this page.
 */
export function startEmbedCover(root=document.body){
  let covered=false,running=false,again=false;
  const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const show=image=>window.dispatchEvent(new CustomEvent('buddy-embed-cover',{detail:{image}}));
  const sync=async()=>{
    if(running){again=true;return;}running=true;
    try{do{again=false;const want=!!root.querySelector(OVERLAYS);
      if(want&&!covered){const shot=await embed({op:'capture'}).catch(()=>null);if(!root.querySelector(OVERLAYS))continue;if(shot?.image){show(shot.image);await frame();}await embed({op:'cover',covered:true}).catch(()=>{});covered=true;}
      else if(!want&&covered){await embed({op:'cover',covered:false}).catch(()=>{});covered=false;await frame();show(null);}
    }while(again);}finally{running=false;}
  };
  const observer=new MutationObserver(()=>void sync());observer.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['open','class']});
  return()=>observer.disconnect();
}
