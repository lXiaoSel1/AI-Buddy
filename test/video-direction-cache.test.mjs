import test from 'node:test';
import assert from 'node:assert/strict';
import {VideoSequenceRenderer,directionContentRect} from '../src/video-sequence-renderer.mjs';

test('transparent padding is cropped after resizing and restored at exact canvas coordinates',async t=>{
 const original=globalThis.createImageBitmap,calls=[],closed=[];
 globalThis.createImageBitmap=async(image,...args)=>{calls.push(args);const crop=args.length===4;return {src:image.src,width:crop?args[2]:args[0].resizeWidth,height:crop?args[3]:args[0].resizeHeight,close(){closed.push(this.width);}};};
 t.after(()=>{globalThis.createImageBitmap=original;});
 const {renderer:r,target,clip,sample}=fixture(t);await r.ready;
 clip.directionContentBounds=[1,1,3,3];target.width=40;target.height=40;
 const drawn=[];target.getContext=()=>({clearRect(){},drawImage(...args){drawn.push(args);}});
 r.draw(target,sample(0));await pause(80);r.draw(target,sample(0));
 const region=directionContentRect(clip,{width:40,height:40},0);assert.deepEqual(region,{x:8,y:8,width:24,height:24});
 const image=r.directions.get(r.stillKey(clip,0,{width:40,height:40}));assert.equal(image.bytes,24*24*4);assert.deepEqual(drawn.at(-1).slice(1),[8,8,24,24]);assert(closed.includes(40));assert(calls.some(a=>a.length===4));r.dispose();await pause(30);
});

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(t,options={}){
 const originalImage=globalThis.Image,originalDocument=globalThis.document;
 const loads={active:0,max:0,started:0};
 globalThis.Image=class{naturalWidth=4;naturalHeight=4;async decode(){loads.started++;loads.active++;loads.max=Math.max(loads.max,loads.active);await pause(4);loads.active--;}};
 globalThis.document={createElement:()=>({muted:true,paused:true,videoWidth:4,videoHeight:4,duration:3,currentTime:0,handlers:{},addEventListener(name,fn){this.handlers[name]=fn;},load(){if(this.src)setTimeout(()=>this.handlers.loadeddata?.(),0);},pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();},removeAttribute(){this.src='';},getVideoPlaybackQuality(){return {totalVideoFrames:0,droppedVideoFrames:0};}})};
 t.after(()=>{globalThis.Image=originalImage;globalThis.document=originalDocument;});
 const count=176,clip={actionId:'look',backend:'webm-alpha',canvas:{width:4,height:4},cycleMs:count*16,frames:Array.from({length:count},(_,i)=>({timestampMs:i*16})),directionFrames:Array.from({length:16},(_,i)=>i*11),video:{src:'look.webm',codec:'vp9-alpha',durationMs:count*16},staticFrames:Object.fromEntries(Array.from({length:count},(_,i)=>[i,{src:'still-'+i}]))};
 const states=new Map(),fallback={ready:Promise.resolve(),draws:0,pixels:{atlas:true},release:target=>states.delete(target),invalidate(){},targetState(target){if(!states.has(target))states.set(target,{key:null,ctx:target.getContext()});return states.get(target);}};
 const target={width:4,height:4,dataset:{},alpha:0,reads:[],getContext(){return {clearRect(){},drawImage:image=>{target.alpha=Number(image.src.split('-').at(-1))+50;},getImageData:(...area)=>{target.reads.push(area);return {data:new Uint8Array(64).fill(target.alpha)};}};}};
 const renderer=new VideoSequenceRenderer(fallback,{sequences:{idle:{...clip,actionId:'idle',directionFrames:undefined},look:clip},maxStaticFrames:32,staticConcurrency:2,directionPrefetch:8,...options});
 const sample=i=>({actionId:'look',elapsedMs:0,lookAngle:(i+.01)/count*360,playbackRate:1});
 return {renderer,target,clip,loads,sample};
}

