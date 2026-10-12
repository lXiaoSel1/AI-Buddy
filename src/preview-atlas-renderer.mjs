import {FRAME_SEQUENCES,sequenceSampleFrame} from './frame-sequence.mjs';
export const PREVIEW_ATLASES=typeof __PREVIEW_ATLASES__==='undefined'?{}:__PREVIEW_ATLASES__;
const load=async src=>{const image=new Image();image.src=src;await image.decode();return image;};

// The gallery shares small decoded pages, while the pet keeps its original PNG player.
// A page stays current for 32 source frames, so decode completion cannot be chased
// away by a new 120fps request on every refresh.
export class PreviewAtlasRenderer{
  constructor(fallback,{maxPages=24,maxBytes=196*1024*1024,concurrency=4,loadImage=load}={}){
    this.fallback=fallback;this.sequences=FRAME_SEQUENCES;this.resources=PREVIEW_ATLASES;
    this.cache=new Map();this.pending=new Map();this.queue=[];this.loading=0;this.targets=new Map();this.requestedTargets=new Map();this.interests=new Map();this.errors=new Map();
    this.maxPages=maxPages;this.maxBytes=maxBytes;this.concurrency=concurrency;this.loadImage=loadImage;this.bytes=0;this.serial=0;this.jobSerial=0;this.sequenceDraws=0;this.ready=fallback.ready;
  }
  get backend(){return 'canvas-preview-frame-atlas';}
  get draws(){return this.sequenceDraws;}
  get rigDraws(){return 0;}
  key(resource,page){return `${resource}/${page}`;}
  interested(key){return [...this.interests.values()].some(value=>value.keys.has(key));}
  prioritize(){const primary=new Set([...this.interests.values()].map(value=>value.primary));this.queue.sort((a,b)=>Number(primary.has(b.key))-Number(primary.has(a.key))||a.order-b.order);}
  prune(){this.queue=this.queue.filter(job=>{if(this.interested(job.key))return true;this.pending.delete(job.key);job.resolve(null);return false;});this.prioritize();}
  request(resource,page){
    const key=this.key(resource,page),cached=this.cache.get(key);if(cached)return Promise.resolve(cached);
    if(this.pending.has(key))return this.pending.get(key).promise;
    if(this.errors.has(key))return Promise.reject(this.errors.get(key));
    let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const job={key,resource,page,promise,resolve,reject,order:++this.jobSerial};this.pending.set(key,job);this.queue.push(job);this.prioritize();this.pump();return promise;
  }
  pump(){
    while(this.loading<this.concurrency&&this.queue.length){
      const job=this.queue.shift(),chunk=this.resources[job.resource].chunks[job.page];this.loading++;
      this.loadImage(chunk.src).then(image=>{
        if(image.naturalWidth!==chunk.width||image.naturalHeight!==chunk.height)throw Error('预览尺寸不一致');
        if(![...this.requestedTargets.values()].some(wanted=>wanted.resource===job.resource)){image.src='';job.resolve(null);return;}
        const entry={image,resource:job.resource,page:job.page,bytes:chunk.width*chunk.height*4,used:++this.serial};this.cache.set(job.key,entry);this.bytes+=entry.bytes;
        // Redraw the latest requested frame in this page, never the stale sample
        // that happened to start the asynchronous decode.
        for(const [target,wanted] of this.requestedTargets)if(wanted.resource===job.resource)this.draw(target,wanted.sample,wanted.options);
        job.resolve(entry);
      }).catch(error=>{this.errors.set(job.key,error);for(const [target,wanted] of this.requestedTargets)if(wanted.key===job.key)target.dataset.sequenceError='动作暂时无法播放';job.reject(error);})
        .finally(()=>{this.pending.delete(job.key);this.loading--;this.trim();this.pump();});
    }
  }
  warm(resource,page,target){
    const key=this.key(resource,page);if(this.interests.get(target)?.primary===key)return;
    const pages=this.resources[resource].chunks.length,next=(page+1)%pages;
    this.interests.set(target,{primary:key,keys:new Set([key,this.key(resource,next)])});this.prune();
    void this.request(resource,page).catch(()=>{});if(next!==page)void this.request(resource,next).catch(()=>{});
  }
  trim(){
    const pinned=new Set([...this.targets.values()].map(value=>value.key).concat([...this.interests.values()].map(value=>value.primary)));
    for(const [key,entry] of [...this.cache].filter(([key])=>!pinned.has(key)).sort((a,b)=>a[1].used-b[1].used)){
      if(this.cache.size<=this.maxPages&&this.bytes<=this.maxBytes)break;
      this.cache.delete(key);this.bytes-=entry.bytes;entry.image.src='';
    }
  }
  closestCached(resource,requested,frames){
    let closest=null;
    for(const [key,entry] of this.cache){
      if(entry.resource!==resource)continue;
      const chunk=this.resources[resource].chunks[entry.page],frame=chunk.firstFrame+chunk.frameCount-1,lag=(requested-frame+frames)%frames;
      if(!closest||lag<closest.lag)closest={key,entry,frame,page:entry.page,lag};
    }
    return closest;
  }
  draw(target,sample,options={}){
    const clip=this.sequences[sample.actionId],resource=clip?.resourceId??sample.actionId,preview=this.resources[resource];
    if(!preview||!target)return false;
    const requested=sequenceSampleFrame(clip,sample,options),requestedPage=Math.floor(requested/preview.chunkFrames),requestedKey=this.key(resource,requestedPage),previous=this.targets.get(target);
    this.requestedTargets.set(target,{key:requestedKey,resource,sample:{...sample},options});this.warm(resource,requestedPage,target);
    let frame=requested,page=requestedPage,key=requestedKey,entry=this.cache.get(key);
    if(!entry){
      if(this.errors.has(key))target.dataset.sequenceError='动作暂时无法播放';else void this.request(resource,page).catch(()=>{});
      // Under decode pressure, show the nearest completed earlier PNG, keeping
      // the real clock. An in-flight page is still delivered even if it is late.
      const sameResource=previous&&(this.sequences[previous.sample.actionId]?.resourceId??previous.sample.actionId)===resource;
      const available=sameResource&&!sample.reducedMotion?this.closestCached(resource,requested,clip.frames.length):null;
      if(!available)return false;({frame,page,key,entry}=available);
    }
    delete target.dataset.sequenceError;entry.used=++this.serial;
    const state=this.fallback.targetState(target),drawKey=`preview/${resource}/${frame}/${target.width}/${target.height}`;
    const shown={...sample,displayedSequenceFrame:frame};
    if(!options.force&&state.key===drawKey){this.targets.set(target,{key,sample:shown,draws:previous?.draws??0});return false;}
    const cell=frame-preview.chunks[page].firstFrame;
    state.ctx.clearRect(0,0,target.width,target.height);
    state.ctx.drawImage(entry.image,(cell%preview.columns)*preview.frameWidth,Math.floor(cell/preview.columns)*preview.frameHeight,preview.frameWidth,preview.frameHeight,0,0,target.width,target.height);
    state.key=drawKey;this.sequenceDraws++;this.targets.set(target,{key,sample:shown,draws:(previous?.draws??0)+1});return true;
  }
  displayedSample(target){return this.targets.get(target)?.sample??null;}
  targetDraws(target){return this.targets.get(target)?.draws??0;}
  inspect(){return {frames:this.cache.size,bytes:this.bytes,maxFrames:this.maxPages,maxBytes:this.maxBytes,loading:this.loading,pending:this.pending.size,maxPending:this.interests.size*2+this.concurrency,targets:this.targets.size,errors:[...this.errors.keys()],physicalResources:Object.keys(this.resources).length};}
  release(target){
    this.targets.delete(target);this.requestedTargets.delete(target);this.interests.delete(target);this.fallback.release(target);
    if(!this.requestedTargets.size){for(const entry of this.cache.values())entry.image.src='';this.cache.clear();this.bytes=0;}else this.trim();this.prune();
  }
}
