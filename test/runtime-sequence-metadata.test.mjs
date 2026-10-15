import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeSequenceMetadata} from '../scripts/runtime-sequence-metadata.mjs';
import {validateFrameSequence,sequenceSampleFrame} from '../src/frame-sequence.mjs';
test('packaged metadata preserves timing and calibrated gaze without review paths',()=>{
 const clip={actionId:'look',resourceId:'grok/look/v178',backend:'webm-alpha',canvas:{width:576,height:624},anchor:{x:276,y:602},eyeOrigin:{x:296,y:325},cycleMs:310/60*1000,frames:Array.from({length:310},(_,i)=>({timestampMs:i/60*1000,originalFrame:i%5===0,sourceIndex:i*.4,source:'E:/private/source.png'})),staticFrames:Object.fromEntries(Array.from({length:310},(_,i)=>[i,{src:'./assets/look/'+i+'.webp',file:'stills/'+i+'.webp'}])),video:{src:'./assets/look.webm',file:'motion.webm',codec:'vp9-alpha',durationMs:310/60*1000},directionFrames:Array.from({length:16},(_,i)=>30+i*15),directionEndFrame:270,directionBlinkRanges:[[149,165]],provenance:{source:'E:/private/source.mp4'},frameHashes:['retained in local records']};
 const packed=runtimeSequenceMetadata(clip);validateFrameSequence(packed);
 for(let angle=0;angle<360;angle++)assert.equal(sequenceSampleFrame(packed,{lookAngle:angle}),sequenceSampleFrame(clip,{lookAngle:angle}));
 assert.deepEqual(packed.eyeOrigin,clip.eyeOrigin);assert(!JSON.stringify(packed).includes('private'));assert(!JSON.stringify(packed).includes('frameHashes'));
});
