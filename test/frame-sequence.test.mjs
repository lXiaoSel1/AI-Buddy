import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFrameSequence,sequenceFrameAt,sequenceFrameElapsed,sequenceSampleFrame,videoSourceFrameAt} from '../src/frame-sequence.mjs';
import {PetActionController,actionSample,GazeTransition} from '../src/pet-actions.mjs';

const clip={canvas:{width:576,height:624},cycleMs:180,frames:[{src:'a.png',timestampMs:0},{src:'b.png',timestampMs:40},{src:'c.png',timestampMs:110}]};
test('30fps video maps displayed frames independently from the complete gaze direction bank',()=>{
 const source={...clip,cycleMs:150,frames:Array.from({length:9},(_,i)=>({timestampMs:i*1000/60})),backend:'webm-alpha',staticFrames:{0:{src:'first.png'}},video:{src:'motion.webm',codec:'vp9-alpha',durationMs:150,encodedFrameCount:5,timeline:[0,33,67,100,133].map((timestampMs,i)=>({timestampMs,sourceFrameIndex:i*2}))}};
 validateFrameSequence(source);assert.equal(videoSourceFrameAt(source,32),0);assert.equal(videoSourceFrameAt(source,33),2);assert.equal(videoSourceFrameAt(source,149.99),8);assert.equal(videoSourceFrameAt(source,150),0);assert.equal(sequenceFrameAt(source,50),3);assert.equal(source.frames.length,9);
 assert.throws(()=>validateFrameSequence({...source,video:{...source.video,encodedFrameCount:9}}));
});
test('Native unequal timestamps hold each source frame through its interval and loop without an extra endpoint',()=>{
  validateFrameSequence(clip);
  for(const [elapsed,frame] of [[0,0],[39.999,0],[40,1],[109.999,1],[110,2],[179.999,2],[180,0],[220,1]])assert.equal(sequenceFrameAt(clip,elapsed),frame);
  assert.equal(sequenceFrameAt(clip,110,{reducedMotion:true}),0);
  assert.equal(sequenceFrameElapsed(clip,2),110.001);
  assert.throws(()=>validateFrameSequence({...clip,frames:[{src:'a',timestampMs:1}]}));
  assert.throws(()=>validateFrameSequence({...clip,frames:[clip.frames[0],clip.frames[0]]}));
});
test('120fps sequence selects actual intermediate poses and holds exact 24fps sources in comparison',()=>{
  const smooth={...clip,cycleMs:100,interpolation:{multiplier:5},frames:Array.from({length:10},(_,i)=>({src:i+'.png',timestampMs:i*10}))};
  validateFrameSequence(smooth);
  assert.equal(sequenceSampleFrame(smooth,{elapsedMs:47}),4);
  assert.equal(sequenceSampleFrame(smooth,{elapsedMs:47},{sourceOnly:true}),0);
  assert.equal(sequenceSampleFrame(smooth,{elapsedMs:87},{sourceOnly:true}),5);
  assert.equal(sequenceSampleFrame(smooth,{elapsedMs:102}),0);
});
test('Full character cursor directions select all sixteen recorded poses and interpolate across angle wrap',()=>{
  const look={...clip,cycleMs:1600,frames:Array.from({length:160},(_,i)=>({src:i+'.png',timestampMs:i*10})),directionFrames:Array.from({length:16},(_,i)=>i*10)};
  validateFrameSequence(look);
  for(let i=0;i<16;i++)assert.equal(sequenceSampleFrame(look,{lookIndex:i,elapsedMs:100}),i*10);
  assert.equal(sequenceSampleFrame(look,{lookAngle:11.25,lookIndex:0}),5);
  assert.equal(sequenceSampleFrame(look,{lookAngle:348.75}),155);
  assert.equal(sequenceSampleFrame(look,{lookAngle:-11.25}),155);
  assert.equal(sequenceSampleFrame(look,{lookAngle:360}),0);
  assert.equal(sequenceSampleFrame(look,{lookAngle:90,lookIndex:4,reducedMotion:true}),40);
  assert.throws(()=>validateFrameSequence({...look,directionFrames:[0,10]}));
  assert.throws(()=>validateFrameSequence({...look,directionFrames:look.directionFrames.map((v,i)=>i===2?10:v)}));
});
test('Continuous gaze keeps intermediate directions and crosses zero on the short arc',()=>{
  const gaze=new GazeTransition({continuous:true});gaze.update(15,350,0);assert.equal(gaze.angle(180),350);
  gaze.update(0,10,180);const middle=gaze.angle(240);assert.ok(middle>350||middle<10);assert.equal(gaze.angle(360),10);
  gaze.update(1,12,360);assert.equal(gaze.angle(540),12);
});
test('Controller speed reaches native timestamp selection once and preserves phase when changing speed',()=>{
  let now=0;const controller=new PetActionController({now:()=>now});controller.play({id:'move-right',durationMs:15000});controller.setSpeed(.5);
  now=220;let state=controller.select();assert.equal(state.elapsed,110);assert.equal(sequenceFrameAt(clip,actionSample(state.id,state.elapsed).elapsedMs),2);
  controller.setSpeed(1);assert.equal(controller.select().elapsed,110);now=290;state=controller.select();assert.equal(state.elapsed,180);assert.equal(sequenceFrameAt(clip,state.elapsed),0);
});
