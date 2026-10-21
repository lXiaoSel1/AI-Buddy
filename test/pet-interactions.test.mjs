import test from 'node:test';
import assert from 'node:assert/strict';
import {PetActivityClock,PetMotion} from '../src/pet-interactions.mjs';
import {interactionPresentation,gloveCursor} from '../src/pet-interaction-view.mjs';
test('external index, deduplicated rescans, counter corrections and new-source baseline never fabricate activity',()=>{
  let now=0;const clock=new PetActivityClock({now:()=>now});
  assert.equal(clock.observeExternal({activityEpoch:1,indexing:true,workSinceStart:100}),false);
  assert.equal(clock.observeExternal({activityEpoch:1,indexing:false,workSinceStart:100}),false);
  now=1000;assert.equal(clock.observeExternal({activityEpoch:1,indexing:false,workSinceStart:110}),true);
  now=2000;assert.equal(clock.observeExternal({activityEpoch:1,indexing:false,workSinceStart:110}),false);assert.equal(clock.lastActivity,1000);
  assert.equal(clock.observeExternal({activityEpoch:1,indexing:false,workSinceStart:108}),false);
  assert.equal(clock.observeExternal({activityEpoch:1,indexing:false,workSinceStart:109}),true);
  assert.equal(clock.observeExternal({activityEpoch:2,indexing:false,workSinceStart:1000000}),false);
});
test('interaction view follows physical phases, retains feedback and identifies missing media explicitly',()=>{
  const presentation=interactionPresentation({phase:'asleep',elapsedMs:100,at:100,motion:{mode:'rest'}},{now:200,hasClip:()=>false});assert.equal(presentation.missing,'sleep-loop');assert.equal(presentation.id,null);assert.equal(presentation.hold,true);
  const flight=interactionPresentation({phase:'awake',elapsedMs:0,at:100,motion:{mode:'flying',elapsedMs:6000}},{now:100,speed:1,hasClip:()=>true,cycle:()=>4000});assert.equal(flight.id,'throw-loop');assert.equal(flight.elapsed,2000);
  assert.match(gloveCursor(),/data:image\/svg\+xml/);assert.notEqual(gloveCursor(),gloveCursor('closed'));
});
test('sleep boundary, real request lifecycle, independent wake grace and new-process baseline',()=>{
  let now=0;const clock=new PetActivityClock({now:()=>now,durations:{enter:1000,wake:1000}});
  now=299999;assert.equal(clock.tick().phase,'awake');now=300000;assert.equal(clock.tick().phase,'sleep-enter');
  now=301000;assert.equal(clock.tick().phase,'asleep');clock.wake('touch');clock.wake('touch');
  now=302000;assert.equal(clock.tick().phase,'awake');assert.equal(clock.lastActivity,0);now=601999;assert.equal(clock.tick().phase,'awake');
  now=602000;assert.equal(clock.tick().phase,'sleep-enter');clock.request('image',true);now+=1000000;assert.equal(clock.tick().phase,'awake');assert.equal(clock.busy.size,1);
  clock.request('image',false);now+=299999;assert.equal(clock.tick().phase,'awake');now++;assert.equal(clock.tick().phase,'sleep-enter');
  const restarted=new PetActivityClock({now:()=>now});assert.equal(restarted.tick().phase,'awake');
});
test('busy guards release independently; feedback wakes without losing activity time',()=>{
  let now=0;const clock=new PetActivityClock({now:()=>now,durations:{enter:10,wake:10}});
  clock.request('chat',true);clock.request('cg',true);clock.request('chat',false);assert.equal(clock.busy.size,1);
  clock.request('cg',false);now=300000;assert.equal(clock.tick({defer:true}).phase,'awake');assert.equal(clock.tick().phase,'sleep-enter');now+=10;clock.tick();
  assert.equal(clock.tick({feedback:true}).phase,'waking');assert.equal(clock.lastActivity,0);
});
test('a completion arriving at the sleep boundary reserves awake time before its feedback enters the queue',()=>{
 let now=0;const clock=new PetActivityClock({now:()=>now});now=300000;clock.wake('feedback');assert.equal(clock.tick().phase,'awake');assert.equal(clock.lastActivity,0);assert.equal(clock.awakeUntil,600000);
});
function rig(){let now=0;const motion=new PetMotion({now:()=>now,bounds:{x:200,y:200,width:270,height:280},displays:()=>[{x:-1920,y:0,width:1920,height:1080},{x:0,y:0,width:1920,height:1080}]});return {motion,at:n=>{now=n;}};}
test('slow placement stays exactly where placed and taps are distinct from dragging/catching/cancellation',()=>{
  const {motion:m,at}=rig();m.begin({x:250,y:250});at(1000);m.move({x:260,y:260});at(1200);const release=m.release({x:260,y:260});assert.equal(release.touch,false);assert.equal(m.mode,'rest');assert.equal(m.bounds.x,210);
  m.begin({x:260,y:260},{button:0});assert.equal(m.release({x:260,y:260}).touch,true);m.begin({x:260,y:260});assert.equal(m.release(null,{cancelled:true}).cancelled,true);
});
test('recent fast throw flies; stopped pointer over 150ms releases at zero',()=>{
  const {motion:m,at}=rig();m.begin({x:250,y:250});at(20);m.move({x:350,y:200});at(40);m.move({x:450,y:180});assert.equal(m.release({x:450,y:180}).flying,true);at(56);m.tick();assert.ok(m.bounds.x>400);
  const stopped=rig();stopped.motion.begin({x:250,y:250});stopped.at(20);stopped.motion.move({x:450,y:200});stopped.at(171);assert.equal(stopped.motion.release({x:450,y:200}).flying,undefined);
});
test('air catch cancels flight and cannot count as a touch',()=>{
  const {motion:m,at}=rig();m.begin({x:250,y:250});at(20);m.move({x:450,y:250});m.release({x:450,y:250});assert.equal(m.mode,'flying');assert.equal(m.begin({x:450,y:250}).caught,true);assert.deepEqual(m.velocity,{x:0,y:0});assert.equal(m.release({x:450,y:250}).touch,false);
});
test('slingshot consumes right, launches opposite pull and cancel restores anchor',()=>{
  const {motion:m,at}=rig();m.begin({x:250,y:250});assert.equal(m.right({x:250,y:250}),false);at(30);m.move({x:300,y:250});assert.equal(m.right({x:300,y:250}),true);const x=m.bounds.x;m.move({x:500,y:350});assert.equal(m.bounds.x,x);assert.equal(m.preview().length,13);m.release({x:500,y:350});assert.ok(m.velocity.x<0);assert.ok(m.velocity.y<0);
  m.begin({x:300,y:250});m.move({x:400,y:250});m.right({x:400,y:250});const anchor={...m.anchor};m.move({x:600,y:500});m.cancel();assert.equal(m.bounds.x,anchor.x);assert.equal(m.bounds.y,anchor.y);
});
test('flight settles without perpetual bounce and recovers removed displays/suspension',()=>{
  const {motion:m,at}=rig();m.begin({x:250,y:250});at(30);m.move({x:350,y:150});m.release({x:350,y:150});for(let time=46;time<60000&&m.mode!=='rest';time+=16){at(time);m.tick();}assert.equal(m.mode,'rest');assert.deepEqual(m.velocity,{x:0,y:0});assert.ok(m.bounds.y<=800);
  m.displays=()=>[{x:0,y:0,width:900,height:650}];m.recover({x:-500,y:2000,width:270,height:280});assert.deepEqual(m.bounds,{x:0,y:370,width:270,height:280});
});
test('strengths change velocity, disabled physics never launches and high frequency samples remain bounded',()=>{
  const speeds=[];for(const strength of ['gentle','standard','strong','exaggerated']){const {motion:m,at}=rig();m.configure({strength});m.begin({x:250,y:250});for(let i=1;i<=40;i++){at(i);m.move({x:250+i*15,y:250});}m.release({x:850,y:250});speeds.push(Math.abs(m.velocity.x));assert.ok(m.samples.length<=7);}assert.ok(speeds.every((s,i)=>!i||s>speeds[i-1]));
  const {motion:m,at}=rig();m.configure({enabled:false});m.begin({x:250,y:250});at(20);m.move({x:450,y:250});assert.equal(m.release({x:450,y:250}).flying,undefined);
});
test('drag and flight cross adjacent monitor seams in negative DIP coordinates, not gaps',()=>{
  const {motion:m,at}=rig();m.begin({x:250,y:250});at(20);m.move({x:-20,y:250});assert.equal(m.bounds.x,-70);m.release({x:-20,y:250});at(36);m.tick();assert.ok(m.bounds.x<-70);assert.ok(m.velocity.x<0);
  m.displays=()=>[{x:-1920,y:0,width:1800,height:1080},{x:0,y:0,width:1920,height:1080}];m.recover({x:-80,y:200,width:270,height:280});assert.ok(m.bounds.x===0||m.bounds.x<=-390);
});

