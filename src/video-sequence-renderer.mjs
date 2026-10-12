import {FRAME_SIZE} from './pet-actions.mjs';
import {FRAME_SEQUENCES,validateFrameSequence,sequenceFrameAt,sequenceSampleFrame} from './frame-sequence.mjs';

const ring=(index,length)=>((index%length)+length)%length;
// Signed shortest step between two indices of a looping direction sequence.
const ringStep=(from,to,length)=>{const d=ring(to-from,length);return d>length/2?d-length:d;};
const outward=(index,length)=>{const out=[ring(index,length)];for(let d=1;d<=length/2;d++){out.push(ring(index+d,length));if(d<length/2)out.push(ring(index-d,length));}return out;};

// Timed media is decoded by Chromium (including WebM BlockAdditional alpha).
// The controller remains the owner of action/feedback timing. Only discontinuities
// seek; ordinary playback uses playbackRate and requestVideoFrameCallback.
//
// Cursor-following stills are kept apart from the full-size stills: they are
// scaled to the target canvas once, held under a byte budget and warmed in the
// background, so circling the pet at any speed draws from memory. When the exact
// direction is still decoding, the nearest decoded direction is shown instead of
// freezing on the previous one.
export class VideoSequenceRenderer{
 constructor(fallback,{sequences=FRAME_SEQUENCES,maxStaticFrames=64,staticConcurrency=2,directionPrefetch=12,directionLookahead=40,directionBudgetBytes=128*1024*1024,directionFallback=15,warmBatch=4}={}){
  this.fallback=fallback;this.sequences=sequences;this.fullFrameSequences=true;this.maxStaticFrames=maxStaticFrames;
  this.targets=new Map();this.prepared=new Map();this.stills=new Map();this.pending=new Map();this.errors=new Map();this.serial=0;this.targetSerial=0;this.videoDraws=0;this.seekCount=0;
  this.staticQueue=[];this.staticJobs=new Map();this.staticActive=0;this.staticEpoch=0;this.staticConcurrency=Math.max(1,staticConcurrency);this.directionPrefetch=Math.min(directionPrefetch,Math.floor((maxStaticFrames-1)/2));
  this.directionLookahead=Math.max(this.directionPrefetch,Math.min(directionLookahead,maxStaticFrames-warmBatch-8));this.directionBudgetBytes=directionBudgetBytes;this.directionFallback=directionFallback;this.warmBatch=warmBatch;
  this.directions=new Map();this.directionBytes=0;this.directionApprox=0;this.directionMisses=0;this.directionLoads=0;
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
 stillKey(clip,index,size=null){return this.resource(clip)+'/'+(clip.staticFrames?.[index]?index:0)+(size?'@'+size.width+'x'+size.height:'');}
 // size: decode a cursor-direction still scaled to that canvas size into the direction cache.
 still(clip,index,{priority=0,size=null}={}){
  if(!clip)return Promise.reject(Error('Missing animation'));
  const record=clip.staticFrames?.[index]??clip.staticFrames?.[0],key=this.stillKey(clip,index,size);
  const cached=(size?this.directions:this.stills).get(key);if(cached){cached.used=++this.serial;return Promise.resolve(cached.image);}
  if(this.pending.has(key)){
   // Direction urgency follows the latest window; a frame that was once current must not stay urgent.
   const job=this.staticJobs.get(key);if(job){if(size){job.priority=priority;job.order=++this.serial;}else job.priority=Math.min(job.priority,priority);}
   return this.pending.get(key);
  }
  let done,fail;const pending=new Promise((resolve,reject)=>{done=resolve;fail=reject;});
  const job={key,clip,record,index:clip.staticFrames?.[index]?index:0,size,priority,order:++this.serial,epoch:this.staticEpoch,done,fail,pending};this.pending.set(key,pending);this.staticJobs.set(key,job);this.staticQueue.push(job);
  this.pruneStaticQueue();queueMicrotask(()=>this.pumpStills());return pending;
 }
 pruneStaticQueue(){
  const interest=new Set([...this.targets.values()].flatMap(s=>[s.stillKey,s.directionKey,...(s.prefetchKeys??[])]));
  this.staticQueue.sort((a,b)=>a.priority-b.priority||b.order-a.order);
  // Direction requests live only while a target still wants them; earlier "current" frames are dropped.
  this.staticQueue=this.staticQueue.filter((job,index)=>{const wanted=job.size?interest.has(job.key):job.priority===0||interest.has(job.key);if(index<this.maxStaticFrames-this.staticActive&&wanted)return true;this.pending.delete(job.key);this.staticJobs.delete(job.key);job.done(null);return false;});
 }
 pumpStills(){
  this.staticQueue.sort((a,b)=>a.priority-b.priority||b.order-a.order);
  while(this.staticActive<this.staticConcurrency&&this.staticQueue.length){
   const job=this.staticQueue.shift(),image=new Image();this.staticActive++;image.src=job.record.src;
   image.decode().then(async()=>{
    if(image.naturalWidth!==job.clip.canvas.width||image.naturalHeight!==job.clip.canvas.height)throw Error('Animation still dimensions differ');
    if(!job.size){if(job.epoch===this.staticEpoch){this.stills.set(job.key,{image,used:++this.serial});this.trimStills();}else image.src='';job.done(image);return;}
    let frame=image;
    if(typeof createImageBitmap==='function'){frame=await createImageBitmap(image,{resizeWidth:job.size.width,resizeHeight:job.size.height,resizeQuality:'high'});image.src='';}
    if(job.epoch===this.staticEpoch&&this.staticJobs.get(job.key)===job){this.storeDirection(job,frame);job.done(frame);}else{this.closeFrame(frame);job.done(null);}
   }).catch(e=>{if(job.epoch===this.staticEpoch)this.errors.set(job.key,e.message);job.fail(e);}).finally(()=>{
    if(this.pending.get(job.key)===job.pending){this.pending.delete(job.key);this.staticJobs.delete(job.key);}this.staticActive--;this.pumpStills();
   });
  }
 }
 closeFrame(frame){if(typeof frame.close==='function')frame.close();else frame.src='';}
 anchorFrames(clip){
  if(!clip.anchorFrames){const original=clip.frames.map((f,i)=>f.originalFrame?i:-1).filter(i=>i>=0);clip.anchorFrames=original.length?original:clip.frames.map((_,i)=>i).filter(i=>i%5===0);}
  return clip.anchorFrames;
 }
 storeDirection(job,frame){
  const bytes=(frame.width||frame.naturalWidth)*(frame.height||frame.naturalHeight)*4,old=this.directions.get(job.key);if(old)this.dropDirection(job.key,old);
  this.directions.set(job.key,{image:frame,used:++this.serial,bytes,index:job.index,size:job.size.width+'x'+job.size.height,anchor:this.anchorFrames(job.clip).includes(job.index)?1:0});
  this.directionBytes+=bytes;this.directionLoads++;this.trimDirections();
 }
 dropDirection(key,entry){this.directions.delete(key);this.directionBytes-=entry.bytes;this.closeFrame(entry.image);}
 trimDirections(){
  const states=[...this.targets.values()],sizes=new Set(states.map(s=>s.directionSize).filter(Boolean));
  // Frames for a size no target uses any more are released straight away.
  for(const [k,e] of [...this.directions])if(!sizes.has(e.size))this.dropDirection(k,e);
  if(this.directionBytes<=this.directionBudgetBytes)return;
  const keep=new Set(states.flatMap(s=>[s.directionKey,s.shownDirectionKey,...(s.prefetchKeys??[])]).filter(Boolean));
  const victims=[...this.directions].filter(([k])=>!keep.has(k)).sort(([,a],[,b])=>a.anchor-b.anchor||a.used-b.used);
  while(this.directionBytes>this.directionBudgetBytes&&victims.length){const[k,e]=victims.shift();this.dropDirection(k,e);}
 }
 // Prefetch reaches further ahead of the motion the faster the gaze is turning,
 // keeps a short window behind, and favours neither side when the gaze is still.
 prefetchDirection(state,clip,index,size){
  const length=clip.frames.length,sizeKey=size.width+'x'+size.height;
  if(state.prefetchCenter!==index||state.prefetchSizeKey!==sizeKey){
   const step=Number.isInteger(state.prefetchCenter)&&state.prefetchSizeKey===sizeKey?ringStep(state.prefetchCenter,index,length):0;
   if(step){state.motion=Math.sign(step);state.speed=Math.abs(step);}else state.speed=0;
   state.prefetchCenter=index;state.prefetchSizeKey=sizeKey;
   const moving=state.speed>0,dir=state.motion||1,ahead=moving?Math.min(this.directionLookahead,this.directionPrefetch+state.speed*4):this.directionPrefetch,behind=moving?Math.min(4,this.directionPrefetch):this.directionPrefetch,frames=[];
   for(let d=1;d<=Math.max(ahead,behind);d++){
    // Equal distances: the later push wins the queue tie, so the side of travel (or alternate sides when still) goes first.
    for(const sign of moving?[-dir,dir]:d%2?[-1,1]:[1,-1])if(d<=(moving&&sign!==dir?behind:ahead))frames.push({index:ring(index+sign*d,length),priority:d});
   }
   state.prefetchFrames=frames;
  }
  const all=[...state.prefetchFrames,...this.warmFrames(clip,index,size,state.prefetchFrames)],keys=all.map(f=>this.stillKey(clip,f.index,size)),signature=keys.join('|');
  if(signature===state.prefetchSignature)return;
  state.prefetchSignature=signature;state.prefetchKeys=new Set(keys);this.pruneStaticQueue();
  for(const frame of all)void this.still(clip,frame.index,{priority:frame.priority,size}).catch(()=>{});
 }
 // Background warm-up: anchors first, then everything outward from the current direction,
 // as long as the whole set fits the byte budget (otherwise only the anchors stay resident).
 warmFrames(clip,index,size,prefetch){
  if(!this.warmBatch)return [];
  const length=clip.frames.length,capacity=Math.floor(this.directionBudgetBytes/Math.max(1,size.width*size.height*4)),anchors=this.anchorFrames(clip);
  if(capacity<anchors.length+this.directionLookahead+8)return [];
  const near=a=>[...a].sort((x,y)=>Math.abs(ringStep(index,x,length))-Math.abs(ringStep(index,y,length))),order=capacity>=length?[...near(anchors),...outward(index,length)]:near(anchors);
  const taken=new Set(prefetch.map(f=>f.index)),out=[];taken.add(index);
  for(const i of order){if(out.length>=this.warmBatch)break;if(taken.has(i))continue;taken.add(i);if(!this.directions.has(this.stillKey(clip,i,size)))out.push({index:i,priority:1000+out.length});}
  return out;
 }
 // Exact direction, else the nearest decoded one, preferring frames between the
 // last shown frame and the target so a fast turn keeps moving.
 nearestDirection(state,clip,index,size){
  const length=clip.frames.length,lookup=i=>{const n=ring(i,length),key=this.stillKey(clip,n,size),entry=this.directions.get(key)??this.stills.get(this.stillKey(clip,n));return entry?{key,entry,index:n}:null;};
  const exact=lookup(index);if(exact)return exact;
  const back=-(state.motion||1);
  for(let d=1;d<=this.directionFallback;d++){const hit=lookup(index+back*d)??lookup(index-back*d);if(hit)return hit;}
  return null;
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
  const key=this.resource(clip);if(s.resource!==key){this.closeSlot(s.slot);s.slot=this.prepared.get(key)??this.createSlot(clip);this.prepared.delete(key);s.resource=key;s.actionId=null;s.drawKey=null;s.stillKey=null;s.lastElapsed=null;this.clearDirection(s);this.pruneStaticQueue();}
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
   slot.video.pause();
   if(direction){
    this.fallback.targetState(target);const size={width:target.width,height:target.height};
    state.stillKey=null;state.directionSize=size.width+'x'+size.height;state.directionKey=this.stillKey(clip,index,size);
    void this.still(clip,index,{size}).catch(()=>{});this.prefetchDirection(state,clip,index,size);
    const found=this.nearestDirection(state,clip,index,size);
    if(!found){this.directionMisses++;return false;}
    if(found.index!==index)this.directionApprox++;
    found.entry.used=++this.serial;image=found.entry.image;shownFrame=found.index;key='direction/'+found.key;state.shownDirectionKey=found.key;
   }else{
    const fixed=sample.reducedMotion?(clip.emotionPeakFrame??0):0;state.stillKey=this.resource(clip)+'/'+fixed;this.clearDirection(state);this.pruneStaticQueue();
    const cached=this.stills.get(state.stillKey);if(cached){cached.used=++this.serial;image=cached.image;shownFrame=fixed;key='still/'+state.stillKey;}else{void this.still(clip,fixed).catch(()=>{});return false;}
   }
   if(slot.error)target.dataset.sequenceError='动画暂时无法播放';
  }else{
   delete target.dataset.sequenceError;state.stillKey=null;this.clearDirection(state);this.pruneStaticQueue();
   const changed=state.actionId!==sample.actionId,rewound=state.lastElapsed!==null&&elapsed+1<state.lastElapsed;
   if(slot.video.playbackRate!==rate)slot.video.playbackRate=rate;
   const delta=Math.abs(slot.video.currentTime*1000-phase),circular=Math.min(delta,Math.abs(delta-clip.cycleMs));
   if(changed||rewound||(playing&&performance.now()-slot.lastSync>1500&&circular>100)){
    if(circular>8)this.seek(slot,phase);slot.lastSync=performance.now();
   }
   // Remember the requested clock even while the decoder is seeking. Otherwise
   // each callback sees the same action change and starts another seek before
   // the new frame can be drawn. The actual displayed sample stays unchanged.
   state.actionId=sample.actionId;state.lastElapsed=elapsed;
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
  const[target,s]=entry,px=Math.min(target.width-1,Math.floor(x/FRAME_SIZE.width*target.width)),py=Math.min(target.height-1,Math.floor(y/FRAME_SIZE.height*target.height)),at=px+','+py;
  // Read only the pixel under the pointer: a full-surface readback after every new
  // direction frame stalls the GPU canvas while the cursor is over the pet.
  if(!s.alpha||s.alpha.size>256)s.alpha=new Map();
  if(!s.alpha.has(at))s.alpha.set(at,target.getContext('2d').getImageData(px,py,1,1).data[3]);
  return s.alpha.get(at);
 }
 clearDirection(s){s.directionKey=null;s.shownDirectionKey=null;s.prefetchCenter=null;s.prefetchSizeKey=null;s.prefetchFrames=null;s.prefetchKeys=null;s.prefetchSignature=null;s.motion=0;s.speed=0;}
 isAdvancing(target){const s=this.targets.get(target);return !!(s?.slot?.ready&&!s.slot.seekPending&&!s.slot.video.paused);}
 targetDraws(target){return this.targets.get(target)?.slot?.serial??0;}
 invalidate(target){const s=this.targets.get(target);if(s){s.drawKey=null;s.alpha=null;}this.fallback.invalidate(target);}
 release(target){const s=this.targets.get(target);if(s)this.closeSlot(s.slot);this.targets.delete(target);this.fallback.release(target);if(!this.targets.size){for(const s of this.prepared.values())this.closeSlot(s);this.prepared.clear();for(const e of this.stills.values())e.image.src='';this.stills.clear();for(const [k,e] of [...this.directions])this.dropDirection(k,e);this.directionBytes=0;this.staticEpoch++;for(const job of this.staticQueue){this.pending.delete(job.key);this.staticJobs.delete(job.key);job.done(null);}this.staticQueue=[];}this.pruneStaticQueue();this.trimStills();this.trimDirections();}
 inspect(){return {backend:this.backend,targets:this.targets.size,decoders:this.targets.size+this.prepared.size,playing:[...this.targets.values()].filter(s=>s.slot&&!s.slot.video.paused).length,frames:this.stills.size,maxFrames:this.maxStaticFrames,maxBytes:this.maxStaticFrames*576*624*4,maxPending:this.maxStaticFrames,bytes:[...this.stills.values()].reduce((n,s)=>n+s.image.naturalWidth*s.image.naturalHeight*4,0),pending:this.pending.size,directionFrames:this.directions.size,directionBytes:this.directionBytes,directionBudgetBytes:this.directionBudgetBytes,directionLoads:this.directionLoads,directionApprox:this.directionApprox,directionMisses:this.directionMisses,errors:[...this.errors],seeks:this.seekCount,physicalResources:new Set(Object.values(this.sequences).map(c=>this.resource(c))).size,videos:[...this.targets.values()].map(s=>{const q=s.slot.video.getVideoPlaybackQuality();return {resource:s.resource,ready:s.slot.ready,frame:s.shown?.displayedSequenceFrame,total:q.totalVideoFrames,dropped:q.droppedVideoFrames,duration:s.slot.video.duration};})};}
}
