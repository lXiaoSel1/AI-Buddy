import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {t} from './i18n.mjs';
import {CHARACTER_EXPRESSIONS} from './character-expressions.generated.mjs';
import {GALGAME_EMOTION_LABELS,galgameReplySentences,normalizeGalgameEmotion} from './galgame-expressions.mjs';
import {B,FX,GALGAME_ICONS} from './galgame-redesign-style.mjs';

const h=React.createElement;
export function GalgameChoice({classic=false,index,label,...button}){
 return h('button',{type:'button',className:classic?'whg-choice gx-choice':'ch',...button},
  h('kbd',{'aria-hidden':true},index),h('span',null,label));
}
export function portraitWidth(characterId,height){
 const viewport=CHARACTER_EXPRESSIONS[characterId]?.viewport;
 return viewport?height*(viewport[2]-viewport[0])/(viewport[3]-viewport[1]):height*.7;
}
export const GalgameIcon=(name,props={})=>h('svg',{className:'ic',viewBox:'0 0 24 24','aria-hidden':true,...props,dangerouslySetInnerHTML:{__html:GALGAME_ICONS[name]||''}});
export const GlassButton=(props,...contents)=>h('button',{type:'button',...props,className:'gb'+(props.className?' '+props.className:'')},...contents);
export const GlassGroup=(...children)=>h('div',{className:'glass'},...children.filter(Boolean));
export const GlassDivider=()=>h('span',{className:'gs','aria-hidden':true});
export const GlassCorner=(position,...children)=>h('div',{className:'corner '+position},...children.filter(Boolean));
export const GlassMenuItem=(icon,label,onClick,extra={},suffix=null)=>h('button',{type:'button',...extra,className:'mi'+(extra.className?' '+extra.className:''),onClick},GalgameIcon(icon),label,suffix);
export const Ornament=()=>h('span',{className:'orn','aria-hidden':true});
export function GalgamePaperHeading({title,subtitle,onClose,busy=false,id}){
 return h(React.Fragment,null,
  h('div',{className:'gx-paper-title'},Ornament(),h('h2',{id},title),h('span',{className:'sub'},subtitle)),
  h('button',{type:'button',className:'gx-paper-close','aria-label':t('返回 Esc'),disabled:busy,onClick:onClose},t('返回 Esc')));
}
export const GlassHideButton=(hide)=>GlassButton({'aria-label':t('隐藏界面'),title:t('隐藏界面'),onClick:hide},GalgameIcon('eyeoff'));

const stageLuminance = new Map();
const linearSrgb = channel => {
 const srgb=channel/255;
 return srgb<=.04045 ? srgb/12.92 : ((srgb+.055)/1.055)**2.4;
};

export function stageBackgroundLuminance(pixels,width,height){
 const start=Math.floor(height/2)*width*4;
 const end=width*height*4;
 let sum=0;
 for(let offset=start;offset<end;offset+=4){
  sum+=.2126*linearSrgb(pixels[offset])+.7152*linearSrgb(pixels[offset+1])+.0722*linearSrgb(pixels[offset+2]);
 }
 return sum/((end-start)/4);
}

export function galgameStageScheme(theme,luminance){
 return typeof luminance==='number'?(luminance<.4?'dark':'light'):theme;
}

function backgroundLuminance(source){
 const url=new URL(source,document.baseURI).href;
 if(stageLuminance.has(url))return stageLuminance.get(url);
 const measured=new Promise(resolve=>{
  const image=new Image();
  if(url.startsWith('buddy-media:'))image.crossOrigin='anonymous';
  image.onload=()=>{
   try{
    const canvas=document.createElement('canvas');
    canvas.width=64;canvas.height=36;
    const context=canvas.getContext('2d',{willReadFrequently:true});
    context.drawImage(image,0,0,64,36);
    resolve(stageBackgroundLuminance(context.getImageData(0,0,64,36).data,64,36));
   }catch{resolve(undefined);}
  };
  image.onerror=()=>resolve(undefined);
  image.src=url;
 });
 stageLuminance.set(url,measured);
 if(stageLuminance.size>32)stageLuminance.delete(stageLuminance.keys().next().value);
 return measured;
}

export function useGalgameStageScheme(background){
 const themeOf=()=>document.documentElement.dataset.scheme==='light'?'light':'dark';
 const [theme,setTheme]=useState(()=>typeof document==='undefined'?'dark':themeOf());
 const [measured,setMeasured]=useState(null);
 useEffect(()=>{
  const update=()=>setTheme(themeOf());
  const observer=new MutationObserver(update);
  observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-scheme']});
  update();
  return()=>observer.disconnect();
 },[]);
 useEffect(()=>{
  if(!background)return;
  let active=true;
  void backgroundLuminance(background).then(value=>{if(active)setMeasured({background,value});});
  return()=>{active=false;};
 },[background]);
 return galgameStageScheme(theme,measured?.background===background?measured?.value:undefined);
}