test('vertical seams are traversable for a complete body, while vertical gaps remain walls',()=>{
 let now=0;const displays=[{x:0,y:-1080,width:1920,height:1080},{x:0,y:0,width:1920,height:1080}];
 const motion=new PetMotion({now:()=>now,bounds:{x:400,y:0,width:270,height:280},displays:()=>displays});
 motion.mode='flying';motion.velocity={x:0,y:-1000};now=16;motion.tick();assert.ok(motion.bounds.y<0);assert.ok(motion.velocity.y<0);assert.equal(motion.allowed(motion.bounds.x,motion.bounds.y),true);
 motion.stop();motion.recover({x:400,y:30,width:270,height:280});motion.begin({x:450,y:80});now=40;motion.move({x:450,y:-40});assert.equal(motion.bounds.y,-90);
 displays[0]={x:0,y:-1180,width:1920,height:1080};motion.recover({x:400,y:0,width:270,height:280});motion.mode='flying';motion.velocity={x:0,y:-1000};now=56;motion.tick();assert.ok(motion.bounds.y>=0);assert.ok(motion.velocity.y>0);
});

test('offset adjacent displays allow their shared corridor but not uncovered corner space',()=>{
 let now=0;const motion=new PetMotion({now:()=>now,bounds:{x:700,y:450,width:270,height:280},displays:()=>[{x:0,y:0,width:1000,height:1000},{x:1000,y:400,width:1000,height:1000}]});
 motion.begin({x:750,y:500});now=20;motion.move({x:1000,y:500});assert.equal(motion.bounds.x,950);assert.equal(motion.allowed(950,450),true);
 motion.cancel();motion.recover({x:700,y:100,width:270,height:280});motion.begin({x:750,y:150});now=40;motion.move({x:1050,y:150});assert.equal(motion.bounds.x,730);assert.equal(motion.allowed(motion.bounds.x,motion.bounds.y),true);
});

