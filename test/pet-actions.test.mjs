import test from 'node:test';
import assert from 'node:assert/strict';
import {PET_ACTIONS,PET_ATLAS,DIRECTION_LABELS,DIRECTION_FRAMES,PetActionController,actionPose,actionSample,framePose,frameElapsed,validatePetPlayback} from '../src/pet-actions.mjs';
test('All ten24-frame actions reach every atlas cell at their actual variable timings',()=>{
  assert.equal(PET_ACTIONS.length,10);assert.equal(PET_ATLAS.width,1536);assert.equal(PET_ATLAS.height,6240);const cells=new Set();
  for(const a of PET_ACTIONS){assert.equal(a.frames,24);assert.ok(Math.abs(a.frameDurationsMs.reduce((n,t)=>n+t,0)-a.cycleMs)<.001);for(let n=0;n<24;n++){const pose=actionPose(a.id,frameElapsed(a.id,n));assert.deepEqual(pose,framePose(a.id,n));assert.ok(pose.row<30&&pose.col<8);cells.add(pose.row+','+pose.col);}}
  assert.equal(cells.size,240);
  assert.throws(()=>actionPose('unknown'),/未知/);
});
test('All sixteen look directions map to the exact two atlas rows, and reduced motion holds a frame',()=>{
  assert.equal(DIRECTION_LABELS.length,16);
  assert.deepEqual(DIRECTION_FRAMES,[0,2,3,5,6,8,9,11,12,14,15,17,18,20,21,23]);
  for(let n=0;n<16;n++)assert.deepEqual(actionPose('look',0,{lookIndex:n}),framePose('look',DIRECTION_FRAMES[n]));
  assert.deepEqual(actionPose('wave',800,{reducedMotion:true}),framePose('wave',0));
  assert.throws(()=>actionPose('look',0,{lookIndex:16}),/方向/);
});
test('Compass sweep preserves angular speed and all action loops wrap without extra or missing frames',()=>{
 assert.deepEqual(PET_ACTIONS.at(-1).frameDurationsMs,Array.from({length:24},(_,n)=>[75,75,150][n%3]));
 for(const a of PET_ACTIONS){assert.deepEqual(actionPose(a.id,a.cycleMs+.01),framePose(a.id,0));assert.deepEqual(actionPose(a.id,a.cycleMs-.01),framePose(a.id,23));}
 assert.throws(()=>framePose('look',24));assert.throws(()=>framePose('idle',-1));
});
test('Presentation phase respects every original duration and wraps within an action',()=>{
 for(const a of PET_ACTIONS){let at=0;for(let n=0;n<24;n++){
  const sample=actionSample(a.id,at+a.frameDurationsMs[n]/2);
  assert.equal(sample.frame,n);assert.ok(Math.abs(sample.mix-.5)<1e-9);
  assert.deepEqual(sample.nextPose,framePose(a.id,(n+1)%24));at+=a.frameDurationsMs[n];
 }const start=actionSample(a.id,a.cycleMs+.01);assert.equal(start.frame,0);assert.ok(start.mix<.01);}
});
test('Fixed gaze and reduced motion never interpolate or use a neighboring direction',()=>{
 for(let n=0;n<16;n++){const s=actionSample('look',759,{lookIndex:n});assert.equal(s.mix,0);assert.deepEqual(s.nextPose,framePose('look',DIRECTION_FRAMES[n]));}
 for(const a of PET_ACTIONS){const s=actionSample(a.id,777,{reducedMotion:true});assert.equal(s.frame,0);assert.equal(s.mix,0);assert.deepEqual(s.nextPose,framePose(a.id,0));}
});
test('Manual playback is bounded and rejects unknown actions, directions, extra options and types',()=>{
  for(const r of [null,[],{id:'delete'},{id:'idle',durationMs:0},{id:'wave',durationMs:20000},{id:'look',lookIndex:16},{id:'wave',lookIndex:1},{id:'idle',path:'C:\\'}])assert.throws(()=>validatePetPlayback(r));
  assert.deepEqual(validatePetPlayback({id:'look',lookIndex:15}),{id:'look',lookIndex:15,durationMs:5000});
});
test('Manual demo, drag direction and interruption restore the current monitor state',()=>{
  let t=0;const c=new PetActionController({now:()=>t});c.setBase('working');c.play({id:'wave',durationMs:1000});assert.equal(c.select().id,'wave');
  c.drag(true,-1);assert.equal(c.select().id,'move-left');c.drag(true,1);assert.equal(c.select().id,'move-right');c.drag(false);
  c.setBase('waiting');assert.equal(c.select().source,'manual');t=1001;assert.equal(c.select().id,'waiting');assert.equal(c.select().manual,false);
  c.play({id:'jump'});c.automatic();assert.equal(c.select().id,'waiting');
});
test('Actual pointer movement drives look; a stationary pointer keeps its target',()=>{
  let t=0;const c=new PetActionController({now:()=>t});c.cursor(20,40,12);assert.equal(c.select().id,'look');assert.equal(c.select().lookIndex,12);
  t=1000;c.cursor(20,40,12);assert.equal(c.select().id,'look');t=1101;c.cursor(20,40,12);assert.equal(c.select().id,'look');
  c.cursor(22,40,4);assert.equal(c.select().id,'look');c.followCursor=false;c.select();t+=180;assert.equal(c.select().id,'idle');
});
test('Higher priority errors preserve the interrupted completion until its own cycles resume',()=>{
  let t=0;const c=new PetActionController({now:()=>t});c.setBase('working');
  c.trigger('wave',{source:'show'});assert.equal(c.select().id,'wave');c.trigger('jump',{source:'completed'});assert.equal(c.select().id,'jump');c.trigger('fail',{source:'failed'});c.trigger('wave',{source:'show'});assert.equal(c.select().id,'fail');
  c.setBase('waiting');t=getCycle('fail');assert.equal(c.select().id,'jump');t+=getCycle('jump')*2;assert.equal(c.select().id,'waiting');c.trigger('reviewing',{source:'dialog'});assert.equal(c.select().id,'reviewing');t+=getCycle('reviewing')*2;assert.equal(c.select().id,'waiting');
});
const getCycle=id=>PET_ACTIONS.find(action=>action.id===id).cycleMs;

