import test from 'node:test';
import assert from 'node:assert/strict';
import {GazeTransition,shortArc,wrapAngle,actionSample,DIRECTION_ANGLES,DIRECTION_FRAMES,framePose} from '../src/pet-actions.mjs';

// Feed a pointer circling the pet every 16ms and sample the gaze between updates, as the pet renderer does.
function circle(speed,dir,ms=2000){
 const g=new GazeTransition({continuous:true});let last=null,reversals=0,travelled=0,maxLag=0;
 for(let t=0;t<=ms;t+=16){
  const raw=wrapAngle(dir*speed*t/1000);g.update(Math.round(raw/22.5)%16,raw,t);
  for(const at of [t+5,t+11]){const a=g.angle(at);if(last!==null){const d=shortArc(last,a);if(d*dir<-1e-6)reversals++;travelled+=d*dir;}last=a;maxLag=Math.max(maxLag,Math.abs(shortArc(a,wrapAngle(dir*speed*at/1000))));}
 }
 return {reversals,travelled,maxLag};
}
test('Circling the pet clockwise or counter-clockwise never turns the gaze backwards at any speed',()=>{
 for(const speed of [120,720,1440,2880,5400])for(const dir of [1,-1]){
  const r=circle(speed,dir);assert.equal(r.reversals,0,`${speed}°/s dir ${dir}`);
  assert.ok(r.travelled>speed*2-360,`${speed}°/s dir ${dir} kept up: ${r.travelled}`);
 }
});
test('A half-turn jump keeps the current turning direction',()=>{
 const cw=new GazeTransition({continuous:true});cw.update(0,0,0);cw.update(0,10,16);cw.update(8,190,32);
 const a=cw.angle(32+60);assert.ok(a>10&&a<190,'clockwise path through 100°, got '+a);
 const ccw=new GazeTransition({continuous:true});ccw.update(0,0,0);ccw.update(15,350,16);ccw.update(7,170,32);
 const b=ccw.angle(32+60);assert.ok(b>170&&b<350,'counter-clockwise path through 260°, got '+b);
 assert.equal(cw.angle(32+180),190);assert.equal(ccw.angle(32+180),170);
});
test('Cursor gaze crosses zero by the short arc and ends exactly in 180ms',()=>{
 const g=new GazeTransition();g.update(15,337.5,0);assert.equal(g.angle(180),337.5);g.update(0,0,200);assert.ok(g.angle(290)>337.5);assert.equal(g.angle(380),0);
 assert.equal(shortArc(337.5,0),22.5);assert.equal(shortArc(0,337.5),-22.5);
});
test('Interrupting and reversing gaze preserves the displayed angle',()=>{
 const g=new GazeTransition();g.update(4,90,0);const before=g.angle(80);g.update(12,270,80);assert.equal(g.angle(80),before);assert.equal(g.angle(260),270);
});
test('Three-degree hysteresis prevents sector chatter on either side of zero',()=>{
 const g=new GazeTransition();g.update(0,0,0);assert.equal(g.update(1,12,20),0);assert.equal(g.update(1,14.3,30),1);assert.equal(g.update(0,10,40),1);assert.equal(g.update(0,8,50),0);
 const h=new GazeTransition();h.update(0,0,0);assert.equal(h.update(15,348,20),0);assert.equal(h.update(15,345,30),15);
});
test('Continuous gaze traverses all 24 drawings with compatible sixteen exact keys',()=>{
 assert.equal(DIRECTION_ANGLES.length,24);
 for(let n=0;n<24;n++){const s=actionSample('look',0,{lookAngle:DIRECTION_ANGLES[n]});assert.equal(s.frame,n);assert.equal(s.mix,0);}
 for(let n=0;n<16;n++){const s=actionSample('look',0,{lookAngle:n*22.5});assert.equal(s.frame,DIRECTION_FRAMES[n]);assert.equal(s.mix,0);}
 const wrap=actionSample('look',0,{lookAngle:350});assert.equal(wrap.frame,23);assert.deepEqual(wrap.nextPose,framePose('look',0));assert.ok(wrap.mix>0&&wrap.mix<1);
});
