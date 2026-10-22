import test from 'node:test';
import assert from 'node:assert/strict';
import {PetActivityClock,PetMotion} from '../src/pet-interactions.mjs';

test('System recovery republishes native position even when the clamped controller position repeats',()=>{
 let native={x:100,y:100,width:338,height:350},writes=0;
 const m=new PetMotion({bounds:native,displays:()=>[{workArea:{x:0,y:0,width:2560,height:1392}}],onPosition:b=>{native={...b};writes++;}});
 m.recover();
 assert.equal(writes,1);
 for(let i=0;i<3;i++){
  native={...native,x:16000,y:-16000};
  // Windows can move or resize a window independently during display changes.
  // Its recovered model position may equal the last published position.
  m.recover({x:100,y:100,width:338,height:350});
  assert.deepEqual(native,m.state().bounds);
 }
 assert.equal(writes,4);
});

test('A long system pause discards old media-ready messages and restarts only the awake grace period',()=>{
 let now=0;const clock=new PetActivityClock({now:()=>now,requireReady:true});
 now=300000;const sleeping=clock.tick();assert.equal(sleeping.phase,'sleep-enter');
 now+=8*60*60*1000;clock.resume();
 assert.equal(clock.markReady(sleeping.animationEpoch),false);
 assert.equal(clock.tick().phase,'awake');
 now+=299999;assert.equal(clock.tick().phase,'awake');
 now++;assert.equal(clock.tick().phase,'sleep-enter');
});

// A throw in the air is not frozen by recovery: it drops straight down from the
// recovered position with a new animation epoch (B8).
test('Removing an offset mixed-DPI display during every active gesture clears motion and stale media',()=>{
 for(const mode of ['dragging','charging','flying','landing']){
  let now=0,displays=[{workArea:{x:-1280,y:-400,width:1280,height:984},scaleFactor:1},{workArea:{x:0,y:0,width:2560,height:1392},scaleFactor:1.5}];
  const m=new PetMotion({now:()=>now,bounds:{x:-800,y:0,width:338,height:350},collisionInsets:{left:45,top:50,right:45,bottom:60},displays:()=>displays,requireReady:true});
  m.begin({x:-700,y:100},{button:2});now=20;m.move({x:-600,y:80});
  if(mode==='charging'){m.right({x:-600,y:80});m.move({x:-800,y:150});}
  if(mode==='flying'||mode==='landing')m.release(null,{button:2});
  if(mode==='landing')m.setMode('landing');
  assert.equal(m.mode,mode);const epoch=m.animationEpoch;
  displays=[displays[1]];now+=600000;m.recover();
  assert.equal(m.mode,mode==='flying'?'flying':'rest');assert.deepEqual(m.velocity,{x:0,y:0});
  assert.equal(m.anchor,null);assert.equal(m.pull,null);assert.equal(m.markReady(epoch),false);
  const b=m.collisionRect();assert.ok(b.x>=0&&b.y>=0&&b.x+b.width<=2560&&b.y+b.height<=1392);
  assert.equal(m.release(null,{button:0}).ignored,true);
  assert.equal(m.release(null,{button:2}).ignored,true);
 }
});