test('Playback speed changes preserve the current pose phase and change only subsequent animation time',()=>{
  let t=0;const c=new PetActionController({now:()=>t});c.setBase('working');c.setSpeed(.75);
  t=400;assert.equal(c.select().elapsed,300);assert.equal(c.select().cycleMs,1200);
  const before=c.select().elapsed;c.setSpeed(.5);assert.equal(c.select().elapsed,before);
  t=800;assert.equal(c.select().elapsed,500);
  c.drag(true,1);t=1000;assert.equal(c.select().id,'move-right');assert.equal(c.select().elapsed,100);
  for(const value of [0,2,NaN,'0.75'])assert.throws(()=>c.setSpeed(value));
});

test('Slow automatic events finish two full cycles while manual expiry and gaze still use wall time',()=>{
  let t=0;const c=new PetActionController({now:()=>t});c.setSpeed(.75);c.trigger('wave');
  assert.equal(c.select().expiresAt,2400);t=1200;assert.equal(c.select().elapsed,900);
  c.setSpeed(.5);assert.equal(c.select().expiresAt,3000);t=2999;assert.equal(c.select().id,'wave');t=3000;assert.equal(c.select().id,'idle');
  c.play({id:'wave',durationMs:5000});t=7999;assert.equal(c.select().manual,true);t=8000;assert.equal(c.select().manual,false);
  c.cursor(100,0,4,90);t+=180;assert.equal(c.select().lookAngle,90);assert.equal(c.select().lookIndex,4);
});
