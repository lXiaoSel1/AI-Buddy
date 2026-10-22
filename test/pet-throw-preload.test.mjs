import test from 'node:test';
import assert from 'node:assert/strict';
import {VideoSequenceRenderer} from '../src/video-sequence-renderer.mjs';
import {interactionPresentation,interactionPreloads} from '../src/pet-interaction-view.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(t){
 const originalImage=globalThis.Image,originalDocument=globalThis.document,videos=[];
 globalThis.Image=class{naturalWidth=4;naturalHeight=4;src='';async decode(){await pause(1);}};
 globalThis.document={createElement:()=>{const video={muted:true,paused:true,videoWidth:4,videoHeight:4,duration:3,currentTime:0,handlers:{},addEventListener(name,fn){this.handlers[name]=fn;},load(){if(this.src)setTimeout(()=>this.handlers.loadeddata?.(),0);},pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();},removeAttribute(){this.src='';},getVideoPlaybackQuality(){return {totalVideoFrames:0,droppedVideoFrames:0};}};videos.push(video);return video;}};
 t.after(()=>{globalThis.Image=originalImage;globalThis.document=originalDocument;});
 const clip=(actionId,loop=true)=>({actionId,backend:'webm-alpha',canvas:{width:4,height:4},cycleMs:1200,loop,frames:Array.from({length:36},(_,i)=>({timestampMs:i*1200/36})),video:{src:actionId+'.webm',codec:'vp9-alpha',durationMs:1200},staticFrames:{0:{src:actionId+'-0'}}});
 const sequences={idle:clip('idle'),'throw-start':clip('throw-start',false),'throw-loop':clip('throw-loop'),'land-recover':clip('land-recover',false)};
 const states=new Map(),fallback={ready:Promise.resolve(),draws:0,pixels:{atlas:true},release:target=>states.delete(target),invalidate(){},targetState(target){if(!states.has(target))states.set(target,{key:null,ctx:target.getContext()});return states.get(target);}};
 const target={width:4,height:4,dataset:{},getContext(){return {clearRect(){},drawImage(){}};}};
 return {renderer:new VideoSequenceRenderer(fallback,{sequences}),sequences,target,videos};
}

test('a throw continues the held flight-loop frame instead of returning to the standing takeoff',()=>{
 const view=(motion,now=0)=>interactionPresentation({phase:'awake',at:0,motion:{animationElapsedMs:0,snapshotSpeed:.75,...motion}},{now,hasClip:()=>true,cycle:()=>1200});
 const held=view({mode:'charging',button:2});
 assert.equal(held.id,'throw-loop');assert.equal(held.staticFrame,0);assert.equal(held.playing,false);
 const released=view({mode:'flying',button:2});
 assert.equal(released.id,'throw-loop');assert.equal(released.elapsed,0);assert.equal(released.staticFrame,null);assert.equal(released.playing,true);
 for(const now of [100,1600,10000])assert.equal(view({mode:'flying',button:2},now).id,'throw-loop');
});

test('only a flight preloads, and only its landing',()=>{
 for(const mode of ['pressed','dragging','charging','landing','rest'])for(const button of [0,2])assert.deepEqual(interactionPreloads({mode,button}),[]);
 assert.deepEqual(interactionPreloads({mode:'flying',button:2}),['land-recover']);
 assert.equal(interactionPreloads({mode:'flying'}),interactionPreloads({mode:'flying',button:0}),'same list object for the same situation');
 assert.deepEqual(interactionPreloads(null),[]);
});

test('release plays the decoder that showed the hold, and the landing starts on its preloaded decoder',async t=>{
 const {renderer:r,sequences:s,target,videos}=fixture(t);await r.ready;
 r.draw(target,{actionId:'throw-loop',elapsedMs:0,staticFrame:0,playing:false,playbackRate:1});
 const flight=r.targets.get(target).slot;await pause(5);assert.equal(flight.ready,true,'the held still also loads the flight loop');
 const created=videos.length;
 r.draw(target,{actionId:'throw-loop',elapsedMs:0,playbackRate:1});
 assert.equal(r.targets.get(target).slot,flight);assert.equal(videos.length,created,'no new video element at release');
 assert.equal(r.displayedSample(target).actionId,'throw-loop');
 r.preload([s['land-recover']]);r.prepare(s.idle);await pause(5);
 const landing=r.prepared.get('land-recover');assert.equal(landing.ready,true,'prepare() keeps preloaded decoders');
 r.draw(target,{actionId:'land-recover',elapsedMs:0,playing:false,playbackRate:1});
 assert.equal(r.targets.get(target).slot,landing);assert.equal(flight.closed,true);
 r.preload([]);assert.equal(r.preloads.size,0);assert.deepEqual([...r.prepared.keys()],['idle']);
 assert.equal(r.inspect().decoders,2);r.dispose();assert.equal(r.prepared.size,0);
});

test('without preloads prepare() still holds a single decoder; an empty list frees preloaded ones',async t=>{
 const {renderer:r,sequences:s}=fixture(t);await r.ready;
 const first=r.prepare(s['throw-start']);r.prepare(s['throw-loop']);
 assert.equal(first.closed,true);assert.deepEqual([...r.prepared.keys()],['throw-loop']);
 r.preload([s['land-recover']]);r.preload([s['land-recover']]);
 assert.equal(r.prepared.size,2,'repeating the same list does not load it twice');
 const landing=r.prepared.get('land-recover');r.preload([]);assert.equal(landing.closed,true);assert.deepEqual([...r.prepared.keys()],['throw-loop']);
 await pause(5);r.dispose();
});
