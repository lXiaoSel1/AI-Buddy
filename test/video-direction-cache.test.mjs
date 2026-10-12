import test from 'node:test';
import assert from 'node:assert/strict';
import {VideoSequenceRenderer} from '../src/video-sequence-renderer.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(t){
 const originalImage=globalThis.Image,originalDocument=globalThis.document;
 const loads={active:0,max:0,started:0};
 globalThis.Image=class{naturalWidth=4;naturalHeight=4;async decode(){loads.started++;loads.active++;loads.max=Math.max(loads.max,loads.active);await pause(4);loads.active--;}};
 globalThis.document={createElement:()=>({muted:true,paused:true,videoWidth:4,videoHeight:4,duration:3,currentTime:0,handlers:{},addEventListener(name,fn){this.handlers[name]=fn;},load(){if(this.src)setTimeout(()=>this.handlers.loadeddata?.(),0);},pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();},removeAttribute(){this.src='';},getVideoPlaybackQuality(){return {totalVideoFrames:0,droppedVideoFrames:0};}})};
 t.after(()=>{globalThis.Image=originalImage;globalThis.document=originalDocument;});
 const count=176,clip={actionId:'look',backend:'webm-alpha',canvas:{width:4,height:4},cycleMs:count*16,frames:Array.from({length:count},(_,i)=>({timestampMs:i*16})),directionFrames:Array.from({length:16},(_,i)=>i*11),video:{src:'look.webm',codec:'vp9-alpha',durationMs:count*16},staticFrames:Object.fromEntries(Array.from({length:count},(_,i)=>[i,{src:'still-'+i}]))};
 const states=new Map(),fallback={ready:Promise.resolve(),draws:0,pixels:{atlas:true},release:target=>states.delete(target),invalidate(){},targetState(target){if(!states.has(target))states.set(target,{key:null,ctx:target.getContext()});return states.get(target);}};
 const target={width:4,height:4,dataset:{},alpha:0,getContext(){return {clearRect(){},drawImage:image=>{target.alpha=Number(image.src.split('-').at(-1))+50;},getImageData:()=>({data:new Uint8Array(64).fill(target.alpha)})};}};
 const renderer=new VideoSequenceRenderer(fallback,{sequences:{idle:{...clip,actionId:'idle',directionFrames:undefined},look:clip},maxStaticFrames:32,staticConcurrency:2,directionPrefetch:8});
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
