// Chat-side pieces of the approved designs C6-C9 (Galgame and group chat): toolbar chips and popovers, the
// More menu, Auto progress, sources under a reply, her proactive lines and the sidebar unread dot.
// Reading, presenting and every Auto action still go through the companion-r95 action bridge.
import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {t,locale} from './i18n.mjs';
import {Icon} from './ui-icons.mjs';
import {Segmented} from './ui-controls.mjs';
import {themeAsset,THEMES} from './appearance.mjs';
import {MoodCard} from './social-core-ui.mjs';
import {safeSearchUrl} from './native-search.mjs';
import {scheduleRenderedAck,r95ElementVisible} from './r95-core-page.mjs';
const h=React.createElement,F=React.Fragment;
const english=()=>locale()==='en';
export const fill=(text,values={})=>Object.entries(values).reduce((out,[key,value])=>out.replaceAll('{'+key+'}',String(value)),String(text));
// English needs "1 source" but "3 sources", so n=1 has its own entry (the key with {n} replaced by 1).
export const tn=(key,n,values={})=>fill(t(n===1?key.replace('{n}','1'):key),{...values,n});
export const clock=at=>Number.isFinite(at)&&at>0?new Date(at).toLocaleTimeString(english()?'en-US':'zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}):'';
export const listJoin=names=>names.filter(Boolean).join(english()?', ':'、');
export const characterLabel=(id,view)=>(view?.feeding?.activeScope?.characterId===id&&view.feeding.characterName)||(english()&&THEMES[id]?.nameEn)||THEMES[id]?.name||t('她');
const face=(id,name)=>h('span',{key:id,className:'gx-face','aria-hidden':true},THEMES[id]?h('img',{src:'./'+themeAsset(id,'head.webp'),alt:'',draggable:false}):String(name||'?').slice(0,1));

// An anchored panel like the toolbar's other chips. Never a <dialog> or aria-modal, so an open panel does not hold
// back the two-frame presentation check of a line (scheduleRenderedAck). Outside click and Esc close it.
export function ChatPop({label,chip,className='',buttonClass='gx-tb r95-chip',chevron=true,role='group',disabled=false,initialOpen=false,children,...rest}){
 const [open,setOpen]=useState(initialOpen),box=useRef(null),close=()=>setOpen(false);
 useEffect(()=>{if(!open)return;const away=event=>{if(!box.current?.contains(event.target))setOpen(false);},key=event=>{if(event.key==='Escape'){setOpen(false);box.current?.querySelector('button')?.focus({preventScroll:true});}};document.addEventListener('pointerdown',away);document.addEventListener('keydown',key);return()=>{document.removeEventListener('pointerdown',away);document.removeEventListener('keydown',key);};},[open]);
 return h('div',{className:'r95-pop-wrap'+(className?' '+className:''),ref:box,...rest},h('button',{type:'button',className:buttonClass+(open?' open':''),'aria-expanded':open,'aria-haspopup':role==='menu'?'menu':'true','aria-label':label,title:label,disabled,onClick:()=>setOpen(value=>!value)},chip,chevron&&Icon('chevron',{size:12})),
  open&&h('div',{className:'r95-pop',role,'aria-label':label},typeof children==='function'?children(close):children));
}

// The same label the read-only mood card shows (overall label, else the mood's own label), translated when known.
export function chatMoodLabel(view){const mood=view?.mood??{},label=mood.overall?.label??mood.label;return typeof label==='string'&&label.trim()?t(label):t('暂无评估');}
export function MoodChip({view,onAction,onOpenSocial,initialOpen}){
 if(!view)return null;const label=chatMoodLabel(view);
 return h(ChatPop,{initialOpen,label:t('心情')+' · '+label,className:'r95-mood-pop','data-chat-mood':true,chip:h(F,null,h('span',{className:'r95-mooddot','aria-hidden':true}),h('span',null,t('心情')+' · '+label))},close=>h(F,null,
  h('div',{className:'r95-pop-h'},t('心情'),h('small',null,t('只读'))),
  h(MoodCard,{view:{...view,language:locale()},onAction,compact:true}),
  onOpenSocial&&h('div',{className:'r95-pop-f'},h('span',{className:'grow'}),h('button',{type:'button',className:'ui-btn ghost sm','data-open-social':'mood',onClick:()=>{close();onOpenSocial();}},t('在社交设置里看')))));
}

// Round n of total (when the session has a round limit), who speaks now and who is next (approved design C6).
// roundIndex counts finished rounds; members take turns in order and the speaker holds auto.pending.
export function autoProgress(auto){
 if(!auto||auto.status==='ended')return null;
 const members=Array.isArray(auto.members)?auto.members.filter(id=>typeof id==='string'):[],count=members.length,done=Number.isSafeInteger(auto.roundIndex)&&auto.roundIndex>0?auto.roundIndex:0,total=auto.mode==='rounds'&&Number.isSafeInteger(auto.roundLimit)&&auto.roundLimit>0?auto.roundLimit:null;
 const round=total?Math.min(done+1,total):done+1,pendingStatus=auto.pending?.status,blocked=['failed','unknown','cancelled'].includes(pendingStatus),failed=pendingStatus==='failed'?auto.pending.characterId:null,unresolved=blocked?auto.pending.characterId:null,speaking=!blocked&&typeof auto.pending?.characterId==='string'?auto.pending.characterId:null;
 let index=Number.isSafeInteger(auto.opportunityIndex)?auto.opportunityIndex:0,nextRound=done+1;
 if(speaking){index++;if(index>=count){index=0;nextRound++;}}
 const next=!blocked&&count&&!(total&&nextRound>total)?members[index%count]??null:null;
 return {status:blocked?'paused':auto.status,round,total,done,speaking,next,members,mode:auto.mode,failed,unresolved,pendingStatus};
}
export const autoRoundText=progress=>progress.total?fill(t('第 {n} / {total} 轮'),{n:progress.round,total:progress.total}):fill(t('第 {n} 轮'),{n:progress.round});
function useRun(onAction){const [pending,setPending]=useState(false),[error,setError]=useState(''),lock=useRef(false);return {pending,error,run:async(action,args)=>{if(lock.current)return;lock.current=true;setPending(true);setError('');try{await onAction(action,args);}catch(e){setError(String(e?.message??e));}finally{lock.current=false;setPending(false);}}};}
// Settings before a start, progress and Pause / Stop while it runs. Each start still confirms the members; a
// pending or unreconciled request cannot be submitted again.
export function GroupAutoPanel({view={},onAction,nameOf=id=>id,onOpenSocial}){
 const auto=view.auto??null,progress=autoProgress(auto),running=!!progress,[mode,setMode]=useState('rounds'),[rounds,setRounds]=useState(6),{pending,error,run}=useRun(onAction);
 const groupId=view.groupId,enabled=view.settings?.auto===true,act=action=>()=>void run(action,{groupId});
 const members=running?progress.members:(Array.isArray(view.members)?view.members:[]),names=members.map(nameOf);
 const status={active:t('正在进行'),paused:t('已暂停')}[progress?.status]??'';
 const validRounds=Number.isSafeInteger(rounds)&&rounds>=1&&rounds<=100000;
 return h('section',{'data-r95-auto':groupId??'',className:'r95-auto-controls'},
  h('h3',{className:'r95-pop-h'},Icon('play',{size:16}),t('群聊 Auto'),running&&h('small',null,status)),
  !running&&h(F,null,
   h('div',{className:'ws-fld'},h('span',null,t('结束方式')),h(Segmented,{label:t('结束方式'),value:mode,options:[['rounds',t('指定轮数')],['until-stopped',t('直到我停止')],['ai-end',t('让 AI 决定')]],onChange:setMode})),
   mode==='rounds'&&h('label',{className:'ws-fld'},h('span',null,t('轮数上限')),h('input',{type:'number',min:1,max:100000,value:Number.isFinite(rounds)?rounds:'',onChange:event=>setRounds(event.target.valueAsNumber)}))),
  running&&h('div',{className:'r95-autoprog'+(progress.total?' meter':''),role:'status','data-auto-progress':progress.round+'/'+(progress.total??'')},
   progress.total?h('span',{className:'r95-tnum'},h('b',null,String(progress.round)),' / '+progress.total+' '+t('轮')):h('span',{className:'r95-tnum'},autoRoundText(progress)),
   progress.total&&h('span',{className:'ws-meter'},h('b',{style:{width:Math.round(progress.round/progress.total*100)+'%'}}))),
  running&&progress.next&&h('p',{className:'r95-cap','data-auto-next':progress.next},fill(t('下一位：{name}'),{name:nameOf(progress.next)})),
  h('p',{className:'r95-cap'},t('每轮每位成员各有一次机会，可以不说；AI 也可以提前结束。')),
  mode!=='rounds'&&!running&&h('p',{role:'status',className:'r95-warn'},Icon('alert',{size:12}),t('此模式可能产生更多模型用量。')),
  h('div',{className:'r95-auto-who'},...members.map((id,i)=>face(id,names[i])),h('span',{className:'r95-cap'},running?t('本次成员已确认'):t('本次成员：')+listJoin(names))),
  !enabled&&!running&&h('div',{className:'r95-auto-off',role:'status'},h('span',{className:'r95-cap'},t('社交与心情里还没有允许群聊 Auto。')),onOpenSocial&&h('button',{type:'button',className:'ui-btn ghost sm','data-open-social':'auto',onClick:onOpenSocial},t('去开启'))),
  h('div',{className:'r95-row'},!running&&h('button',{type:'button',className:'ui-btn sm primary',disabled:pending||!enabled||!groupId||mode==='rounds'&&!validRounds,onClick:()=>void run('auto-start',{groupId,mode,rounds})},t('确认成员并开始')),
   running&&progress.status==='active'&&h('button',{type:'button',className:'ui-btn sm',disabled:pending,onClick:act('auto-pause')},Icon('pause',{size:14}),t('暂停')),
   running&&progress.status==='paused'&&h('button',{type:'button',className:'ui-btn sm',disabled:pending||!!auto.pending,onClick:act('auto-continue')},Icon('play',{size:14}),t('继续 Auto')),
   running&&h('button',{type:'button',className:'ui-btn sm danger',disabled:pending,onClick:act('auto-stop')},Icon('stop',{size:14}),t('停止 Auto'))),
  auto?.pending&&h('p',{role:'status',className:'r95-cap'},t('有待完成或核对的请求，不能重复提交。')),
  error&&h('p',{role:'alert',className:'r95-err'},error));
}
export function AutoChip({view,onAction,nameOf,onOpenSocial,initialOpen}){
 if(!view)return null;const progress=autoProgress(view.auto),status=progress?autoRoundText(progress):view.settings?.auto===true?t('未开始'):t('未开启');
 return h(ChatPop,{initialOpen,label:t('群聊 Auto')+' · '+status,className:'r95-auto-pop','data-r95-auto-menu':true,buttonClass:'gx-tb r95-chip'+(progress?' on':''),chip:h(F,null,Icon(progress?.status==='paused'?'pause':'play',{size:16}),h('span',null,'Auto'),h('small',{className:'r95-chip-st'},status))},close=>h(GroupAutoPanel,{view,onAction,nameOf,onOpenSocial:onOpenSocial&&(()=>{close();onOpenSocial();})}));
}
// The strip at the top of the group dialogue while Auto runs: who is talking, round n / total, who is next,
// whether your message waits behind hers, and Pause / Stop (approved designs C6 and C9).
export function AutoRoundStrip({view,onAction,nameOf=id=>id,busy=false,speaker='',queued=0}){
 const progress=autoProgress(view?.auto),{pending,run}=useRun(onAction);if(!progress)return null;
 const groupId=view.groupId,who=progress.unresolved?'':speaker||(progress.speaking?nameOf(progress.speaking):''),paused=progress.status==='paused',speakingBusy=busy&&!progress.unresolved;
 const detail=['Auto',autoRoundText(progress),progress.failed&&nameOf(progress.failed)+' · '+t('回复失败'),progress.next&&fill(t('下一位 {name}'),{name:nameOf(progress.next)})].filter(Boolean).join(' · ');
 return h('div',{className:'r95-roundstrip',role:'status','data-auto-strip':groupId??''},
  h('span',{className:'r95-row'},speakingBusy?h('span',{className:'ui-spinner','aria-hidden':true}):Icon(paused?'pause':'play',{size:14}),speakingBusy&&who?h('span',null,h('b',null,who),' '+t('正在说')):h('span',null,paused?t('Auto 已暂停'):t('Auto 进行中'))),
  h('small',null,detail),h('span',{className:'grow'}),
  queued>0&&h('span',{className:'ws-tag','data-r95-queued-user':queued},t('你的消息排在她后面')),
  paused?h('button',{type:'button',className:'ui-btn sm ghost',disabled:pending||!!view.auto?.pending,onClick:()=>void run('auto-continue',{groupId})},Icon('play',{size:14}),t('继续')):h('button',{type:'button',className:'ui-btn sm ghost',disabled:pending,onClick:()=>void run('auto-pause',{groupId})},Icon('pause',{size:14}),t('暂停')),
  h('button',{type:'button',className:'ui-btn sm ghost danger',disabled:pending,onClick:()=>void run('auto-stop',{groupId})},Icon('stop',{size:14}),t('停止')));
}

// The More menu that takes History / CG / Pet when the toolbar does not fit on one line (approved design C6).
export function MoreMenu({items=[],initialOpen}){
 const list=items.filter(Boolean);if(!list.length)return null;
 return h(ChatPop,{initialOpen,label:t('更多'),className:'gx-more-pop',role:'menu','data-toolbar-more':list.map(item=>item.key).join(' '),chip:h(F,null,Icon('more',{size:15}),h('span',null,t('更多')))},close=>list.map(item=>h('button',{key:item.key,type:'button',role:item.checked===undefined?'menuitem':'menuitemcheckbox','aria-checked':item.checked,disabled:item.disabled,title:item.title,className:'gx-more-item','data-more-item':item.key,onClick:event=>{const anchor=event.currentTarget.closest('.r95-pop-wrap')?.querySelector('button');close();item.onClick?.(event,anchor);}},Icon(item.icon,{size:15}),h('span',null,item.label),item.count?h('span',{className:'gx-cnt'},item.count):null)));
}
// Collapses a one-line toolbar when its content is wider than the room it has, and opens it again once the room
// is back to the width it needed. key: anything that changes the toolbar's content (language, labels).
export function useToolbarCollapse(ref,key){
 const [collapsed,setCollapsed]=useState(false),need=useRef(0),seen=useRef(key);
 if(seen.current!==key){seen.current=key;need.current=0;if(collapsed)setCollapsed(false);}
 useLayoutEffect(()=>{const node=ref.current,box=node?.parentElement;if(!node||!box||typeof ResizeObserver!=='function')return;
  const room=()=>{const style=getComputedStyle(box);return box.clientWidth-(parseFloat(style.paddingLeft)||0)-(parseFloat(style.paddingRight)||0);};
  const check=()=>{if(!collapsed){if(node.scrollWidth>Math.min(node.clientWidth,room())+1){need.current=node.scrollWidth;setCollapsed(true);}}else if(need.current&&need.current<=room())setCollapsed(false);};
  const observer=new ResizeObserver(check),mutations=typeof MutationObserver==='function'?new MutationObserver(check):null;observer.observe(box);mutations?.observe(node,{childList:true,subtree:true,characterData:true});check();return()=>{observer.disconnect();mutations?.disconnect();};},[collapsed,key]);
 return collapsed;
}

// Sources recorded with the reply itself (approved design C7): a chip next to Full text, a popover with the first
// few pages (cited ones first) and +N for the rest; links stay filtered by safeSearchUrl.
export const SOURCE_LIMIT=5;
const hostOf=url=>{try{return new URL(url).hostname.replace(/^www\./,'');}catch{return url;}};
export function sourceView(message){
 const data=message?.nativeSearch;if(!data||typeof data!=='object')return null;
 const seen=new Set(),sources=(Array.isArray(data.sources)?data.sources:[]).map((row,index)=>({...row,url:safeSearchUrl(row?.url),index})).filter(row=>row.url&&!seen.has(row.url)&&seen.add(row.url)).sort((a,b)=>(b.cited===true)-(a.cited===true)||a.index-b.index);
 const status=typeof data.status==='string'?data.status:null;
 if(status==='not-used'||!sources.length&&!['completed','failed','unavailable'].includes(status))return null;
 return {status,sources,reason:data.reason?String(data.reason):'',warn:!sources.length&&(status==='failed'||status==='unavailable')};
}
export function MessageSources({message,initialOpen}){
 const view=sourceView(message),[all,setAll]=useState(false);if(!view)return null;
 const {status,sources,reason,warn}=view,id=message.id??'';
 if(!sources.length)return h('span',{'data-r95-search-sources':id,className:'r95-src-chip'+(warn?' warn':''),title:reason||undefined},Icon(warn?'alert':'globe',{size:14}),status==='failed'?t('联网检索失败'):status==='unavailable'?t('当前连接原生联网不可用'):t('查过了，没有可用来源'));
 const shown=all?sources:sources.slice(0,SOURCE_LIMIT),more=sources.length-shown.length,label=tn('来源 {n}',sources.length);
 return h(ChatPop,{initialOpen,label,className:'r95-src-wrap','data-r95-search-sources':id,buttonClass:'r95-src-chip on',chevron:false,chip:h(F,null,Icon('globe',{size:14}),h('span',null,label))},
  h('b',{className:'r95-src-h'},tn('这次查了 {n} 个网页',sources.length)),reason&&h('p',{className:'r95-cap'},reason),
  ...shown.map(row=>h('a',{key:row.url,className:'r95-src',href:row.url,target:'_blank',rel:'noreferrer noopener','data-cited':row.cited===true||undefined},h('span',{className:'r95-fav','aria-hidden':true},hostOf(row.url).slice(0,1).toUpperCase()),h('span',null,h('b',null,row.title||hostOf(row.url)),h('small',null,hostOf(row.url))),Icon('external',{size:14}))),
  more>0&&h('button',{type:'button',className:'ui-btn ghost sm r95-src-more','data-sources-more':more,'aria-label':tn('显示其余 {n} 个来源',more),onClick:()=>setAll(true)},'+'+more));
}

// Her own lines (approved design C8): a tag with kind and time, the line, reply options, and a note when the pet
// showed it too. Presentation is still the two-frame check; reading is still speech-read. Replying counts as read
// (the caller sends speech-read when the reply goes out).
const SPEECH={proactive:['chats','主动来找你'],selftalk:['more','自言自语'],dream:['moon','梦话']};
export const speechTag=kind=>SPEECH[kind]??SPEECH.proactive;
export const speechKind=line=>line?.mode==='dream'?'dream':line?.kind==='selftalk'||line?.mode==='selfTalk'||line?.mode==='selftalk'?'selftalk':'proactive';
export const unreadLines=view=>(Array.isArray(view?.lines)?view.lines:[]).filter(line=>line&&line.status!=='read'&&typeof line.text==='string');
const petLines=new Set();
// main.mjs tells the window which line the pet showed (game:output social.updated with petMessageId).
export function notePetLine(id){if(typeof id!=='string'||!id)return;petLines.add(id);if(petLines.size>64)petLines.delete(petLines.values().next().value);}
export const petShowedLine=id=>petLines.has(id);
export function speechOptions(line,{onReply,onDismiss}){const kind=speechKind(line),dismiss=kind==='proactive'?t('知道了'):english()?'Dismiss':t('收起');return [...(kind==='dream'?[]:[{key:'reply',label:kind==='proactive'?t('回她'):t('接一句'),run:()=>onReply?.(line)}]),{key:'read',label:dismiss,run:onDismiss,needsPresented:true}];}
export function SpeechLine({line,onAction,onReply,more=0,inDialog=false,optionsRef}){
 const node=useRef(null),[error,setError]=useState(''),[read,setRead]=useState(false),[pending,setPending]=useState(false),action=useRef(onAction);action.current=onAction;
 useEffect(()=>{if(line.status!=='awaiting-presentation')return;return scheduleRenderedAck({isReady:()=>r95ElementVisible(node.current)&&node.current.textContent===line.text,send:()=>action.current('speech-presented',{messageId:line.messageId}),onError:e=>setError(e.message)});},[line.messageId,line.status,line.text]);
 const hidden=read||line.status==='read',kind=speechKind(line),[icon,tag]=SPEECH[kind],presented=line.status==='presented';
 const dismiss=async()=>{if(pending||!presented)return;setPending(true);setError('');try{await action.current('speech-read',{messageId:line.messageId});setRead(true);}catch(e){setError(e.message);}finally{setPending(false);}};
 const options=speechOptions(line,{onReply,onDismiss:()=>void dismiss()}).map(option=>({...option,disabled:option.needsPresented&&(!presented||pending)}));
 useEffect(()=>{if(!optionsRef)return;optionsRef.current=hidden?null:options;return()=>{if(optionsRef.current)optionsRef.current=null;};});
 if(hidden)return null;
 return h('article',{'data-r95-speech':line.messageId,className:'r95-speech '+kind+(inDialog?' in-dlg':'')},
  h('div',{className:'r95-speech-h'},h('span',{className:'r95-spk '+kind},Icon(icon,{size:13}),[t(tag),clock(line.at)].filter(Boolean).join(' · ')),more>0&&h('small',null,fill(t('还有 {n} 句'),{n:more}))),
  h('p',{ref:node,'data-r95-speech-text':line.messageId},line.text),
  h('div',{className:'gx-choices r95-speech-opts'},...options.map((option,index)=>h('button',{key:option.key,type:'button',className:'gx-choice','data-speech-option':option.key,disabled:option.disabled,title:option.disabled&&!presented?t('台词完整显示出来以后才能点'):undefined,onClick:option.run},h('kbd',{'aria-hidden':true},index+1),h('span',null,option.label)))),
  petShowedLine(line.messageId)&&h('p',{className:'r95-speech-pet'},Icon('paw',{size:12}),t('桌宠上也说了这一句，在哪边回应都算读过')),
  error&&h('p',{role:'alert',className:'r95-err'},error));
}
// One line at a time, oldest first; the rest wait their turn ("还有 N 句").
export function ChatSpeechLines({view,onAction,onReply,inDialog=false,optionsRef}){
 const lines=unreadLines(view);if(!lines.length)return null;const line=lines[0];
 return h('div',{'data-r95-speech-lines':true,className:'r95-speech-lines'+(inDialog?' in-dlg':'')},h(SpeechLine,{key:JSON.stringify(view?.scope??{})+line.messageId,line,onAction,onReply,more:lines.length-1,inDialog,optionsRef}));
}
// Read lines stay in the conversation history with what you said next (approved design C8).
export function speechHistory(lines=[],messages=[]){
 const users=messages.filter(row=>row?.role==='user'&&Number.isFinite(row.createdAt)).sort((a,b)=>a.createdAt-b.createdAt);
 return (Array.isArray(lines)?lines:[]).filter(line=>line&&Number.isFinite(line.at)&&typeof line.text==='string').map(line=>({line,kind:speechKind(line),reply:line.status==='read'?users.find(row=>row.createdAt>=line.at)?.text??null:null,read:line.status==='read'}));
}

// Sidebar dot (approved design C8): she has unread lines in the current conversation.
export function galgameUnread(view){const lines=unreadLines(view);if(!lines.length)return null;const id=view.scope?.characterId,name=characterLabel(id,view);return {count:lines.length,characterId:id,name,title:tn('{name} 有 {n} 句话想跟你说',lines.length,{name})};}
export function useGalgameUnread(request=globalThis.window?.whale?.game){
 const [view,setView]=useState(null),call=useRef(request);call.current=request;
 useEffect(()=>{let alive=true,busy=false;const refresh=async()=>{if(busy||document.hidden||typeof call.current!=='function')return;busy=true;try{const result=await call.current('companion-r95',{action:'view',args:{}});if(alive)setView(result?.companion?.r95??result?.r95Result??null);}catch{}finally{busy=false;}};
  void refresh();const timer=setInterval(refresh,20000),off=globalThis.window?.whale?.onOutput?.(event=>{if(event?.type==='social.updated')void refresh();});document.addEventListener('visibilitychange',refresh);
  return()=>{alive=false;clearInterval(timer);off?.();document.removeEventListener('visibilitychange',refresh);};},[]);
 return galgameUnread(view);
}

export const ChatR95CSS=`
.gx-tools[data-fit=full]{flex-wrap:nowrap}
.r95-chip.on{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-accent) 45%,transparent)}
.r95-chip.on .r95-chip-st{padding:1px 7px;border-radius:999px;background:color-mix(in srgb,var(--buddy-accent) 22%,transparent);color:var(--buddy-dlg-text);font-variant-numeric:tabular-nums}
.r95-pop-f{display:flex;align-items:center;gap:8px;margin:2px -16px -14px;padding:8px 12px;border-top:1px solid var(--buddy-border)}
.r95-pop-f .grow,.r95-roundstrip .grow,.gx-foot>.grow{flex:1}
.whg-root-tab .gx-top .r95-pop{max-height:max(160px,var(--gx-pop-room,60vh))}
.whg-root-tab .gx-row>.r95-net-pop{position:static}
.whg-root-tab .gx-row>.r95-net-pop>.r95-pop{top:100%;right:16px;left:auto}
.gx-tools .r95-auto-pop .r95-pop,.gx-tools .r95-mood-pop .r95-pop{left:auto;right:0}
.r95-auto-pop .r95-pop{width:min(380px,calc(100vw - 48px))}
.r95-auto-pop .ui-seg{display:flex;flex-wrap:wrap;width:100%;box-sizing:border-box}
.r95-auto-pop .ui-seg>button{flex:1 1 auto;justify-content:center;white-space:nowrap}
.r95-autoprog.meter{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:12px}
.r95-autoprog .ws-meter{margin:0}
.r95-autoprog>span{font-size:var(--buddy-fs-sm)}
.r95-auto-who{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.r95-auto-who .r95-cap{margin-left:4px}
.r95-auto-off{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.gx-more-pop .r95-pop{width:220px;gap:2px;padding:6px}
.gx-more-item{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:0 10px;border:0;border-radius:var(--buddy-r-btn-s);background:none;color:var(--buddy-text);font:inherit;font-size:var(--buddy-fs-sm);text-align:left;cursor:pointer}
.gx-more-item>span:first-of-type{flex:1;min-width:0}
.gx-more-item>.ui-icon{color:var(--buddy-muted)}
.gx-more-item:hover:not(:disabled),.gx-more-item:focus-visible{background:var(--buddy-surface2);outline:0}
.gx-more-item[aria-checked=true]>.ui-icon{color:var(--buddy-accent-text)}
.gx-more-item:disabled{opacity:.5;cursor:default}
.r95-roundstrip{flex:none;flex-wrap:wrap;border-radius:10px;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-accent) 30%,transparent)}
.r95-roundstrip small{margin-left:0}
.r95-roundstrip .ui-btn{height:26px}
.r95-roundstrip .ui-spinner{color:var(--buddy-accent-text)}
.gx-foot{display:flex;flex:none;flex-wrap:wrap;align-items:center;gap:8px;min-height:26px}
.gx-foot .buddy-full-message-control{min-height:0}
.gx-foot .r95-pop{top:auto;bottom:calc(100% + 8px)}
.gx-foot-st{display:inline-flex;align-items:center;gap:6px;color:var(--buddy-dlg-muted);font-size:var(--buddy-fs-cap)}
.gx-foot-st.stopped{color:var(--buddy-warn);font-weight:600}
.gx-foot .gx-stop{height:28px}
.r95-src-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border:0;border-radius:999px;background:color-mix(in srgb,var(--buddy-dlg-text) 8%,transparent);color:var(--buddy-dlg-muted);font:inherit;font-size:var(--buddy-fs-cap);font-weight:600;white-space:nowrap}
span.r95-src-chip{cursor:default}
button.r95-src-chip{cursor:pointer}
.r95-src-chip.on{color:var(--buddy-accent-text);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-accent) 45%,transparent)}
.r95-src-chip.on.open{background:color-mix(in srgb,var(--buddy-accent) 14%,transparent)}
.r95-src-chip.warn{color:var(--buddy-warn);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-warn) 40%,transparent)}
.r95-src-wrap .r95-pop{width:min(380px,calc(100vw - 48px));gap:4px;padding:10px}
.r95-src-h{font-size:var(--buddy-fs-sm)}
.r95-src-more{align-self:flex-start;margin-top:2px}
.r95-speech-lines.in-dlg{flex:0 1 auto;min-height:0}
.r95-speech.in-dlg{gap:8px;padding:0;background:none;box-shadow:none}
.r95-speech.in-dlg>p{max-height:max(2.6em,calc(var(--gx-stage-h,100vh) * .4 - var(--gx-dlg-rest,200px)));overflow:auto;font-family:inherit;font-size:clamp(15px,1.5vw,20px);line-height:1.55;font-weight:500;color:var(--buddy-dlg-text)}
.r95-speech.in-dlg.selftalk>p{font-style:italic;font-weight:400;color:var(--buddy-dlg-muted)}
.r95-speech.in-dlg.dream>p{letter-spacing:.08em;font-weight:400;color:var(--buddy-dlg-muted)}
.r95-speech-h{flex-wrap:wrap}
.r95-speech-opts{grid-template-columns:repeat(2,minmax(0,1fr))}
.r95-speech-pet{display:flex;align-items:center;gap:6px;margin:0;color:var(--buddy-dlg-muted);font-size:var(--buddy-fs-cap)}
.buddy-history-line{display:grid;gap:4px;padding:10px 13px;border-left:3px solid color-mix(in srgb,var(--buddy-accent-text) 45%,transparent);border-radius:0 10px 10px 0;background:color-mix(in srgb,var(--buddy-side-bg) 22%,transparent)}
.buddy-history-line .r95-spk{justify-self:start}
.buddy-history-line>p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.buddy-history-line.selftalk>p,.buddy-history-line.dream>p{font-style:italic;color:var(--buddy-muted)}
.buddy-history-line>small{color:var(--buddy-muted);font-size:var(--buddy-fs-cap)}
`;
