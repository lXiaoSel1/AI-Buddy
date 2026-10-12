import {FRAME_SIZE} from './pet-actions.mjs';
import {FRAME_SEQUENCES,validateFrameSequence,sequenceSampleFrame} from './frame-sequence.mjs';

const load=async src=>{const image=new Image();image.src=src;await image.decode();return image;};
function alphaPlane(image){
  const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);
  const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data,alpha=new Uint8Array(rgba.length/4);
  for(let n=0;n<alpha.length;n++)alpha[n]=rgba[n*4+3];
  return alpha;
}

export class FrameSequenceRenderer{
  constructor(fallback,{maxFrames=128,maxBytes=196*1024*1024,concurrency=6,prefetch=12}={}){
    this.fallback=fallback;this.fullFrameSequences=true;this.sequences=FRAME_SEQUENCES;
    this.cache=new Map();this.pending=new Map();this.queue=[];this.loading=0;this.targets=new Map();this.wanted=new WeakMap();this.requestedTargets=new Map();this.interests=new Map();this.readinessOwner=Symbol('readiness');this.errors=new Map();this.initialized=false;
    this.maxFrames=maxFrames;this.maxBytes=maxBytes;this.concurrency=concurrency;this.prefetch=prefetch;this.bytes=0;this.serial=0;this.jobSerial=0;this.sequenceDraws=0;this.lastSequenceFrame=null;
    for(const clip of Object.values(this.sequences))validateFrameSequence(clip);
    this.ready=Promise.all([fallback.ready,this.sequences.idle?this.request(this.sequences.idle,0):Promise.resolve()]).then(()=>{this.initialized=true;return this;});
  }
  get backend(){return 'canvas-full-frame-sequence';}
  get pixels(){return this.fallback.pixels;}
  get draws(){return this.fallback.draws+this.sequenceDraws;}
  get geometryReads(){return this.fallback.geometryReads;}
  get allActionsRig(){return this.fallback.allActionsRig;}
  get workingRigPilot(){return this.fallback.workingRigPilot;}
  get rigDraws(){return this.fallback.rigDraws;}
  get rigResizes(){return this.fallback.rigResizes;}
  eyeOrigin(sample){const clip=this.sequences[sample.actionId],point=clip?.eyeOrigin;if(point)return {x:point.x/clip.canvas.width*FRAME_SIZE.width,y:point.y/clip.canvas.height*FRAME_SIZE.height};return this.fallback.eyeOrigin?.(sample)??{x:98,y:130};}
  key(clip,index){return `${clip.resourceId??clip.actionId}/${index}`;}
  request(clip,index,{direct=true,priority=false}={}){
    const key=this.key(clip,index),cached=this.cache.get(key);if(cached){cached.used=++this.serial;return Promise.resolve(cached);}
    if(this.pending.has(key)){const job=this.pending.get(key);job.direct||=direct;return job.promise;}
    if(this.errors.has(key))return Promise.reject(this.errors.get(key));
    let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const job={key,clip,index,promise,resolve,reject,direct,order:++this.jobSerial};this.pending.set(key,job);this.queue.push(job);this.prioritizeRequests();this.pump();return promise;
  }
  interested(key){return [...this.interests.values()].some(window=>window.keys.has(key));}
  activeResource(clip){const resource=clip.resourceId??clip.actionId;return [...this.interests.values()].some(window=>window.resource===resource);}
  prioritizeRequests(){
    const primary=new Set([...this.interests.values()].map(window=>window.primary));
    this.queue.sort((a,b)=>Number(primary.has(b.key))-Number(primary.has(a.key))||a.order-b.order);
  }
  pruneRequests(){
    this.queue=this.queue.filter(job=>{if(job.direct||this.interested(job.key))return true;this.pending.delete(job.key);job.resolve(null);return false;});
    this.prioritizeRequests();
  }
  pump(){
    while(this.loading<this.concurrency&&this.queue.length){const job=this.queue.shift();this.loading++;
      load(job.clip.frames[job.index].src).then(image=>{
        if(image.naturalWidth!==job.clip.canvas.width||image.naturalHeight!==job.clip.canvas.height)throw Error('动画尺寸不一致');
        if(!job.direct&&!this.activeResource(job.clip)){image.src='';job.resolve(null);return;}
        const entry={image,bytes:image.naturalWidth*image.naturalHeight*4,used:++this.serial,alpha:null};
        this.cache.set(job.key,entry);this.bytes+=entry.bytes;job.resolve(entry);
        if(this.initialized&&!this.requestedTargets.size)this.clearInactive();
      }).catch(error=>{this.errors.set(job.key,error);job.reject(error);}).finally(()=>{this.pending.delete(job.key);this.loading--;this.trim();this.pump();});
    }
  }
  warm(clip,index,owner){
    // Shared sources are decoded once, regardless of their logical action IDs.
    const indices=Array.from({length:this.prefetch+1},(_,offset)=>(index+offset)%clip.frames.length);
    this.interests.set(owner,{resource:clip.resourceId??clip.actionId,primary:this.key(clip,index),keys:new Set(indices.map(frame=>this.key(clip,frame)))});this.pruneRequests();
    for(const [offset,frame] of indices.entries())void this.request(clip,frame,{direct:false,priority:offset===0}).catch(()=>{});
  }
  isReadyFor(id,elapsed,options={}){
    const clip=this.sequences[id];if(!clip)return true;
    const frame=sequenceSampleFrame(clip,{elapsedMs:elapsed,...options});this.warm(clip,frame,this.readinessOwner);
    return this.cache.has(this.key(clip,frame));
  }
  trim(){
    const pinned=new Set([...this.targets.values()].map(value=>value.key).concat([...this.interests.values()].map(window=>window.primary)));
    const entries=[...this.cache.entries()].filter(([key])=>!pinned.has(key)).sort((a,b)=>a[1].used-b[1].used);
    for(const [key,entry] of entries){if(this.cache.size<=this.maxFrames&&this.bytes<=this.maxBytes)break;this.cache.delete(key);this.bytes-=entry.bytes;entry.image.src='';entry.alpha=null;}
  }
  clearInactive(){for(const entry of this.cache.values()){entry.image.src='';entry.alpha=null;}this.cache.clear();this.bytes=0;}
  draw(target,sample,options={}){
    const clip=this.sequences[sample.actionId];if(!clip)return this.fallback.draw(target,sample,options);
    if(!target)return false;
    const frame=sequenceSampleFrame(clip,sample,options),key=this.key(clip,frame);this.requestedTargets.set(target,key);this.warm(clip,frame,target);
    this.wanted.set(target,key);
    const entry=this.cache.get(key);
    if(!entry){if(this.errors.has(key))target.dataset.sequenceError='动画暂时无法播放';else void this.request(clip,frame,{direct:false,priority:true}).then(()=>{if(this.wanted.get(target)===key)this.draw(target,sample,options);}).catch(()=>{if(this.wanted.get(target)===key)target.dataset.sequenceError='动画暂时无法播放';});return false;}
    delete target.dataset.sequenceError;entry.used=++this.serial;
    const state=this.fallback.targetState(target),drawKey=`sequence/${key}/${target.width}/${target.height}`;
    this.targets.set(target,{key,sample:{...sample,displayedSequenceFrame:frame}});this.lastSequenceFrame=frame;
    if(!options.force&&state.key===drawKey)return false;
    state.ctx.clearRect(0,0,target.width,target.height);state.ctx.drawImage(entry.image,0,0,target.width,target.height);
    state.key=drawKey;this.sequenceDraws++;return true;
  }
  displayedSample(target){return this.targets.get(target)?.sample??null;}
  alpha(sample,x,y){
    const clip=this.sequences[sample.actionId];if(!clip)return this.fallback.alpha(sample,x,y);
    if(x<0||y<0||x>=FRAME_SIZE.width||y>=FRAME_SIZE.height)return 0;
    const frame=sample.displayedSequenceFrame??sequenceSampleFrame(clip,sample),entry=this.cache.get(this.key(clip,frame));if(!entry)return 0;
    if(!entry.alpha){entry.alpha=alphaPlane(entry.image);this.bytes+=entry.alpha.byteLength;entry.bytes+=entry.alpha.byteLength;this.trim();}
    const {width,height}=clip.canvas;
    const px=Math.max(0,Math.min(width-1,x*width/FRAME_SIZE.width-.5)),py=Math.max(0,Math.min(height-1,y*height/FRAME_SIZE.height-.5));
    const x0=Math.floor(px),y0=Math.floor(py),fx=px-x0,fy=py-y0,a=entry.alpha;
    const at=(dx,dy)=>a[Math.min(height-1,y0+dy)*width+Math.min(width-1,x0+dx)];
    return (at(0,0)*(1-fx)+at(1,0)*fx)*(1-fy)+(at(0,1)*(1-fx)+at(1,1)*fx)*fy;
  }
  inspect(){return {frames:this.cache.size,bytes:this.bytes,maxFrames:this.maxFrames,maxBytes:this.maxBytes,loading:this.loading,pending:this.pending.size,maxPending:this.interests.size*(this.prefetch+1)+this.concurrency,targets:this.targets.size,errors:[...this.errors.keys()],physicalResources:new Set(Object.values(this.sequences).map(clip=>clip.resourceId??clip.actionId)).size};}
  invalidate(target){this.fallback.invalidate(target);}
  release(target){this.wanted.delete(target);this.targets.delete(target);this.requestedTargets.delete(target);this.interests.delete(target);this.fallback.release(target);if(!this.requestedTargets.size){this.interests.delete(this.readinessOwner);this.clearInactive();}else this.trim();this.pruneRequests();}
}

