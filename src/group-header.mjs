import React,{useCallback,useEffect,useRef,useState} from 'react';
import {t} from './i18n.mjs';
import {cleanIpcMessage} from './ipc-message.mjs';
import {historyMessageKey,useCompanionHistoryPage} from './companion-history-page-client.mjs';
import {Icon} from './ui-icons.mjs';
import {Switch} from './ui-controls.mjs';
import {plateVars} from './plate-colors.mjs';
import {GroupCgGallery,useGroupCg,groupCgLabel,activeGroupCg} from './group-cg-ui.mjs';
import {GroupEditor,ImageField,characterHead,companionCharacterName,companionImage,GROUP_BUSY_STATUSES,groupModes,groupModeHelp} from './companion-ui.mjs';
import {R95NetButton} from './r95-core-page.mjs';
import {MoodChip,AutoChip} from './chat-r95-ui.mjs';
import {GalgameIcon,GlassButton,GlassCorner,GlassDivider,GlassGroup,GlassHideButton,GlassMenuItem,GalgamePaperHeading,HistoryExpressionText,HistoryExpressionPreview,Ornament} from './galgame-redesign.mjs';
import {groupSpeakerState} from './group-stage.mjs';
import {groupMemberAvatar} from './group-member-avatar.mjs';
const h=React.createElement,F=React.Fragment;
const button=(text,onClick,props={})=>h('button',{type:'button',className:'whg-btn',onClick,...props},t(text));
const MODE_NAMES=Object.fromEntries(groupModes);
const face=(c,resolveArt,className='gx-face',head=characterHead)=>{const src=head(c,resolveArt);return h('span',{className,'aria-hidden':true},src?h('img',{src,alt:'',draggable:false}):companionCharacterName(c).slice(0,1)||'?');};
export function groupHeaderContext(state){
 const group=state.groups?.find(g=>g.id===state.activeGroupId);if(!group)return null;
 const members=group.memberIds.map(id=>state.characters?.find(c=>c.id===id)).filter(Boolean),runtime=state.groupRuntime||{};
 const identity=groupSpeakerState(runtime,state.groupMessages),{running}=identity,message=identity.displayMessage;
 const speakerId=running?identity.activeId:identity.failedId?null:identity.displayId;
 const speaker=members.find(c=>c.id===speakerId),recorded=running?runtime.pendingMessage?.request:identity.failedId?undefined:message?.request;
 const route=speaker?.effectiveConnection;
 return {group,members,running,speaker,recorded,route,model:recorded?.model||route?.model||'',speakingSpeaker:members.find(c=>c.id===identity.speakingId),failedSpeaker:members.find(c=>c.id===identity.failedId),displaySpeaker:members.find(c=>c.id===identity.displayId),persona:state.personas?.find(p=>p.id===group.personaId)};
}
const groupPaperSubtitle={rename:'Group name',history:'Backlog',gallery:'Group gallery',background:'Group background',connections:'Connections',settings:'Group'};
function Modal({title,onClose,small=false,wide=false,children,busy=false,kind,footer,galgame=false}){
 const subtitle=galgame&&groupPaperSubtitle[kind];
 const ref=useRef(null),focus=useRef(null);
 useEffect(()=>{focus.current=document.activeElement;ref.current?.showModal();return()=>{ref.current?.close();focus.current?.isConnected&&focus.current.focus({preventScroll:true});};},[]);
 return h('dialog',{ref,className:'buddy-dialog buddy-group-modal'+(subtitle?' gx-paper-dialog'+(kind==='rename'?' gx-paper-small':''):'')+(!subtitle&&small?' buddy-group-small':'')+(!subtitle&&wide?' buddy-group-wide':''),'aria-label':t(title),'data-group-dialog':kind,onCancel:e=>{e.preventDefault();if(!busy)onClose();},onWheel:e=>e.stopPropagation()},
  h('header',{className:subtitle?'gx-paper-head':undefined},subtitle?h(GalgamePaperHeading,{title:t(title),subtitle,onClose,busy}):h(F,null,h('h2',null,t(title)),h('button',{type:'button',className:'buddy-dialog-close ui-icon-btn',onClick:onClose,disabled:busy,'aria-label':t('关闭')+' · '+t(title)},Icon('close',{size:18})))),
  h('div',{className:'buddy-group-modal-body'},children),
  footer&&h('footer',{className:'buddy-group-modal-foot'},footer));
}
function GroupRename({group,request,onClose,galgame}){
 const [name,setName]=useState(group.name),[busy,setBusy]=useState(false),[error,setError]=useState(''),id=React.useId();
 return h(Modal,{galgame,title:'编辑群聊名称',small:true,onClose,busy,kind:'rename',footer:h(F,null,h('span',{className:'spacer'}),button('取消',onClose,{disabled:busy}),h('button',{type:'submit',form:id,className:'whg-btn buddy-primary',disabled:busy||!name.trim()},t('保存')))},
  h('form',{id,onSubmit:async e=>{e.preventDefault();if(busy||!name.trim())return;setBusy(true);try{await request('companion-group-save',{id:group.id,name:name.trim()});onClose();}catch(e){setError(e.message);}finally{setBusy(false);}}},
   h('label',{className:'buddy-field'},h('span',{className:'buddy-field-label'},t('群名')),h('input',{className:'buddy-group-input',value:name,autoFocus:true,maxLength:200,'aria-label':t('群名'),disabled:busy,onChange:e=>setName(e.target.value)})),
   h('small',{className:'buddy-count-row'},h('span',null,t('只改群名，不影响成员和记录。')),h('span',null,name.length+' / 200')),
   error&&h('p',{role:'alert',className:'buddy-error'},error)));
}
function Background({context,request,resolveArt,onClose,galgame}){
 const {group}=context,[background,setBackground]=useState(group.background||''),[table,setTable]=useState(group.sceneTemplate!=='plain'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const library=table?'assets/group-scene/galgame-library.jpg':resolveArt('bg-kimi-moonlit-reading-study'),choices=[{key:'',name:t('默认图书室'),src:library}];
 for(const c of context.members)if(c.background&&!choices.some(x=>x.key===c.background))choices.push({key:c.background,name:companionCharacterName(c)+' · '+t('内置场景'),src:companionImage(c.background,resolveArt)});
 const custom=!!background&&!choices.some(c=>c.key===background),preview=companionImage(background,resolveArt)||(!background?library:null);
 const card=(key,name,src,props={})=>h('button',{type:'button',key:key||'default',role:'radio','aria-checked':background===key,className:'buddy-group-bg-card',disabled:busy,onClick:()=>setBackground(key),...props},h('i',{style:src?{backgroundImage:`url("${src}")`}:undefined}),h('b',null,name));
 const save=async()=>{if(busy)return;setBusy(true);try{await request('companion-group-save',{id:group.id,background,sceneTemplate:table?'library':'plain'});onClose();}catch(e){setError(e.message);}finally{setBusy(false);}};
 return h(Modal,{galgame,title:'群聊背景',onClose,busy,kind:'background',footer:h(F,null,h('button',{type:'button',className:'whg-btn buddy-ghost',disabled:busy,onClick:()=>setBackground('')},t('恢复默认')),h('span',{className:'spacer'}),button('取消',onClose,{disabled:busy}),h('button',{type:'button',className:'whg-btn buddy-primary',disabled:busy,onClick:()=>void save()},t('保存背景')))},
  h('p',{className:'buddy-note'},t('只修改当前群聊背景，不改变任何角色的私聊背景。')),
  preview&&h('div',{className:'buddy-group-bg-preview'},h('img',{className:'buddy-group-background-preview',src:preview,alt:t('群聊背景预览')}),h('span',{className:'ws-tag'},t('预览'))),
  h('div',{className:'buddy-group-bg-cards',role:'radiogroup','aria-label':t('选择群聊场景')},...choices.map(c=>card(c.key,c.name,c.src)),custom&&card(background,t('自定义背景'),preview)),
  h(ImageField,{label:'上传群聊背景',value:custom?background:'',onChange:setBackground,disabled:busy,resolveArt,onError:setError}),
  h('div',{className:'buddy-switch-row wide'},h('div',null,h('b',null,t('显示圆桌前景')),h('small',null,t('关掉后只显示背景和成员。'))),h(Switch,{checked:table,disabled:busy,label:t('显示圆桌前景'),onChange:setTable})),
  error&&h('p',{className:'buddy-error',role:'alert'},error));
}
function Members({context,resolveArt,onBrowse,onClose,trigger}){
 const box=useRef(null),search=useRef(null),inputId=React.useId(),[query,setQuery]=useState('');
 const speakerId=context.speakingSpeaker?.id;
 const members=context.members.filter(c=>companionCharacterName(c).toLowerCase().includes(query.trim().toLowerCase()));
 const dismiss=useCallback((restoreFocus=false)=>{
  if(restoreFocus){
   const anchor=trigger?.getClientRects().length?trigger:box.current?.closest('.gx-redesign')?.querySelector('[data-galgame-roster]');
   anchor?.focus({preventScroll:true});
  }
  onClose();
 },[trigger,onClose]);
 useEffect(()=>{
  const node=box.current,stage=node?.closest('.gx-redesign');
  if(!node||!stage)return;
  const rail=stage.querySelector('[data-galgame-roster]');
  const toolbar=stage.matches('.classic')?null:stage.querySelector('.corner.br');
  const history=toolbar&&stage.querySelector('.corner.tr > .glass:nth-child(2)');
  const place=()=>{
   const bounds=stage.getBoundingClientRect(),hasRail=rail?.getClientRects().length>0;
   const anchor=(hasRail?rail:trigger)?.getBoundingClientRect();
   const width=Math.min(330,bounds.width-24);
   const preferredLeft=hasRail?anchor.left-bounds.left-width-12:anchor?anchor.left-bounds.left:12;
   const preferredTop=hasRail?120:anchor?anchor.bottom-bounds.top+10:60;
   const safeTop=toolbar?Math.max(12,Math.ceil(Math.max(toolbar.getBoundingClientRect().bottom,history?.getBoundingClientRect().bottom??0)-bounds.top+10)):12;
   node.style.left=Math.max(12,Math.min(bounds.width-width-12,preferredLeft))+'px';
   if(toolbar)node.style.maxHeight=Math.max(0,bounds.height-safeTop-12)+'px';
   node.style.top=Math.max(safeTop,Math.min(bounds.height-node.offsetHeight-12,preferredTop))+'px';
  };
  const outside=event=>{
   if(!node.contains(event.target)&&!trigger?.contains(event.target)&&!rail?.contains(event.target))onClose();
  };
  const escape=event=>{
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss(true);}
  };
  const observer=new ResizeObserver(place);
  observer.observe(stage);observer.observe(node);
  if(rail)observer.observe(rail);
  if(toolbar)observer.observe(toolbar);
  if(history)observer.observe(history);
  if(trigger&&trigger!==rail)observer.observe(trigger);
  place();
  search.current?.focus({preventScroll:true});
  document.addEventListener('pointerdown',outside);
  document.addEventListener('keydown',escape,true);
  return()=>{
   observer.disconnect();
   document.removeEventListener('pointerdown',outside);
   document.removeEventListener('keydown',escape,true);
  };
 },[trigger,onClose,dismiss]);
 return h('section',{ref:box,id:'galgame-members',className:'gx-members-pop',role:'dialog','aria-label':t('在场角色')},
  h('h5',null,t('在场角色')),
  h('label',{className:'gx-members-search',htmlFor:inputId},GalgameIcon('search'),
   h('input',{id:inputId,ref:search,type:'search','aria-label':t('搜索成员'),placeholder:t('搜索成员'),value:query,onChange:event=>setQuery(event.target.value)})),
  h('div',{className:'gx-members-list'},...members.map(c=>h('div',{className:'row',key:c.id},
   face(c,resolveArt,'hd',groupMemberAvatar),h('div',{className:'grow'},companionCharacterName(c),
    h('div',{className:'sub'},t(speakerId===c.id?'正在发言':context.group.mutedIds?.includes(c.id)?'在场 · 静音':'在场'))),
   button('查看',()=>{onBrowse?.(c.id);dismiss(true);},{className:'b','aria-label':t('查看')+' '+companionCharacterName(c),'data-group-member-view':c.id})))),
  !members.length&&h('p',{className:'sub',role:'status'},t('没有找到这个成员')),
  h('hr'),
  h('footer',{className:'acts'},
   button('回到发言者',()=>{onBrowse?.(null);dismiss(true);},{className:'b'}),
   button('完成',()=>dismiss(true),{className:'b pri'})));
}