test('Direction neighbors are decoded ahead, with bounded concurrency and no video seeking',async t=>{
 const {renderer:r,target,loads,sample}=fixture(t);await r.ready;
 r.draw(target,sample(0));await pause(100);r.draw(target,sample(0));
 const before=loads.started;
 for(let i=1;i<=5;i++){assert.equal(r.draw(target,sample(i)),true);assert.equal(r.displayedSample(target).displayedSequenceFrame,i);await pause(8);}
 assert.ok(loads.started>=before);assert.ok(loads.max<=2);assert.equal(r.seekCount,0);assert.ok(r.stills.size<=32);assert.ok(r.pending.size<=32);
 r.release(target);await pause(20);assert.equal(r.stills.size,0);
});

test('An uncached direction keeps the displayed frame and its hit mask until ready',async t=>{
 const {renderer:r,target,clip,sample}=fixture(t);await r.ready;await r.still(clip,0);r.draw(target,sample(0));
 const old=r.displayedSample(target);assert.equal(r.alpha(old,1,1),50);
 assert.equal(r.draw(target,sample(100)),false);assert.equal(r.displayedSample(target),old);assert.equal(r.alpha(old,1,1),50);
 await r.still(clip,100);assert.equal(r.draw(target,sample(100)),true);assert.equal(r.displayedSample(target).displayedSequenceFrame,100);assert.equal(r.alpha(r.displayedSample(target),1,1),150);
 r.release(target);await pause(20);
});

test('A nearest-frame fallback never freezes a known closed-eye frame',async t=>{
 const {renderer:r,clip}=fixture(t);await r.ready;clip.directionBlinkRanges=[[50,60]];
 await r.still(clip,60);await r.still(clip,65);
 const found=r.nearestDirection({motion:1},clip,61,{width:4,height:4});
 assert.equal(found.index,65);r.dispose();await pause(20);
});

test('Rapid direction changes cancel obsolete prefetch and release cannot resurrect decoded frames',async t=>{
 const {renderer:r,target,loads,sample}=fixture(t);await r.ready;
 for(let i=0;i<176;i+=7){r.draw(target,sample(i));assert.ok(r.pending.size<=32);}
 await pause(1);r.release(target);await pause(25);
 assert.equal(r.targets.size,0);assert.equal(r.prepared.size,0);assert.equal(r.stills.size,0);assert.equal(r.pending.size,0);assert.equal(r.staticQueue.length,0);assert.equal(r.staticActive,0);assert.ok(loads.max<=2);
});

test('A video action change seeks once instead of chasing the advancing clock',async t=>{
 const {renderer:r,target}=fixture(t);await r.ready;
 r.draw(target,{actionId:'idle',elapsedMs:0});await pause(15);r.draw(target,{actionId:'idle',elapsedMs:0});
 const state=r.targets.get(target),previous=r.displayedSample(target);state.actionId='previous-logical-action';
 r.draw(target,{actionId:'idle',elapsedMs:1000});assert.equal(r.seekCount,1);assert.equal(r.displayedSample(target),previous);
 state.slot.seekPending=false;state.slot.mediaMs=1000;state.slot.serial++;
 assert.equal(r.draw(target,{actionId:'idle',elapsedMs:1040}),true);assert.equal(r.seekCount,1);assert.equal(r.displayedSample(target).elapsedMs,1040);
 r.release(target);await pause(20);
});
test('one-shot sleep/wake/recovery clips hold the last pose instead of automatically replaying',async t=>{
 const {renderer:r,target}=fixture(t);r.sequences.idle.loop=false;await r.ready;
 r.draw(target,{actionId:'idle',elapsedMs:0});await pause(15);r.draw(target,{actionId:'idle',elapsedMs:100});
 const slot=r.targets.get(target).slot;assert.equal(slot.video.loop,false);assert.equal(slot.video.paused,false);
 slot.video.currentTime=(r.sequences.idle.cycleMs-30)/1000;
 r.draw(target,{actionId:'idle',elapsedMs:r.sequences.idle.cycleMs-30});assert.equal(slot.video.paused,true);
 r.draw(target,{actionId:'idle',elapsedMs:r.sequences.idle.cycleMs*3});assert.equal(slot.video.paused,true);
 r.dispose();await pause(20);
});

