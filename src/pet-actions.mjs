import {ACTION_MANIFEST as manifest} from './pet-assets.mjs';
import {frameSequence,sequenceFrameElapsed} from './frame-sequence.mjs';
import {PetFeedbackQueue} from './pet-feedback.mjs';
import {EMOTIONS} from './emotions.mjs';
import {validPetCharacter} from './pet-characters.mjs';
export const PET_ATLAS=Object.freeze({src:manifest.src,width:manifest.width,height:manifest.height,columns:manifest.columns,rows:manifest.rows,version:manifest.version});
export const FRAME_SIZE=Object.freeze({width:manifest.frameWidth,height:manifest.frameHeight});
const sequenceInfo=clip=>({cycleMs:clip.cycleMs,sourceFrameCount:clip.frames.length,nativeFrameCount:clip.nativeFrameCount??clip.interpolation?.nativeFrameCount??clip.frames.length,description:clip.description??'MiniMax 完整人物动画。'});
const originalActions=manifest.actions.map(a=>{const clip=frameSequence(a.id);return Object.freeze({...a,...(clip?sequenceInfo(clip):{}),frameDurationsMs:Object.freeze(clip?a.frameDurationsMs.map(t=>t*clip.cycleMs/a.cycleMs):a.frameDurationsMs)});});
const emotionActions=Object.values(EMOTIONS).flatMap(emotion=>{const clip=frameSequence(emotion.actionId);return clip?[Object.freeze({id:emotion.actionId,label:emotion.label,fullFrame:true,frames:clip.frames.length,...sequenceInfo(clip),frameDurationsMs:Object.freeze(clip.frames.map((frame,index)=>(clip.frames[index+1]?.timestampMs??clip.cycleMs)-frame.timestampMs)),transitions:Object.freeze([])})]:[];});
export const PET_ACTIONS=Object.freeze([...originalActions,...emotionActions]);
export const DIRECTION_FRAMES=Object.freeze(manifest.directionFrames);
export const DIRECTION_ANGLES=Object.freeze(manifest.directionAnglesDeg);
const byId=new Map(PET_ACTIONS.map(action=>[action.id,action]));
const sequenceActions=new WeakMap();
export const DIRECTION_LABELS=Object.freeze(manifest.directionLabels);
export function getPetAction(id,characterId){const action=byId.get(id);if(!action)throw new Error('未知桌宠动作：'+id);const clip=frameSequence(id,characterId);if(!clip)return action;if(!sequenceActions.has(clip))sequenceActions.set(clip,{...action,...sequenceInfo(clip),fullFrame:true,frames:clip.frames.length,frameDurationsMs:clip.frames.map((frame,index)=>(clip.frames[index+1]?.timestampMs??clip.cycleMs)-frame.timestampMs)});return sequenceActions.get(clip);}
export function framePose(id,frame){const action=getPetAction(id);if(!Number.isInteger(frame)||frame<0||frame>=action.frames)throw new Error('无效动作帧');if(action.fullFrame)return {row:0,col:0,frame};const index=action.startFrame+frame;return {row:Math.floor(index/PET_ATLAS.columns),col:index%PET_ATLAS.columns,frame};}
export function frameElapsed(id,frame){const clip=frameSequence(id);if(clip)return sequenceFrameElapsed(clip,frame);const action=getPetAction(id);framePose(id,frame);return action.frameDurationsMs.slice(0,frame).reduce((n,t)=>n+t,0)+.001;}
export function actionPose(id,elapsed=0,{lookIndex=null,reducedMotion=false}={}){
  const action=getPetAction(id);let frame=0;
  if(id==='look'&&lookIndex!==null){if(!Number.isInteger(lookIndex)||lookIndex<0||lookIndex>15)throw new Error('观看方向必须在 0–15 之间');frame=DIRECTION_FRAMES[lookIndex];}
  else if(!reducedMotion){let t=Math.max(0,elapsed)%action.cycleMs;while(frame<action.frames-1&&t>=action.frameDurationsMs[frame]){t-=action.frameDurationsMs[frame++];}}
  return framePose(id,frame);
}
// Drawing count and playback rate are separate: keep the manifest's original
// timing, and expose the phase between two existing drawings for presentation.
export function actionSample(id,elapsed=0,options={}){
  const identity={actionId:id,elapsedMs:elapsed,reducedMotion:options.reducedMotion===true,lookAngle:options.lookAngle??null,lookIndex:options.lookIndex??null};
  if(id==='look'&&Number.isFinite(options.lookAngle)&&!options.reducedMotion){
    const angle=wrapAngle(options.lookAngle);
    let frame=DIRECTION_ANGLES.findLastIndex(a=>a<=angle);if(frame<0)frame=23;
    const next=(frame+1)%24,start=DIRECTION_ANGLES[frame],end=next?DIRECTION_ANGLES[next]:360;
    return {...identity,...framePose(id,frame),nextPose:framePose(id,next),mix:(angle-start)/(end-start)};
  }
  const action=getPetAction(id),pose=actionPose(id,elapsed,options);
  if(options.reducedMotion||(id==='look'&&options.lookIndex!==null&&options.lookIndex!==undefined))return {...identity,...pose,nextPose:pose,mix:0};
  const offset=action.frameDurationsMs.slice(0,pose.frame).reduce((n,t)=>n+t,0);
  const phase=Math.max(0,elapsed)%action.cycleMs;
  return {...identity,...pose,nextPose:framePose(id,(pose.frame+1)%action.frames),mix:Math.max(0,Math.min(1,(phase-offset)/action.frameDurationsMs[pose.frame]))};
}
export function validatePetPlayback(request){
  if(!request||typeof request!=='object'||Array.isArray(request))throw new Error('无效动作请求');
  for(const key of Object.keys(request))if(!['id','lookIndex','durationMs','characterId'].includes(key))throw new Error('未知动作选项：'+key);
  if(request.characterId!==undefined&&!validPetCharacter(request.characterId))throw new Error('未知桌宠角色');
  const action=getPetAction(request.id,request.characterId),durationMs=request.durationMs??5000,lookIndex=request.lookIndex??null;
  const maximum=action.sourceFrameCount?60000:15000;
  if(!Number.isFinite(durationMs)||durationMs<500||durationMs>maximum)throw new Error('演示时长必须在 0.5–'+maximum/1000+' 秒之间');
  if(lookIndex!==null&&(action.id!=='look'||!Number.isInteger(lookIndex)||lookIndex<0||lookIndex>15))throw new Error('无效观看方向');
  return {id:action.id,durationMs,lookIndex,...(request.characterId===undefined?{}:{characterId:request.characterId})};
}
export const wrapAngle=a=>((a%360)+360)%360;
export const shortArc=(from,to)=>((to-from+540)%360)-180;
export function cursorDirection(point,eyes,{deadZone=12}={}){
  const dx=point.x-eyes.x,dy=point.y-eyes.y,distance=Math.hypot(dx,dy);
  if(distance<=deadZone)return null;
  const angle=wrapAngle(Math.atan2(dx,-dy)*180/Math.PI);
  return {angle,index:Math.round(angle/22.5)%16,distance};
}
export class GazeTransition{
  constructor({continuous=false}={}){this.target=0;this.from=0;this.at=0;this.initialized=false;this.continuous=continuous;this.unwrapped=null;this.duration=180;this.speed=0;}
  ease(now){const t=Math.max(0,Math.min(1,(now-this.at)/this.duration));return 1-(1-t)**3;}
  // Slow pointer movement keeps the 180ms glide; a fast circle shortens it (down to
  // 90ms at 1440°/s and above) so the gaze lag stays small instead of growing with speed.
  glide(step,now){const v=Math.abs(step)/Math.max(8,now-this.at)*1000;this.speed=this.speed*.6+v*.4;this.duration=180-90*Math.max(0,Math.min(1,(this.speed-360)/1080));}
  // Continuous gaze eases along an unwrapped angle. Pointer samples arrive every
  // 16ms, so each step is small even when the cursor circles fast; the eased gaze
  // may lag far behind, but it keeps turning the way the pointer went instead of
  // taking the opposite short arc once the lag reaches half a turn.
  unwrappedAngle(now){const u=this.unwrapped;return u.from+(u.to-u.from)*this.ease(now);}
  angle(now){if(this.unwrapped)return wrapAngle(this.unwrappedAngle(now));return wrapAngle(this.from+shortArc(this.from,this.target)*this.ease(now));}
  update(index,angle,now){
    if(this.continuous&&Number.isFinite(angle)){
      const target=wrapAngle(angle);
      if(!this.initialized||!this.unwrapped){const from=this.initialized?this.angle(now):0,to=from+shortArc(from,target);this.unwrapped={from,to,turn:to<from?-1:1};this.target=target;this.at=now;this.initialized=true;return index;}
      let step=shortArc(this.target,target);
      if(Math.abs(step)<.3)return Math.round(this.target/22.5)%16;
      // A half-turn jump (pointer crossing the eyes) is ambiguous; keep the current turning direction.
      if(Math.abs(step)>=179.5)step=Math.abs(step)*this.unwrapped.turn;
      const from=this.unwrappedAngle(now),to=this.unwrapped.to+step,shift=Math.abs(to)>3600?360*Math.trunc(to/360):0;
      this.glide(step,now);this.unwrapped={from:from-shift,to:to-shift,turn:step<0?-1:1};this.target=target;this.at=now;return index;
    }
    if(this.initialized&&Number.isFinite(angle)&&Math.abs(shortArc(this.target,angle))<=14.25)return Math.round(this.target/22.5)%16;
    const target=index*22.5;if(this.initialized&&target===this.target)return index;
    this.from=this.initialized?this.angle(now):0;this.unwrapped=null;this.duration=180;this.target=target;this.at=now;this.initialized=true;return index;
  }
}
export class PetActionController{
  constructor({now=()=>Date.now(),ready=()=>true}={}){this.now=now;this.speed=1;this.speedAt=now();this.animationAt=this.speedAt;this.base='idle';this.baseAt=this.animationAt;this.manual=null;this.event=null;this.dragging=false;this.dragDirection=1;this.dragAt=this.animationAt;this.pointer=null;this.lookAt=-Infinity;this.lookAnimationAt=this.animationAt;this.lookIndex=0;this.followCursor=true;this.gaze=new GazeTransition({continuous:!!frameSequence('look')});this.gazeBlend={from:0,target:0,at:this.speedAt};this.turn=null;this.visible=true;this.feedback=new PetFeedbackQueue({now,cycle:id=>getPetAction(id).cycleMs,ready});}
  animationNow(now=this.now()){return this.animationAt+Math.max(0,now-this.speedAt)*this.speed;}
  setSpeed(value){
    if(!Number.isFinite(value)||value<.25||value>1)throw new Error('无效动作速度');
    if(value===this.speed)return;
    this.select();const now=this.now(),animation=this.animationNow(now);this.animationAt=animation;this.speedAt=now;this.speed=value;
  }
  setBase(id){if(!['idle','working','waiting'].includes(id))throw new Error('Invalid base action');if(this.base!==id){this.base=id;this.baseAt=this.animationNow();}}
  play(request){this.select();const value=validatePetPlayback(request),now=this.now();this.manual={...value,startedAt:this.animationNow(now),expiresAt:now+value.durationMs};return this.select();}
  automatic(){this.select();this.manual=null;return this.select();}
  setVisible(value){this.visible=!!value;if(!this.visible)this.feedback.clear();}
  enqueueFeedback(value){if(!this.visible)return false;if(value.id)getPetAction(value.id);this.select();return this.feedback.enqueue(value);}
  trigger(id,{durationMs=null,source='event'}={}){
    return this.enqueueFeedback({id,source,cycles:id==='fail'?1:2,...(durationMs===null?{}:{durationMs})});
  }
  drag(active,direction=0){if(active!==this.dragging){this.select();this.dragAt=this.animationNow();this.dragging=active;this.turn=null;}if(direction&&Math.sign(direction)!==this.dragDirection){this.turn={from:this.dragDirection,to:Math.sign(direction),at:this.now(),durationMs:120};this.dragDirection=Math.sign(direction);}}
  cursor(x,y,index,angle=null){if(!this.pointer||Math.hypot(x-this.pointer.x,y-this.pointer.y)>1){this.pointer={x,y};this.lookAt=this.now();if(!this.gaze.initialized)this.lookAnimationAt=this.animationNow(this.lookAt);this.lookIndex=this.gaze.update(index,angle,this.lookAt);}}
  gazeWeight(now=this.now()){const b=this.gazeBlend,t=Math.max(0,Math.min(1,(now-b.at)/180)),u=t*t*(3-2*t);return b.from+(b.target-b.from)*u;}
  select(){
    const now=this.now(),manualEnd=this.manual?.expiresAt;if(this.manual&&now>=this.manual.expiresAt)this.manual=null;
    const feedback=this.feedback.tick({paused:!this.visible||this.dragging||!!this.manual||!!this.holdFeedback,speed:this.speed,resumedAt:manualEnd!==undefined&&manualEnd<=now?manualEnd:null});this.event=feedback;
    let id=this.base,startedAt=this.baseAt,source='monitor',lookIndex=null,expiresAt=null;
    const wantsGaze=!!(this.followCursor&&this.base==='idle'&&this.gaze.initialized&&!this.event&&!this.manual&&!this.dragging),weight=this.gazeWeight(now);
    if(Number(wantsGaze)!==this.gazeBlend.target)this.gazeBlend={from:weight,target:Number(wantsGaze),at:now};
    const gazeWeight=this.gazeWeight(now);
    if(this.base==='idle'&&(wantsGaze||gazeWeight>0)){id='look';startedAt=this.lookAnimationAt;lookIndex=this.lookIndex;source=wantsGaze?'cursor':'cursor-return';}
    if(feedback&&!feedback.paused&&feedback.id){({id,expiresAt,source}=feedback);startedAt=this.animationNow(now)-feedback.elapsed;}
    if(this.manual){({id,startedAt,expiresAt,lookIndex}=this.manual);source='manual';}
    if(this.dragging){id=this.dragDirection<0?'move-left':'move-right';startedAt=this.dragAt;source='drag';lookIndex=null;expiresAt=null;}
    return {id,source,manual:!!this.manual,expiresAt,feedback,queuedFeedback:this.feedback.queue.length,elapsed:Math.max(0,this.animationNow(now)-startedAt),baseElapsed:Math.max(0,this.animationNow(now)-this.baseAt),clockMs:this.animationNow(now),animationSpeed:this.speed,cycleMs:getPetAction(id).cycleMs/this.speed,lookIndex,lookAngle:source.startsWith('cursor')?this.gaze.angle(now):null,gazeWeight:source.startsWith('cursor')?gazeWeight:0,turn:this.dragging&&this.turn&&now-this.turn.at<120?{...this.turn,progress:Math.max(0,(now-this.turn.at)/120)}:null};
  }
}
