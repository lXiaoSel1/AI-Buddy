import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFrameSequence,sequenceSampleFrame,sequenceFrameAt} from '../src/frame-sequence.mjs';

test('calibrated gaze excludes the opening/closing hold without shortening the demonstration',()=>{
 const clip={cycleMs:310/60*1000,canvas:{width:576,height:624},frames:Array.from({length:310},(_,i)=>({src:i+'.png',timestampMs:i/60*1000})),directionFrames:Array.from({length:16},(_,i)=>30+i*15),directionEndFrame:270};
 validateFrameSequence(clip);
 assert.equal(sequenceSampleFrame(clip,{lookAngle:0}),30);
 assert.equal(sequenceSampleFrame(clip,{lookAngle:90}),90);
 assert.equal(sequenceSampleFrame(clip,{lookAngle:180}),150);
 assert.equal(sequenceSampleFrame(clip,{lookAngle:270}),210);
 assert.equal(sequenceSampleFrame(clip,{lookAngle:359}),269);
 assert.equal(sequenceSampleFrame(clip,{lookAngle:360}),30);
 assert.equal(sequenceFrameAt(clip,5000),300);
 assert.throws(()=>validateFrameSequence({...clip,directionEndFrame:255}));
 assert.throws(()=>validateFrameSequence({...clip,directionEndFrame:310}));
});

test('cursor holds an open-eyed pose while normal playback keeps the recorded blink',()=>{
 const clip={cycleMs:310/60*1000,canvas:{width:576,height:624},frames:Array.from({length:310},(_,i)=>({src:i+'.png',timestampMs:i/60*1000})),directionFrames:Array.from({length:16},(_,i)=>30+i*15),directionEndFrame:270,directionBlinkRanges:[[149,165]]};
 validateFrameSequence(clip);
 assert.equal(sequenceSampleFrame(clip,{lookAngle:180}),148);
 assert.equal(sequenceSampleFrame(clip,{lookAngle:200}),166);
 assert.equal(sequenceSampleFrame(clip,{elapsedMs:160/60*1000}),160);
 assert.throws(()=>validateFrameSequence({...clip,directionBlinkRanges:[[0,165]]}));
 assert.throws(()=>validateFrameSequence({...clip,directionBlinkRanges:[[149,165],[160,170]]}));
});