test('large drag and flight steps cannot tunnel across an interior display-union hole',()=>{
 let now=0;const areas=[{x:0,y:0,width:1000,height:100},{x:0,y:100,width:100,height:300},{x:900,y:100,width:100,height:300},{x:0,y:400,width:1000,height:100}];
 const motion=new PetMotion({now:()=>now,bounds:{x:10,y:200,width:50,height:50},displays:()=>areas});
 assert.equal(motion.allowed(925,200),true);assert.equal(motion.allowed(450,200),false);
 motion.begin({x:20,y:210});now=20;motion.move({x:950,y:210});assert.equal(motion.bounds.x,50);
 motion.cancel();motion.recover({x:10,y:200,width:50,height:50});motion.mode='flying';motion.velocity={x:900000,y:0};now=36;motion.tick();assert.ok(motion.bounds.x<=50);assert.equal(motion.allowed(motion.bounds.x,motion.bounds.y),true);
});

test('sleep and wake phases accumulate the old speed before changing rates; inactivity stays wall-clock based',()=>{
 let now=0;const clock=new PetActivityClock({now:()=>now,durations:{enter:4000,wake:4000}});
 now=300000;assert.equal(clock.tick().phase,'sleep-enter');now=302000;assert.equal(clock.tick().animationElapsedMs,2000);
 clock.configure({speed:.25});let snapshot=clock.tick();assert.equal(snapshot.animationElapsedMs,2000);assert.equal(snapshot.snapshotSpeed,.25);
 assert.equal(interactionPresentation({...snapshot,at:now},{now,speed:1,hasClip:()=>true,cycle:()=>4000}).elapsed,2000);
 now=309999;assert.equal(clock.tick().phase,'sleep-enter');now=310000;assert.equal(clock.tick().phase,'asleep');
 clock.configure({speed:1});clock.wake('touch');now=312000;clock.configure({speed:.25});assert.equal(clock.tick().animationElapsedMs,2000);
 now=319999;assert.equal(clock.tick().phase,'waking');now=320000;assert.equal(clock.tick().phase,'awake');
 now=619999;assert.equal(clock.tick().phase,'awake');now=620000;assert.equal(clock.tick().phase,'sleep-enter');
});

test('renderer extrapolates at snapshotSpeed instead of retroactively applying the newest preference',()=>{
 const value={phase:'waking',at:2000,animationElapsedMs:2000,snapshotSpeed:1,motion:{mode:'rest'}};
 const before=interactionPresentation(value,{now:2100,speed:.25,hasClip:()=>true,cycle:()=>4000});assert.equal(before.elapsed,2100);
 const next={...value,at:2100,animationElapsedMs:2100,snapshotSpeed:.25};assert.equal(interactionPresentation(next,{now:2100,speed:.25,hasClip:()=>true,cycle:()=>4000}).elapsed,2100);
 assert.equal(interactionPresentation(next,{now:2200,speed:.25,hasClip:()=>true,cycle:()=>4000}).elapsed,2125);
});