export function useGalgameStageUi(scope,{inputNeeded=false,classic=false}={}){
 const [inputOpen,setInputOpen]=useState(false),[hidden,setHidden]=useState(false),[menu,setMenu]=useState(false);
 const trigger=useRef(null);
 useEffect(()=>{setHidden(false);setMenu(false);setInputOpen(false);},[scope]);
 const openInput=()=>{
  setInputOpen(true);
  requestAnimationFrame(()=>document.querySelector('#whg-panel textarea:not(:disabled)')?.focus({preventScroll:true}));
 };
 const closeInput=(restoreFocus=true)=>{
  setInputOpen(false);
  if(restoreFocus)requestAnimationFrame(()=>trigger.current?.focus({preventScroll:true}));
 };
 const hide=()=>{setMenu(false);setHidden(true);};
 useEffect(()=>{
  const escape=event=>{
   if(event.key!=='Escape'||event.defaultPrevented||document.querySelector('dialog[open],.whg-picker-floating,.whg-archive-scrim'))return;
   if(hidden){event.preventDefault();setHidden(false);}
   else if(menu){event.preventDefault();setMenu(false);}
   else if(inputOpen&&!inputNeeded&&!classic){event.preventDefault();closeInput();}
  };
  document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);
 },[hidden,menu,inputOpen,inputNeeded,classic]);
 useEffect(()=>{
  if(!menu)return;
  const close=event=>{if(!event.target.closest?.('.gx-redesign .menu,[data-galgame-menu]'))setMenu(false);};
  document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);
 },[menu]);
 return {inputOpen:inputOpen||inputNeeded,openInput,closeInput,trigger,hidden,hide,restore:()=>setHidden(false),menu,toggleMenu:()=>setMenu(old=>!old),closeMenu:()=>setMenu(false)};
}

export function GalgameInput({open,onOpen,trigger,label,input,help=true}){
 return h('div',{className:'bottom'},open
  ? h(React.Fragment,null,help&&h('span',{className:'ihelp',id:'gx-stage-keyboard-hint'},t('Enter 发送 · Shift+Enter 换行')),input)
  : h('button',{type:'button',className:'iline',ref:trigger,'data-galgame-input-toggle':true,'aria-expanded':false,onClick:onOpen},label||t('说点什么')));
}

// Keep the browser's scroll container in place as the renderer exchanges streaming,
// narrated and stored bodies. Only a new reply restores following after an upward scroll.
export function StageDialogueText({scope,replyId,follow,children}){
 const body=useRef(null),scroll=useRef(null);
 useLayoutEffect(()=>{
  const node=body.current;
  const currentText=node.textContent;
  const previous=scroll.current;
  const sameReply=previous?.scope===scope&&previous.replyId===replyId;
  const optedOut=sameReply&&previous.optedOut;
  const changed=!sameReply||previous.text!==currentText;
  if(changed||previous.follow!==follow){
   if(follow&&!optedOut)node.scrollTop=node.scrollHeight;
   else node.scrollTop=sameReply?previous.top:0;
   scroll.current={scope,replyId,follow,optedOut,text:currentText,top:node.scrollTop};
  }
  node.toggleAttribute('data-scroll-more',node.scrollHeight-node.scrollTop>node.clientHeight+1);
 });
 const onScroll=({currentTarget:node})=>{
  const state=scroll.current,top=node.scrollTop;
  // A shorter scroll range can clamp the browser position without a user gesture.
  if(state.follow&&top+1<Math.min(state.top,node.scrollHeight-node.clientHeight))state.optedOut=true;
  state.top=top;
  node.toggleAttribute('data-scroll-more',node.scrollHeight-top>node.clientHeight+1);
 };
 return h('div',{className:'tx',ref:body,onScroll},children);
}

