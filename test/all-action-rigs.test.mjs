import test from 'node:test';import assert from 'node:assert/strict';
import {ACTION_RIGS,actionPose,actionPoint,jointPose,jumpState,expressionState,meshNodes,meshIndices} from '../src/action-rigs.mjs';
test('All nine additional actions have stable, non-folding continuous geometry and loop seams',()=>{
 const nodes=meshNodes(),indices=meshIndices();assert.equal(Object.keys(ACTION_RIGS).length,9);
 for(const [id,cfg] of Object.entries(ACTION_RIGS)){
  for(let n=0;n<=384;n++){const pose=actionPose(cfg,n/384),points=nodes.map(([x,y])=>actionPoint(cfg,pose,x,y));for(let i=0;i<indices.length;i+=3){const [a,b,c]=[points[indices[i]],points[indices[i+1]],points[indices[i+2]]],area=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);assert.ok(area>24,`${id} folded at ${n}, area ${area}`);}}
  for(const [x,y] of [[100,200],[192,247],[192,cfg.floor]]){const a=actionPoint(cfg,actionPose(cfg,0),x,y),b=actionPoint(cfg,actionPose(cfg,1),x,y);assert.ok(Math.hypot(a[0]-b[0],a[1]-b[1])<1e-8,id+' seam');}
 }
});
test('Idle preserves the lettering and grounded actions keep foot contacts',()=>{
 for(let n=0;n<96;n++){const t=n/96,cfg=ACTION_RIGS.idle;for(const p of [[13,4],[150,50],[320,142]])assert.deepEqual(actionPoint(cfg,actionPose(cfg,t),...p),p);for(const id of ['idle','wave','waiting','reviewing','fail']){const c=ACTION_RIGS[id],p=actionPoint(c,actionPose(c,t),192,c.floor);assert.ok(Math.abs(p[1]-c.floor)<1e-8,id+' feet');}}
});
test('Jump anticipates, flies, contacts and recovers; expression events preserve meaning',()=>{
 assert.equal(jumpState(.1).stage,'anticipation');assert.ok(jumpState(.1).squash>0);assert.equal(jumpState(.4).stage,'launch');assert.ok(jumpState(.43).lift<-56);assert.equal(jumpState(.6).stage,'descent');assert.equal(jumpState(.75).stage,'contact');assert.ok(jumpState(.75).squash>.09);assert.equal(jumpState(.9).stage,'recovery');
 assert.deepEqual([.1,.4,.8,.99].map(t=>expressionState('fail',t)),['fear','cry','sad','fear']);assert.equal(expressionState('jump',.4),'joy');assert.deepEqual([.5,.57,.63,.7,.8].map(t=>expressionState('wave',t)),['open','half','closed','half','open']);
});
test('Jump geometry stays continuous at preparation, landing and recovery boundaries',()=>{
 const cfg=ACTION_RIGS.jump;for(const boundary of [.18,.68,.82])for(const point of [[192,70],[120,220],[192,395]]){const a=actionPoint(cfg,actionPose(cfg,boundary-1e-6),...point),b=actionPoint(cfg,actionPose(cfg,boundary+1e-6),...point);assert.ok(Math.hypot(a[0]-b[0],a[1]-b[1])<.01,`jump discontinuity at ${boundary}`);}
});
test('Semantic hand paths keep their endpoints and interpolate along short arcs',()=>{
 for(const id of ['waiting','jump','fail']){const cfg=ACTION_RIGS[id];for(let n=0;n<=100;n++)for(let i=0;i<2;i++){const p=jointPose(cfg,n/100,i);assert.ok(Number.isFinite(p.angle));assert.ok(p.scale>.45&&p.scale<2.2);const a=jointPose(cfg,0,i),b=jointPose(cfg,1,i);assert.ok(Math.abs(a.angle-b.angle)<1e-8);assert.equal(a.sourceFrame,b.sourceFrame);}}
});
