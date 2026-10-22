import test from 'node:test';
import assert from 'node:assert/strict';
import {VideoSequenceRenderer} from '../src/video-sequence-renderer.mjs';
import {interactionPresentation,interactionPreloads} from '../src/pet-interaction-view.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(t){
 const originalImage=globalThis.Image,originalDocument=globalThis.document,videos=[];
 globalThis.Image=class{naturalWidth=4;naturalHeight=4;src='';async decode(){await pause(1);}};
 globalThis.document={createElement:()=>{const video={muted:true,paused:true,videoWidth:4,videoHeight:4,duration:3,currentTime:0,closed:false,handlers:{},addEventListener(name,fn){this.handlers[name]=fn;},load(){if(this.src)setTimeout(()=>this.handlers.loadeddata?.(),0);else this.closed=true;},pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();},removeAttribute(){this.src='';},getVideoPlaybackQuality(){return {totalVideoFrames:0,droppedVideoFrames:0};}};videos.push(video);return video;}};
 t.after(()=>{globalThis.Image=originalImage;globalThis.document=originalDocument;});
 const clip=(actionId,loop=true)=>({actionId,backend:'webm-alpha',canvas:{width:4,height:4},cycleMs:1200,loop,frames:Array.from({length:36},(_,i)=>({timestampMs:i*1200/36})),video:{src:actionId+'.webm',codec:'vp9-alpha',durationMs:1200},staticFrames:{0:{src:actionId+'-0'}}});
 const sequences={idle:clip('idle'),'throw-start':clip('throw-start',false),'throw-loop':clip('throw-loop'),'land-recover':clip('land-recover',false)};
 const states=new Map(),fallback={ready:Promise.resolve(),draws:0,pixels:{atlas:true},release:target=>states.delete(target),invalidate(){},targetState(target){if(!states.has(target))states.set(target,{key:null,ctx:target.getContext()});return states.get(target);}};
 const target={width:4,height:4,dataset:{},getContext(){return {clearRect(){},drawImage(){}};}};
 return {renderer:new VideoSequenceRenderer(fallback,{sequences}),sequences,target,videos};
}

test('a right-button hold preloads the takeoff; a throw preloads its flight loop and landing',()=>{
 assert.deepEqual(interactionPreloads({mode:'pressed',button:2}),['throw-start']);
 assert.deepEqual(interactionPreloads({mode:'charging',button:2}),['throw-start']);
 assert.equal(interactionPreloads({mode:'dragging',button:2}),interactionPreloads({mode:'pressed',button:2}),'same list object for the same situation');
 assert.deepEqual(interactionPreloads({mode:'dragging',button:0}),[]);
 assert.deepEqual(interactionPreloads({mode:'flying',button:2}),['throw-loop','land-recover']);
 for(const mode of ['landing','rest'])assert.deepEqual(interactionPreloads({mode,button:2}),[]);
 assert.deepEqual(interactionPreloads(null),[]);
});

test('a 1.2 s takeoff reaches the flight loop within an ordinary throw',()=>{
 const flight=interactionPresentation({phase:'awake',at:0,motion:{mode:'flying',animationElapsedMs:0,snapshotSpeed:.75}},{now:1700,hasClip:()=>true,cycle:id=>id==='throw-start'?1200:5166.67});
 assert.equal(flight.id,'throw-loop');
});

test('released throw starts on the preloaded decoder, and preloads never evict each other or the prepare slot',async t=>{
 const {renderer:r,sequences:s,target,videos}=fixture(t);await r.ready;
 r.draw(target,{actionId:'throw-loop',elapsedMs:0,staticFrame:0,playing:false,playbackRate:1});
 r.preload([s['throw-start']]);await pause(5);
 const takeoff=r.prepared.get('throw-start');assert.equal(takeoff.ready,true);
 r.prepare(s.idle);assert.equal(r.prepared.get('throw-start'),takeoff,'prepare() keeps preloaded decoders');
 const created=videos.length;
 r.draw(target,{actionId:'throw-start',elapsedMs:0,playing:false,playbackRate:1});
 assert.equal(videos.length,created,'no new video element at release');
 assert.equal(r.targets.get(target).slot,takeoff);assert.equal(r.displayedSample(target).actionId,'throw-start');
 r.preload([s['throw-loop'],s['land-recover']]);await pause(5);
 assert.deepEqual([...r.prepared.keys()].sort(),['idle','land-recover','throw-loop']);
 r.draw(target,{actionId:'throw-loop',elapsedMs:0,playbackRate:1});
 assert.equal(r.targets.get(target).slot.ready,true,'flight loop is decoded when the takeoff ends');
 const landing=r.prepared.get('land-recover');r.preload([]);
 assert.equal(landing.closed,true);assert.equal(r.prepared.has('land-recover'),false);assert.equal(r.prepared.has('idle'),true);
 assert.equal(r.inspect().decoders,2);r.dispose();assert.equal(r.prepared.size,0);assert.equal(r.preloads.size,0);
});

test('without preloads prepare() still holds a single decoder',async t=>{
 const {renderer:r,sequences:s}=fixture(t);await r.ready;
 const first=r.prepare(s['throw-start']);r.prepare(s['throw-loop']);
 assert.equal(first.closed,true);assert.deepEqual([...r.prepared.keys()],['throw-loop']);
 r.preload([s['land-recover']]);r.preload([s['land-recover']]);
 assert.equal(r.prepared.size,2,'repeating the same list does not load it twice');
 await pause(5);r.dispose();
});