export function GalgameSettings({name,group=false,titleEditor,settings,onPatch,onClose,onReset,busy,galgame=false}){
 const dialog=useRef(null),[confirm,setConfirm]=useState(false),[error,setError]=useState(''),[saving,setSaving]=useState(false),working=useRef(false);
 useLayoutEffect(()=>{
  const node=dialog.current,target=document.activeElement;node?.showModal();
  return()=>{node?.close();if(target?.isConnected)target.focus({preventScroll:true});};
 },[]);
 const patch=async changes=>{
  if(working.current)return;
  working.current=true;setSaving(true);setError('');
  try{await onPatch(changes);}catch(reason){setError(String(reason?.message||reason));}finally{working.current=false;setSaving(false);}
 };
 const segment=(label,key,options)=>h('div',{className:'row',key},h('strong',{className:'setting-label'},t(label)),h('div',{className:'grow'},h('span',{className:'seg',role:'group','aria-label':t(label)},...options.map(([value,text])=>h('button',{type:'button',key:value,'data-galgame-setting':key,'data-value':value,'aria-pressed':settings[key]===value,disabled:saving,onClick:()=>void patch({[key]:value})},t(text))))));
 return h('dialog',{ref:dialog,className:'gx-settings-dialog'+(galgame?' gx-paper-dialog':''), 'data-galgame-settings':true,'aria-label':t('设置'),onCancel:event=>{event.preventDefault();if(confirm)setConfirm(false);else onClose();},onClick:event=>{if(event.target===dialog.current)onClose();}},
  h('section',{className:'sheet'+(confirm?' sm':''),onClick:event=>event.stopPropagation()},
   h('header',{className:'shh'},Ornament(),h('h4',null,t(confirm?'重新开始？':'设置')),h('span',{className:'sub'},confirm?'Restart':'Config'),h('span',{className:'crumb'},confirm?'':t(group?'{name} · 只对这个群聊生效':'{name} · 只对当前角色生效').replace('{name}',()=>name)),h('button',{type:'button',className:'x',onClick:confirm?()=>setConfirm(false):onClose},t(confirm&&!galgame?'关闭':'返回 Esc'))),
   h('div',{className:'shb'},confirm
    ? h('p',{style:{margin:0}},t('等级和好感度会清零，聊天记录保留。'))
    : h(React.Fragment,null,
       h('div',{className:'row setting-title-row'},h('strong',{className:'setting-label'},t('标题')),titleEditor),h('hr'),
       segment('对话样式','dialogueStyle',[['frameless','无框'],['classic','经典框']]),h('hr'),
       segment('字号','fontScale',[[.85,'小'],[1,'标准'],[1.15,'大']]),h('hr'),
       segment('表情','expressionMode',[['sentence','按句切换'],['reply','整条一个']]),h('hr'),
       segment('表情小动作','expressionMotion',[[true,'开'],[false,'关']]),
       !group&&h(React.Fragment,null,h('hr'),h('div',{className:'row setting-reset'},h('strong',{className:'setting-label'},t('重新开始')),h('span',{className:'grow sub'},t('清零等级与好感度，聊天记录保留。')),h('button',{type:'button',className:'b',disabled:busy,onClick:()=>setConfirm(true)},t('重新开始…')))))),
   error&&h('p',{className:'errbox',role:'alert'},t(error)),
   confirm&&h('footer',{className:'shf'},h('button',{type:'button',className:'b',onClick:()=>setConfirm(false)},t('取消')),h('button',{type:'button',className:'b dng',disabled:busy||saving,onClick:async()=>{if(working.current)return;working.current=true;setSaving(true);setError('');try{await onReset();onClose();}catch(reason){setError(String(reason?.message||reason));}finally{working.current=false;setSaving(false);}}},t('重新开始')))));
}

function readingDelay(text){
 return Math.max(500,Math.min(3500,[...text].length*80));
}

export function useGalgameSentence(message,{scope='',mode='sentence',voiceLine,fallback='normal',streaming=false}={}){
 const id=message?.requestId||message?.id||'',key=scope+':'+id;
 const lines=galgameReplySentences(message,mode);
 const [cursor,setCursor]=useState({key:'',index:0}),[fresh,setFresh]=useState(false),previous=useRef(null),voiced=useRef(null),lastEmotion=useRef(fallback);
 const newReply=previous.current?.scope===scope&&previous.current.key!==key&&!!id;
 useLayoutEffect(()=>{
  const advancing=!!id&&previous.current?.scope===scope&&previous.current.key!==key;
  previous.current={scope,key};
  setFresh(advancing);
  setCursor({key,index:advancing?0:Number.POSITIVE_INFINITY});
 },[scope,key,id]);
 const subtitle=voiceLine?.subtitle;
 const voiceIndex=Number.isSafeInteger(subtitle?.envelope?.index)?subtitle.envelope.index:null;
 const voiceEmotion=mode==='sentence'?subtitle?.visualEmotion:lines[0]?.emotion;
 useLayoutEffect(()=>{
  if(!voiceLine)return;
  voiced.current={key,index:voiceIndex??voiced.current?.index};
  if(voiceEmotion)lastEmotion.current=voiceEmotion;
 },[key,!!voiceLine,voiceIndex,voiceEmotion]);
 const stoppedVoice=!voiceLine&&voiced.current?.key===key;
 const index=stoppedVoice?Math.max(0,lines.length-1):voiceIndex!==null?Math.min(voiceIndex,Math.max(0,lines.length-1))
  :cursor.key===key?Math.min(cursor.index,Math.max(0,lines.length-1)):newReply?0:Math.max(0,lines.length-1);
 const current=lines[index],next=lines[index+1];
 useEffect(()=>{
  if(!fresh||!current||!next||voiceLine||stoppedVoice||!Number.isFinite(cursor.index))return;
  const timer=setTimeout(()=>setCursor(old=>old.key===key?{key,index:old.index+1}:old),readingDelay(current.text));
  return()=>clearTimeout(timer);
 },[key,index,fresh,current?.text,!!next,!!voiceLine,stoppedVoice]);
 const waiting=voiceLine?.waiting;
 const emotion=normalizeGalgameEmotion(waiting?lastEmotion.current:voiceEmotion??current?.emotion??message?.emotion,fallback);
 useLayoutEffect(()=>{if(!waiting)lastEmotion.current=emotion;},[waiting,emotion]);
 const queuedEmotion=mode==='sentence'?voiceLine?.nextVisualEmotion:null;
 return {emotion,nextEmotion:queuedEmotion??(voiceLine?(waiting?current?.emotion:null):next?.emotion),lines,index,key,text:message?.text,
  fresh:!waiting&&(fresh||!!subtitle)&&!stoppedVoice,progressive:fresh&&lines.length>1&&!voiceLine&&!stoppedVoice&&mode==='sentence'&&!!message?.emotionSentences?.length,
  streaming};
}