test('landing and airborne animation preserve their accumulated phase while physical speed remains unchanged',()=>{
 let now=0;const motion=new PetMotion({now:()=>now,bounds:{x:200,y:200,width:270,height:280},displays:()=>[{x:0,y:0,width:1920,height:1080}]});
 motion.setMode('landing');now=2000;motion.configure({speed:.25,landDurationMs:4000});assert.equal(motion.state().animationElapsedMs,2000);now=9999;assert.equal(motion.tick().mode,'landing');now=10000;assert.equal(motion.tick().mode,'rest');
 motion.setMode('flying');motion.velocity={x:123,y:-456};now=11000;motion.configure({speed:1});assert.deepEqual(motion.velocity,{x:123,y:-456});assert.equal(motion.state().animationElapsedMs,250);
 const snapshot={phase:'awake',at:now,motion:{...motion.state(),elapsedMs:1000}};
 assert.equal(interactionPresentation(snapshot,{now,speed:1,hasClip:()=>true,cycle:()=>4000}).elapsed,250);
});

test('fixed transparent padding does not become a floating floor; the real feet reach the work area edge',()=>{
 let now=0;const bottom=58.583333333333314,area={x:0,y:0,width:1920,height:1080};
 const motion=new PetMotion({now:()=>now,bounds:{x:200,y:500,width:338,height:350},collisionInsets:{left:45,top:60,right:45,bottom},displays:()=>[area]});
 motion.mode='flying';motion.velocity={x:0,y:100};for(let time=16;time<60000&&motion.mode!=='rest';time+=16){now=time;motion.tick();}
 assert.equal(motion.mode,'rest');const body=motion.collisionRect();assert.ok(Math.abs(body.y+body.height-1080)<1e-6);assert.ok(Math.abs(motion.bounds.y-(1080-350+bottom))<1e-6);
 assert.equal(motion.bounds.width,338);assert.equal(motion.bounds.height,350);assert.ok(motion.bounds.y+motion.bounds.height>1080);
 assert.ok(Math.abs(motion.limits().maxY-motion.bounds.y)<1e-6);
});

test('fixed insets permit transparent window overlap at horizontal and vertical seams, with holes still blocked',()=>{
 let now=0;const displays=[{x:-1000,y:0,width:1000,height:1000},{x:0,y:0,width:1000,height:1000},{x:0,y:-1000,width:1000,height:1000}];
 const motion=new PetMotion({now:()=>now,bounds:{x:200,y:0,width:270,height:280},collisionInsets:{left:30,top:20,right:40,bottom:60},displays:()=>displays});
 motion.begin({x:250,y:50});now=20;motion.move({x:250,y:-100});assert.equal(motion.bounds.y,-150);assert.equal(motion.allowed(200,-150),true);
 motion.cancel();motion.recover({x:0,y:200,width:270,height:280});motion.begin({x:50,y:250});now=40;motion.move({x:-150,y:250});assert.equal(motion.bounds.x,-200);assert.equal(motion.allowed(-200,200),true);
 displays.splice(0,displays.length,{x:0,y:0,width:1000,height:1000},{x:1100,y:0,width:1000,height:1000});motion.recover({x:700,y:200,width:270,height:280});motion.begin({x:750,y:250});now=60;motion.move({x:1350,y:250});assert.equal(motion.bounds.x,770);assert.equal(motion.collisionRect().x+motion.collisionRect().width,1000);
});

test('configure and recovery use the same fixed collision body and reject inverted padding',()=>{
 const motion=new PetMotion({bounds:{x:700,y:800,width:270,height:280},displays:()=>[{x:0,y:0,width:1000,height:1000}]});
 motion.configure({collisionInsets:{left:30,top:20,right:40,bottom:60}});motion.recover({x:4000,y:4000,width:270,height:280});
 assert.equal(motion.bounds.x,770);assert.equal(motion.bounds.y,780);assert.deepEqual(motion.state().collisionInsets,{left:30,top:20,right:40,bottom:60});assert.equal(motion.allowed(770,780),true);
 assert.throws(()=>motion.configure({collisionInsets:{left:200,right:100}}),/Invalid fixed collision insets/);assert.throws(()=>motion.configure({collisionInsets:{bottom:-1}}),/Invalid fixed collision insets/);
});
