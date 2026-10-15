import test from 'node:test';import assert from 'node:assert/strict';import {fiveActionPose,footPath,failureExpression,gazePose,blinkOpen} from '../src/v014-rig-motion.mjs';
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
test('Run has alternating support and actual two-bone knees with constant lengths',()=>{
 for(const id of ['move-left','move-right'])for(let n=0;n<480;n++){const p=fiveActionPose(id,n/480);for(const l of p.legs){assert.ok(l.reachable);assert.ok(Math.abs(distance(l.root,l.joint)-22)<1e-8);assert.ok(Math.abs(distance(l.joint,l.end)-24)<1e-8);if(l.contact)assert.equal(l.end[1],363);}}
 assert.equal(footPath(.1).contact,true);assert.equal(footPath(.6).contact,false);assert.ok(!footPath(.45).contact&&!footPath(.95).contact);
 assert.ok(distance(fiveActionPose('move-right',.2).legs[0].joint,fiveActionPose('move-right',.7).legs[0].joint)>8);
});
test('Gesture hands remain reachable and wrists match continuous targets without hand scaling',()=>{
 for(const id of ['waiting','fail'])for(let n=0;n<480;n++){const p=fiveActionPose(id,n/480);for(const a of p.arms){assert.ok(a.reachable,id+' '+n);assert.ok(Math.abs(distance(a.root,a.joint)-25)<1e-8);assert.ok(Math.abs(distance(a.joint,a.end)-30)<1e-8);}}
});
test('Every internal expression/gesture boundary and loop seam has continuous joints',()=>{
 for(const id of ['waiting','fail','move-left','move-right'])for(const t of [0,.18,.34,.38,.4,.66,.67,.82,.87,.94,1]){const a=fiveActionPose(id,t-1e-7),b=fiveActionPose(id,t+1e-7);for(let n=0;n<a.arms.length;n++)assert.ok(distance(a.arms[n].end,b.arms[n].end)<.001,id+' wrist '+t);for(let n=0;n<a.legs.length;n++)assert.ok(distance(a.legs[n].end,b.legs[n].end)<.001,id+' ankle '+t);assert.ok(Math.abs((a.expression?.quiver??0)-(b.expression?.quiver??0))<.001);}
});
test('Gaze retains side profiles while blink continues at a fixed angle',()=>{
 assert.ok(gazePose(90).yaw>1);assert.ok(gazePose(270).yaw<-1);assert.equal(gazePose(0).yaw,0);const a=gazePose(360-1e-7),b=gazePose(1e-7);assert.ok(Math.abs(a.yaw-b.yaw)<1e-7);assert.equal(blinkOpen(0),1);assert.equal(blinkOpen(3200*.62+10),0);assert.equal(blinkOpen(3200*.62+200),1);assert.ok(failureExpression(.5).crying>.99);assert.ok(failureExpression(.88).sad>.99);
});
test('Running arms oppose their own leg through both directions and reversal',()=>{
 for(const direction of [-1,-.5,0,.5,1])for(let n=0;n<240;n++){
  const p=fiveActionPose('move-right',n/240,{movementDirection:direction});
  for(let k=0;k<2;k++)assert.ok((p.arms[k].end[0]-p.arms[k].root[0])*p.legs[k].x<=1e-7);
 }
});
test('Failure recovers to neutral before its loop restarts',()=>{
 for(const t of [0,.99999]){const e=failureExpression(t);assert.ok(e.fear<.001);assert.ok(e.crying<.001);assert.ok(e.sad<.001);}
 assert.ok(failureExpression(.12).fear>.99);
});
