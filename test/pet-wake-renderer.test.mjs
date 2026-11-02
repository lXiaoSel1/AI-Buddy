import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {VideoSequenceRenderer} from '../src/video-sequence-renderer.mjs';
import {interactionFrameStatus} from '../src/pet-frame-readiness.mjs';

function deliverFeedback(value){
 const source=readFileSync(new URL('../src/pet.mjs',import.meta.url),'utf8');
 const start=source.indexOf("  if(value.kind==='feedback'){");
 const end=source.indexOf("  if(value.kind==='play')",start);
 assert.ok(start>=0&&end>start);
 const calls={glove:[],feedback:[],updates:0};
 vm.runInNewContext(source.slice(start,end),{value:{kind:'feedback',value},updateGlove:()=>calls.updates++,gloveState:{touch:event=>calls.glove.push(event)},controller:{enqueueFeedback:event=>calls.feedback.push(event)}});
 return calls;
}

test('a confirmed wake touch keeps the glove and never enters the role-expression queue',()=>{
 const event={source:'touch',playExpression:false,eventId:'wake-1',gestureId:'g1',characterId:'deepseek'};
 const calls=deliverFeedback(event);
 assert.equal(calls.updates,1);assert.deepEqual(calls.glove,[event]);assert.deepEqual(calls.feedback,[]);
});

test('ordinary and legacy touches and task feedback keep existing queue behavior',()=>{
 for(const event of [{source:'touch',playExpression:true,id:'emotion-cheerful'},{source:'touch',id:'emotion-shy'},{source:'completed',id:'jump'}]){
  const calls=deliverFeedback(event);assert.deepEqual(calls.feedback,[event]);assert.equal(calls.glove.length,event.source==='touch'?1:0);
 }
});

function fixture(t){
 const originalImage=globalThis.Image,originalDocument=globalThis.document;
 globalThis.Image=class{naturalWidth=4;naturalHeight=4;src='';async decode(){}};
 globalThis.document={createElement:()=>({paused:true,videoWidth:4,videoHeight:4,readyState:0,duration:.4,currentTime:0,handlers:{},addEventListener(name,fn){this.handlers[name]=fn;},load(){},pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();},removeAttribute(){this.src='';}})};
 t.after(()=>{globalThis.Image=originalImage;globalThis.document=originalDocument;});
 const clip=id=>({actionId:id,resourceId:'resource-'+id,backend:'webm-alpha',canvas:{width:4,height:4},cycleMs:400,loop:false,frames:[0,100,200,300].map(timestampMs=>({timestampMs})),video:{src:id+'.webm',codec:'vp9-alpha',durationMs:400},staticFrames:{0:{src:id+'.webp'}}});
 const states=new Map(),draws=[];
 const target={width:4,height:4,dataset:{},getContext:()=>({clearRect(){},drawImage:image=>draws.push(image)})};
 const fallback={ready:Promise.resolve(),draws:0,release:target=>states.delete(target),targetState(target){if(!states.has(target))states.set(target,{key:null,ctx:target.getContext()});return states.get(target);}};
 const renderer=new VideoSequenceRenderer(fallback,{sequences:{idle:clip('idle'),wake:clip('wake')}});
 t.after(()=>renderer.dispose());
 return {renderer,target,draws};
}

test('drawn samples distinguish a cold placeholder from a decoded video frame of the same action',async t=>{
 const {renderer:r,target}=fixture(t);await r.ready;await r.still(r.sequences.wake,0);
 const sample={actionId:'wake',elapsedMs:0,playing:false};
 assert.equal(r.draw(target,sample),true);
 const cold=r.displayedSample(target);assert.equal(cold.displayedSource,'still');assert.equal(cold.displayedResource,'resource-wake');assert.equal(cold.displayedReducedMotion,false);
 const slot=r.targets.get(target).slot;slot.ready=true;slot.video.readyState=2;slot.serial++;
 assert.equal(r.draw(target,sample),true);
 const decoded=r.displayedSample(target);assert.equal(decoded.displayedSource,'video');assert.equal(decoded.displayedResource,'resource-wake');assert.notEqual(decoded,cold);
});

test('reduced-motion stills identify themselves as deliberate rather than cold-load placeholders',async t=>{
 const {renderer:r,target}=fixture(t);await r.ready;await r.still(r.sequences.wake,0);
 assert.equal(r.draw(target,{actionId:'wake',elapsedMs:0,reducedMotion:true}),true);
 const shown=r.displayedSample(target);assert.equal(shown.displayedSource,'still');assert.equal(shown.displayedReducedMotion,true);assert.equal(shown.displayedResource,'resource-wake');
});

function readyFixture(){
 return {expected:{id:'wake',scope:'sleep',epoch:3},resource:'deepseek-wake',displayed:{actionId:'wake',displayedResource:'deepseek-wake',displayedSource:'video',displayedReducedMotion:false},slot:{resource:'deepseek-wake',ready:true,seekPending:false,closed:false,error:null,video:{readyState:2}}};
}

test('readiness requires an actual drawn video of the exact action/resource, not loaded metadata alone',()=>{
 const f=readyFixture();assert.deepEqual(interactionFrameStatus(f),{ready:true,failed:false});
 for(const change of [undefined,{...f.displayed,actionId:'idle'},{...f.displayed,displayedResource:'other-wake'},{...f.displayed,displayedSource:'still'}]){
  assert.equal(interactionFrameStatus({...f,displayed:change}).ready,false);
 }
 for(const change of [{ready:false},{seekPending:true},{closed:true},{resource:'other-wake'},{video:{readyState:1}}]){
  assert.equal(interactionFrameStatus({...f,slot:{...f.slot,...change}}).ready,false);
 }
 assert.equal(interactionFrameStatus({...f,expected:null}).ready,false);
});

test('reduced motion accepts only its deliberately drawn static pose, never a cold-load still',()=>{
 const f=readyFixture();f.reducedMotion=true;f.slot.ready=false;f.slot.video.readyState=0;
 f.displayed={...f.displayed,displayedSource:'still',displayedReducedMotion:true};
 assert.deepEqual(interactionFrameStatus(f),{ready:true,failed:false});
 assert.equal(interactionFrameStatus({...f,displayed:{...f.displayed,displayedReducedMotion:false}}).ready,false);
 assert.equal(interactionFrameStatus({...f,displayed:{...f.displayed,displayedResource:'other'}}).ready,false);
 assert.equal(interactionFrameStatus({...f,displayed:{...f.displayed,actionId:'idle'}}).ready,false);
});

test('an obsolete decoder error cannot fail the current transition',()=>{
 const f=readyFixture();f.slot.error='decode failed';
 assert.deepEqual(interactionFrameStatus(f),{ready:false,failed:true});
 assert.deepEqual(interactionFrameStatus({...f,slot:{...f.slot,resource:'old-resource'}}),{ready:false,failed:false});
 assert.deepEqual(interactionFrameStatus({...f,slot:{...f.slot,closed:true}}),{ready:false,failed:false});
});

test('same static pixels are explicitly redrawn when reduced-motion intent changes',async t=>{
 const {renderer:r,target,draws}=fixture(t);await r.ready;await r.still(r.sequences.wake,0);
 assert.equal(r.draw(target,{actionId:'wake',elapsedMs:0}),true);const before=draws.length;
 assert.equal(r.displayedSample(target).displayedReducedMotion,false);
 assert.equal(r.draw(target,{actionId:'wake',elapsedMs:0,reducedMotion:true}),true);
 assert.equal(draws.length,before+1);assert.equal(r.displayedSample(target).displayedReducedMotion,true);
});
