import test from 'node:test';
import assert from 'node:assert/strict';
import {PetMotion} from '../src/pet-interactions.mjs';

const FLOOR=1080-280;
// Right-button drag upward and release fast: a throw.
function thrown(){
 const clock={now:0};
 const motion=new PetMotion({now:()=>clock.now,bounds:{x:400,y:700,width:270,height:280},displays:()=>[{x:0,y:0,width:1920,height:1080}]});
 motion.begin({x:500,y:800},{button:2});clock.now=16;motion.move({x:520,y:700});clock.now=32;motion.move({x:560,y:560});clock.now=48;motion.move({x:600,y:420});
 assert.equal(motion.release({x:600,y:420}).flying,true);
 return {motion,clock};
}
// 16 ms frames, with optional interruptions at given frame numbers.
function run({motion,clock},events={},frames=1500){
 for(let frame=0;frame<frames;frame++){events[frame]?.(motion,clock);clock.now+=16;motion.tick();}
 return motion;
}
const onFloor=motion=>motion.mode!=='flying'&&Math.abs(motion.bounds.y-FLOOR)<1;

test('B8: a 520 ms stall during a throw does not freeze the pet in mid-air',()=>{
 const motion=run(thrown(),{8:(_,clock)=>{clock.now+=520;}});
 assert.ok(onFloor(motion),JSON.stringify({mode:motion.mode,y:motion.bounds.y}));
});

test('B8: cancelling the gesture, stopping or recovering during a throw lets it land',()=>{
 for(const interrupt of [m=>m.cancel(),m=>m.stop(),m=>m.recover(),m=>m.recover({...m.bounds})]){
  const motion=run(thrown(),{6:interrupt});
  assert.ok(onFloor(motion),String(interrupt)+' '+JSON.stringify({mode:motion.mode,y:motion.bounds.y}));
 }
});

test('B8: a left-button drag still rests wherever it is dropped',()=>{
 const clock={now:0},motion=new PetMotion({now:()=>clock.now,bounds:{x:400,y:700,width:270,height:280},displays:()=>[{x:0,y:0,width:1920,height:1080}]});
 motion.begin({x:500,y:800},{button:0});clock.now=16;motion.move({x:500,y:500});clock.now=32;motion.move({x:500,y:300});motion.release({x:500,y:300});
 const y=motion.bounds.y;run({motion,clock},{3:m=>m.recover()},200);
 assert.equal(motion.mode,'rest');assert.equal(motion.bounds.y,y);assert.ok(y<FLOOR-100);
});

test('B8: turning physics off during a throw lands the pet instead of freezing or flying on',()=>{
 const {motion,clock}=thrown();clock.now+=64;motion.tick();assert.equal(motion.mode,'flying');
 motion.configure({enabled:false});assert.ok(onFloor(motion),JSON.stringify({mode:motion.mode,y:motion.bounds.y}));
 const y=motion.bounds.y;run({motion,clock},{2:m=>m.recover()},50);assert.equal(motion.mode,'rest');assert.equal(motion.bounds.y,y);
});
