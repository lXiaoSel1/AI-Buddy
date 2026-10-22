import {PetActionController,actionSample,getPetAction,PET_ATLAS,FRAME_SIZE,cursorDirection} from './pet-actions.mjs';
import {subscribeAnimationClock} from './animation-clock.mjs';
import {motionRenderer,prepareCharacterRenderer,adoptCharacterRenderer} from './motion-renderer.mjs';
import {currentPetCharacter,CHARACTER_SEQUENCES} from './frame-sequence.mjs';
import {resolvePetCharacter} from './pet-characters.mjs';
import {PetCharacterSwitch} from './pet-character-switch.mjs';
import {interactionPresentation} from './pet-interaction-view.mjs';
import {PetGloveController,gloveCursorV2,preloadGloveArtwork} from './pet-glove.mjs';
import {petPresentation,petActionPresentation} from './pet-presentation.mjs';
import {APP_NAME} from './app-brand.mjs';
import {applyAppearance} from './appearance.mjs';
import {t} from './i18n.mjs';
import {badgeText,bubbleView} from './pet-badge.mjs';
import {iconElement} from './ui-icons.mjs';
const sprite=document.querySelector('.sprite'),bubble=document.querySelector('.bubble'),badge=document.querySelector('.badge');
const badgeLabel=badge.querySelector('.badge-label'),badgeClose=badge.querySelector('.badge-close'),bubbleBox=bubble.querySelector('.bubble-box');
badgeClose.append(iconElement('close',{size:12}));
const surface=document.createElement('canvas');surface.width=FRAME_SIZE.width;surface.height=FRAME_SIZE.height;surface.setAttribute('aria-hidden','true');sprite.append(surface);
const image=new Image();image.src=PET_ATLAS.src;
sprite.style.backgroundImage=`url('${PET_ATLAS.src}')`;sprite.style.backgroundSize=PET_ATLAS.width+'px '+PET_ATLAS.height+'px';
const controller=new PetActionController({ready:(id,elapsed)=>motionRenderer.isReadyFor?.(id,elapsed,{reducedMotion:reducedMotion.matches})??true});
controller.holdFeedback=true;
let presentedBubble=null;
let pixels=null,mode='idle',row=0,col=0,down=false,lastOpaque=null,bodyOpaque=false,interaction=null,bubbleTimer,frameTimer=null,dialogActive=false,lastCursor=null,lastBackground='',lastState='',lastSnapshot={},badgeHeld=false,badgeKey='',bubbleOpen=null,notice=false;
let gestureId=null,capturedPointer=null,readySent=null,ownerButton=null,releaseButton=null,chordRequest=null,suppressedButtons=0,observedButtons=0;
let currentSample=actionSample('idle',0);
let geometry=null;
function petGeometry(){if(!geometry)geometry={sprite:sprite.getBoundingClientRect(),badge:badge.getBoundingClientRect()};return geometry;}
window.addEventListener('resize',()=>{geometry=null;motionRenderer.invalidate?.(surface);});
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
const gloveState=new PetGloveController({highDpi:CSS.supports('cursor',gloveCursorV2('open'))});
const gloveArtwork=preloadGloveArtwork();gloveState.setContext({artReady:false});
let lastGloveCss=null,gloveDisposed=false;
window.petGloveArtworkReady=gloveArtwork.ready.then(state=>{if(!gloveDisposed){gloveState.setContext(state);updateGlove();}return state;});
let preferences={petScale:1.25,animationSpeed:.75,showStatusBadge:true,followCursor:true,completionBubbles:true};
let configuredCharacter=currentPetCharacter(),demoRequest=null,demoActive=false,settingsReady=false,characterError=null;
let appliedPresentation=null;
let badgeLayout=null;
function placeStatusBadge(){const grounded=interaction?.motion?.grounded===true,hidden=!preferences.showStatusBadge||badgeHeld||grounded&&!bubble.hidden,top=grounded?Math.max(4,(interaction.motion.collisionInsets?.top??0)/(preferences.petScale??1.25)-34)+'px':'';const key=hidden+'|'+top;if(key===badgeLayout)return;badgeLayout=key;badge.hidden=hidden;badge.style.top=top;badge.style.bottom=grounded?'auto':'';geometry=null;}
function applyCharacterPresentation(id,actionId='idle'){const presentation=petActionPresentation(id,motionRenderer.sequences?.[actionId]);if(appliedPresentation?.transform===presentation.transform)return false;sprite.style.transformOrigin='0 0';sprite.style.transform=presentation.transform;appliedPresentation=presentation;geometry=null;motionRenderer.invalidate?.(surface);return true;}
applyCharacterPresentation(currentPetCharacter());
let initialCharacterReady=false,resolveInitialCharacter;
window.petCharacterReady=new Promise(resolve=>{resolveInitialCharacter=resolve;});
async function finishInitialCharacter(){await motionRenderer.ready;if(initialCharacterReady||characterSwitch.loading||characterSwitch.current!==characterSwitch.target)return;motionRenderer.draw(surface,actionSample('idle',0,{reducedMotion:true}));currentSample=motionRenderer.displayedSample?.(surface)??actionSample('idle',0);initialCharacterReady=true;resolveInitialCharacter(true);}
const characterSwitch=new PetCharacterSwitch({current:currentPetCharacter(),prepare:prepareCharacterRenderer,commit:(id,next)=>{gloveState.cancel('character-change');adoptCharacterRenderer(id,next);applyCharacterPresentation(id);controller.baseAt=controller.animationNow();controller.lookAt=-Infinity;controller.gaze.initialized=false;controller.gaze.unwrapped=null;controller.gazeBlend={from:0,target:0,at:Date.now()};currentSample=actionSample('idle',0);lastOpaque=null;geometry=null;},onPrepared:()=>{if(!initialCharacterReady){characterSwitch.advance();void finishInitialCharacter();}},onError:error=>{window.petMotionError=error.message;characterError=t('角色动作加载失败，请重试。',preferences.language);demoRequest=null;demoActive=false;controller.holdFeedback=false;if(!initialCharacterReady)void finishInitialCharacter();}});
function requestCharacter(id){if(id!==currentPetCharacter())gloveState.cancel('character-switch');characterSwitch.request(id);if(!initialCharacterReady&&!characterSwitch.loading)void finishInitialCharacter();}
function applySettings(value){
  preferences=value.preferences;
  settingsReady=true;
  configuredCharacter=value.effectivePetCharacter??resolvePetCharacter(preferences,value.themeCharacter);
  if(!demoRequest&&!demoActive)requestCharacter(configuredCharacter);
  applyAppearance(preferences,value.themeCharacter);
  tintGlove(document.documentElement.dataset.theme);
  controller.setSpeed(preferences.animationSpeed??.75);
  document.body.style.setProperty('--pet-scale',preferences.petScale);
  geometry=null;motionRenderer.invalidate?.(surface);
  badgeLayout=null;badge.hidden=!preferences.showStatusBadge;
  badgeClose.setAttribute('aria-label',t('关闭状态条',preferences.language));badgeClose.title=t('关闭状态条',preferences.language);
  controller.followCursor=preferences.followCursor;
  controller.setVisible(preferences.petVisible!==false&&!document.hidden);
  if(!preferences.completionBubbles){bubble.hidden=true;clearTimeout(bubbleTimer);presentedBubble=null;}
  lastOpaque=null;
  render();
}
window.whale.onSettings(applySettings);
window.whale.settings().then(applySettings);
window.petInputDiagnostic={move:0,down:0,up:0};
image.onload=()=>{const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);pixels=ctx.getImageData(0,0,image.width,image.height).data;lastOpaque=null;render();};
motionRenderer.ready.then(()=>{pixels=motionRenderer.pixels.atlas;sprite.style.backgroundImage='none';lastOpaque=null;render();}).catch(error=>{window.petMotionError=error.message;});
const originalIcon=new Image();originalIcon.src='./assets/pet-spritesheet.webp';originalIcon.onload=()=>{const icon=document.createElement('canvas');icon.width=26;icon.height=28;icon.getContext('2d').drawImage(originalIcon,6*192,0,192,208,0,0,26,28);window.whale.setPetIcon(icon.toDataURL('image/png'));};
function updateSnapshot(snapshot){
  const active=snapshot.sessions || [];
  const running=active.filter(s=>s.displayStatus==='running').length,waiting=active.some(s=>s.displayStatus==='waiting');
  mode=motionRenderer.workingRigPilot?'working':waiting?'waiting':running?'working':'idle';controller.setBase(dialogActive?'working':mode);
  lastSnapshot=snapshot;
  badge.title='今日 Claude '+compact(snapshot.todayUsage?.claude?.total || 0)+' / Codex '+compact(snapshot.todayUsage?.codex?.total || 0)+' token';
}
window.whale.onUpdate(updateSnapshot);
function compact(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(n);}
window.whale.onBubble(text=>{if(!preferences.completionBubbles)return;fillBubble({text});bubble.hidden=false;clearTimeout(bubbleTimer);bubbleTimer=setTimeout(()=>bubble.hidden=true,6500);});
function presentFeedback(value){
  if(!preferences.completionBubbles){if(!notice)bubble.hidden=true;return;}
  if(value?.paused){if(presentedBubble&&!presentedBubble.paused){presentedBubble.remaining=Math.max(0,presentedBubble.until-Date.now());presentedBubble.paused=true;clearTimeout(bubbleTimer);}bubble.hidden=true;geometry=null;return;}
  if(!value?.text)return;
  if(presentedBubble?.eventId!==value.eventId){presentedBubble={eventId:value.eventId,remaining:6500,paused:true};notice=false;fillBubble(value);}
  if(presentedBubble.paused){presentedBubble.paused=false;presentedBubble.until=Date.now()+presentedBubble.remaining;bubble.hidden=false;geometry=null;clearTimeout(bubbleTimer);bubbleTimer=setTimeout(()=>{bubble.hidden=true;geometry=null;},presentedBubble.remaining);}
}
window.whale.onCursor(point=>{
  lastCursor=point;
  const rect=petGeometry().sprite;
  const origin=motionRenderer.eyeOrigin?.(motionRenderer.sequences?.idle?actionSample('idle',0):currentSample)??{x:98,y:130};
  const direction=cursorDirection(point,{x:rect.left+origin.x/FRAME_SIZE.width*rect.width,y:rect.top+origin.y/FRAME_SIZE.height*rect.height});
  if(direction)controller.cursor(point.x,point.y,direction.index,direction.angle);
  controller.drag(!!point.dragging);
});
window.whale.onPetAction(value=>{
  if(value.kind==='interaction')interaction=value.value;
  if(value.kind==='gesture-reset'&&(!value.gestureId||value.gestureId===gestureId)){
    if(Number.isInteger(value.buttons))suppressedButtons=value.buttons;
    // Native release may beat DOM pointerup. Keep this gesture eligible for
    // its following confirmed touch; cancellation must invalidate it instead.
    clearPointer(value.reason??'cancelled',value.gestureId??gestureId);
  }
  if(value.kind==='feedback'){
    if(value.value?.source==='touch'){updateGlove();gloveState.touch(value.value);}
    controller.enqueueFeedback(value.value);
  }
  if(value.kind==='play'){demoRequest={id:value.id,lookIndex:value.lookIndex,durationMs:value.durationMs,characterId:value.characterId??currentPetCharacter()};requestCharacter(demoRequest.characterId);}
  if(value.kind==='auto'){demoRequest=null;demoActive=false;requestCharacter(configuredCharacter);controller.holdFeedback=characterSwitch.target!==characterSwitch.current;controller.automatic();}
  if(value.kind==='trigger')controller.trigger(value.id,{source:value.source,durationMs:value.durationMs});
  if(value.kind==='drag')controller.drag(value.active,value.direction);
  if(value.kind==='dialog'){dialogActive=value.active;controller.setBase(dialogActive?'working':mode);}
  render();
});
function render(){
  if(document.hidden)return;
  // Read rectangles before any style/text write. Only the small sprite is repainted.
  const {sprite:rect,badge:b}=petGeometry();
  if(demoActive&&(!controller.manual||controller.manual.expiresAt<=Date.now())){demoActive=false;requestCharacter(demoRequest?.characterId??configuredCharacter);controller.holdFeedback=!!demoRequest||characterSwitch.target!==characterSwitch.current;controller.automatic();}
  const hasStartedFeedback=!!controller.feedback.active||controller.feedback.queue.some(item=>item.startedAt!==undefined);
  const interactionView=interactionPresentation(interaction,{speed:preferences.animationSpeed??.75,hasClip:id=>!!motionRenderer.sequences?.[id],cycle:id=>getPetAction(id).cycleMs});
  controller.holdFeedback=!settingsReady||interactionView?.hold||!!((demoRequest||characterSwitch.target!==characterSwitch.current)&&!hasStartedFeedback);
  let state=controller.select();
  const characterChanged=characterSwitch.advance({busy:controller.dragging||['flying','charging','landing'].includes(interactionView?.motion)||!!controller.manual||hasStartedFeedback});
  if(characterChanged)state=controller.select();
  if(demoRequest&&!characterSwitch.loading&&!characterSwitch.failed&&currentPetCharacter()===demoRequest.characterId&&!controller.dragging&&!controller.manual){controller.play(demoRequest);demoRequest=null;demoActive=true;controller.holdFeedback=false;state=controller.select();}
  if(interactionView?.id&&!state.manual){state={...state,id:interactionView.id,source:'interaction',elapsed:interactionView.elapsed,lookIndex:null,lookAngle:null,gazeWeight:0,feedback:null};}
  else if(interactionView?.hold&&!state.manual){state={...state,id:'idle',source:'interaction-pending-media',elapsed:0,lookIndex:null,lookAngle:null,gazeWeight:0,feedback:null};}
  const pose=actionSample(state.id,state.elapsed,{lookIndex:state.lookIndex,lookAngle:state.lookAngle,reducedMotion:reducedMotion.matches});
  pose.elapsedMs=state.elapsed;pose.clockMs=state.clockMs;pose.baseElapsedMs=state.baseElapsed;pose.followBaseId=state.source.startsWith('cursor')?'idle':null;pose.gazeAngle=state.lookAngle;pose.gazeWeight=state.gazeWeight;pose.turn=state.turn;pose.reducedMotion=reducedMotion.matches;
  pose.playbackRate=state.animationSpeed;pose.staticFrame=!state.manual?interactionView?.staticFrame:null;pose.playing=state.manual||!(interactionView?.playing===false||interactionView?.animationWaiting||interactionView?.missing||interactionView?.asleep&&!interactionView.id);
  currentSample=pose;
  row=pose.row;col=pose.col;
  const background=(-col*FRAME_SIZE.width)+'px '+(-row*FRAME_SIZE.height)+'px';
  if(background!==lastBackground){sprite.style.backgroundPosition=background;lastBackground=background;}
  motionRenderer.draw(surface,pose);
  currentSample=motionRenderer.displayedSample?.(surface)??pose;
  if(interactionView?.animationWaiting&&!state.manual&&interaction.characterId===currentPetCharacter()){
    const id=interactionView.id,key=[currentPetCharacter(),interactionView.readyScope,interactionView.animationEpoch,id].join(':');
    motionRenderer.isReadyFor?.(id,0); // Also enforces the bounded decoder timeout.
    const slot=motionRenderer.targets?.get(surface)?.slot,failed=!!slot?.error;
    // Ack only a decoded frame actually drawn for this action, never its placeholder.
    const ready=slot?.ready&&!slot.seekPending&&currentSample.actionId===id;
    if(readySent!==key&&(ready||failed)){readySent=key;window.whale.interactionReady({characterId:currentPetCharacter(),scope:interactionView.readyScope,epoch:interactionView.animationEpoch,id,failed});}
  }
  const registrationChanged=applyCharacterPresentation(currentPetCharacter(),currentSample.actionId);
  presentFeedback(state.feedback);
  if(characterError&&!state.feedback&&!controller.manual){
    fillBubble({text:characterError});characterError=null;bubble.hidden=false;geometry=null;clearTimeout(bubbleTimer);
    bubbleTimer=setTimeout(()=>{bubble.hidden=true;geometry=null;},6500);
  }
  placeStatusBadge();
  if(lastCursor&&!characterChanged&&!registrationChanged)hitAt(lastCursor.x,lastCursor.y,rect,b);
  updateGlove();
  renderBadge(badgeText({snapshot:lastSnapshot,interaction,demo:state.manual?getPetAction(state.id).label:'',rigPilot:motionRenderer.workingRigPilot?Math.round((preferences.animationSpeed??.75)*100):null,language:preferences.language}));
  const label=APP_NAME+' · '+getPetAction(state.id).label;if(sprite.getAttribute('aria-label')!==label)sprite.setAttribute('aria-label',label);
  window.petActionDiagnostic={...state,...pose,interaction,interactionView,characterId:currentPetCharacter(),targetCharacterId:characterSwitch.target,presentation:appliedPresentation??petPresentation(currentPetCharacter()),renderer:motionRenderer.backend,displayedActionId:currentSample.actionId,sequenceFrame:motionRenderer.sequences?.[state.id]?currentSample.displayedSequenceFrame??null:null,sourceFrameCount:motionRenderer.sequences?.[state.id]?.frames.length??getPetAction(state.id).frames,draws:motionRenderer.draws,rigDraws:motionRenderer.rigDraws??0,rigResizes:motionRenderer.rigResizes??0,canvasSize:[surface.width,surface.height],geometryReads:motionRenderer.geometryReads??0};
  const report={id:state.id,source:state.source,manual:state.manual,expiresAt:state.expiresAt,characterId:currentPetCharacter()},key=JSON.stringify(report);
  if(key!==lastState){lastState=key;window.whale.reportPetState(report);}
}
// Dot (or icon) + label + "· detail". Rebuilt only when the wording changes.
function renderBadge(view){
  const key=JSON.stringify(view);if(key===badgeKey)return;badgeKey=key;badgeHeld=!view;placeStatusBadge();if(!view)return;
  badge.dataset.state=view.tone||'';
  let lead;if(view.icon)lead=iconElement(view.icon,{size:13});else{lead=document.createElement('i');lead.className=view.tone==='busy'?'badge-spin':'badge-dot';}
  lead.setAttribute('aria-hidden','true');badge.firstElementChild.replaceWith(lead);
  const detail=view.detail?[Object.assign(document.createElement('small'),{textContent:'· '+view.detail})]:[];
  badgeLabel.replaceChildren(view.label,...detail);geometry=null;
}
// Bold "who / what happened", then a second line; a check or warning icon; the original text stays in data-text.
function fillBubble(value){
  const view=bubbleView(value,{language:preferences.language}),text=document.createElement('div');text.className='bubble-text';
  bubbleOpen=view.open??null;bubble.dataset.kind=view.kind;bubble.dataset.text=String(value.text??view.title);
  if(view.open)bubble.dataset.open=view.open;else delete bubble.dataset.open;
  if(view.name)text.append(Object.assign(document.createElement('span'),{className:'bubble-name',textContent:view.name}));
  const title=document.createElement(['plain','say'].includes(view.kind)?'span':'b');title.textContent=view.title;
  if(view.undo){const undo=Object.assign(document.createElement('button'),{type:'button',className:'bubble-undo',textContent:view.undo});undo.addEventListener('click',restoreBadge);title.append(undo);}
  text.append(title);
  if(view.detail)text.append(Object.assign(document.createElement('small'),{textContent:view.detail}));
  if(view.link)text.append(Object.assign(document.createElement('span'),{className:'bubble-link',textContent:view.link}));
  bubbleBox.replaceChildren(...(view.icon?[iconElement(view.icon,{size:16})]:[]),text);geometry=null;
}
// Shown once after the bar is closed, whether or not completion bubbles are on.
function showNotice(value){notice=true;fillBubble(value);bubble.hidden=false;geometry=null;clearTimeout(bubbleTimer);bubbleTimer=setTimeout(()=>{notice=false;bubble.hidden=true;geometry=null;},6500);}
async function restoreBadge(event){event.preventDefault();event.stopPropagation();try{applySettings(await window.whale.setSettings({showStatusBadge:true}));}catch{}notice=false;bubble.hidden=true;geometry=null;clearTimeout(bubbleTimer);}
let gloveTheme=null;
function tintGlove(theme){
  if(!theme||theme===gloveTheme)return;gloveTheme=theme;const baseUrl='./assets/pet-glove-tint/'+theme,art=preloadGloveArtwork({baseUrl,highDpi:gloveState.cursorOptions.highDpi});
  art.ready.then(state=>{if(gloveTheme!==theme||gloveDisposed||!state.artReady)return;gloveState.cursorOptions.baseUrl=baseUrl;tintedArtwork=art;lastGloveCss=null;updateGlove();});
}
let tintedArtwork=null;
function hitAt(clientX,clientY,rect=petGeometry().sprite,b=petGeometry().badge){
  let hit=false;
  if(pixels && clientX>=rect.left && clientX<rect.right && clientY>=rect.top && clientY<rect.bottom){
    const x=(clientX-rect.left)/rect.width*FRAME_SIZE.width,y=(clientY-rect.top)/rect.height*FRAME_SIZE.height;
    hit=motionRenderer.pixels?motionRenderer.alpha(currentSample,x,y)>25:pixels[((Math.floor(y)+row*FRAME_SIZE.height)*image.width+Math.floor(x)+col*FRAME_SIZE.width)*4+3]>25;
  }
  bodyOpaque=hit;updateGlove();
  if(!badge.hidden&&clientX>=b.left&&clientX<b.right&&clientY>=b.top&&clientY<b.bottom)hit=true;
  if(!bubble.hidden){const br=bubble.getBoundingClientRect();if(clientX>=br.left&&clientX<br.right&&clientY>=br.top&&clientY<br.bottom)hit=true;}
  if(hit!==lastOpaque){lastOpaque=hit;window.whale.hit(hit);}
}
// This control can overlap the sprite's transparent/opaque area. Consume its
// own button events before the document's drag, touch and chord handlers.
for(const type of ['pointerdown','mousedown'])badge.addEventListener(type,event=>{event.stopPropagation();event.preventDefault();});
for(const type of ['pointerdown','mousedown','pointerup','mouseup','dblclick','contextmenu'])badgeClose.addEventListener(type,event=>{event.stopPropagation();if(['pointerdown','mousedown','contextmenu'].includes(type))event.preventDefault();});
badge.addEventListener('click',event=>{if(!event.target.closest('.badge-close'))window.whale.open('overview');});
bubble.addEventListener('click',event=>{if(bubbleOpen&&!event.target.closest('button'))window.whale.open(bubbleOpen);});
badgeClose.addEventListener('click',async event=>{
  event.preventDefault();event.stopPropagation();if(badgeClose.disabled)return;badgeClose.disabled=true;
  try{applySettings(await window.whale.setSettings({showStatusBadge:false}));showNotice({kind:'badge-hidden'});hitAt(event.clientX,event.clientY);}
  catch{badgeClose.title=t('关闭失败，请重试',preferences.language);}
  finally{badgeClose.disabled=false;}
});
function updateGlove(){
  const state=gloveState.setContext({opaque:bodyOpaque,down,mode:interaction?.motion?.mode??'rest',characterId:currentPetCharacter(),visible:preferences.petVisible!==false&&!document.hidden,reducedMotion:reducedMotion.matches});
  if(lastGloveCss!==state.cursorCss){lastGloveCss=state.cursorCss;sprite.style.cursor=state.cursorCss;}
  window.petGloveDiagnostic=state;return state;
}
function clearPointer(reason='released',id=gestureId){
  if(id)gloveState.releaseGesture(id,{reason});else if(reason!=='released')gloveState.cancel(reason);
  down=false;gestureId=null;ownerButton=null;releaseButton=null;chordRequest=null;controller.drag(false);updateGlove();
  const captured=capturedPointer;capturedPointer=null;if(captured)try{captured.target.releasePointerCapture(captured.id);}catch{}
}
function cancelPointer(reason){gloveState.cancel(reason);if(!down){updateGlove();return;}const id=gestureId;suppressedButtons=observedButtons;clearPointer(reason);void window.whale.cancelPetGesture({gestureId:id,reason});}
document.addEventListener('mousemove',event=>{
 observedButtons=event.buttons;suppressedButtons&=event.buttons;window.petInputDiagnostic.move++;window.petInputDiagnostic.cursor={x:event.clientX,y:event.clientY};hitAt(event.clientX,event.clientY);
 if(down&&!chordRequest&&!(event.buttons&(releaseButton===2?2:1)))cancelPointer('button-lost');else if(down)window.whale.dragMove({gestureId});
});
document.addEventListener('pointerdown',event=>{
 // Native pointerdown occurs only on the transition from no buttons to held.
 // It proves a prior out-of-window release occurred, unlike chord mousedown.
 observedButtons=event.buttons;if(!down)suppressedButtons=0;if(![0,2].includes(event.button)||down)return;hitAt(event.clientX,event.clientY);if(!bodyOpaque)return;
 down=true;ownerButton=event.button;releaseButton=ownerButton;gestureId=crypto.randomUUID();gloveState.beginGesture(gestureId,{characterId:currentPetCharacter()});updateGlove();window.petInputDiagnostic.down++;
 window.whale.dragStart({gestureId,button:ownerButton,local:{x:event.clientX/innerWidth,y:event.clientY/innerHeight}});
 try{event.target.setPointerCapture(event.pointerId);capturedPointer={target:event.target,id:event.pointerId};}catch{cancelPointer('capture-failed');}
});
// Chorded buttons use mouse events. Once charging is accepted, LEFT release
// launches, even if RIGHT was released first. Buffer releases while the main
// process confirms charging so fast clicks cannot race the IPC response.
document.addEventListener('mousedown',event=>{
 observedButtons=event.buttons;if(suppressedButtons){suppressedButtons=event.buttons;return;}if(!down||ownerButton!==2||releaseButton===0||event.button!==0||chordRequest)return;
 event.preventDefault();const id=gestureId,request={releases:[]};chordRequest=request;
 void window.whale.petContext({gestureId:id,button:0}).then(result=>{
  if(!down||gestureId!==id||chordRequest!==request)return;
  if(result?.charging)releaseButton=0;
  chordRequest=null;for(const event of request.releases)endPointer(event);
  if(down&&gestureId===id&&request.captureLost)cancelPointer('capture-lost');
 }).catch(()=>{if(down&&gestureId===id&&chordRequest===request)cancelPointer('charge-failed');});
});
const endPointer=event=>{observedButtons=event.buttons??0;suppressedButtons&=observedButtons;if(!down)return;if(chordRequest){chordRequest.releases.push({button:event.button,buttons:event.buttons});return;}if(event.button!==releaseButton)return;const id=gestureId,button=releaseButton;suppressedButtons=observedButtons;clearPointer();window.petInputDiagnostic.up++;void window.whale.dragEnd({gestureId:id,button});};
document.addEventListener('pointerup',endPointer);document.addEventListener('mouseup',endPointer);
document.addEventListener('pointercancel',()=>cancelPointer('pointer-cancel'));
document.addEventListener('lostpointercapture',()=>{
 // Chromium implicitly releases capture after the last button-up. If that
 // up is buffered behind a chord acknowledgement, resolve it before treating
 // capture loss as cancellation. Genuine loss still cancels a held gesture.
 if(!down)return;
 if(chordRequest?.releases.length){chordRequest.captureLost=true;capturedPointer=null;return;}
 cancelPointer('capture-lost');
});
window.addEventListener('blur',()=>cancelPointer('window-blur'));
document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelPointer('window-hidden');});
// The main process opens the menu only after a stationary right gesture.
document.addEventListener('contextmenu',event=>event.preventDefault());
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&down){event.preventDefault();cancelPointer('escape');}else if(event.key==='ContextMenu'&&!down&&lastOpaque){event.preventDefault();void window.whale.petContext({});}});
window.whale.status().then(updateSnapshot);
function clock(){frameTimer?.();frameTimer=null;const wasVisible=controller.visible;controller.setVisible(!document.hidden&&preferences.petVisible!==false);if(!document.hidden){if(!wasVisible)controller.trigger('wave',{source:'show'});render();frameTimer=subscribeAnimationClock(render);}else motionRenderer.release?.(surface);}
document.addEventListener('visibilitychange',clock);
window.addEventListener('pagehide',()=>{gloveDisposed=true;gloveState.cancel('pagehide');frameTimer?.();characterSwitch.dispose();motionRenderer.dispose?.();});
reducedMotion.addEventListener('change',render);
clock();