test('A missing direction shows the nearest decoded one along the turn instead of freezing',async t=>{
 const {renderer:r,target,sample}=fixture(t,{warmBatch:0});await r.ready;
 r.draw(target,sample(0));await pause(120);r.draw(target,sample(0));
 assert.equal(r.draw(target,sample(20)),true);
 const shown=r.displayedSample(target).displayedSequenceFrame;assert.ok(shown>=1&&shown<=8,'nearest frame on the way, got '+shown);
 assert.ok(r.inspect().directionApprox>=1);
 await pause(120);assert.equal(r.draw(target,sample(20)),true);assert.equal(r.displayedSample(target).displayedSequenceFrame,20);
 r.release(target);await pause(20);
});

test('Superseded current directions are cancelled instead of decoding ahead of the new window',async t=>{
 const {renderer:r,target,sample}=fixture(t,{warmBatch:0});await r.ready;
 for(const i of [0,60,120])r.draw(target,sample(i));
 const s=r.targets.get(target),wanted=new Set([s.directionKey,...s.prefetchKeys]),queued=r.staticQueue.filter(job=>job.size);
 assert.ok(queued.length>0);for(const job of queued)assert.ok(wanted.has(job.key),'stale job '+job.key);
 assert.ok(!queued.some(job=>job.index===0||job.index===60));
 r.release(target);await pause(20);
});

test('Prefetch favours the direction of travel and has no clockwise bias at rest',async t=>{
 const {renderer:r,target,sample}=fixture(t,{warmBatch:0});await r.ready;
 r.draw(target,sample(50));let s=r.targets.get(target);
 const rest=s.prefetchFrames.map(f=>f.index);assert.equal(rest.filter(i=>i>50).length,rest.filter(i=>i<50).length);
 r.draw(target,sample(45));s=r.targets.get(target);
 const ahead=s.prefetchFrames.filter(f=>f.index<45).length,behind=s.prefetchFrames.filter(f=>f.index>45).length;assert.ok(ahead>behind*2,`ahead ${ahead} behind ${behind}`);
 const first=[...r.staticQueue].sort((a,b)=>a.priority-b.priority||b.order-a.order).find(job=>job.size&&job.priority===1);assert.equal(first.index,44);
 r.release(target);await pause(20);
});

test('Scaled direction bitmaps stay within the byte budget and hit tests read one pixel',async t=>{
 const original=globalThis.createImageBitmap,closed=[];
 globalThis.createImageBitmap=async(image,{resizeWidth,resizeHeight})=>({src:image.src,width:resizeWidth,height:resizeHeight,close(){closed.push(this.src);}});
 t.after(()=>{globalThis.createImageBitmap=original;});
 const budget=40*4*4*4,{renderer:r,target,sample}=fixture(t,{directionBudgetBytes:budget});await r.ready;
 for(let i=0;i<176;i+=6){r.draw(target,sample(i));await pause(12);}
 await pause(80);const info=r.inspect();assert.ok(info.directionBytes<=budget,`${info.directionBytes} > ${budget}`);assert.ok(closed.length>0);
 r.draw(target,sample(170));await pause(60);r.draw(target,sample(170));
 const shown=r.displayedSample(target);assert.equal(shown.displayedSequenceFrame,170);
 target.reads.length=0;assert.equal(r.alpha(shown,1,1),220);assert.equal(r.alpha(shown,1,1),220);
 assert.equal(target.reads.length,1);assert.deepEqual(target.reads[0].slice(2),[1,1]);
 r.release(target);await pause(20);assert.equal(r.inspect().directionBytes,0);
});
