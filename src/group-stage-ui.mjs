import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {scheduleRenderedAck,r95ElementVisible,createR95ActionClient} from './r95-core-page.mjs';
import {stageCapacity,stageWindow,stableMembers,groupSpeakerState} from './group-stage.mjs';
import {t} from './i18n.mjs';
import {VoiceIcon} from './voice/design-icons.mjs';
import {hasCloudVoice} from './voice/design-ui.mjs';
import {groupMemberAvatar} from './group-member-avatar.mjs';
import {ExpressionBubble,portraitWidth,useGalgameExpressionFx} from './galgame-redesign.mjs';
import {visibleCompanionText} from './companion-presentation.mjs';
const h=React.createElement;
const name=c=>c?.name||c?.id||'';
const image=(c,resolve)=>Object.hasOwn(c?.effective||{},'sprite')?c.effective.sprite||null:resolve(c?.sprite)||null;
const button=(label,onClick,props={})=>h('button',{type:'button',className:'whg-btn',onClick,...props},t(label));
export function CompanionGroupStage({state,request,resolveArt=()=>null,renderPortrait,browseRequest,toolbarTarget,onMembers,playback,expressionMotion,classic=true,cloudVoiceCharacters}){
 const group=state.groups?.find(g=>g.id===state.activeGroupId);
 const identity=groupSpeakerState(state.groupRuntime,state.groupMessages),runtime=state.groupRuntime||{};
 const streaming=identity.running&&runtime.streaming?.text?runtime.streaming:null;
 const message=streaming?{...streaming,id:streaming.requestId}:identity.displayMessage;
 const speaker=identity.activeId??identity.displayId;
 const viewport=useRef(null),previous=useRef([]),lastMessage=useRef(null);
 const [width,setWidth]=useState(1280),[manual,setManual]=useState(null),[presentationError,setPresentationError]=useState(null),[ackError,setAckError]=useState(''),[ackCheck,setAckCheck]=useState(0);
 const activeCharacter=playback?.characterId??speaker;
 const visual=playback??{key:'',emotion:message?.characterId===activeCharacter?message?.emotion??'normal':'normal',fresh:false};
 const fx=useGalgameExpressionFx(visual,expressionMotion!==false&&!manual);
 useEffect(()=>{const node=viewport.current;if(!node)return;const measure=()=>setWidth(node.clientWidth);measure();const observer=new ResizeObserver(measure);observer.observe(node);return()=>observer.disconnect();},[group?.id]);
 useEffect(()=>{setManual(null);previous.current=[];lastMessage.current=null;},[group?.id]);
 const messageKey=message?.occurrenceId??message?.id;
 useEffect(()=>{if(messageKey&&lastMessage.current!==messageKey){lastMessage.current=messageKey;setManual(null);}},[messageKey]);
 useEffect(()=>{if(browseRequest?.groupId!==group?.id)return;if(browseRequest.characterId==null)setManual(null);else if(group.memberIds.includes(browseRequest.characterId))setManual(browseRequest.characterId);},[browseRequest]);
 const requestRef=useRef(request);requestRef.current=request;
 const renderedMessage=runtime.currentMessage,renderedText=visibleCompanionText(renderedMessage,{messages:state.groupMessages??[]}),streamingPending=!!state.groupRuntime?.streaming?.text,renderedScope=state.r95?.scope,renderedScopeKey=JSON.stringify(renderedScope??null),renderedTarget=state.r95?.autoPresentation,renderedTargetKey=JSON.stringify(renderedTarget??null),targetMatches=renderedTarget?.messageId===renderedMessage?.id&&renderedTarget?.occurrenceId===renderedMessage?.occurrenceId&&renderedTarget?.autoRequestId===renderedMessage?.autoRequestId&&renderedTarget?.characterId===renderedMessage?.characterId&&renderedTarget?.scope&&renderedScope&&['characterId','personaId','lifeId','operationId','channel','conversationId'].every(key=>renderedTarget.scope[key]===renderedScope[key]),autoStopped=state.r95?.auto?.status==='ended'&&!['round-limit','topic-ended'].includes(state.r95.auto.endedReason);
 useEffect(()=>{setAckError('');const m=renderedMessage;if(autoStopped||!targetMatches||!m?.autoRequestId||m.status!=='presented'||!m.id)return;const ackClient=createR95ActionClient((...args)=>requestRef.current(...args));return scheduleRenderedAck({isReady:()=>{const node=[...document.querySelectorAll('[data-group-message-id]')].find(n=>n.dataset.groupMessageId===m.id&&(!m.occurrenceId||n.dataset.groupMessageOccurrence===m.occurrenceId)&&n.dataset.autoRequestId===m.autoRequestId);return r95ElementVisible(node)&&node.textContent===renderedText;},send:()=>ackClient('auto-rendered',{groupId:group.id,messageId:m.id,occurrenceId:m.occurrenceId,autoRequestId:m.autoRequestId,scope:renderedScope}),onError:e=>setAckError(e.message)});},[group?.id,renderedMessage?.id,renderedMessage?.occurrenceId,renderedMessage?.autoRequestId,renderedMessage?.status,renderedText,streamingPending,renderedScopeKey,renderedTargetKey,state.r95?.auto?.id,autoStopped,ackCheck]);
 const groupId=group?.id,pendingId=runtime.pendingMessage?.id,roundId=runtime.roundId,canPresent=typeof request==='function';
 const error=presentationError?.groupId===groupId&&presentationError?.pendingId===pendingId&&presentationError?.roundId===roundId?presentationError?.message:null;
 useEffect(()=>{
  setPresentationError(null);
  if(!groupId||!pendingId||!canPresent)return;
  let stopped=false,presenting=false;
  const ack=async()=>{
   if(stopped||presenting||document.hidden||document.querySelector('dialog[open]'))return;
   presenting=true;
   try{
    const result=await requestRef.current('companion-group-present',{id:groupId,requestId:pendingId,roundId});
    if(stopped)return;
    setPresentationError(null);
    if(!result?.presentationDeferred)stop();
   }catch(error){
    if(stopped)return;
    if(error?.code==='GROUP_PRESENTATION_STALE'){setPresentationError(null);stop();}
    else setPresentationError({groupId,pendingId,roundId,message:String(error?.message??error)});
   }finally{presenting=false;}
  };
  const timer=setInterval(ack,200),frame=requestAnimationFrame(ack);
  function stop(){stopped=true;clearInterval(timer);cancelAnimationFrame(frame);}
  return stop;
 },[groupId,pendingId,roundId,canPresent]);
 if(!group)return null;
 const order=stableMembers(group);
 const hero=[manual,activeCharacter,order[0]].find(id=>order.includes(id));
 const capacity=stageCapacity(width),visible=stageWindow(order,capacity,hero,previous.current);previous.current=visible;
 const rail=width>860,stageWidth=rail?width-90:width,tableWidth=stageWidth*1.2;
 const withoutVoice=id=>!!cloudVoiceCharacters&&!cloudVoiceCharacters.some(row=>row.characterId===id&&hasCloudVoice(row));
 const characters=Object.fromEntries((state.characters||[]).map(c=>[c.id,c])),viewed=manual&&characters[manual];
 const rest=visible.filter(id=>id!==hero),slots=rest.length===3?[.27,.73,.1]:rest.length===2?[.24,.76]:[.24];
 const portrait=c=>{const src=groupMemberAvatar(c,resolveArt);return src?h('img',{src,alt:'',loading:'lazy',draggable:false,onError:e=>{e.currentTarget.style.display='none';}}):name(c).slice(0,2);};
 const controls=manual&&h(React.Fragment,null,
  h('span',{className:'buddy-viewing','data-viewing':manual,title:classic?undefined:name(viewed)},t('正在查看：')+name(viewed)),
  button('回到发言者',()=>setManual(null)));
 const ackControl=ackError&&!autoStopped&&h('div',{className:'buddy-ack-error gx-group-feedback',role:'alert'},h('span',null,ackError),h('button',{type:'button',className:'ui-btn sm','data-recheck-rendered':renderedMessage?.id,onClick:()=>setAckCheck(value=>value+1)},t('重新检查显示状态')));
 const feedback=h(React.Fragment,null,ackControl,error&&h('span',{className:'gx-group-feedback',role:'alert'},error));
 const figure=(id,position,main)=>{
  if(!id)return null;
  const c=characters[id],src=image(c,resolveArt),isSpeaking=main&&id===activeCharacter,emotion=isSpeaking?visual.emotion:'normal';
  return h('div',{
   key:id,className:'gf '+(main?'spk gx-figure-hero':'gx-figure-back')+(isSpeaking&&fx?.action?' m-'+fx.action:''),
   'data-character-id':id,'data-speaker':isSpeaking,'data-galgame-emotion':emotion,
   style:{left:Math.round(position)+'px',top:main?30:122,height:main?880:600,'--gx-portrait-width-natural':portraitWidth(id,main?880:600)+'px'},
   onAnimationEnd:e=>{if(e.target===e.currentTarget&&isSpeaking&&fx?.action)e.currentTarget.classList.remove('m-'+fx.action);},
  },
  c&&renderPortrait?renderPortrait(c,src,emotion,isSpeaking?visual.nextEmotion:null):src?h('img',{src,alt:name(c),draggable:false}):h('div',{className:'buddy-stage-placeholder'},name(c)),isSpeaking&&h(ExpressionBubble,{effect:fx}));
 };
 return h(React.Fragment,null,
  toolbarTarget&&createPortal(classic?controls:h(React.Fragment,null,manual&&h('div',{className:'buddy-group-stage-controls gx-group-stage-controls'},controls),feedback),toolbarTarget),
  h('div',{className:'gscene',ref:viewport,'data-companion-group-stage':group.id,'data-capacity':capacity,'data-visible-members':visible.join(',')},
   ...rest.map((id,index)=>figure(id,slots[index]*stageWidth,false)),figure(hero,stageWidth/2,true),
   group.sceneTemplate!=='plain'&&h('img',{className:'gtable2 soft',src:'assets/group-scene/galgame-table.webp',alt:'',draggable:false,'aria-hidden':true,style:{width:Math.round(tableWidth),left:Math.round(stageWidth/2-tableWidth/2),top:'calc(max(586px, 81.3889%) - '+Math.round(tableWidth*533/1600*.24)+'px)'}}),
   ...rest.map((id,index)=>h('span',{className:'gcap',key:'cap-'+id,style:{left:Math.round(slots[index]*stageWidth),top:98}},name(characters[id])))),
  (rail||!classic&&!!cloudVoiceCharacters)&&h('button',{className:'grail'+(rail?'':' bc-small-rail'),type:'button','data-galgame-roster':true,'aria-label':t('在场角色'),title:t('在场角色'),onClick:onMembers},
   h('span',{className:'grail-faces'},...order.map(id=>h('span',{className:(id===hero?'spk ':'')+(group.mutedIds?.includes(id)?'mute ':'')+(withoutVoice(id)?'bc-rail-missing':''),key:id,'data-speaking':id===identity.speakingId,title:withoutVoice(id)?`${name(characters[id])} · ${t('还没选云端声音')}`:name(characters[id])},portrait(characters[id]),withoutVoice(id)&&h('i',{className:'bc-rail-indicator','aria-label':t('还没选云端声音')},VoiceIcon('mic-off',{size:10}))))),
   h('span',null,t('在场')+' '+order.length)),
  (classic||!toolbarTarget)&&feedback);
}
