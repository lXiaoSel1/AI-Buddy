import test from 'node:test';import assert from 'node:assert/strict';import {cursorDirection,PetActionController} from '../src/pet-actions.mjs';
test('Gaze has a 12 DIP eye-centered dead zone and stable cardinal directions',()=>{
 const eye={x:98,y:130};assert.equal(cursorDirection(eye,eye),null);assert.equal(cursorDirection({x:110,y:130},eye),null);
 assert.equal(cursorDirection({x:111,y:130},eye).index,4);assert.equal(cursorDirection({x:98,y:100},eye).index,0);assert.equal(cursorDirection({x:70,y:130},eye).index,12);
});
test('Stationary gaze retains target and its independent breathing clock for thirty seconds',()=>{
 let time=0;const c=new PetActionController({now:()=>time});c.setSpeed(.75);c.cursor(100,0,4,90);c.select();time=180;assert.equal(c.select().gazeWeight,1);time=30000;const a=c.select();assert.equal(a.id,'look');assert.equal(a.lookAngle,90);assert.equal(a.elapsed,22500);assert.equal(a.baseElapsed,22500);c.cursor(110,0,4,90);assert.equal(c.select().elapsed,a.elapsed);
});
test('Follow disabling returns to neutral smoothly; working and waiting never inherit gaze',()=>{
 let time=0;const c=new PetActionController({now:()=>time});c.cursor(100,0,4,90);c.select();time=180;c.followCursor=false;assert.equal(c.select().gazeWeight,1);time=270;assert.equal(c.select().gazeWeight,.5);time=360;assert.equal(c.select().id,'idle');c.followCursor=true;c.setBase('working');assert.equal(c.select().lookAngle,null);c.setBase('waiting');assert.equal(c.select().id,'waiting');assert.equal(c.select().gazeWeight,0);
});
test('Drag reversal preserves gait time and provides an exact 120ms turn window',()=>{
 let time=0;const c=new PetActionController({now:()=>time});c.drag(true,1);time=400;const before=c.select().elapsed;c.drag(true,-1);assert.equal(c.select().elapsed,before);assert.equal(c.select().turn.progress,0);time=460;assert.equal(c.select().turn.progress,.5);time=520;assert.equal(c.select().turn,null);
});
