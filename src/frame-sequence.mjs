// The build supplies immutable sequence metadata and shared physical resources.
const legacySequences=typeof __FRAME_SEQUENCES__==='undefined'?{}:__FRAME_SEQUENCES__;
export const CHARACTER_SEQUENCES=typeof __PET_CHARACTER_SEQUENCES__==='undefined'?{deepseek:legacySequences}:__PET_CHARACTER_SEQUENCES__;
const initialCharacter=typeof location!=='undefined'?new URLSearchParams(location.search).get('petCharacter'):null;
let activeCharacter=initialCharacter&&CHARACTER_SEQUENCES[initialCharacter]?.idle?initialCharacter:'deepseek';
export let FRAME_SEQUENCES=CHARACTER_SEQUENCES[activeCharacter]??legacySequences;
export const currentPetCharacter=()=>activeCharacter;
export const frameSequence=(id,characterId=activeCharacter)=>CHARACTER_SEQUENCES[characterId]?.[id]??null;
export function activatePetCharacter(id){
 if(!CHARACTER_SEQUENCES[id]?.idle)throw Error('角色动作资源未就绪');
 activeCharacter=id;FRAME_SEQUENCES=CHARACTER_SEQUENCES[id];
}

export function validateFrameSequence(clip){
  if(!clip||!Number.isFinite(clip.cycleMs)||clip.cycleMs<=0||!Number.isInteger(clip.canvas?.width)||!Number.isInteger(clip.canvas?.height)||clip.canvas.width<=0||clip.canvas.height<=0||!Array.isArray(clip.frames)||!clip.frames.length)throw Error('Invalid full-frame sequence');
  let previous=-1;
  for(const [index,frame] of clip.frames.entries()){
    if((clip.backend!=='webm-alpha'&&typeof frame.src!=='string')||!Number.isFinite(frame.timestampMs)||frame.timestampMs<0||frame.timestampMs<=previous||frame.timestampMs>=clip.cycleMs||index===0&&frame.timestampMs!==0)throw Error('Invalid sequence frame timestamp');
    previous=frame.timestampMs;
  }
  if(clip.interpolation&&(!Number.isInteger(clip.interpolation.multiplier)||clip.interpolation.multiplier<1))throw Error('Invalid interpolation multiplier');
  if(clip.emotionPeakFrame!==undefined&&(!Number.isInteger(clip.emotionPeakFrame)||clip.emotionPeakFrame<0||clip.emotionPeakFrame>=clip.frames.length))throw Error('Invalid emotion peak frame');
  if(clip.directionFrames&&(!Array.isArray(clip.directionFrames)||clip.directionFrames.length!==16||clip.directionFrames.some((frame,index)=>!Number.isInteger(frame)||frame<0||frame>=clip.frames.length||index>0&&frame<=clip.directionFrames[index-1])))throw Error('Invalid sixteen-direction mapping');
  if(clip.directionEndFrame!==undefined&&(!clip.directionFrames||!Number.isInteger(clip.directionEndFrame)||clip.directionEndFrame<=clip.directionFrames[15]||clip.directionEndFrame>=clip.frames.length))throw Error('Invalid direction arc endpoint');
  if(clip.directionBlinkRanges!==undefined&&(!clip.directionFrames||!Array.isArray(clip.directionBlinkRanges)||clip.directionBlinkRanges.some((r,i)=>!Array.isArray(r)||r.length!==2||!r.every(Number.isInteger)||r[0]<1||r[1]<r[0]||r[1]>=clip.frames.length-1||i>0&&r[0]<=clip.directionBlinkRanges[i-1][1])))throw Error('Invalid gaze blink exclusions');
  if(clip.backend==='webm-alpha'){
    const bounds=[clip.directionContentBounds,...Object.values(clip.staticFrames??{}).map(f=>f.contentBounds)].filter(b=>b!==undefined);
    if(bounds.some(b=>!Array.isArray(b)||b.length!==4||!b.every(Number.isInteger)||b[0]<0||b[1]<0||b[2]<=b[0]||b[3]<=b[1]||b[2]>clip.canvas.width||b[3]>clip.canvas.height))throw Error('Invalid direction content bounds');
    if(typeof clip.video?.src!=='string'||clip.video.codec!=='vp9-alpha'||!Number.isFinite(clip.video.durationMs)||Math.abs(clip.video.durationMs-clip.cycleMs)>1||!clip.staticFrames?.[0]?.src)throw Error('Invalid transparent video resource');
    if(clip.emotionPeakFrame!==undefined&&!clip.staticFrames[clip.emotionPeakFrame]?.src)throw Error('Missing emotion still');
    if(clip.directionFrames&&clip.frames.some((f,index)=>!clip.staticFrames[index]?.src))throw Error('Missing direction still');
    if(clip.video.timeline){const timeline=clip.video.timeline;if(!Array.isArray(timeline)||timeline.length!==clip.video.encodedFrameCount||timeline.some((f,i)=>!Number.isFinite(f.timestampMs)||f.timestampMs<0||f.timestampMs>=clip.cycleMs||i===0&&f.timestampMs!==0||i>0&&f.timestampMs<=timeline[i-1].timestampMs||!Number.isInteger(f.sourceFrameIndex)||f.sourceFrameIndex<0||f.sourceFrameIndex>=clip.frames.length))throw Error('Invalid encoded video timeline');}
  }
  return clip;
}

