import test from 'node:test';
import assert from 'node:assert/strict';
const ids=Array.from({length:9},(_,index)=>index?'preview-'+index:'idle');
const clips=Object.fromEntries(ids.map(id=>[id,{actionId:id,canvas:{width:4,height:4},cycleMs:360,frames:Array.from({length:36},(_,index)=>({src:id+'/'+index,timestampMs:index*10}))}]));
globalThis.__FRAME_SEQUENCES__={...clips,'emotion-cheerful':{...clips.idle,actionId:'emotion-cheerful',resourceId:'idle'}};
globalThis.__PREVIEW_ATLASES__=Object.fromEntries(ids.map(id=>[id,{resourceId:id,frameWidth:2,frameHeight:2,columns:4,chunkFrames:12,chunks:Array.from({length:3},(_,page)=>({src:id+'/page-'+page,firstFrame:page*12,frameCount:12,width:8,height:6}))}]));
const {PreviewAtlasRenderer}=await import('../src/preview-atlas-renderer.mjs');
const pause=ms=>new Promise(done=>setTimeout(done,ms));
function fixture(delay=30,options={}){
  const calls=new Map(),states=new WeakMap(),images=[];
  const fallback={ready:Promise.resolve(),targetState:target=>{if(!states.has(target))states.set(target,{key:null,ctx:{clearRect(){},drawImage(...args){target.lastDraw=args;}}});return states.get(target);},release:target=>states.delete(target)};
  const renderer=new PreviewAtlasRenderer(fallback,{maxPages:18,maxBytes:4096,concurrency:4,...options,loadImage:async src=>{calls.set(src,(calls.get(src)??0)+1);await pause(typeof delay==='function'?delay(src):delay);const image={src,naturalWidth:8,naturalHeight:6};images.push(image);return image;}});
  const target=()=>({width:2,height:2,dataset:{}});
  return {renderer,calls,images,target};
}

test('A delayed page decode displays the latest requested complete frame and shares aliases',async()=>{
  const {renderer,calls,target}=fixture(45),first=target(),alias=target();
  renderer.draw(first,{actionId:'idle',elapsedMs:0});
  renderer.draw(alias,{actionId:'emotion-cheerful',elapsedMs:0});
  await pause(10);renderer.draw(first,{actionId:'idle',elapsedMs:90});
  await pause(55);
  assert.equal(renderer.displayedSample(first).displayedSequenceFrame,9,'Async decode must not draw its obsolete frame zero');
  assert.equal(calls.get('idle/page-0'),1,'Aliases decode the same page once');
  assert.deepEqual(first.lastDraw.slice(1),[2,4,2,2,0,0,2,2],'The selected complete PNG cell is drawn directly');
  renderer.release(first);renderer.release(alias);await pause(50);assert.equal(renderer.inspect().frames,0);assert.equal(renderer.inspect().pending,0);
});

test('Nine simultaneously visible previews keep changing frames under decode delay and release bounded pages',async()=>{
  const {renderer,target}=fixture(35),targets=ids.map(()=>target()),frames=ids.map(()=>new Set());
  for(let tick=0;tick<75;tick++){
    for(let index=0;index<ids.length;index++){
      renderer.draw(targets[index],{actionId:ids[index],elapsedMs:tick*10});
      const sample=renderer.displayedSample(targets[index]);if(sample)frames[index].add(sample.displayedSequenceFrame);
    }
    await pause(10);
    const cache=renderer.inspect();assert.ok(cache.frames<=cache.maxFrames);assert.ok(cache.bytes<=cache.maxBytes);assert.ok(cache.pending<=cache.maxPending);
  }
  for(const [index,id] of ids.entries())assert.ok(frames[index].size>=12,id+' must keep advancing its own displayed frame');
  const stopped=targets.map(value=>renderer.displayedSample(value).displayedSequenceFrame);await pause(60);
  assert.deepEqual(targets.map(value=>renderer.displayedSample(value).displayedSequenceFrame),stopped,'Stopping the clock freezes the exact displayed source frame');
  for(const value of targets)renderer.release(value);await pause(100);
  assert.equal(renderer.inspect().targets,0);assert.equal(renderer.inspect().frames,0);assert.equal(renderer.inspect().bytes,0);assert.equal(renderer.inspect().pending,0);
});

test('A late decoded page advances the picture while a newer page is still loading',async()=>{
  const {renderer,target}=fixture(src=>src.endsWith('0')?5:src.endsWith('1')?100:220,{maxPages:1}),value=target();
  renderer.draw(value,{actionId:'idle',elapsedMs:0});await pause(120);
  renderer.draw(value,{actionId:'idle',elapsedMs:130});await pause(10);
  renderer.draw(value,{actionId:'idle',elapsedMs:260});
  await pause(115);
  assert.equal(renderer.displayedSample(value).displayedSequenceFrame,23,'A completed earlier page must be used even after the requested page changed');
  await pause(130);assert.equal(renderer.displayedSample(value).displayedSequenceFrame,26,'The newest decoded page catches up to the unchanged real clock');
  renderer.release(value);await pause(230);assert.equal(renderer.inspect().frames,0);assert.equal(renderer.inspect().pending,0);
});
