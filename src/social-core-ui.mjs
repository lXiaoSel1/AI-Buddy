import React,{useEffect,useRef,useState} from 'react';
import {Icon} from './ui-icons.mjs';
import {CheckSwitch,Segmented} from './ui-controls.mjs';
import {themeAsset} from './appearance.mjs';
import {t} from './i18n.mjs';
import {FOODS} from './food-catalog.mjs';
import {zoneOptions} from './preferences.mjs';

const h=React.createElement,english=view=>String(view?.language??'').startsWith('en');
const name=(view,zh,en)=>english(view)?en:zh;
const button=(label,action,disabled=false,kind='',extra={})=>h('button',{type:'button',className:'ui-btn'+(kind?' '+kind:''),disabled,onClick:action,...extra},label);
// Times in the mood card follow the app's statistics time zone (view.timeZone; 'local' is the system zone), without seconds.
const when=(view,value)=>new Date(value).toLocaleString(english(view)?'en-US':'zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false,...zoneOptions(view?.timeZone)});
const clock=(view,value)=>new Date(value).toLocaleTimeString(english(view)?'en-US':'zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false,...zoneOptions(view?.timeZone)});
// One mood word for the toolbar chip and the card. Before any evaluation Core reports the resting mood 平静;
// both places show it (Calm in English) and the card says it has not been evaluated yet.
const FIXED_MOODS=Object.freeze({'平静':'Calm'});
export const moodEvaluated=mood=>mood?.available!==false&&typeof mood?.overall?.label==='string'&&!!mood.overall.label;
export function moodLabel(mood,view){const text=moodEvaluated(mood)?mood.overall.label:'平静';return english(view)?FIXED_MOODS[text]??text:text;}
export function moodSourceIds(mood={}){return [...new Set([...(mood.overall?.eventIds??[]),...(mood.feelings??[]).flatMap(row=>row.eventIds??[])].filter(id=>typeof id==='string'&&id))];}
export async function readMoodSources(onAction,mood){const eventIds=moodSourceIds(mood);if(!eventIds.length)return {sources:[]};const result=await onAction('mood-sources',{eventIds});if(!Array.isArray(result?.sources))throw Error('Mood sources are unavailable');return {sources:result.sources.filter(row=>eventIds.includes(row.eventId)&&typeof row.text==='string')};}
const clip=(text,limit=80)=>{const chars=[...String(text??'').replace(/\s+/g,' ').trim()];return chars.length>limit?chars.slice(0,limit).join('')+'…':chars.join('');};
// Meal evidence stores its text as JSON (companion-r95 onExperience); anything that does not parse is treated as absent.
function mealValue(text){try{const value=JSON.parse(text);return value&&typeof value==='object'&&!Array.isArray(value)?value:null;}catch{return null;}}
/** One readable sentence per mood source. Raw stored text is only shown inside the 「原始数据」 fold. */
export function moodSourceLine(row,view={}){
 const kind=String(row?.sourceKind??''),text=typeof row?.text==='string'?row.text:'';
 if(kind==='meal'){
  const meal=mealValue(text),food=FOODS.find(item=>item.id===meal?.foodId),foodName=food?t(food.name,english(view)?'en':'zh-CN'):name(view,'一份食物','some food');
  const before=Number.isFinite(meal?.before)?Math.round(meal.before):null,after=Number.isFinite(meal?.after)?Math.round(meal.after):null;
  const head=meal?.automatic===true?name(view,'她自己吃了'+foodName,'She ate '+foodName+' on her own'):name(view,'你喂她吃了'+foodName,'You fed her '+foodName);
  return before!=null&&after!=null?head+' · '+name(view,'饱食 ','Fullness ')+before+'→'+after:head;
 }
 if(kind==='user-interaction')return row.kind==='group-chat'?name(view,'你在群聊里说：「'+clip(text)+'」','You said in group chat: “'+clip(text)+'”'):name(view,'你说：「'+clip(text)+'」','You said: “'+clip(text)+'”');
 if(kind==='bilibili-watch')return name(view,'看了 B站视频：','Watched on Bilibili: ')+clip(text);
 if(kind==='work-report')return name(view,'工作汇报：','Work report: ')+clip(text);
 if(kind==='social-message'||kind==='qq-inbound')return name(view,'QQ 消息：','QQ message: ')+clip(text);
 if(kind.startsWith('bilibili'))return name(view,'B站：','Bilibili: ')+clip(text);
 return clip(text)||name(view,'一条经历','An experience');
}
const sourceAt=row=>{if(row?.sourceKind==='meal'){const meal=mealValue(row.text);if(Number.isFinite(meal?.occurredAt))return meal.occurredAt;}return Number.isFinite(row?.at)?row.at:null;};
export function MoodSourceList({view={},sources=[],loading=false,error='',loaded=false}){return h('div',{'data-r95-mood-sources':true,className:'r95-mood-sources'},loading&&h('p',{role:'status'},name(view,'正在读取来源…','Reading sources…')),error&&h('p',{role:'alert'},name(view,'来源读取失败，请重试。','Could not read sources. Please retry.')),loaded&&!loading&&!error&&!sources.length&&h('p',null,name(view,'当前可见范围没有来源记录。','No source records are visible in this context.')),
 ...sources.map(row=>{const at=sourceAt(row);return h('article',{key:row.eventId,'data-r95-mood-event':row.eventId},h('p',null,[at!=null?when(view,at):null,moodSourceLine(row,view)].filter(Boolean).join(' · ')),h('details',{className:'r95-tech'},h('summary',null,name(view,'原始数据','Raw data')),h('pre',{className:'r95-raw'},[row.sourceKind,row.text].filter(Boolean).join('\n'))));}));}
// The 「查看来源（N）」 button opens and closes the list; a list already read for this mood opens again without another request.
export const nextSourceState=({open,loaded,sameContext})=>open?{open:false,load:false}:{open:true,load:!(sameContext&&loaded)};
// Read-only mood (approved design C5 / C6): who she is, how she feels, why, and when it may change.
export function MoodCard({view={},onAction=()=>{},compact=false}){
 const [sources,setSources]=useState([]),[loading,setLoading]=useState(false),[sourceError,setSourceError]=useState(''),[loaded,setLoaded]=useState(false),[sourceContext,setSourceContext]=useState(null),[open,setOpen]=useState(false),mood=view.mood??view,overall=mood.overall??{},ids=moodSourceIds(mood),context=JSON.stringify([view.scope??null,mood.version??null,ids]),current=useRef(context),mounted=useRef(true),inFlight=useRef(false);current.current=context;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{setSources([]);setSourceError('');setLoaded(false);setLoading(false);setOpen(false);inFlight.current=false;},[context]);
 const load=async()=>{if(inFlight.current)return;const captured=context;inFlight.current=true;setSourceContext(context);setLoading(true);setSourceError('');try{const result=await readMoodSources(onAction,mood);if(mounted.current&&current.current===captured){setSources(result.sources);setLoaded(true);}}catch(error){if(mounted.current&&current.current===captured)setSourceError(error.message);}finally{if(mounted.current&&current.current===captured){setLoading(false);inFlight.current=false;}}};
 const toggle=()=>{const next=nextSourceState({open,loaded,sameContext:sourceContext===context});setOpen(next.open);if(next.load)void load();};
 const evaluated=moodEvaluated(mood),label=moodLabel(mood,view),intensity=evaluated&&Number.isFinite(overall.intensity)?Math.round(overall.intensity*100):null,character=view.scope?.characterId;
 const times=[mood.lastEvaluatedAt&&name(view,'上次评估 ','Evaluated ')+when(view,mood.lastEvaluatedAt),mood.nextReviewAt&&name(view,'之后可再评估 ','May reconsider after ')+when(view,mood.nextReviewAt)].filter(Boolean).join(' · ');
 return h('section',{'data-r95-mood':true,className:'r95-mood-card'+(compact?' compact':'')},
  h('div',{className:'r95-mood-head'},character&&h('img',{className:'r95-face',src:'./'+themeAsset(character,'head.webp'),alt:'',draggable:false}),h('div',{className:'r95-mood-main'},h('div',{className:'r95-row'},h('b',{className:'r95-mood-l'},label),intensity!=null&&h('small',null,name(view,'强度 ','Intensity ')+intensity+'%')),intensity!=null&&h('span',{className:'ws-meter'},h('b',{style:{width:intensity+'%'}})),times&&h('small',null,times),!evaluated&&h('small',{'data-r95-mood-unevaluated':true},name(view,'还没评估过；有了真实的交流以后才会评估。','Not evaluated yet; it is evaluated after real interaction.')))),
  evaluated&&overall.summary&&h('p',{className:'r95-mood-sum'},overall.summary),
  (mood.feelings??[]).length>0&&h('div',{className:'r95-feel'},...mood.feelings.map((row,index)=>h('span',{key:row.target??index,className:'ws-tag',title:row.summary??''},[row.target,row.label].filter(Boolean).join(' · ')))),
  mood.failure&&h('p',{role:'status',className:'r95-cap'},name(view,'上次评估未完成，保留原心情。','The last evaluation failed; the previous mood is retained.')),
  h('div',{className:'r95-row r95-end'},!ids.length&&h('small',{className:'r95-cap'},name(view,'还没有可以查看的来源。','No sources to show yet.')),button(h(React.Fragment,null,Icon(open?'chevron':'eye',{size:14}),open?name(view,'收起来源','Hide sources'):name(view,'查看来源（'+ids.length+'）','View sources ('+ids.length+')')),toggle,!ids.length,'ghost sm',{'aria-expanded':open,'data-r95-mood-toggle':open?'open':'closed'})),
  open&&h(MoodSourceList,{view,sources:sourceContext===context?sources:[],loading:sourceContext===context&&loading,error:sourceContext===context?sourceError:'',loaded:sourceContext===context&&loaded}),
  h('small',{className:'r95-cap'},name(view,'心情只会因为真实的交流变化，这里不能手动改。','Mood changes only through real interaction; it cannot be edited here.')));
}
const toggle=(view,key,zh,en,szh,sen,checked,onChange)=>h('div',{key,className:'ws-srow'},h('div',null,h('b',null,name(view,zh,en)),h('small',null,name(view,szh,sen))),h(CheckSwitch,{checked,label:name(view,zh,en),onChange}));
export function SocialSettings({view={},onAction=()=>{}}){
 const settings=view.settings??{},availability=view.availability??{},[minutes,setMinutes]=useState(60),act=(action,args)=>()=>onAction(action,args);
 return h('section',{'data-r95-social-settings':true,className:'r95-settings'},h('h3',{className:'ws-sec'},name(view,'主动行为','Proactive behaviour')),
  h('p',{className:'ws-meta'},name(view,'三项默认都是关的。打开后会调用聊天模型，可能多用一些 Token。','All three are off by default. When on, they use the chat model and may use more tokens.')),
  toggle(view,'proactive','主动搭话','Start conversations','她会在合适的时候先来找你。','She may reach out first when it fits.',settings.proactive===true,value=>onAction('social-settings',{proactive:value})),
  toggle(view,'selfTalk','自言自语','Talk to herself','没人说话时偶尔嘀咕一句。','An occasional remark when it is quiet.',settings.selfTalk===true,value=>onAction('social-settings',{selfTalk:value})),
  toggle(view,'auto','群聊 Auto','Group Auto','允许群聊自动轮流聊；每次开始前还要确认成员。','Lets group chat take turns on its own; each run still asks you to confirm members.',settings.auto===true,value=>onAction('social-settings',{auto:value})),
  h('h4',{className:'ws-sub-h'},name(view,'免打扰','Availability')),
  h('div',{className:'ws-srow'},h('div',null,h('b',null,availability.busy?name(view,'你正在忙','You are busy')+(Number.isFinite(availability.busyUntil)?' · '+name(view,'到 ','until ')+clock(view,availability.busyUntil):''):name(view,'我在忙','I’m busy')),h('small',null,name(view,'忙的时候少来打扰；到点会问你忙完没有。','Fewer interruptions; she checks back when time is up.'))),
   h('div',{className:'r95-row'},h(Segmented,{label:name(view,'忙碌分钟数','Busy for minutes'),value:minutes,options:[[30,'30'],[60,'60'],[120,'120']],onChange:setMinutes}),h('span',{className:'r95-cap'},name(view,'分钟','min')),
    button(availability.busy?name(view,'重新计时','Restart'):name(view,'开始','Start'),act('availability-set',{busyForMs:minutes*60000}),false,'sm'),availability.busy&&button(name(view,'我忙完了','I’m done'),act('availability-set',{clearBusy:true}),false,'sm primary'))),
  h('div',{className:'ws-srow'},h('div',null,h('b',null,name(view,'不要主动打扰我','Do not disturb')),h('small',null,name(view,'一直有效，点一下对话不会取消它。','Stays on; a click in chat does not cancel it.'))),h(CheckSwitch,{checked:availability.doNotDisturb===true,label:name(view,'不要主动打扰我','Do not disturb'),onChange:value=>onAction('availability-set',{doNotDisturb:value})})));
}
export function AutoControls({view={},onAction=()=>{}}){
 const auto=view.auto??null,[mode,setMode]=useState('rounds'),[rounds,setRounds]=useState(6),groupId=view.groupId,running=auto&&auto.status!=='ended',act=action=>()=>onAction(action,{groupId});
 const status={active:name(view,'正在进行','Running'),paused:name(view,'已暂停','Paused'),ended:name(view,'已结束','Ended')}[auto?.status]??auto?.status;
 return h('section',{'data-r95-auto':groupId??'',className:'r95-auto-controls'},h('h3',{className:'r95-pop-h'},Icon('play',{size:16}),name(view,'群聊 Auto','Group Auto'),running&&h('small',null,status)),
  !running&&h(React.Fragment,null,h('div',{className:'ws-fld'},h('span',null,name(view,'结束方式','Stop condition')),h(Segmented,{label:name(view,'结束方式','Stop condition'),value:mode,options:[['rounds',name(view,'指定轮数','Round limit')],['until-stopped',name(view,'直到我停止','Until I stop it')],['ai-end',name(view,'让 AI 决定','Let AI end it')]],onChange:setMode})),
   mode==='rounds'&&h('label',{className:'ws-fld'},h('span',null,name(view,'轮数上限','Maximum rounds')),h('input',{type:'number',min:1,max:100000,value:rounds,onChange:event=>setRounds(event.target.valueAsNumber)}))),
  running&&h('div',{className:'r95-autoprog',role:'status'},h('b',{className:'r95-tnum'},auto.roundIndex),h('span',null,name(view,' 轮已完成',' rounds done'))),
  h('p',{className:'r95-cap'},name(view,'每轮每位成员各有一次机会，可沉默；AI可以提前结束。','Each member gets one opportunity per round and may stay silent. AI may end earlier.')),
  mode!=='rounds'&&!running&&h('p',{role:'status',className:'r95-warn'},Icon('alert',{size:12}),name(view,'此模式可能产生更多模型用量。','This mode may use more model tokens.')),
  h('p',{className:'r95-cap'},name(view,'本次成员：','Members: ')+(view.memberNames??view.members??[]).join('、')),
  view.enabled!==true&&!running&&h('p',{className:'r95-cap',role:'status'},name(view,'社交与心情里还没有允许群聊 Auto。','Group Auto is not allowed yet in Social & mood.')),
  h('div',{className:'r95-row'},!running&&button(name(view,'确认成员并启动','Authorize members and start'),()=>onAction('auto-start',{groupId,mode,rounds}),view.enabled!==true||!groupId||mode==='rounds'&&(!Number.isSafeInteger(rounds)||rounds<1||rounds>100000),'sm primary'),
   running&&auto.status==='active'&&button(h(React.Fragment,null,Icon('pause',{size:14}),name(view,'暂停','Pause')),act('auto-pause'),false,'sm'),running&&auto.status==='paused'&&button(h(React.Fragment,null,Icon('play',{size:14}),name(view,auto.pending?.status==='unknown'?'从下一位继续':'继续 Auto',auto.pending?.status==='unknown'?'Continue with the next member':'Continue Auto')),()=>void onAction('auto-continue',{groupId:view.groupId,...auto.pending?.status==='unknown'&&{resumeFromNext:true,requestId:auto.pending.requestId}}),!!auto.pending&&auto.pending.status!=='unknown','sm'),running&&button(h(React.Fragment,null,Icon('stop',{size:14}),name(view,'停止 Auto','Stop Auto')),act('auto-stop'),false,'sm danger')),
  auto?.pending&&h('p',{role:'status',className:'r95-cap'},name(view,auto.pending?.status==='unknown'?'上一轮没有完成。':'有待完成或核对的请求，不能重复提交。',auto.pending?.status==='unknown'?'The previous turn did not finish.':'A request is pending or requires reconciliation; it will not be resubmitted.')));
}