// Video timestamps are separate from the full logical/gaze index bank.
export function videoSourceFrameAt(clip,elapsedMs){
 const timeline=clip.video?.timeline;if(!timeline)return sequenceFrameAt(clip,elapsedMs);
 const phase=Math.max(0,elapsedMs)%clip.cycleMs;let low=0,high=timeline.length;
 while(low+1<high){const mid=(low+high)>>1;if(timeline[mid].timestampMs<=phase)low=mid;else high=mid;}return timeline[low].sourceFrameIndex;
}

// Elapsed time is already scaled by the controller or gallery clock.
export function sequenceFrameAt(clip,elapsedMs,{reducedMotion=false}={}){
  if(reducedMotion)return clip.emotionPeakFrame??0;
  const phase=Math.max(0,elapsedMs)%clip.cycleMs;
  let low=0,high=clip.frames.length;
  while(low+1<high){const mid=(low+high)>>1;if(clip.frames[mid].timestampMs<=phase)low=mid;else high=mid;}
  return low;
}

export function sequenceSampleFrame(clip,sample,{sourceOnly=false}={}){
  let index;
  if(clip.directionFrames&&Number.isFinite(sample.lookAngle)&&!sample.reducedMotion){
    const sector=((sample.lookAngle%360)+360)%360/22.5,first=Math.floor(sector),mix=sector-first;
    // An accepted look clip can hold the up pose before/after its actual turn.
    // Map only the calibrated moving arc; keep the full video for demonstrations.
    const start=clip.directionFrames[first],end=first===15?(clip.directionEndFrame??clip.frames.length):clip.directionFrames[first+1];
    index=Math.min(clip.frames.length-1,Math.floor(start+(end-start)*mix));
  }else if(clip.directionFrames&&Number.isInteger(sample.lookIndex))index=clip.directionFrames[sample.lookIndex];
  else index=sequenceFrameAt(clip,sample.elapsedMs??0,sample);
  // A cursor can stop indefinitely. Do not freeze a video blink as its gaze pose.
  // The complete blink remains in the ordinary demonstration timeline.
  if(Number.isFinite(sample.lookAngle)||Number.isInteger(sample.lookIndex)){
    for(const [start,end] of clip.directionBlinkRanges??[])if(index>=start&&index<=end){index=index-start<=end-index?start-1:end+1;break;}
  }
  if(sourceOnly&&clip.derivation){while(index>0&&!clip.frames[index].originalFrame)index--;}
  else if(sourceOnly&&clip.interpolation)index=Math.floor(index/clip.interpolation.multiplier)*clip.interpolation.multiplier;
  return index;
}

export function sequenceFrameElapsed(clip,index){
  if(!Number.isInteger(index)||index<0||index>=clip.frames.length)throw Error('Invalid sequence frame');
  return clip.frames[index].timestampMs+.001;
}