function Connections({context,request,resolveArt,onClose,galgame}){
 const [profiles,setProfiles]=useState([]),[loaded,setLoaded]=useState(false),[draft,setDraft]=useState(()=>Object.fromEntries(context.members.map(c=>[c.id,c.modelBinding?.enabled?c.modelBinding.connectionId:'']))),[busy,setBusy]=useState(null),[error,setError]=useState(''),[saved,setSaved]=useState(null);
 useEffect(()=>{let live=true;window.whale.models.get().then(v=>{if(live){setProfiles(v.profiles||[]);setLoaded(true);}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[]);
 // A choice is saved as soon as it is made; a failed save puts the old choice back.
 const choose=async(c,value)=>{if(busy)return;const before=draft[c.id]||'';setDraft(old=>({...old,[c.id]:value}));setSaved(null);setBusy(c.id);setError('');try{await request('companion-character-save',{id:c.id,modelBinding:{enabled:!!value,connectionId:value||null}});setSaved(c.id);}catch(e){setDraft(old=>({...old,[c.id]:before}));setError(e.message);}finally{setBusy(null);}};
 const savedName=saved&&companionCharacterName(context.members.find(c=>c.id===saved));
 return h(Modal,{galgame,title:'成员的聊天连接',onClose,busy:!!busy,kind:'connections',footer:h(F,null,h('span',{className:'spacer buddy-note'+(saved?' buddy-ok':''),role:'status'},saved&&Icon('check',{size:14}),saved?savedName+t(' 的连接已保存'):t('选完立即保存。')),h('button',{type:'button',className:'whg-btn buddy-primary',onClick:onClose,disabled:!!busy},t('完成')))},
  h('p',{className:'buddy-note'},t('默认跟随全局连接；专属连接用于该角色之后的私聊和群聊，不改变全局连接。')),
  ...context.members.map(c=>{const route=c.effectiveConnection||{},now=context.speaker?.id===c.id,model=now&&context.recorded?.model?context.recorded.model:route.model;return h('section',{className:'buddy-group-route'+(now?' now':''),key:c.id,'data-group-api-member':c.id},face(c,resolveArt,'buddy-face lg',groupMemberAvatar),
   h('div',{className:'spacer'},h('strong',null,companionCharacterName(c),context.speakingSpeaker?.id===c.id&&h('span',{className:'ws-tag'},t('正在说话'))),h('small',null,route.error?t(route.error):[t(route.mode==='character'?'角色专属':'跟随全局'),route.name,model].filter(Boolean).join(' · '))),
   h('select',{className:'buddy-group-input',value:draft[c.id]||'','aria-label':companionCharacterName(c)+' API',disabled:!loaded||!!busy,onChange:e=>void choose(c,e.target.value)},h('option',{value:''},t('跟随全局连接')),draft[c.id]&&!profiles.some(p=>p.id===draft[c.id])&&h('option',{value:draft[c.id],disabled:true},t('原连接已不可用')),...profiles.map(p=>h('option',{key:p.id,value:p.id,disabled:p.enabled===false||p.capabilities?.chat===false},p.name+' · '+p.model))));}),
  error&&h('p',{className:'buddy-error',role:'alert'},error));
}
function History({state,context,request,resolveArt,onClose,renderHistoryPortrait,galgame}){
 const [query,setQuery]=useState(''),[error,setError]=useState(''),[status,setStatus]=useState(''),[historySelection,setHistorySelection]=useState(null);
 const page=useCompanionHistoryPage({request,ownerType:'group',ownerId:context.group.id,search:query,currentRevision:state.revision,initial:state.groupMessages?.filter(row=>row.status!=='pending-presentation')});
 const messages=page.messages;
 const exportLog=async()=>{setError('');try{const result=await request('companion-group-export',{id:context.group.id}),url=URL.createObjectURL(new Blob([JSON.stringify(result.data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='AI-Buddy-group-'+context.group.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setStatus(t('群聊已导出；可在对话历史中恢复。'));}catch(e){setError(t(cleanIpcMessage(e?.message??e)));}};
 return h(Modal,{galgame,title:t('群聊记录')+' · '+context.group.name,onClose,kind:'history',footer:h(F,null,h('button',{type:'button',className:'whg-btn buddy-ghost',onClick:()=>void exportLog()},Icon('download',{size:14}),t('导出群聊记录')),h('span',{className:'spacer buddy-note',role:'status'},status),button('关闭',onClose))},
  historySelection&&renderHistoryPortrait&&h(HistoryExpressionPreview,{preview:historySelection,portrait:renderHistoryPortrait,onClose:()=>setHistorySelection(null)}),
  h('div',{className:'buddy-group-history-tools'},h('label',{className:'buddy-searchbox'},Icon('search',{size:15}),h('input',{type:'search',placeholder:t('搜索本群消息'),'aria-label':t('搜索本群消息'),value:query,onChange:e=>setQuery(e.target.value)})),h('small',{className:'buddy-muted'},t('共 {n} 条').replace('{n}',String(page.totalCount)))),
  h('div',{className:'buddy-msgs buddy-group-history-list',ref:page.scrollRef,onScroll:page.onScroll},
   page.hasMore&&h('button',{type:'button',className:'buddy-history-page-more b',disabled:page.pending,onClick:page.loadOlder},t(page.pending?'读取中…':'加载更早的消息')),
   h('div',{className:'buddy-msgs',ref:page.listRef},...messages.map(m=>{const mine=m.role==='user',c=state.characters?.find(x=>x.id===m.characterId);return h('article',{key:historyMessageKey(m),className:'buddy-message'+(mine?' me':''),'data-group-history-message':m.id,'data-history-message-id':historyMessageKey(m),style:mine?undefined:plateVars({characterId:m.characterId,color:c?.color})},mine?h('span',{className:'buddy-face blank','aria-hidden':true},Icon('person',{size:15})):face(c,resolveArt,'buddy-face'),h('div',{className:'buddy-message-main'},h('div',{className:'buddy-message-head'},h('strong',null,mine?(m.personaName||m.personaSnapshot?.nickname||t('你')):(m.characterName||companionCharacterName(c))),h('small',{className:'buddy-muted'},m.createdAt?new Date(m.createdAt).toLocaleString():'')),h('p',{className:'buddy-message-body'},mine?m.text:h(HistoryExpressionText,{message:m,text:m.text,onPreview:renderHistoryPortrait&&c?(sentence,text)=>setHistorySelection({character:c,emotion:sentence.emotion,text}):null}))));}))),
  messages.length===0&&h('p',{className:'buddy-note',role:'status'},t(page.pending?'读取中…':'没有匹配的群聊消息。')),
  page.error&&h('p',{role:'alert',className:'buddy-error'},t(String(page.error.message||page.error)),button('重试',page.retry)),
  error&&h('p',{role:'alert',className:'buddy-error'},error));
}
function GroupModePopover({group,request,blocked,returnFocus,onClose}){
 const popover=useRef(null),lifetime=useRef(null),closeRef=useRef(onClose);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 closeRef.current=onClose;
 useEffect(()=>{
  const turn={saving:false};lifetime.current=turn;
  const node=popover.current;
  (node.querySelector('[aria-pressed=true]:not(:disabled)')||node).focus({preventScroll:true});
  const dismiss=event=>{
   if(!node.contains(event.target)&&!event.target.closest?.('[data-group-mode]'))closeRef.current();
  };
  const escape=event=>{
   if(event.key!=='Escape')return;
   event.preventDefault();
   event.stopPropagation();
   closeRef.current();
   returnFocus?.focus({preventScroll:true});
  };
  document.addEventListener('pointerdown',dismiss,true);
  document.addEventListener('keydown',escape,true);
  return()=>{lifetime.current=null;document.removeEventListener('pointerdown',dismiss,true);document.removeEventListener('keydown',escape,true);};
 },[returnFocus]);
 const selected=MODE_NAMES[group.mode]?group.mode:'natural';
 const select=async mode=>{
  const turn=lifetime.current;
  if(!turn||turn.saving||blocked||mode===selected)return;
  turn.saving=true;setBusy(true);setError('');
  try{
   await request('companion-group-save',{id:group.id,mode});
   if(lifetime.current===turn){onClose();returnFocus?.focus({preventScroll:true});}
  }catch(reason){
   if(lifetime.current===turn)setError(t(reason?.message||'操作失败'));
  }finally{
   turn.saving=false;
   if(lifetime.current===turn)setBusy(false);
  }
 };
 return h('section',{ref:popover,id:'galgame-group-mode',className:'gx-mode-pop',role:'region','aria-label':t('发言方式'),tabIndex:-1,'aria-busy':busy,'data-group-dialog':'mode'},
  h('h5',null,t('发言方式')),
  ...groupModes.map(([value,label])=>h('button',{type:'button',key:value,'aria-pressed':selected===value,disabled:blocked||busy,onClick:()=>void select(value)},
   h('span',{className:'gx-mode-label'},t(label),h('small',null,t(groupModeHelp[value]))),selected===value&&GalgameIcon('check'))),
  blocked&&h('p',{className:'gx-mode-note'},t('请先完成或停止当前轮次，再修改发言方式')),
  error&&h('p',{className:'gx-mode-note',role:'alert'},error));
}
function Settings({state,request,resolveArt,onClose,galgame}){
 const [feedback,setFeedback]=useState('');return h(Modal,{galgame,title:'群聊设置',wide:true,onClose,kind:'settings'},h(GroupEditor,{state,request,resolveArt,onClose,setFeedback}),feedback&&h('p',{role:'status'},feedback));
}
export function GroupHeader({state,request,resolveArt=()=>null,onBrowse,petEnabled,onPetToggle,panelRequest,loadCg,toolbarRef,chat,onToggleChat,r95Action,onOpenSocial,voiceControls,stopReading,stageUi={},onSettings,renderHistoryPortrait,onGroupPhoto,classic=true,galgame=false}){
 const [panel,setPanel]=useState(null),[cgSelection,setCgSelection]=useState(null),[leaving,setLeaving]=useState(false),[error,setError]=useState(''),context=groupHeaderContext(state),catalog=useGroupCg(context?.group,request);
 useEffect(()=>setPanel(null),[state.activeGroupId]);
 const modeReturnFocus=useRef(null),groupMenuTrigger=useRef(null),membersTrigger=useRef(null),ending=useRef(false);
 useEffect(()=>{if(panelRequest?.groupId===state.activeGroupId){if(panelRequest.panel==='members')membersTrigger.current=panelRequest.trigger??document.activeElement;setPanel(panelRequest.panel);if(panelRequest.panel==='gallery')setCgSelection(panelRequest.cgId||null);}},[panelRequest]);
 const closeMembers=useCallback(()=>setPanel(value=>value==='members'?null:value),[]);
 if(!context)return null;
 const latest=catalog.items.find(activeGroupCg)||catalog.items[0],{group,members,speaker,model}=context,close=()=>setPanel(null);
 const actual=speaker?companionCharacterName(speaker)+' · '+(model||t('未配置')):t('按成员配置');
 const cgTitle=catalog.error?t('CG 状态读取失败：')+catalog.error:latest?groupCgLabel(latest)+(latest.model?' · '+latest.model:''):t('CG 图鉴');
 const status=state.groupRuntime?.status??'idle',busy=GROUP_BUSY_STATUSES.includes(status),roundActive=status!=='idle';
 const end=async()=>{
  if(roundActive||ending.current)return;
  ending.current=true;stageUi.closeMenu?.();setError('');
  try{await request('companion-group-end',{id:group.id});}
  catch(error){setError(t(String(error?.message??error)));}
  finally{ending.current=false;}
 };
 const leave=async()=>{if(leaving)return;setLeaving(true);setError('');try{await request('companion-group-close',{id:group.id});}catch(e){setError(String(e?.message||e));}finally{setLeaving(false);}};
 const open=kind=>()=>{stageUi.closeMenu?.();setPanel(kind);};
 const openMembers=event=>{membersTrigger.current=event.currentTarget.closest('.menu')?groupMenuTrigger.current:event.currentTarget;stageUi.closeMenu?.();setPanel(value=>value==='members'?null:'members');};
 const openMode=event=>{modeReturnFocus.current=event.currentTarget.closest('.menu')?groupMenuTrigger.current:event.currentTarget;stageUi.closeMenu?.();setPanel(current=>current==='mode'?null:'mode');};
 const modeProps={'data-group-mode':true,'aria-controls':'galgame-group-mode','aria-expanded':panel==='mode'};
 const gallery=()=>{stageUi.closeMenu?.();setCgSelection(latest?.id||null);setPanel('gallery');};
 const network=chat&&(state.r95&&r95Action?h(R95NetButton,{view:state.r95,onAction:r95Action,chat:{enabled:!!chat.enabled,onToggle:()=>onToggleChat?.()}}):h('div',{className:'gx-net','data-group-net':true},GalgameIcon('globe'),h('span',null,t('联网群聊')),h(Switch,{checked:!!chat.enabled,label:t('联网群聊'),onChange:()=>onToggleChat?.()})));
 return h('div',{'data-group-header':group.id,role:'toolbar','aria-label':t('群聊工具栏')},
  GlassCorner('tl',GlassGroup(
   GlassButton({'aria-label':t('编辑群聊名称'),title:group.name,onClick:open('rename')},GalgameIcon('users'),h('b',{className:'gx-group-title'},group.name),GalgameIcon('edit')),
   GlassDivider(),GlassButton({'data-group-members':true,'aria-controls':'galgame-members','aria-expanded':panel==='members',title:t('在场角色'),onClick:openMembers},t('在场')+' '+members.length),
   h('span',{className:'gs mode-group','aria-hidden':true}),GlassButton({className:'mode-group',...modeProps,onClick:openMode},t('发言方式')+' · '+t(MODE_NAMES[group.mode]||'自然接话')))),
  GlassCorner('tr',
   GlassGroup(voiceControls,voiceControls&&GlassDivider(),network,network&&GlassDivider(),GlassButton({'aria-label':t('菜单'),'aria-expanded':stageUi.menu,'data-galgame-menu':true,ref:groupMenuTrigger,onClick:stageUi.toggleMenu},GalgameIcon('menu'))),
   GlassGroup(GlassButton({'aria-label':t('群聊记录'),title:t('群聊记录'),onClick:open('history')},GalgameIcon('hist')))),
  GlassCorner('br',GlassGroup(
   stopReading,stopReading&&GlassDivider(),
   state.r95&&r95Action&&h('div',{'data-chat-toolbar':'group',className:'r95-toolbar'},h(AutoChip,{view:{...state.r95,groupId:state.r95.groupId??group.id},onAction:r95Action,nameOf:id=>companionCharacterName(state.characters?.find(c=>c.id===id))||t('成员'),onOpenSocial})),
   GlassDivider(),GlassButton({'aria-label':t('CG 图鉴'),title:cgTitle,className:'buddy-cg-chip','data-status':catalog.error?'failed':latest?.status,'data-active':activeGroupCg(latest),onClick:gallery},GalgameIcon('image')),
   state.r95&&r95Action&&GlassDivider(),
   state.r95&&r95Action&&h('div',{className:'r95-toolbar'},h(MoodChip,{galgame,view:state.r95,onAction:r95Action,onOpenSocial,voiceControls})),
   GlassDivider(),GlassHideButton(stageUi.hide))),
  h('div',{ref:toolbarRef,className:classic?'buddy-group-stage-controls gx-group-stage-controls':'gx-group-stage-notices'}),
  stageUi.menu&&h('div',{className:'menu','aria-label':t('菜单')},
   h('div',{className:'mh'},h('button',{type:'button',onClick:open('rename')},group.name,GalgameIcon('edit'))),h('hr'),
   GlassMenuItem('check',t('发言方式'),openMode,modeProps),
   GlassMenuItem('image',t('群聊背景'),open('background')),
   GlassMenuItem('users',t('在场角色'),openMembers,{'aria-controls':'galgame-members','aria-expanded':panel==='members'}),
   GlassMenuItem('gear',t('管理群聊'),open('settings')),h('hr'),
   GlassMenuItem('link',t('对话模型'),open('connections'),{'data-group-connections':true,title:t('实际对话 · ')+actual}),
   GlassMenuItem('hist',t('群聊记录'),open('history')),
   GlassMenuItem('image',t('CG 图鉴'),gallery),GlassMenuItem('image',t('群聊合影'),()=>{stageUi.closeMenu?.();onGroupPhoto?.();},{disabled:classic?busy:roundActive}),
   !classic&&GlassMenuItem('stop',t('结束本次聊天'),()=>void end(),{disabled:roundActive||ending.current,'data-galgame-group-end':true}),h('hr'),
   GlassMenuItem('pet',t('桌宠'),()=>{stageUi.closeMenu?.();onPetToggle?.();},{'aria-pressed':petEnabled}),
   GlassMenuItem('gear',t('设置'),()=>{stageUi.closeMenu?.();onSettings?.();}),
   GlassMenuItem('back',t('回到私聊'),()=>{stageUi.closeMenu?.();void leave();},{disabled:busy||leaving})),
  error&&h('p',{className:'buddy-error gx-group-feedback',role:'alert'},error),
  panel==='mode'&&h(GroupModePopover,{group,request,blocked:!!state.groupRuntime?.status&&state.groupRuntime.status!=='idle',returnFocus:modeReturnFocus.current,onClose:()=>setPanel(current=>current==='mode'?null:current)}),
  panel==='rename'&&h(GroupRename,{galgame,group,request,onClose:close}),panel==='members'&&h(Members,{context,resolveArt,onBrowse,onClose:closeMembers,trigger:membersTrigger.current}),panel==='background'&&h(Background,{galgame,context,request,resolveArt,onClose:close}),panel==='connections'&&h(Connections,{galgame,context,request,resolveArt,onClose:close}),panel==='history'&&h(History,{galgame,context,state,request,resolveArt,renderHistoryPortrait,onClose:close}),panel==='gallery'&&h(GroupCgGallery,{galgame,catalog,request,loadImage:loadCg,onClose:close,Dialog:Modal,selectedId:cgSelection}),panel==='settings'&&h(Settings,{galgame,state,request,resolveArt,onClose:close}));
}
