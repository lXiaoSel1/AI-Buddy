import React,{useEffect,useRef,useState} from 'react';
import {t} from './i18n.mjs';
import {Icon} from './ui-icons.mjs';
import {Switch} from './ui-controls.mjs';
import {plateVars} from './plate-colors.mjs';
import {GroupCgGallery,useGroupCg,groupCgLabel,activeGroupCg} from './group-cg-ui.mjs';
import {GroupEditor,ImageField,characterHead,companionCharacterName,companionImage,GROUP_BUSY_STATUSES} from './companion-ui.mjs';
const h=React.createElement,F=React.Fragment;
const button=(text,onClick,props={})=>h('button',{type:'button',className:'whg-btn',onClick,...props},t(text));
const MODE_NAMES={natural:'自然接话',list:'列表顺序',manual:'手动点名',pool:'轮换池'};
const face=(c,resolveArt,className='gx-face')=>{const src=characterHead(c,resolveArt);return h('span',{className,'aria-hidden':true},src?h('img',{src,alt:'',draggable:false}):companionCharacterName(c).slice(0,1)||'?');};
// Built-ins have a half-length group thumbnail; custom characters fall back to their head.
const portrait=(c,resolveArt)=>c?.builtin?h('img',{className:'buddy-group-thumb',src:`assets/group-thumbnails/${c.id}.png`,alt:''}):face(c,resolveArt,'buddy-face lg');
export function groupHeaderContext(state){
 const group=state.groups?.find(g=>g.id===state.activeGroupId);if(!group)return null;
 const members=group.memberIds.map(id=>state.characters?.find(c=>c.id===id)).filter(Boolean),runtime=state.groupRuntime||{};
 const running=['queued','generating','running','preparing','awaiting-presentation'].includes(runtime.status);
 const message=runtime.currentMessage?.role==='assistant'?runtime.currentMessage:[...(state.groupMessages||[])].reverse().find(m=>m.role==='assistant'&&m.status!=='pending-presentation');
 const speakerId=running?(runtime.pendingMessage?.characterId||runtime.queue?.[0]):message?.characterId;
 const speaker=members.find(c=>c.id===speakerId),recorded=running?runtime.pendingMessage?.request:message?.request;
 const route=speaker?.effectiveConnection;
 return {group,members,running,speaker,recorded,route,model:recorded?.model||route?.model||'',persona:state.personas?.find(p=>p.id===group.personaId)};
}
// Group dialogs share one frame: title and × on top, actions at the bottom right.
function Modal({title,onClose,small=false,wide=false,children,busy=false,kind,footer}){
 const ref=useRef(null),focus=useRef(null);
 useEffect(()=>{focus.current=document.activeElement;ref.current?.showModal();return()=>{ref.current?.close();focus.current?.isConnected&&focus.current.focus({preventScroll:true});};},[]);
 return h('dialog',{ref,className:'buddy-dialog buddy-group-modal'+(small?' buddy-group-small':'')+(wide?' buddy-group-wide':''),'aria-label':t(title),'data-group-dialog':kind,onCancel:e=>{e.preventDefault();if(!busy)onClose();},onWheel:e=>e.stopPropagation()},
  h('header',null,h('h2',null,t(title)),h('button',{type:'button',className:'buddy-dialog-close ui-icon-btn',onClick:onClose,disabled:busy,'aria-label':t('关闭')+' · '+t(title)},Icon('close',{size:18}))),
  h('div',{className:'buddy-group-modal-body'},children),
  footer&&h('footer',{className:'buddy-group-modal-foot'},footer));
}
function GroupRename({group,request,onClose}){
 const [name,setName]=useState(group.name),[busy,setBusy]=useState(false),[error,setError]=useState(''),id=React.useId();
 return h(Modal,{title:'编辑群聊名称',small:true,onClose,busy,kind:'rename',footer:h(F,null,h('span',{className:'spacer'}),button('取消',onClose,{disabled:busy}),h('button',{type:'submit',form:id,className:'whg-btn buddy-primary',disabled:busy||!name.trim()},t('保存')))},
  h('form',{id,onSubmit:async e=>{e.preventDefault();if(busy||!name.trim())return;setBusy(true);try{await request('companion-group-save',{id:group.id,name:name.trim()});onClose();}catch(e){setError(e.message);}finally{setBusy(false);}}},
   h('label',{className:'buddy-field'},h('span',{className:'buddy-field-label'},t('群名')),h('input',{className:'buddy-group-input',value:name,autoFocus:true,maxLength:200,'aria-label':t('群名'),disabled:busy,onChange:e=>setName(e.target.value)})),
   h('small',{className:'buddy-count-row'},h('span',null,t('只改群名，不影响成员和记录。')),h('span',null,name.length+' / 200')),
   error&&h('p',{role:'alert',className:'buddy-error'},error)));
}
function Background({context,request,resolveArt,onClose}){
 const {group}=context,[background,setBackground]=useState(group.background||''),[table,setTable]=useState(group.sceneTemplate!=='plain'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const library=resolveArt('bg-kimi-moonlit-reading-study'),choices=[{key:'',name:t('默认图书室'),src:library}];
 for(const c of context.members)if(c.background&&!choices.some(x=>x.key===c.background))choices.push({key:c.background,name:companionCharacterName(c)+' · '+t('内置场景'),src:companionImage(c.background,resolveArt)});
 const custom=!!background&&!choices.some(c=>c.key===background),preview=companionImage(background,resolveArt)||(!background?library:null);
 const card=(key,name,src,props={})=>h('button',{type:'button',key:key||'default',role:'radio','aria-checked':background===key,className:'buddy-group-bg-card',disabled:busy,onClick:()=>setBackground(key),...props},h('i',{style:src?{backgroundImage:`url("${src}")`}:undefined}),h('b',null,name));
 const save=async()=>{if(busy)return;setBusy(true);try{await request('companion-group-save',{id:group.id,background,sceneTemplate:table?'library':'plain'});onClose();}catch(e){setError(e.message);}finally{setBusy(false);}};
 return h(Modal,{title:'群聊背景',onClose,busy,kind:'background',footer:h(F,null,h('button',{type:'button',className:'whg-btn buddy-ghost',disabled:busy,onClick:()=>setBackground('')},t('恢复默认')),h('span',{className:'spacer'}),button('取消',onClose,{disabled:busy}),h('button',{type:'button',className:'whg-btn buddy-primary',disabled:busy,onClick:()=>void save()},t('保存背景')))},
  h('p',{className:'buddy-note'},t('只修改当前群聊背景，不改变任何角色的私聊背景。')),
  preview&&h('div',{className:'buddy-group-bg-preview'},h('img',{className:'buddy-group-background-preview',src:preview,alt:t('群聊背景预览')}),h('span',{className:'ws-tag'},t('预览'))),
  h('div',{className:'buddy-group-bg-cards',role:'radiogroup','aria-label':t('选择群聊场景')},...choices.map(c=>card(c.key,c.name,c.src)),custom&&card(background,t('自定义背景'),preview)),
  h(ImageField,{label:'上传群聊背景',value:custom?background:'',onChange:setBackground,disabled:busy,resolveArt,onError:setError}),
  h('div',{className:'buddy-switch-row wide'},h('div',null,h('b',null,t('显示圆桌前景')),h('small',null,t('关掉后只显示背景和成员。'))),h(Switch,{checked:table,disabled:busy,label:t('显示圆桌前景'),onChange:setTable})),
  error&&h('p',{className:'buddy-error',role:'alert'},error));
}
function Members({context,resolveArt,onBrowse,onClose}){
 const speakerId=context.speaker?.id;
 return h(Modal,{title:'在场角色',small:true,onClose,kind:'members',footer:h(F,null,button('回到发言者',()=>{onBrowse(null);onClose();}),h('span',{className:'spacer'}),h('button',{type:'button',className:'whg-btn buddy-primary',onClick:onClose},t('完成')))},
  h('p',{className:'buddy-note'},t('选择成员只切换查看镜头，不改变桌宠或聊天连接。')),
  h('div',{className:'buddy-group-member-list'},...context.members.map(c=>h('div',{className:'buddy-group-member-row'+(speakerId===c.id?' now':''),key:c.id},portrait(c,resolveArt),h('div',null,h('strong',null,companionCharacterName(c)),h('small',null,[speakerId===c.id?t('正在发言'):'',context.group.mutedIds?.includes(c.id)?t('在场 · 静音'):t('在场')].filter(Boolean).join(' · '))),button('查看',()=>{onBrowse(c.id);onClose();},{className:'whg-btn buddy-ghost','aria-label':t('查看')+' '+companionCharacterName(c),'data-group-member-view':c.id})))));
}
function Connections({context,request,resolveArt,onClose}){
 const [profiles,setProfiles]=useState([]),[loaded,setLoaded]=useState(false),[draft,setDraft]=useState(()=>Object.fromEntries(context.members.map(c=>[c.id,c.modelBinding?.enabled?c.modelBinding.connectionId:'']))),[busy,setBusy]=useState(null),[error,setError]=useState(''),[saved,setSaved]=useState(null);
 useEffect(()=>{let live=true;window.whale.models.get().then(v=>{if(live){setProfiles(v.profiles||[]);setLoaded(true);}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[]);
 // A choice is saved as soon as it is made; a failed save puts the old choice back.
 const choose=async(c,value)=>{if(busy)return;const before=draft[c.id]||'';setDraft(old=>({...old,[c.id]:value}));setSaved(null);setBusy(c.id);setError('');try{await request('companion-character-save',{id:c.id,modelBinding:{enabled:!!value,connectionId:value||null}});setSaved(c.id);}catch(e){setDraft(old=>({...old,[c.id]:before}));setError(e.message);}finally{setBusy(null);}};
 const savedName=saved&&companionCharacterName(context.members.find(c=>c.id===saved));
 return h(Modal,{title:'成员的聊天连接',onClose,busy:!!busy,kind:'connections',footer:h(F,null,h('span',{className:'spacer buddy-note'+(saved?' buddy-ok':''),role:'status'},saved&&Icon('check',{size:14}),saved?savedName+t(' 的连接已保存'):t('选完立即保存。')),h('button',{type:'button',className:'whg-btn buddy-primary',onClick:onClose,disabled:!!busy},t('完成')))},
  h('p',{className:'buddy-note'},t('默认跟随全局连接；专属连接用于该角色之后的私聊和群聊，不改变全局连接。')),
  ...context.members.map(c=>{const route=c.effectiveConnection||{},now=context.speaker?.id===c.id,model=now&&context.recorded?.model?context.recorded.model:route.model;return h('section',{className:'buddy-group-route'+(now?' now':''),key:c.id,'data-group-api-member':c.id},portrait(c,resolveArt),
   h('div',{className:'spacer'},h('strong',null,companionCharacterName(c),now&&h('span',{className:'ws-tag'},t('正在说话'))),h('small',null,route.error?t(route.error):[t(route.mode==='character'?'角色专属':'跟随全局'),route.name,model].filter(Boolean).join(' · '))),
   h('select',{className:'buddy-group-input',value:draft[c.id]||'','aria-label':companionCharacterName(c)+' API',disabled:!loaded||!!busy,onChange:e=>void choose(c,e.target.value)},h('option',{value:''},t('跟随全局连接')),draft[c.id]&&!profiles.some(p=>p.id===draft[c.id])&&h('option',{value:draft[c.id],disabled:true},t('原连接已不可用')),...profiles.map(p=>h('option',{key:p.id,value:p.id,disabled:p.enabled===false||p.capabilities?.chat===false},p.name+' · '+p.model))));}),
  error&&h('p',{className:'buddy-error',role:'alert'},error));
}
function History({state,context,request,resolveArt,onClose}){
 const [query,setQuery]=useState(''),[error,setError]=useState(''),[status,setStatus]=useState('');
 const all=(state.groupMessages||[]).filter(m=>m.status!=='pending-presentation'),messages=all.filter(m=>m.text?.toLowerCase().includes(query.toLowerCase()));
 const exportLog=async()=>{setError('');try{const result=await request('companion-group-export',{id:context.group.id}),url=URL.createObjectURL(new Blob([JSON.stringify(result.data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='AI-Buddy-group-'+context.group.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setStatus(t('群聊已导出；可在对话历史中恢复。'));}catch(e){setError(e.message);}};
 return h(Modal,{title:t('群聊记录')+' · '+context.group.name,onClose,kind:'history',footer:h(F,null,h('button',{type:'button',className:'whg-btn buddy-ghost',onClick:()=>void exportLog()},Icon('download',{size:14}),t('导出群聊记录')),h('span',{className:'spacer buddy-note',role:'status'},status),button('关闭',onClose))},
  h('div',{className:'buddy-group-history-tools'},h('label',{className:'buddy-searchbox'},Icon('search',{size:15}),h('input',{type:'search',placeholder:t('搜索本群消息'),'aria-label':t('搜索本群消息'),value:query,onChange:e=>setQuery(e.target.value)})),h('small',{className:'buddy-muted'},t('共 {n} 条').replace('{n}',String(all.length)))),
  h('div',{className:'buddy-msgs buddy-group-history-list'},...messages.map(m=>{const mine=m.role==='user',c=state.characters?.find(x=>x.id===m.characterId);return h('article',{key:m.id,className:'buddy-message'+(mine?' me':''),'data-group-history-message':m.id,style:mine?undefined:plateVars({characterId:m.characterId,color:c?.color})},mine?h('span',{className:'buddy-face blank','aria-hidden':true},Icon('person',{size:15})):face(c,resolveArt,'buddy-face'),h('div',{className:'buddy-message-main'},h('div',{className:'buddy-message-head'},h('strong',null,mine?(m.personaName||m.personaSnapshot?.nickname||t('你')):(m.characterName||companionCharacterName(c))),h('small',{className:'buddy-muted'},m.createdAt?new Date(m.createdAt).toLocaleString():'')),h('p',{className:'buddy-message-body'},m.text)));})),
  messages.length===0&&h('p',{className:'buddy-note'},t('没有匹配的群聊消息。')),
  error&&h('p',{role:'alert',className:'buddy-error'},error));
}
function Settings({state,request,resolveArt,onClose}){
 const [feedback,setFeedback]=useState('');return h(Modal,{title:'群聊设置',wide:true,onClose,kind:'settings'},h(GroupEditor,{state,request,resolveArt,onClose,setFeedback}),feedback&&h('p',{role:'status'},feedback));
}
export function GroupHeader({state,request,resolveArt=()=>null,onBrowse,petEnabled,onPetToggle,panelRequest,loadCg,toolbarRef,chat,onToggleChat}){
 const [panel,setPanel]=useState(null),[cgSelection,setCgSelection]=useState(null),[leaving,setLeaving]=useState(false),[error,setError]=useState(''),context=groupHeaderContext(state),catalog=useGroupCg(context?.group,request);
 useEffect(()=>setPanel(null),[state.activeGroupId]);
 useEffect(()=>{if(panelRequest?.groupId===state.activeGroupId){setPanel(panelRequest.panel);if(panelRequest.panel==='gallery')setCgSelection(panelRequest.cgId||null);}},[panelRequest]);
 if(!context)return null;
 const latest=catalog.items.find(activeGroupCg)||catalog.items[0],{group,members,speaker,model}=context,close=()=>setPanel(null);
 const actual=speaker?companionCharacterName(speaker)+' · '+(model||t('未配置')):t('按成员配置');
 const cgTitle=catalog.error?t('CG 状态读取失败：')+catalog.error:latest?groupCgLabel(latest)+(latest.model?' · '+latest.model:''):t('CG 图鉴');
 const busy=GROUP_BUSY_STATUSES.includes(state.groupRuntime?.status);
 const leave=async()=>{if(leaving)return;setLeaving(true);setError('');try{await request('companion-group-close',{id:group.id});}catch(e){setError(String(e?.message||e));}finally{setLeaving(false);}};
 const tool=(icon,label,onClick,props={})=>h('button',{type:'button',onClick,...props,className:'gx-tb'+(props.className?' '+props.className:'')},Icon(icon,{size:15}),t(label));
 const sep=key=>h('i',{key,className:'gx-sep','aria-hidden':true});
 return h(F,null,
  h('div',{className:'gx-top buddy-group-top','data-group-header':group.id},
   h('div',{className:'gx-row'},
    h('button',{type:'button',className:'gx-title buddy-title-edit','aria-label':t('编辑群聊名称'),onClick:()=>setPanel('rename'),title:group.name},h('span',null,group.name),Icon('pencil',{size:15})),
    h('button',{type:'button',className:'gx-chip','data-group-members':true,title:t('在场角色'),onClick:()=>setPanel('members')},h('span',{className:'buddy-faces','aria-hidden':true},...members.slice(0,4).map(c=>h(F,{key:c.id},face(c,resolveArt)))),h('small',null,t('在场')),h('strong',null,String(members.length))),
    h('button',{type:'button',className:'gx-chip np',title:t('管理群聊'),onClick:()=>setPanel('settings')},h('i',{className:'gx-dot'+(chat&&!chat.enabled?' off':''),'aria-hidden':true}),h('small',null,t('发言方式')),h('strong',null,t(MODE_NAMES[group.mode]||'自然接话'))),
    h('span',{className:'gx-grow'}),
    chat&&h('div',{className:'gx-net','data-group-net':true},Icon('globe',{size:15}),h('span',null,t('联网群聊')),h(Switch,{checked:!!chat.enabled,label:t('联网群聊'),onChange:()=>onToggleChat?.()}))),
   h('div',{className:'gx-tools buddy-group-primary',role:'toolbar','aria-label':t('群聊工具栏')},
    tool('image','群聊背景',()=>setPanel('background')),
    tool('clock','群聊记录',()=>setPanel('history')),
    tool('gallery','CG 图鉴',()=>{setCgSelection(latest?.id||null);setPanel('gallery');},{className:'buddy-cg-chip','data-status':catalog.error?'failed':latest?.status,'data-active':activeGroupCg(latest),title:cgTitle}),
    tool('link','对话模型',()=>setPanel('connections'),{'data-group-connections':true,title:t('实际对话 · ')+actual}),
    sep('s1'),
    tool('sliders','管理群聊',()=>setPanel('settings')),
    sep('s2'),
    tool('exit','回到私聊',()=>void leave(),{disabled:busy||leaving}),
    h('div',{ref:toolbarRef,className:'buddy-group-stage-controls'})),
   error&&h('p',{className:'buddy-error',role:'alert'},error)),
  panel==='rename'&&h(GroupRename,{group,request,onClose:close}),panel==='members'&&h(Members,{context,resolveArt,onBrowse,onClose:close}),panel==='background'&&h(Background,{context,request,resolveArt,onClose:close}),panel==='connections'&&h(Connections,{context,request,resolveArt,onClose:close}),panel==='history'&&h(History,{context,state,request,resolveArt,onClose:close}),panel==='gallery'&&h(GroupCgGallery,{catalog,request,loadImage:loadCg,onClose:close,Dialog:Modal,selectedId:cgSelection}),panel==='settings'&&h(Settings,{state,request,resolveArt,onClose:close}));
}