export function GalgameSentenceText({playback}){
 const {lines,index}=playback;
 return h(React.Fragment,null,...lines.slice(0,index+1).map((row,i)=>{
  const text=(playback.text?.slice(i?lines[i-1].end:0,row.end)??row.text);
  return i===index?text:h('span',{className:'past',key:row.start},text);
 }),
  index<lines.length-1&&h('span',{className:'caret','aria-hidden':true},'▼'));
}

export function useGalgameExpressionFx(playback,enabled=true){
 const [effect,setEffect]=useState(null),last=useRef(null),counter=useRef(0);
 const motion=typeof matchMedia==='function'&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
 const {key,emotion,fresh}=playback;
 useLayoutEffect(()=>{
  const prior=last.current;last.current={key,emotion};
  if(!enabled||!motion||!fresh){setEffect(null);return;}
  if(prior?.emotion===emotion)return;
  const [action,bubble]=FX[emotion]??[];
  setEffect(action||bubble?{action,bubble,nonce:++counter.current}:null);
 },[key,emotion,fresh,enabled,motion]);
 return effect;
}

export function ExpressionBubble({effect}){
 return effect?.bubble?h('div',{className:'bub on',key:effect.nonce,'aria-hidden':true,dangerouslySetInnerHTML:{__html:B[effect.bubble]}}):null;
}

export function HistoryExpressionText({message,text,onPreview}){
 const rows=galgameReplySentences(message);
 if(!Array.isArray(message?.emotionSentences)||message.text!==text||!rows.length)return text;
 return h(React.Fragment,null,...rows.map((row,index)=>{
  const visible=text.slice(index?rows[index-1].end:0,row.end),label=t('查看这句的表情')+' · '+t(GALGAME_EMOTION_LABELS[row.emotion]??row.emotion);
  return onPreview?h('button',{type:'button',key:row.start,className:'gx-history-expression','data-galgame-history-emotion':row.emotion,title:label,
   onClick:()=>onPreview(row,visible)},visible):h('span',{key:row.start,'data-galgame-history-emotion':row.emotion},visible);
 }),text.slice(rows.at(-1).end));
}

export function HistoryExpressionPreview({preview,portrait,onClose}){
 const dialog=useRef(null);
 useLayoutEffect(()=>{
  const node=dialog.current,trigger=document.activeElement;node?.showModal();
  return()=>{node?.close();if(trigger?.isConnected)trigger.focus({preventScroll:true});};
 },[]);
 const emotion=t(GALGAME_EMOTION_LABELS[preview.emotion]??preview.emotion);
 return h('dialog',{className:'buddy-dialog gx-paper-dialog gx-history-preview',ref:dialog,'aria-label':t('查看这句的表情'),onCancel:event=>{event.preventDefault();onClose();}},
  h('header',{className:'buddy-dialog-head'},h('div',{className:'gx-paper-title'},Ornament(),h('h2',null,preview.character.name+' · '+emotion)),
   h('button',{type:'button',className:'ui-btn',onClick:onClose},t('返回 Esc'))),
  h('div',{className:'gx-history-preview-portrait','data-galgame-history-preview':preview.emotion},portrait(preview.character,preview.emotion)),
  h('p',{className:'gx-history-preview-line'},preview.text));
}
