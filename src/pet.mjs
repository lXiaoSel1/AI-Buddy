import {PetActionController,actionSample,getPetAction,PET_ATLAS,FRAME_SIZE,cursorDirection} from './pet-actions.mjs';
import {subscribeAnimationClock} from './animation-clock.mjs';
import {motionRenderer,prepareCharacterRenderer,adoptCharacterRenderer} from './motion-renderer.mjs';
import {currentPetCharacter,CHARACTER_SEQUENCES} from './frame-sequence.mjs';
import {resolvePetCharacter} from './pet-characters.mjs';
import {PetCharacterSwitch} from './pet-character-switch.mjs';
import {petPresentation} from './pet-presentation.mjs';
import {APP_NAME} from './app-brand.mjs';
import {applyAppearance} from './appearance.mjs';
import {t} from './i18n.mjs';
const sprite=document.querySelector('.sprite'),bubble=document.querySelector('.bubble'),badge=document.querySelector('.badge');
const surface=document.createElement('canvas');surface.width=FRAME_SIZE.width;surface.height=FRAME_SIZE.height;surface.setAttribute('aria-hidden','true');sprite.append(surface);
const image=new Image();image.src=PET_ATLAS.src;
sprite.style.backgroundImage=`url('${PET_ATLAS.src}')`;sprite.style.backgroundSize=PET_ATLAS.width+'px '+PET_ATLAS.height+'px';
const controller=new PetActionController({ready:(id,elapsed)=>motionRenderer.isReadyFor?.(id,elapsed,{reducedMotion:reducedMotion.matches})??true});
controller.holdFeedback=true;
let presentedBubble=null;
let pixels=null,mode='idle',row=0,col=0,down=false,lastOpaque=null,bubbleTimer,frameTimer=null,dialogActive=false,lastCursor=null,lastBackground='',lastState='',badgeText=APP_NAME+' · 离线陪伴';
let currentSample=actionSample('idle',0);
let geometry=null;
function petGeometry(){if(!geometry)geometry={sprite:sprite.getBoundingClientRect(),badge:badge.getBoundingClientRect()};return geometry;}
window.addEventListener('resize',()=>{geometry=null;motionRenderer.invalidate?.(surface);});
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
let preferences={petScale:1.25,animationSpeed:.75,showStatusBadge:true,followCursor:true,completionBubbles:true};
let configuredCharacter='deepseek',demoRequest=null,demoActive=false,settingsReady=false,characterError=null;
function applyCharacterPresentation(id){sprite.style.transformOrigin='0 0';sprite.style.transform=petPresentation(id).transform;geometry=null;motionRenderer.invalidate?.(surface);}
applyCharacterPresentation('deepseek');
let initialCharacterReady=false,resolveInitialCharacter;
window.petCharacterReady=new Promise(resolve=>{resolveInitialCharacter=resolve;});
async function finishInitialCharacter(){await motionRenderer.ready;if(initialCharacterReady||characterSwitch.loading||characterSwitch.current!==characterSwitch.target)return;motionRenderer.draw(surface,actionSample('idle',0,{reducedMotion:true}));currentSample=motionRenderer.displayedSample?.(surface)??actionSample('idle',0);initialCharacterReady=true;resolveInitialCharacter(true);}
const characterSwitch=new PetCharacterSwitch({prepare:prepareCharacterRenderer,commit:(id,next)=>{adoptCharacterRenderer(id,next);applyCharacterPresentation(id);controller.baseAt=controller.animationNow();controller.lookAt=-Infinity;controller.gaze.initialized=false;controller.gaze.unwrapped=null;controller.gazeBlend={from:0,target:0,at:Date.now()};currentSample=actionSample('idle',0);lastOpaque=null;geometry=null;},onPrepared:()=>{if(!initialCharacterReady){characterSwitch.advance();void finishInitialCharacter();}},onError:error=>{window.petMotionError=error.message;characterError=t('角色动作加载失败，请重试。',preferences.language);demoRequest=null;demoActive=false;controller.holdFeedback=false;if(!initialCharacterReady)void finishInitialCharacter();}});
function requestCharacter(id){characterSwitch.request(id);if(!initialCharacterReady&&!characterSwitch.loading)void finishInitialCharacter();}
function applySettings(value){
  preferences=value.preferences;
  settingsReady=true;
  configuredCharacter=resolvePetCharacter(preferences,value.themeCharacter);
  if(!demoRequest&&!demoActive)requestCharacter(configuredCharacter);
  applyAppearance(preferences,value.themeCharacter);
  controller.setSpeed(preferences.animationSpeed??.75);
  document.body.style.setProperty('--pet-scale',preferences.petScale);
  geometry=null;motionRenderer.invalidate?.(surface);
  badge.hidden=!preferences.showStatusBadge;
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
  badgeText=motionRenderer.workingRigPilot?'工作动作小样 · '+Math.round((preferences.animationSpeed??.75)*100)+'%':snapshot.indexing?'正在整理本地记录':running?'工作中 · '+running+' 个会话':waiting?'等待你的回应':APP_NAME+' · 离线陪伴';
  badge.title='今日 Claude '+compact(snapshot.todayUsage?.claude?.total || 0)+' / Codex '+compact(snapshot.todayUsage?.codex?.total || 0)+' token';
}
window.whale.onUpdate(updateSnapshot);
function compact(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(n);}
window.whale.onBubble(text=>{if(!preferences.completionBubbles)return;bubble.textContent=text;bubble.hidden=false;clearTimeout(bubbleTimer);bubbleTimer=setTimeout(()=>bubble.hidden=true,6500);});
function presentFeedback(value){
  if(!preferences.completionBubbles){bubble.hidden=true;return;}
  if(value?.paused){if(presentedBubble&&!presentedBubble.paused){presentedBubble.remaining=Math.max(0,presentedBubble.until-Date.now());presentedBubble.paused=true;clearTimeout(bubbleTimer);}bubble.hidden=true;geometry=null;return;}
  if(!value?.text)return;
  if(presentedBubble?.eventId!==value.eventId){presentedBubble={eventId:value.eventId,remaining:6500,paused:true};bubble.textContent=value.text;}
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
  if(value.kind==='feedback')controller.enqueueFeedback(value.value);
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
  controller.holdFeedback=!settingsReady||!!((demoRequest||characterSwitch.target!==characterSwitch.current)&&!hasStartedFeedback);
  let state=controller.select();
  const characterChanged=characterSwitch.advance({busy:controller.dragging||!!controller.manual||hasStartedFeedback});
  if(characterChanged)state=controller.select();
  if(demoRequest&&!characterSwitch.loading&&!characterSwitch.failed&&currentPetCharacter()===demoRequest.characterId&&!controller.dragging&&!controller.manual){controller.play(demoRequest);demoRequest=null;demoActive=true;controller.holdFeedback=false;state=controller.select();}
  const pose=actionSample(state.id,state.elapsed,{lookIndex:state.lookIndex,lookAngle:state.lookAngle,reducedMotion:reducedMotion.matches});
  pose.elapsedMs=state.elapsed;pose.clockMs=state.clockMs;pose.baseElapsedMs=state.baseElapsed;pose.followBaseId=state.source.startsWith('cursor')?'idle':null;pose.gazeAngle=state.lookAngle;pose.gazeWeight=state.gazeWeight;pose.turn=state.turn;pose.reducedMotion=reducedMotion.matches;
  pose.playbackRate=state.animationSpeed;pose.playing=true;
  currentSample=pose;
  row=pose.row;col=pose.col;
  const background=(-col*FRAME_SIZE.width)+'px '+(-row*FRAME_SIZE.height)+'px';
  if(background!==lastBackground){sprite.style.backgroundPosition=background;lastBackground=background;}
  motionRenderer.draw(surface,pose);
  currentSample=motionRenderer.displayedSample?.(surface)??pose;
  presentFeedback(state.feedback);
  if(characterError&&!state.feedback&&!controller.manual){
    bubble.textContent=characterError;characterError=null;bubble.hidden=false;geometry=null;clearTimeout(bubbleTimer);
    bubbleTimer=setTimeout(()=>{bubble.hidden=true;geometry=null;},6500);
  }
  if(lastCursor&&!characterChanged)hitAt(lastCursor.x,lastCursor.y,rect,b);
  const text=state.manual?'演示 · '+getPetAction(state.id).label:badgeText;if(badge.textContent!==text)badge.textContent=text;
  const label=APP_NAME+' · '+getPetAction(state.id).label;if(sprite.getAttribute('aria-label')!==label)sprite.setAttribute('aria-label',label);
  window.petActionDiagnostic={...state,...pose,characterId:currentPetCharacter(),targetCharacterId:characterSwitch.target,presentation:petPresentation(currentPetCharacter()),renderer:motionRenderer.backend,displayedActionId:currentSample.actionId,sequenceFrame:motionRenderer.sequences?.[state.id]?currentSample.displayedSequenceFrame??null:null,sourceFrameCount:motionRenderer.sequences?.[state.id]?.frames.length??getPetAction(state.id).frames,draws:motionRenderer.draws,rigDraws:motionRenderer.rigDraws??0,rigResizes:motionRenderer.rigResizes??0,canvasSize:[surface.width,surface.height],geometryReads:motionRenderer.geometryReads??0};
  const report={id:state.id,source:state.source,manual:state.manual,expiresAt:state.expiresAt,characterId:currentPetCharacter()},key=JSON.stringify(report);
  if(key!==lastState){lastState=key;window.whale.reportPetState(report);}
}
function hitAt(clientX,clientY,rect=petGeometry().sprite,b=petGeometry().badge){
  let hit=false;
  if(pixels && clientX>=rect.left && clientX<rect.right && clientY>=rect.top && clientY<rect.bottom){
    const x=(clientX-rect.left)/rect.width*FRAME_SIZE.width,y=(clientY-rect.top)/rect.height*FRAME_SIZE.height;
    hit=motionRenderer.pixels?motionRenderer.alpha(currentSample,x,y)>25:pixels[((Math.floor(y)+row*FRAME_SIZE.height)*image.width+Math.floor(x)+col*FRAME_SIZE.width)*4+3]>25;
  }
  if(!badge.hidden&&clientX>=b.left&&clientX<b.right&&clientY>=b.top&&clientY<b.bottom)hit=true;
  if(!bubble.hidden){const br=bubble.getBoundingClientRect();if(clientX>=br.left&&clientX<br.right&&clientY>=br.top&&clientY<br.bottom)hit=true;}
  if(hit!==lastOpaque){lastOpaque=hit;window.whale.hit(hit);}
}
document.addEventListener('mousemove',event=>{window.petInputDiagnostic.move++;window.petInputDiagnostic.cursor={x:event.clientX,y:event.clientY};hitAt(event.clientX,event.clientY);if(down)window.whale.dragMove({x:event.screenX,y:event.screenY});});
const begin=event=>{if(event.button!==0 || down)return;down=true;window.petInputDiagnostic.down++;window.whale.dragStart({x:event.screenX,y:event.screenY});try{event.target.setPointerCapture?.(event.pointerId);}catch{/* Main window keeps mouse input during a drag. */}};
const end=async event=>{if(!down)return;down=false;window.petInputDiagnostic.up++;const moved=await window.whale.dragEnd({x:event.screenX,y:event.screenY});if(!moved)window.whale.open('overview');};
document.addEventListener('pointerdown',begin);document.addEventListener('mousedown',begin);
document.addEventListener('pointerup',end);document.addEventListener('mouseup',end);
document.addEventListener('pointercancel',()=>{if(down){down=false;void window.whale.dragEnd();}});
window.whale.status().then(updateSnapshot);
function clock(){frameTimer?.();frameTimer=null;const wasVisible=controller.visible;controller.setVisible(!document.hidden&&preferences.petVisible!==false);if(!document.hidden){if(!wasVisible)controller.trigger('wave',{source:'show'});render();frameTimer=subscribeAnimationClock(render);}else motionRenderer.release?.(surface);}
document.addEventListener('visibilitychange',clock);
window.addEventListener('pagehide',()=>{frameTimer?.();characterSwitch.dispose();motionRenderer.dispose?.();});
reducedMotion.addEventListener('change',render);
clock();
