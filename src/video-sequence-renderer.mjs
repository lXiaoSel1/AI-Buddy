import {FRAME_SIZE} from './pet-actions.mjs';
import {FRAME_SEQUENCES,validateFrameSequence,sequenceFrameAt,sequenceSampleFrame} from './frame-sequence.mjs';

// Timed media is decoded by Chromium (including WebM BlockAdditional alpha).
// The controller remains the owner of action/feedback timing. Only discontinuities
// seek; ordinary playback uses playbackRate and requestVideoFrameCallback.
export class VideoSequenceRenderer{
 constructor(fallback,{sequences=FRAME_SEQUENCES,maxStaticFrames=64}={}){
  this.fallback=fallback;this.sequences=sequences;this.fullFrameSequences=true;this.maxStaticFrames=maxStaticFrames;
  this.targets=new Map();this.prepared=new Map();this.stills=new Map();this.pending=new Map();this.errors=new Map();this.serial=0;this.targetSerial=0;this.videoDraws=0;this.seekCount=0;
  for(const c of Object.values(sequences))validateFrameSequence(c);
  this.ready=Promise.all([fallback.ready,this.still(sequences.idle,0)]).then(()=>this);
 }
 get backend(){return 'canvas-transparent-webm';}
 get pixels(){return this.fallback.pixels;}
 get draws(){return this.videoDraws+this.fallback.draws;}
 get geometryReads(){return this.fallback.geometryReads;}
 get allActionsRig(){return false;}get workingRigPilot(){return false;}get rigDraws(){return 0;}get rigResizes(){return 0;}
 eyeOrigin(sample){const c=this.sequences[sample.actionId],p=c?.eyeOrigin;return p?{x:p.x/c.canvas.width*FRAME_SIZE.width,y:p.y/c.canvas.height*FRAME_SIZE.height}:this.fallback.eyeOrigin?.(sample)??{x:98,y:130};}
 resource(clip){return clip.resourceId??clip.actionId;}
 still(clip,index){
  if(!clip)return Promise.reject(Error('Missing animation'));
  const record=clip.staticFrames?.[index]??clip.staticFrames?.[0],key=this.resource(clip)+'/'+(clip.staticFrames?.[index]?index:0);
  const cached=this.stills.get(key);if(cached){cached.used=++this.serial;return Promise.resolve(cached.image);}
  if(this.pending.has(key))return this.pending.get(key);
  const image=new Image();image.src=record.src;
  const pending=image.decode().then(()=>{if(image.naturalWidth!==clip.canvas.width||image.naturalHeight!==clip.canvas.height)throw Error('Animation still dimensions differ');this.stills.set(key,{image,used:++this.serial});this.pending.delete(key);this.trimStills();return image;}).catch(e=>{this.pending.delete(key);this.errors.set(key,e.message);throw e;});this.pending.set(key,pending);return pending;
 }
 trimStills(){const keep=new Set([...this.targets.values()].filter(s=>s.stillKey).map(s=>s.stillKey));const oldest=[...this.stills].filter(([k])=>!keep.has(k)).sort((a,b)=>a[1].used-b[1].used);while(this.stills.size>this.maxStaticFrames&&oldest.length){const[k,e]=oldest.shift();this.stills.delete(k);e.image.src='';}}
 createSlot(clip){
  const video=document.createElement('video');video.muted=true;video.loop=true;video.playsInline=true;video.preload='auto';
  const s={resource:this.resource(clip),clip,video,ready:false,closed:false,serial:0,mediaMs:0,callback:null,seekPending:false,loadStarted:performance.now(),lastSync:0,error:null};
  const loaded=()=>{if(s.closed)return;if(video.videoWidth!==clip.canvas.width||video.videoHeight!==clip.canvas.height){s.error='动画尺寸不一致';return;}s.ready=true;s.serial++;};
  video.addEventListener('loadeddata',loaded);video.addEventListener('error',()=>{if(s.closed)return;s.error=video.error?.message||'动画暂时无法播放';this.errors.set(s.resource,s.error);});
  video.addEventListener('seeked',()=>{s.seekPending=false;s.mediaMs=video.currentTime*1000;s.serial++;});
  if(video.requestVideoFrameCallback){const update=(_,m)=>{if(s.closed)return;s.mediaMs=m.mediaTime*1000;s.serial++;s.callback=video.requestVideoFrameCallback(update);};s.callback=video.requestVideoFrameCallback(update);}
  video.src=clip.video.src;video.load();void this.still(clip,0).catch(()=>{});return s;
 }
 closeSlot(s){if(!s||s.closed)return;s.closed=true;if(s.callback!==null)s.video.cancelVideoFrameCallback?.(s.callback);s.video.pause();s.video.removeAttribute('src');s.video.load();}
 prepare(clip){const key=this.resource(clip);if(!this.prepared.has(key)){for(const [old,s] of this.prepared){this.closeSlot(s);this.prepared.delete(old);}this.prepared.set(key,this.createSlot(clip));}return this.prepared.get(key);}
 isReadyFor(id,elapsed,{reducedMotion=false}={}){
  const c=this.sequences[id];if(!c)return true;
  if(reducedMotion){const index=c.emotionPeakFrame??0,key=this.resource(c)+'/'+index;void this.still(c,index).catch(()=>{});return this.stills.has(key);}
  const active=[...this.targets.values()].find(s=>s.slot?.resource===this.resource(c))?.slot,slot=active??this.prepare(c);
  if(!slot.ready&&!slot.error&&performance.now()-slot.loadStarted>15000){slot.error='动画加载超时';this.errors.set(slot.resource,slot.error);}
  return slot.ready||!!slot.error;
 }
 acquire(target,clip){
  let s=this.targets.get(target);if(!s){s={id:++this.targetSerial,resource:null,slot:null,shown:null,drawKey:null,alpha:null,stillKey:null,lastElapsed:null,actionId:null};this.targets.set(target,s);}
  const key=this.resource(clip);if(s.resource!==key){this.closeSlot(s.slot);s.slot=this.prepared.get(key)??this.createSlot(clip);this.prepared.delete(key);s.resource=key;s.actionId=null;s.drawKey=null;s.stillKey=null;s.lastElapsed=null;}
  return s;
 }
 seek(slot,ms){if(slot.seekPending||!slot.ready)return;slot.seekPending=true;slot.video.currentTime=Math.max(0,Math.min(slot.video.duration-.001,ms/1000));this.seekCount++;}
 draw(target,sample,{force=false}={}){
  const clip=this.sequences[sample.actionId];if(!clip)return this.fallback.draw(target,sample,{force});if(!target)return false;
  const state=this.acquire(target,clip),slot=state.slot,elapsed=Math.max(0,sample.elapsedMs??0),phase=elapsed%clip.cycleMs,rate=sample.playbackRate??1,playing=sample.playing!==false&&!sample.reducedMotion;
  const index=sequenceSampleFrame(clip,sample),direction=clip.directionFrames&&(Number.isFinite(sample.lookAngle)||Number.isInteger(sample.lookIndex));
  const stillMode=sample.reducedMotion||direction||slot.error||!slot.ready;
  let image,shownFrame=index,key;
  if(stillMode){
   slot.video.pause();const fixed=direction?index:sample.reducedMotion?(clip.emotionPeakFrame??0):0;state.stillKey=this.resource(clip)+'/'+fixed;
   const cached=this.stills.get(state.stillKey);if(cached){cached.used=++this.serial;image=cached.image;shownFrame=fixed;key='still/'+state.stillKey;}else{void this.still(clip,fixed).catch(()=>{});return false;}
   if(slot.error)target.dataset.sequenceError='动画暂时无法播放';
  }else{
   delete target.dataset.sequenceError;state.stillKey=null;
   const changed=state.actionId!==sample.actionId,rewound=state.lastElapsed!==null&&elapsed+1<state.lastElapsed;
   if(slot.video.playbackRate!==rate)slot.video.playbackRate=rate;
   const delta=Math.abs(slot.video.currentTime*1000-phase),circular=Math.min(delta,Math.abs(delta-clip.cycleMs));
   if(changed||rewound||(playing&&performance.now()-slot.lastSync>1500&&circular>100)){
    if(circular>8)this.seek(slot,phase);slot.lastSync=performance.now();
   }
   if(playing&&slot.video.paused&&!slot.seekPending)void slot.video.play().catch(e=>{slot.error=e.message;this.errors.set(slot.resource,e.message);});else if(!playing&&!slot.video.paused)slot.video.pause();
   if(slot.seekPending&&state.shown)return false;
   image=slot.video;shownFrame=sequenceFrameAt(clip,slot.mediaMs+.1);key='video/'+state.resource+'/'+slot.serial;
  }
  const surface=this.fallback.targetState(target);key+='/'+target.width+'/'+target.height;
  state.actionId=sample.actionId;state.lastElapsed=elapsed;
  if(!force&&state.drawKey===key&&surface.key===key)return false;
  surface.ctx.clearRect(0,0,target.width,target.height);surface.ctx.drawImage(image,0,0,target.width,target.height);surface.key=key;state.drawKey=key;state.alpha=null;this.videoDraws++;
  state.shown={...sample,displayedSequenceFrame:shownFrame,displayedTargetId:state.id,decodedMediaMs:slot.mediaMs};return true;
 }
 displayedSample(target){return this.targets.get(target)?.shown??null;}
 alpha(sample,x,y){
  const entry=[...this.targets].find(([,s])=>s.id===sample.displayedTargetId);if(!entry||x<0||y<0||x>=FRAME_SIZE.width||y>=FRAME_SIZE.height)return 0;
  const[target,s]=entry;if(!s.alpha)s.alpha=target.getContext('2d').getImageData(0,0,target.width,target.height).data;
  const px=Math.min(target.width-1,Math.floor(x/FRAME_SIZE.width*target.width)),py=Math.min(target.height-1,Math.floor(y/FRAME_SIZE.height*target.height));return s.alpha[(py*target.width+px)*4+3];
 }
 isAdvancing(target){const s=this.targets.get(target);return !!(s?.slot?.ready&&!s.slot.seekPending&&!s.slot.video.paused);}
 targetDraws(target){return this.targets.get(target)?.slot?.serial??0;}
 invalidate(target){const s=this.targets.get(target);if(s){s.drawKey=null;s.alpha=null;}this.fallback.invalidate(target);}
 release(target){const s=this.targets.get(target);if(s)this.closeSlot(s.slot);this.targets.delete(target);this.fallback.release(target);if(!this.targets.size){for(const s of this.prepared.values())this.closeSlot(s);this.prepared.clear();for(const e of this.stills.values())e.image.src='';this.stills.clear();}this.trimStills();}
 inspect(){return {backend:this.backend,targets:this.targets.size,decoders:this.targets.size+this.prepared.size,playing:[...this.targets.values()].filter(s=>s.slot&&!s.slot.video.paused).length,frames:this.stills.size,maxFrames:this.maxStaticFrames,maxBytes:this.maxStaticFrames*576*624*4,maxPending:this.maxStaticFrames,bytes:[...this.stills.values()].reduce((n,s)=>n+s.image.naturalWidth*s.image.naturalHeight*4,0),pending:this.pending.size,errors:[...this.errors],seeks:this.seekCount,physicalResources:new Set(Object.values(this.sequences).map(c=>this.resource(c))).size,videos:[...this.targets.values()].map(s=>{const q=s.slot.video.getVideoPlaybackQuality();return {resource:s.resource,ready:s.slot.ready,frame:s.shown?.displayedSequenceFrame,total:q.totalVideoFrames,dropped:q.droppedVideoFrames,duration:s.slot.video.duration};})};}
}
