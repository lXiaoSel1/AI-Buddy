import test from 'node:test';
import assert from 'node:assert/strict';

test('Whole-frame cache shares alias images, freezes the displayed hit mask during loading, and stays bounded',async()=>{
  const clip={actionId:'idle',canvas:{width:4,height:4},cycleMs:100,frames:Array.from({length:10},(_,index)=>({src:'image-'+index,timestampMs:index*10})),emotionPeakFrame:4};
  globalThis.__FRAME_SEQUENCES__={idle:clip,'emotion-cheerful':{...clip,actionId:'emotion-cheerful',resourceId:'idle'}};
  const loads=new Map();
  globalThis.Image=class{naturalWidth=4;naturalHeight=4;async decode(){loads.set(this.src,(loads.get(this.src)??0)+1);await new Promise(resolve=>setTimeout(resolve,2));}};
  globalThis.document={createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8Array(64).fill(255)})})})};
  const {FrameSequenceRenderer}=await import('../src/frame-sequence-renderer.mjs');
  const target={width:4,height:4,dataset:{}},states=new WeakMap();
  const fallback={ready:Promise.resolve(),draws:0,pixels:{atlas:true},targetState:value=>{if(!states.has(value))states.set(value,{ctx:{clearRect(){},drawImage(){}},key:null});return states.get(value);},release:value=>states.delete(value),invalidate(){}};
  const renderer=new FrameSequenceRenderer(fallback,{maxFrames:3,maxBytes:1000,prefetch:0,concurrency:2});
  await renderer.ready;renderer.draw(target,{actionId:'idle',elapsedMs:0});
  assert.equal(renderer.alpha(renderer.displayedSample(target),1,1),255);
  renderer.draw(target,{actionId:'emotion-cheerful',elapsedMs:0});assert.equal(loads.get('image-0'),1);
  renderer.draw(target,{actionId:'idle',elapsedMs:10});assert.equal(renderer.displayedSample(target).displayedSequenceFrame,0);
  await renderer.request(clip,1);await new Promise(resolve=>setTimeout(resolve,2));assert.equal(renderer.displayedSample(target).displayedSequenceFrame,1);
  renderer.draw(target,{actionId:'idle',elapsedMs:99,reducedMotion:true});await renderer.request(clip,4);await new Promise(resolve=>setTimeout(resolve,2));assert.equal(renderer.displayedSample(target).displayedSequenceFrame,4);
  for(let index=5;index<10;index++)await renderer.request(clip,index);
  await new Promise(resolve=>setTimeout(resolve,2));assert.ok(renderer.inspect().frames<=3);assert.ok(renderer.inspect().bytes<=1000);assert.equal(renderer.inspect().physicalResources,1);
  renderer.release(target);assert.equal(renderer.inspect().targets,0);assert.equal(renderer.inspect().frames,0);
  renderer.prefetch=2;
  for(let index=0;index<100;index++)renderer.draw(target,{actionId:'idle',elapsedMs:index*10});
  assert.ok(renderer.inspect().pending<=renderer.inspect().maxPending,'Obsolete queued prefetch must be cancelled');
  renderer.release(target);assert.ok(renderer.inspect().pending<=2);await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(renderer.inspect().pending,0);assert.equal(renderer.inspect().frames,0,'Inactive in-flight images must also be released');
});
