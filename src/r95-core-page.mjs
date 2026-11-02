import React,{useEffect,useRef,useState} from 'react';
import {t,locale} from './i18n.mjs';
import {FeedingPage,characterName} from './feeding-ui.mjs';
import {MoodCard,SocialSettings,AutoControls,moodLabel} from './social-core-ui.mjs';
import {zoneOptions} from './preferences.mjs';
import {Icon} from './ui-icons.mjs';
import {StatusPill,CheckSwitch} from './ui-controls.mjs';
import {themeAsset} from './appearance.mjs';
import {safeSearchUrl} from './native-search.mjs';
const h=React.createElement;
const uuid=()=>globalThis.crypto.randomUUID();
const scopeKey=view=>JSON.stringify(view?.scope??{});
const actionable=new Set(['auto-start','feeding-buy','feeding-feed']);
export function r95GroupInputPolicy(view,{offline,busy,canContinue,canRetry}={}){const autoSession=!!view?.auto&&view.auto.status!=='ended',blocked=!!(offline||busy||canContinue||canRetry);return {autoSession,inputBlocked:autoSession?!!offline:blocked,sendBlocked:autoSession?!!offline:blocked};}
export function r95ElementVisible(node){
 if(!node?.isConnected||!node.getClientRects?.().length)return false;const rect=node.getBoundingClientRect(),doc=node.ownerDocument,win=doc?.defaultView;
 if(rect.width<=0||rect.height<=0||rect.bottom<=0||rect.right<=0||rect.top>=(win?.innerHeight??Infinity)||rect.left>=(win?.innerWidth??Infinity))return false;
 let bounds={...rect,top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right};
 for(let element=node,depth=0;element&&depth<100;element=element.parentElement,depth++){const style=win?.getComputedStyle?.(element);if(element.hidden||element.getAttribute?.('aria-hidden')==='true'||style&&(style.display==='none'||['hidden','collapse'].includes(style.visibility)||style.opacity==='0'))return false;
  if(element!==node&&style&&element.getBoundingClientRect){const clip=element.getBoundingClientRect();if(/hidden|clip|auto|scroll/.test(style.overflowY??'')){bounds.top=Math.max(bounds.top,clip.top);bounds.bottom=Math.min(bounds.bottom,clip.bottom);}if(/hidden|clip|auto|scroll/.test(style.overflowX??'')){bounds.left=Math.max(bounds.left,clip.left);bounds.right=Math.min(bounds.right,clip.right);}if(bounds.top>=bounds.bottom||bounds.left>=bounds.right)return false;}}
 return true;
}
export function createR95ActionClient(request){
 const pending=new Map(),retryIds=new Map();let inputTail=Promise.resolve();
 return (action,args={})=>{const body={...args};if(action==='input'){const task=inputTail.catch(()=>{}).then(()=>request('companion-r95',{action,args:body})).then(result=>{if(result?.ok===false)throw Error(result.error??t('操作失败'));return result?.r95Result;});inputTail=task;return task;}const identity=JSON.stringify([action,Object.fromEntries(Object.entries(body).filter(([key])=>key!=='requestId'))]);if(pending.has(identity))return pending.get(identity);
  if(actionable.has(action)){body.requestId=retryIds.get(identity)??body.requestId??uuid();retryIds.set(identity,body.requestId);if(retryIds.size>64)retryIds.delete(retryIds.keys().next().value);}
  const task=Promise.resolve().then(()=>request('companion-r95',{action,args:body})).then(result=>{if(result?.ok===false)throw Error(result.error??result.message??t('操作失败'));const value=result?.r95Result;if(action==='auto-rendered'&&value?.acknowledged!==true){const retryable=value?.retryable===true;throw Object.assign(Error(t(retryable?'显示确认尚未完成':'显示确认已失效')),{retryable,reason:value?.reason});}retryIds.delete(identity);return value;}).finally(()=>pending.delete(identity));pending.set(identity,task);return task;};
}
/** A presentation acknowledgement is a two-frame DOM check, never a reading timer. */
export function scheduleRenderedAck({document:doc=globalThis.document,requestFrame=globalThis.requestAnimationFrame,cancelFrame=globalThis.cancelAnimationFrame,Observer=globalThis.MutationObserver,setTimer=globalThis.setTimeout,clearTimer=globalThis.clearTimeout,isReady,send,onError=()=>{}}){
 let stopped=false,completed=false,inFlight=false,terminal=false,first=null,second=null,retryTimer=null,retries=0;const delays=[250,1000,2500],win=globalThis.window;
 const visible=()=>!doc.hidden&&!doc.querySelector('dialog[open], [aria-modal="true"]')&&isReady();
 const failed=error=>{if(stopped)return;if(error?.retryable===false||retries>=delays.length){terminal=true;onError(error);return;}retryTimer=setTimer(()=>{retryTimer=null;arm();},delays[retries++]);};
 const arm=()=>{if(stopped||completed||terminal||inFlight||retryTimer!==null||first!==null||second!==null||!visible())return;first=requestFrame(()=>{first=null;if(stopped||!visible())return;second=requestFrame(()=>{second=null;if(stopped||!visible())return;inFlight=true;Promise.resolve().then(()=>{if(stopped||!visible())return false;return Promise.resolve(send()).then(()=>true);}).then(sent=>{if(sent)completed=true;},failed).finally(()=>{inFlight=false;});});});};
 doc.addEventListener('visibilitychange',arm);doc.addEventListener('scroll',arm,true);win?.addEventListener?.('resize',arm);const observer=Observer?new Observer(arm):null;observer?.observe(doc.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['open','aria-modal','hidden','aria-hidden','style','class','data-group-message-id','data-auto-request-id']});arm();
 return()=>{stopped=true;if(first!==null)cancelFrame(first);if(second!==null)cancelFrame(second);if(retryTimer!==null)clearTimer(retryTimer);doc.removeEventListener('visibilitychange',arm);doc.removeEventListener('scroll',arm,true);win?.removeEventListener?.('resize',arm);observer?.disconnect();};
}
// Approved design C7: the sources chip sits under the reply; nothing shows when no search ran.
export function NativeSearchSources({message}){
 const data=message?.nativeSearch;if(!data)return null;const sources=(data.sources??[]).map(row=>({...row,url:safeSearchUrl(row.url)})).filter(row=>row.url),status=typeof data.status==='string'?data.status:null;
 if(status==='not-used'||status==='available'&&!sources.length)return null;
 const label={available:t('已允许当前模型原生联网'),unavailable:t('当前连接原生联网不可用'),completed:sources.length?t('已联网检索'):t('检索已执行，暂无可用来源'),failed:t('联网检索失败'),['not-used']:t('本次未执行联网检索')};
 const warn=status==='failed'||status==='unavailable',host=url=>{try{return new URL(url).hostname.replace(/^www\./,'');}catch{return url;}};
 return h('details',{'data-r95-search-sources':message.id??'',className:'r95-search-sources'+(warn?' warn':'')},h('summary',{className:'r95-src-chip',title:data.reason?String(data.reason):undefined},Icon(warn?'alert':'globe',{size:14}),label[status]??t('原生联网记录'),sources.length?' · '+sources.length:''),
  h('div',{className:'r95-src-pop'},data.reason&&h('p',{className:'r95-cap'},String(data.reason)),...sources.map((row,index)=>h('a',{key:row.url+index,className:'r95-src',href:row.url,target:'_blank',rel:'noreferrer noopener'},h('span',{className:'r95-fav','aria-hidden':true},host(row.url).slice(0,1).toUpperCase()),h('span',null,h('b',null,row.title||host(row.url)),h('small',null,host(row.url))),Icon('external',{size:14})))));
}
// A small anchored panel for the chat toolbar. It is never a <dialog> or aria-modal, so an open panel cannot
// hold back the presentation acknowledgement of a reply (scheduleRenderedAck).
function Pop({label,chip,className='',children,...rest}){
 const [open,setOpen]=useState(false),box=useRef(null);
 useEffect(()=>{if(!open)return;const away=event=>{if(!box.current?.contains(event.target))setOpen(false);},key=event=>{if(event.key==='Escape')setOpen(false);};document.addEventListener('pointerdown',away);document.addEventListener('keydown',key);return()=>{document.removeEventListener('pointerdown',away);document.removeEventListener('keydown',key);};},[open]);
 return h('div',{className:'r95-pop-wrap '+className,ref:box,...rest},h('button',{type:'button',className:'gx-tb r95-chip'+(open?' open':''),'aria-expanded':open,'aria-label':label,title:label,onClick:()=>setOpen(value=>!value)},chip,Icon('chevron',{size:12})),open&&h('div',{className:'r95-pop',role:'group','aria-label':label},children));
}
// Approved design C6: chat (online) and the model's own search share one 联网 button at the top right.
export function R95NetButton({view,onAction,chat}){
 const [error,setError]=useState(''),[pending,setPending]=useState(false),lock=useRef(false);
 const run=async(action,args)=>{if(lock.current)return;lock.current=true;setPending(true);setError('');try{await onAction(action,args);}catch(e){setError(e.message);}finally{lock.current=false;setPending(false);}};
 const capability=view?.search?.capability,searchOn=view?.search?.enabled===true,unsupported=capability?.supported===false,chatOn=!!chat?.enabled;
 return h(Pop,{label:t('联网'),className:'r95-net-pop','data-galgame-net':true,chip:h(React.Fragment,null,Icon('globe',{size:16}),h('span',null,t('联网')),h('small',{className:'r95-chip-st'},(chatOn?t('聊天 开'):t('聊天 关'))+' · '+(searchOn?t('搜索 开'):t('搜索 关'))))},
  h('div',{className:'ws-srow'},h('div',null,h('b',null,t('联网聊天')),h('small',null,t('关掉后只能翻看之前的对话。'))),h(CheckSwitch,{checked:chatOn,label:t('联网聊天'),onChange:()=>chat?.onToggle?.()})),
  h('div',{className:'ws-srow'},h('div',null,h('b',null,t('用模型自带的联网搜索')),h('small',null,unsupported?t('当前连接原生联网不可用')+' · '+t(capability.reason):t('开了以后，回复下方会出现「来源」小标签。'))),h(CheckSwitch,{checked:searchOn,disabled:pending||unsupported&&!searchOn,label:t('原生联网搜索'),onChange:value=>void run('search-settings',{enabled:value})})),
  error&&h('p',{role:'alert',className:'r95-err'},error));
}
export function R95Toolbar({view,onAction,group=false,net=true}){
 const [error,setError]=useState(''),[pending,setPending]=useState(false),lock=useRef(false);if(!view)return null;
 const run=async(action,args)=>{if(lock.current)return;lock.current=true;setPending(true);setError('');try{await onAction(action,args);}catch(e){setError(e.message);}finally{lock.current=false;setPending(false);}};
 const local={...view,language:locale(),timeZone:view.timeZone},capability=view.search?.capability,searchOn=view.search?.enabled===true,unsupported=capability?.supported===false;
 const mood=moodLabel(view.mood,local),auto=view.auto,running=auto&&auto.status!=='ended';
 return h('div',{'data-r95-toolbar':group?'group':'private',className:'r95-toolbar'},
  h(Pop,{label:t('心情')+' · '+mood,className:'r95-mood-pop',chip:h(React.Fragment,null,h('span',{className:'r95-mooddot','aria-hidden':true}),h('span',null,t('心情')+' · '+mood))},h(MoodCard,{view:local,onAction})),
  net&&h(Pop,{label:t('原生联网搜索'),className:'r95-net-pop',chip:h(React.Fragment,null,Icon('globe',{size:16}),h('span',null,t('联网搜索')),h('small',{className:'r95-chip-st'},searchOn?t('开'):t('关')))},
   h('div',{className:'ws-srow'},h('div',null,h('b',null,t('用模型自带的联网搜索')),h('small',null,unsupported?t('当前连接原生联网不可用')+' · '+t(capability.reason):t('开了以后，回复下方会出现「来源」小标签。'))),h(CheckSwitch,{checked:searchOn,disabled:pending||unsupported&&!searchOn,label:t('原生联网搜索'),onChange:value=>void run('search-settings',{enabled:value})})),
   error&&h('p',{role:'alert',className:'r95-err'},error)),
  group&&h(Pop,{label:t('群聊 Auto'),className:'r95-auto-pop','data-r95-auto-menu':true,chip:h(React.Fragment,null,Icon('play',{size:16}),h('span',null,'Auto'),h('small',{className:'r95-chip-st'},running?t('第 {n} 轮').replace('{n}',(auto.roundIndex??0)+1):view.settings?.auto===true?t('未开始'):t('未开启')))},h(AutoControls,{view:{...local,enabled:view.settings?.auto===true},onAction:(action,args)=>run(action,args)})),
  error&&h('span',{role:'alert',className:'r95-err'},error));
}
// Approved design C8 (Galgame side): her line with a tag for what kind it is; reading still needs a click.
const SPEECH_ICON={dream:'moon',selftalk:'more',proactive:'chats'};
function SpeechLine({line,onAction}){
 const node=useRef(null),[error,setError]=useState(''),[read,setRead]=useState(false),[pending,setPending]=useState(false),action=useRef(onAction);action.current=onAction;
 useEffect(()=>{if(line.status!=='awaiting-presentation')return;return scheduleRenderedAck({isReady:()=>r95ElementVisible(node.current)&&node.current.textContent===line.text,send:()=>action.current('speech-presented',{messageId:line.messageId}),onError:e=>setError(e.message)});},[line.messageId,line.status,line.text]);
 if(read||line.status==='read')return null;
 const kind=line.mode==='dream'?'dream':line.kind==='selftalk'||line.mode==='selfTalk'?'selftalk':'proactive';
 return h('article',{'data-r95-speech':line.messageId,className:'r95-speech '+kind},h('div',{className:'r95-speech-h'},h('span',{className:'r95-spk '+kind},Icon(SPEECH_ICON[kind],{size:13}),kind==='dream'?t('梦话'):kind==='selftalk'?t('自言自语'):t('主动搭话')),Number.isFinite(line.at)&&h('small',null,new Date(line.at).toLocaleTimeString(locale()==='en'?'en-US':'zh-CN',{hour:'2-digit',minute:'2-digit'}))),
  h('p',{ref:node,'data-r95-speech-text':line.messageId},line.text),
  h('div',{className:'r95-row r95-end'},h('button',{type:'button',className:'ui-btn sm ghost',disabled:pending||line.status!=='presented',title:line.status!=='presented'?t('台词完整显示出来以后才能点'):undefined,onClick:async()=>{if(pending)return;setPending(true);setError('');try{await action.current('speech-read',{messageId:line.messageId});setRead(true);}catch(e){setError(e.message);}finally{setPending(false);}}},t('读完了'))),error&&h('p',{role:'alert',className:'r95-err'},error));
}
export function R95SpeechLines({view,onAction}){return h('div',{'data-r95-speech-lines':true,className:'r95-speech-lines'},...(view?.lines??[]).filter(line=>line.status!=='read').map(line=>h(SpeechLine,{key:scopeKey(view)+line.messageId,line,onAction})));}
// Approved design C5: 「DeepSeek 问你 · 2 分钟前」, and how much longer is a choice of 30 / 60 / 120 minutes.
const BUSY_MORE=[30,60,120];
export function R95AvailabilityQuestion({view,onAction,now=Date.now()}){
 const question=view?.availability?.busyQuestion,[minutes,setMinutes]=useState(60),[pending,setPending]=useState(false),[error,setError]=useState(''),lock=useRef(false);if(question?.status!=='awaiting-answer')return null;
 const answer=async value=>{if(lock.current)return;lock.current=true;setPending(true);setError('');try{await onAction('busy-answer',{eventId:question.eventId,answer:value,...(value==='still-busy'?{extendMs:minutes*60000}:{})});}catch(e){setError(e.message);}finally{lock.current=false;setPending(false);}};
 const character=view.scope?.characterId,who=view.characterName??characterName(character),ago=Number.isFinite(question.at)?Math.max(0,Math.floor((now-question.at)/60000)):null;
 const since=ago==null?null:ago<1?t('刚刚'):ago<60?(ago===1&&locale()==='en'?t('1 分钟前'):t('{n} 分钟前').replace('{n}',ago)):new Date(question.at).toLocaleTimeString(locale()==='en'?'en-US':'zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false,...zoneOptions(view.timeZone)});
 const asked=who?t('{name} 问你').replace('{name}',who):t('她问你');
 return h('section',{className:'ws-card r95-ask','data-r95-busy-question':question.eventId},character&&h('img',{className:'r95-face lg',src:'./'+themeAsset(character,'head.webp'),alt:'',draggable:false}),h('div',{className:'r95-ask-t'},h('small',null,since?asked+' · '+since:asked),h('b',null,question.text)),
  h('div',{className:'r95-row'},h('button',{type:'button',className:'ui-btn primary',disabled:pending,onClick:()=>void answer('finished')},t('我忙完了')),h('button',{type:'button',className:'ui-btn',disabled:pending||!BUSY_MORE.includes(minutes),onClick:()=>void answer('still-busy')},t('我还在忙')),h('label',{className:'r95-sel'},h('select',{value:minutes,'aria-label':t('再忙多少分钟'),disabled:pending,onChange:e=>setMinutes(Number(e.target.value))},...BUSY_MORE.map(n=>h('option',{key:n,value:n},t('再忙 {n} 分钟').replace('{n}',n)))))),error&&h('p',{role:'alert',className:'r95-err'},error));
}
export function r95OwnerBindingArgs(form,view){
 const options=view?.ownerWorkOptions??{},project=(options.projects??[]).find(row=>row.id===form.projectId),member=(options.members??[]).find(row=>row.id===form.leadMemberId&&(!row.projectId||row.projectId===form.projectId));
 if(!project||!member?.bindingId)throw Error(t('请先选择已登记项目及已配置的工作负责人'));
 const accountBindingId=String(form.accountBindingId??'').trim(),actorId=String(form.actorId??'').trim(),personaId=String(form.personaId??'').trim();
 if(!accountBindingId||!actorId||!personaId)throw Error(t('请填写本人账号绑定、发送者和身份'));
 const existing=(view.ownerBindings??[]).find(row=>row.accountBindingId===accountBindingId),version=(existing?.version??0)+1;
 if(!Number.isSafeInteger(version)||version<1)throw Error(t('主人绑定版本无效，请重新读取'));
 // The task route is copied only from host-listed configuration. Text entered
 // in QQ cannot register a path or manufacture an Agent/binding here.
 return {accountBindingId,actorId,personaId,version,route:{projectId:project.id,leadMemberId:member.id,team:[structuredClone(member.member??member)]}};
}
// Approved design C5 (丙8): the owner is picked, not typed. The QQ account comes from the accounts the APP has
// connected (the same list the Extension Center shows), the contact from private senders Core has already recorded
// for that account (owner-contacts), the identity from the app's Personas. The three IDs stay editable in the
// 「高级：手动填写 ID」 fold, which opens by itself when the account list cannot be read.
export const personaLabel=(persona,id)=>persona?.nickname||(id==='default'?t('默认身份'):id);
export function R95OwnerBindingForm({view,onAction,accountsApi=globalThis.window?.whale?.plugins,accounts:initialAccounts=null}){
 const [form,setForm]=useState(()=>({accountBindingId:'',actorId:'',personaId:view?.scope?.personaId??'',projectId:'',leadMemberId:''})),[pending,setPending]=useState(false),[error,setError]=useState(''),[receipt,setReceipt]=useState(null),lock=useRef(false);
 const [accounts,setAccounts]=useState(initialAccounts),[accountsError,setAccountsError]=useState(false),[contacts,setContacts]=useState({account:null,rows:[],loading:false,error:false});
 const options=view?.ownerWorkOptions??{},projects=options.projects??[],members=(options.members??[]).filter(row=>!row.projectId||row.projectId===form.projectId),ready=projects.length>0&&members.length>0;
 const personas=view?.personas??[],qq=(accounts??[]).filter(row=>row.platform==='qq'||row.pluginId==='@ai-buddy/qq-connect'),known=qq.some(row=>row.accountId===form.accountBindingId);
 useEffect(()=>{let alive=true;if(typeof accountsApi?.action!=='function'){setAccountsError(true);return;}
  const read=()=>Promise.resolve(accountsApi.action({action:'social-accounts-list'})).then(result=>{if(result?.error||!Array.isArray(result?.accounts))throw Error('accounts');if(alive){setAccounts(result.accounts);setAccountsError(false);}},()=>{if(alive)setAccountsError(true);});
  void read();globalThis.window?.addEventListener?.('ai-buddy:social-accounts-changed',read);return()=>{alive=false;globalThis.window?.removeEventListener?.('ai-buddy:social-accounts-changed',read);};},[accountsApi]);
 useEffect(()=>{let alive=true;const account=form.accountBindingId;if(!known){setContacts({account:null,rows:[],loading:false,error:false});return;}setContacts({account,rows:[],loading:true,error:false});
  Promise.resolve().then(()=>onAction('owner-contacts',{accountBindingId:account})).then(result=>{if(alive)setContacts({account,rows:Array.isArray(result?.contacts)?result.contacts:[],loading:false,error:false});},()=>{if(alive)setContacts({account,rows:[],loading:false,error:true});});return()=>{alive=false;};},[form.accountBindingId,known]);
 const update=(key,value)=>{setReceipt(null);setForm(previous=>({...previous,[key]:value,...(key==='projectId'?{leadMemberId:''}:{}),...(key==='accountBindingId'&&value!==previous.accountBindingId?{actorId:''}:{})}));};
 const submit=async event=>{event.preventDefault();if(lock.current)return;setError('');setReceipt(null);let args;try{args=r95OwnerBindingArgs(form,view);}catch(e){setError(e.message);return;}lock.current=true;setPending(true);try{setReceipt(await onAction('owner-bind',args));}catch(e){setError(e.message);}finally{lock.current=false;setPending(false);}};
 const bindings=view?.ownerBindings??[],latest=bindings.reduce((a,b)=>(b.version??0)>(a?.version??0)?b:a,null);
 const accountName=id=>{const row=qq.find(item=>item.accountId===id);return row?row.label+' · '+row.accountId:id;},personaName=id=>personaLabel(personas.find(row=>row.id===id),id);
 const projectName=id=>projects.find(row=>row.id===id)?.name??id,memberName=id=>(options.members??[]).find(row=>row.id===id)?.name??id;
 const contactRows=contacts.account===form.accountBindingId?contacts.rows:[],contactKnown=contactRows.some(row=>row.actorId===form.actorId);
 const seen=at=>Number.isFinite(at)?new Date(at).toLocaleString(locale()==='en'?'en-US':'zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false,...zoneOptions(view?.timeZone)}):null;
 const accountHint=accountsError?t('没读到已连接的 QQ 账号，可以在下面「高级」里手动填写。'):accounts&&!qq.length?t('还没有连接 QQ 账号；先在扩展中心的「账号连接」里扫码连接。'):t('从已连接的 QQ 账号里选');
 const contactHint=!known?t('先选 QQ 账号'):contacts.loading?t('正在读取这个账号收到过的私聊…'):contacts.error?t('联系人没读到，可以在下面「高级」里手动填写。'):!contactRows.length?t('这个账号还没收到过私聊。先用你自己的 QQ 给它发一句话，再回来选。'):t('只有这个联系人能交代工作');
 const picker=(name,label,value,onChange,list,hint,disabled)=>h('label',{key:name,className:'ws-fld'},h('span',null,label),h('select',{name,value,disabled:pending||disabled,onChange:e=>onChange(e.target.value)},...list),hint&&h('small',null,hint));
 const field=(key,label,hint)=>h('label',{key,className:'ws-fld'},h('span',null,t(label)),h('input',{name:key,value:form[key],required:true,disabled:pending,onChange:e=>update(key,e.target.value),autoComplete:'off'}),hint&&h('small',null,t(hint)));
 const option=(value,label)=>h('option',{key:value||'none',value},label);
 return h('section',{className:'ws-card ws-set r95-owner','data-r95-owner-binding':true},h('div',{className:'r95-between'},h('h3',{className:'ws-sec'},Icon('shield',{size:18}),t('可信主人：在 QQ 里交代工作')),latest&&h(StatusPill,{tone:'ok'},t('已绑定 · 第 {n} 版').replace('{n}',latest.version))),
  h('p',{className:'ws-meta'},t('只有你本人直接私聊才能提出工作；执行前仍要你批准具体计划。转发、引用和群聊都不能授权。')),
  h('form',{onSubmit:submit,className:'r95-col'},h('div',{className:'r95-grid3'},
    picker('ownerAccount',t('你的 QQ 账号'),known?form.accountBindingId:'',value=>update('accountBindingId',value),[option('',t('选择 QQ 账号')),...qq.map(row=>option(row.accountId,row.label+' · '+row.accountId+(row.enabled?'':' · '+t('已停用'))))],accountHint,!qq.length),
    picker('ownerContact',t('哪个联系人是你'),contactKnown?form.actorId:'',value=>update('actorId',value),[option('',t('选择联系人')),...contactRows.map(row=>option(row.actorId,[row.actorId,seen(row.lastAt)&&t('最近 {time}').replace('{time}',seen(row.lastAt))].filter(Boolean).join(' · ')))],contactHint,!contactRows.length),
    picker('ownerPersona',t('用哪个身份'),form.personaId,value=>update('personaId',value),[...(personas.some(row=>row.id===form.personaId)||!form.personaId?[]:[option(form.personaId,personaName(form.personaId))]),...personas.map(row=>option(row.id,personaLabel(row,row.id)))],null,!personas.length&&!form.personaId)),
   h('div',{className:'r95-grid2'},h('label',{className:'ws-fld'},h('span',null,t('工作项目')),h('select',{name:'projectId',value:form.projectId,disabled:pending||!projects.length,required:true,onChange:e=>update('projectId',e.target.value)},h('option',{value:''},t('选择项目')),...projects.map(row=>h('option',{key:row.id,value:row.id},row.name??row.id)))),
    h('label',{className:'ws-fld'},h('span',null,t('负责的角色')),h('select',{name:'leadMemberId',value:form.leadMemberId,disabled:pending||!form.projectId||!members.length,required:true,onChange:e=>update('leadMemberId',e.target.value)},h('option',{value:''},t('选择负责人')),...members.map(row=>h('option',{key:row.id,value:row.id},row.name??row.id))))),
   h('details',{className:'r95-tech r95-manual',open:accountsError||undefined},h('summary',null,t('高级：手动填写 ID')),h('div',{className:'r95-grid3'},field('accountBindingId','本人账号绑定 ID','QQ连接里你自己的账号连接'),field('actorId','主人发送者 ID','只有这个发送者能交代工作'),field('personaId','绑定 Persona ID','默认是当前身份'))),
   !ready&&h('div',{className:'ui-note',role:'status'},Icon('info',{size:16}),h('div',null,t('请先在工作页登记项目并配置负责人；尚未绑定时，QQ 工作请求会被拒绝。'))),
   h('div',{className:'r95-row r95-end'},h('button',{type:'submit',disabled:pending||!ready||!form.projectId||!form.leadMemberId,className:'ui-btn primary'},Icon('shield',{size:16}),t('保存工作绑定')))),
  receipt&&h('p',{role:'status',className:'r95-ok','data-r95-owner-receipt':true},t('主人工作绑定已保存'),' · ',t('第 {n} 版').replace('{n}',receipt.version)),error&&h('p',{role:'alert',className:'r95-err'},error),
  bindings.length>0&&h('details',{className:'r95-tech'},h('summary',null,t('已保存的绑定（{n}）').replace('{n}',bindings.length)),h('ul',null,...bindings.map(row=>h('li',{key:row.accountBindingId},[accountName(row.accountBindingId),row.actorId,personaName(row.personaId),row.route?.projectId&&projectName(row.route.projectId),row.route?.leadMemberId&&memberName(row.route.leadMemberId)].filter(Boolean).join(' · '),' · ',t('第 {n} 版').replace('{n}',row.version))))));
}
export function R95CorePage({page='social',language=locale(),request=globalThis.window?.whale?.game,onPage,onStatus,timeZone,initialView=null}){
 const [view,setView]=useState(initialView),[error,setError]=useState(''),[loading,setLoading]=useState(true),client=useRef(null),revision=useRef(0);const requestRef=useRef(request);requestRef.current=request;
 const invoke=async(action,args)=>{const epoch=revision.current,result=await requestRef.current(action,args);if(epoch===revision.current&&result?.companion?.r95)setView(result.companion.r95);return result;};
 if(!client.current)client.current=createR95ActionClient(invoke);
 useEffect(()=>{let alive=true,inFlight=false;const refresh=async()=>{if(inFlight||document.hidden)return;inFlight=true;try{const result=await requestRef.current('companion-r95',{action:'view',args:{}});if(alive){setView(result?.companion?.r95??result?.r95Result??null);setError('');}}catch(e){if(alive)setError(e.message);}finally{inFlight=false;if(alive)setLoading(false);}};void refresh();const timer=setInterval(refresh,1500);document.addEventListener('visibilitychange',refresh);return()=>{alive=false;revision.current++;clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};},[]);
 // The sidebar footer (A2) shows points and fullness on the shop pages, proactive and do-not-disturb on Social.
 const feeding=view?.feeding,statusKey=JSON.stringify([feeding?.wallet?.balance,feeding?.hunger?.satiety!=null?Math.round(feeding.hunger.satiety):null,view?.settings?.proactive,view?.settings?.selfTalk,view?.availability?.doNotDisturb,view?.availability?.busy]);
 useEffect(()=>{if(!view)return;onStatus?.({feeding:feeding?{points:feeding.wallet?.balance??0,fullness:feeding.hunger?.satiety!=null?Math.round(feeding.hunger.satiety):'—'}:null,social:{proactive:view.settings?.proactive===true||view.settings?.selfTalk===true,quiet:view.availability?.doNotDisturb===true||view.availability?.busy===true}});},[statusKey]);
 if(!view)return h('div',{className:'ws-page','data-r95-page':page,'aria-busy':loading},h('div',{className:'ws-page-head'},h('div',null,h('h2',{className:'ws-ptitle'},t(page==='social'?'社交与心情':'商店与背包')))),h('div',{className:error?'ui-alert warn':'r95-loading',role:error?'alert':'status'},error?Icon('alert',{size:16}):h('span',{className:'ui-spinner','aria-hidden':true}),h('div',null,error||t('正在读取社交与生活…'))));
 // The app's statistics time zone ('local' by default) reaches every time shown here; see intlTimeZone.
 const zone=timeZone??view.timeZone,local={...view,language,timeZone:zone};
 if(['shop','inventory'].includes(page))return h('div',{'data-r95-page':page},error&&h('div',{role:'alert',className:'ui-alert warn'},Icon('alert',{size:16}),h('div',null,error)),h(FeedingPage,{key:page,initialTab:page,view:view.feeding,timeZone:zone,onPage,onAction:(action,args)=>client.current('feeding-'+action,args)}));
 return h('div',{'data-r95-page':page,className:'ws-page r95-social'},
  h('div',{className:'ws-page-head'},h('div',null,h('h2',{className:'ws-ptitle'},t('社交与心情')),h('p',{className:'ws-meta'},t('她的心情、会不会主动找你、你忙不忙，以及谁能在 QQ 里交代工作。'))),onPage&&h('div',{className:'ws-row-btns'},h('button',{type:'button',className:'ui-btn ghost',onClick:()=>onPage('galgame')},Icon('chats',{size:16}),t('返回聊天')))),
  error&&h('div',{role:'alert',className:'ui-alert warn'},Icon('alert',{size:16}),h('div',null,error)),
  h(R95AvailabilityQuestion,{view:local,onAction:(action,args)=>client.current(action,args)}),
  h('div',{className:'r95-set2'},h('article',{className:'ws-card ws-set'},h('div',{className:'r95-between'},h('h3',{className:'ws-sec'},t('心情')),h('span',{className:'ws-tag'},t('只读'))),h(MoodCard,{view:local,onAction:(action,args)=>client.current(action,args)})),
   h('article',{className:'ws-card ws-set'},h(SocialSettings,{view:local,onAction:(action,args)=>client.current(action,args).catch(e=>setError(e.message))}))),
  h(R95OwnerBindingForm,{view:local,onAction:(action,args)=>client.current(action,args)}));
}
