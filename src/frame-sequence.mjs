// The build supplies immutable sequence metadata and shared physical resources.
export const FRAME_SEQUENCES=typeof __FRAME_SEQUENCES__==='undefined'?{}:__FRAME_SEQUENCES__;
export const frameSequence=id=>FRAME_SEQUENCES[id]??null;

export function validateFrameSequence(clip){
  if(!clip||!Number.isFinite(clip.cycleMs)||clip.cycleMs<=0||!Number.isInteger(clip.canvas?.width)||!Number.isInteger(clip.canvas?.height)||clip.canvas.width<=0||clip.canvas.height<=0||!Array.isArray(clip.frames)||!clip.frames.length)throw Error('Invalid full-frame sequence');
  let previous=-1;
  for(const [index,frame] of clip.frames.entries()){
    if((clip.backend!=='webm-alpha'&&typeof frame.src!=='string')||!Number.isFinite(frame.timestampMs)||frame.timestampMs<0||frame.timestampMs<=previous||frame.timestampMs>=clip.cycleMs||index===0&&frame.timestampMs!==0)throw Error('Invalid sequence frame timestamp');
    previous=frame.timestampMs;
  }
  if(clip.interpolation&&(!Number.isInteger(clip.interpolation.multiplier)||clip.interpolation.multiplier<1))throw Error('Invalid interpolation multiplier');
  if(clip.emotionPeakFrame!==undefined&&(!Number.isInteger(clip.emotionPeakFrame)||clip.emotionPeakFrame<0||clip.emotionPeakFrame>=clip.frames.length))throw Error('Invalid emotion peak frame');
  if(clip.directionFrames&&(!Array.isArray(clip.directionFrames)||clip.directionFrames.length!==16||clip.directionFrames[0]!==0||clip.directionFrames.some((frame,index)=>!Number.isInteger(frame)||frame<0||frame>=clip.frames.length||index>0&&frame<=clip.directionFrames[index-1])))throw Error('Invalid sixteen-direction mapping');
  if(clip.backend==='webm-alpha'){
    if(typeof clip.video?.src!=='string'||clip.video.codec!=='vp9-alpha'||!Number.isFinite(clip.video.durationMs)||Math.abs(clip.video.durationMs-clip.cycleMs)>1||!clip.staticFrames?.[0]?.src)throw Error('Invalid transparent video resource');
    if(clip.emotionPeakFrame!==undefined&&!clip.staticFrames[clip.emotionPeakFrame]?.src)throw Error('Missing emotion still');
    if(clip.directionFrames&&clip.frames.some((f,index)=>!clip.staticFrames[index]?.src))throw Error('Missing direction still');
  }
  return clip;
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
    const start=clip.directionFrames[first],end=first===15?clip.frames.length:clip.directionFrames[first+1];
    index=Math.min(clip.frames.length-1,Math.floor(start+(end-start)*mix));
  }else if(clip.directionFrames&&Number.isInteger(sample.lookIndex))index=clip.directionFrames[sample.lookIndex];
  else index=sequenceFrameAt(clip,sample.elapsedMs??0,sample);
  if(sourceOnly&&clip.derivation){while(index>0&&!clip.frames[index].originalFrame)index--;}
  else if(sourceOnly&&clip.interpolation)index=Math.floor(index/clip.interpolation.multiplier)*clip.interpolation.multiplier;
  return index;
}

export function sequenceFrameElapsed(clip,index){
  if(!Number.isInteger(index)||index<0||index>=clip.frames.length)throw Error('Invalid sequence frame');
  return clip.frames[index].timestampMs+.001;
}
