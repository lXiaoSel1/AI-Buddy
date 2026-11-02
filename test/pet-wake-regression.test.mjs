import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {PetActivityClock,PetMotion} from '../src/pet-interactions.mjs';
import * as presentation from '../src/pet-interaction-view.mjs';
import {PetTouchExpressions} from '../src/pet-touch.mjs';
import {PetGloveController} from '../src/pet-glove.mjs';
// Real main IPC handlers and state machines; fake window/IPC/clock, no user data.
const main=readFileSync(new URL('../src/main.mjs',import.meta.url),'utf8');
const at=main.indexOf("ipcMain.on('pet:drag-start'"),end=main.indexOf('\nfunction observePetButtons',at);
const ready=main.indexOf("ipcMain.on('pet:animation-ready'"),readyEnd=main.indexOf('\n});',ready)+4;
const cancel=main.indexOf("ipcMain.handle('pet:gesture-cancel'"),cancelEnd=main.indexOf("\nipcMain.handle('pet:context'",cancel);
assert.ok(at>=0&&end>at&&ready>=0&&readyEnd>ready);
function fixture(phase='asleep'){
 let now=0,context,motion,expressionCalls=0;
 const handlers=new Map(),frames=[],events=[],awards=[],audits=[];
 const clock=new PetActivityClock({now:()=>now,requireReady:true,durations:{enter:100,wake:100}});
 const glove=new PetGloveController({now:()=>now,wallNow:()=>10000+now});glove.setContext({characterId:'deepseek',opaque:true});
 const state=()=>({...clock.tick({defer:!!context?.drag}),characterId:'deepseek',motion:motion.state(),at:now});
 const capture=()=>{const value=state(),view=presentation.interactionPresentation(value,{now,hasClip:()=>true,speed:1,cycle:()=>100});frames.push({phase:value.phase,id:view.id,mode:value.motion.mode});return value;};
 motion=new PetMotion({now:()=>now,bounds:{x:100,y:100,width:270,height:280},displays:()=>[{x:0,y:0,width:1920,height:1080}],onState:capture});
 const webContents={},expressions=new PetTouchExpressions({random:()=>0}),next=expressions.next.bind(expressions);expressions.next=id=>{expressionCalls++;return next(id);};
 const petEvent=e=>{events.push(e);if(e.kind==='gesture-reset'){glove.releaseGesture(e.gestureId,{reason:e.reason});glove.setContext({down:false,mode:motion.mode});}if(e.kind==='feedback')glove.touch(e.value);};
 class WallDate extends Date{static now(){return 10000+now;}}
 context=vm.createContext({...presentation,ipcMain:{on:(k,f)=>handlers.set(k,f),handle:(k,f)=>handlers.set(k,f)},pet:{webContents,getContentBounds:()=>({...motion.bounds}),setIgnoreMouseEvents:()=>{}},petMotion:motion,activityClock:clock,drag:null,petState:{characterId:'deepseek'},gesturePoint:m=>({x:m.x,y:m.y}),effectivePetCharacter:()=> 'deepseek',game:{context:()=>({personaId:'isolated'}),touch:async args=>{awards.push(args);return {awarded:true};}},nativeButtons:0,buttonObserver:{start:()=>{},stop:()=>{}},ignoringMouse:false,moveDrag:p=>motion.move(p),publishInteraction:capture,petInteraction:state,audit:e=>audits.push(e),gestureMatches:m=>!!context.drag&&context.drag.gestureId===m.gestureId,arg:()=> 'manual',petEvent,touchExpressions:expressions,setGestureMode:()=>{},gestureMode:null,petContextMenu:()=>{},settings:{preferences:{petScale:1.25}},petBounds:x=>x,saveSettings:async()=>{},Date:WallDate,process:{pid:424242},cancelGesture:reason=>{const id=context.drag?.gestureId;context.drag=null;motion.cancel();petEvent({kind:'gesture-reset',gestureId:id,reason});}});
 vm.runInContext(main.slice(at,end)+'\n'+main.slice(cancel,cancelEnd)+'\n'+main.slice(ready,readyEnd),context);
 if(phase!=='awake'){clock.sleepNow();if(phase!=='sleep-enter'){clock.markReady(clock.animationEpoch);now+=100;clock.tick();}if(phase==='waking')clock.wake('token');}
 const event={sender:webContents};
 return {clock,motion,glove,frames,events,awards,audits,context,expressionCalls:()=>expressionCalls,touches:()=>events.filter(x=>x.kind==='feedback'&&x.value?.source==='touch').map(x=>x.value),begin(id='g1',button=0){glove.beginGesture(id,{characterId:'deepseek',startedAt:10000+now});handlers.get('pet:drag-start')(event,{gestureId:id,button,x:150,y:150});},end(id='g1',button=0){return handlers.get('pet:drag-end')(event,{gestureId:id,button});},ready(extra={}){handlers.get('pet:animation-ready')(event,{characterId:'deepseek',scope:'sleep',epoch:clock.animationEpoch,id:'wake',...extra});},advance(ms){now+=ms;return capture();},move(x,y,id='g1'){handlers.get('pet:drag-move')(event,{gestureId:id,x,y});},cancel(id='g1'){return handlers.get('pet:gesture-cancel')(event,{gestureId:id,reason:'cancelled'});}};
}
test('sleeping press never publishes unrelated idle before wake',()=>{const f=fixture();f.begin();assert.equal(f.frames.some(x=>x.id==='idle'),false,JSON.stringify(f.frames));assert.equal(f.clock.phase,'waking');});
test('confirmed wake touch retains poke and reward without choosing a random expression',async()=>{const f=fixture();f.begin();await f.end();assert.equal(f.expressionCalls(),0);assert.equal(f.touches().length,1);assert.equal(f.touches()[0].playExpression,false);assert.equal(f.awards.length,1);assert.equal(f.glove.sample().pokeCount,1);});
test('idle ready cannot start wake clock',()=>{const f=fixture();f.begin();f.ready({id:'idle'});assert.equal(f.clock.animationWaiting,true);f.advance(1000);assert.equal(f.clock.phase,'waking');});

for(const phase of ['sleep-enter','waking'])test(`${phase} press keeps wake presentation and suppresses click expression`,async()=>{
 const f=fixture(phase);f.begin();
 assert.equal(f.frames.some(x=>x.id==='idle'),false,JSON.stringify(f.frames));
 assert.equal(f.clock.phase,'waking');assert.equal(f.clock.animationWaiting,true);
 const result=await f.end();assert.equal(result.wakeOnly,true);assert.equal(f.expressionCalls(),0);
 assert.equal(f.touches()[0].playExpression,false);assert.equal(f.awards.length,1);assert.equal(f.glove.sample().pokeCount,1);
});

test('holding a wake gesture until awake does not reclassify release as an ordinary expression',async()=>{
 const f=fixture();f.begin();f.ready();assert.equal(f.clock.animationWaiting,false);
 f.advance(101);assert.equal(f.clock.phase,'awake');const result=await f.end();
 assert.equal(result.wakeOnly,true);assert.equal(f.expressionCalls(),0);assert.equal(f.touches()[0].playExpression,false);
 assert.equal(f.glove.sample().pokeCount,1);assert.equal(f.awards.length,1);
});

test('a new click after wake completion still selects an ordinary expression',async()=>{
 const f=fixture();f.begin();await f.end();f.ready();f.advance(101);
 f.begin('g2');const result=await f.end('g2');
 assert.notEqual(result.wakeOnly,true);assert.equal(f.expressionCalls(),1);
 assert.match(f.touches()[1].id,/^emotion-/);assert.notEqual(f.touches()[1].playExpression,false);
 assert.equal(f.glove.sample().pokeCount,2);assert.equal(f.awards.length,2);
});

test('repeated release and stale gesture messages do not duplicate touch or reward',async()=>{
 const f=fixture();f.begin();await f.end();
 const duplicate=await f.end(),stale=await f.end('stale');
 assert.equal(duplicate.ignored,true);assert.equal(stale.ignored,true);
 assert.equal(f.touches().length,1);assert.equal(f.awards.length,1);assert.equal(f.glove.sample().pokeCount,1);
});

test('two release paths racing before reward persistence completes still submit one touch',async()=>{
 const f=fixture();f.begin();const first=f.end(),second=f.end();
 const [accepted,ignored]=await Promise.all([first,second]);
 assert.equal(accepted.touch,true);assert.equal(ignored.ignored,true);
 assert.equal(f.touches().length,1);assert.equal(f.awards.length,1);assert.equal(f.glove.sample().pokeCount,1);
});

for(const[name,extra]of[
 ['scope',{scope:'unknown'}],['epoch',{epoch:-1}],['character',{characterId:'claude'}],
 ['failed action',{id:'idle',failed:true}],['failed scope',{scope:'unknown',failed:true}],
 ['failed epoch',{epoch:-1,failed:true}],['failed character',{characterId:'claude',failed:true}],
])test(`wrong ${name} ready does not start wake timing or resume to idle`,()=>{
 const f=fixture();f.begin();const epoch=f.clock.animationEpoch;f.ready(extra);
 assert.equal(f.clock.animationEpoch,epoch);assert.equal(f.clock.phase,'waking');assert.equal(f.clock.animationWaiting,true);
 f.advance(1000);assert.equal(f.clock.phase,'waking');assert.equal(f.clock.animationWaiting,true);
});

test('matching wake ready starts once and requires one complete cycle after readiness',async()=>{
 const f=fixture();f.begin();await f.end();f.advance(1000);assert.equal(f.clock.phase,'waking');
 const epoch=f.clock.animationEpoch;f.ready();assert.equal(f.clock.animationWaiting,false);
 f.advance(99);assert.equal(f.clock.phase,'waking');f.ready();assert.equal(f.clock.animationEpoch,epoch);
 f.advance(1);assert.equal(f.clock.phase,'awake');
});

test('valid wake media failure ends waiting, but its late repeat cannot reset a later awake state',()=>{
 const f=fixture();f.begin();const failedEpoch=f.clock.animationEpoch;f.ready({failed:true});
 assert.equal(f.clock.phase,'awake');const epoch=f.clock.animationEpoch;
 f.ready({epoch:failedEpoch,failed:true});assert.equal(f.clock.animationEpoch,epoch);assert.equal(f.clock.phase,'awake');
});

test('rapid wake taps keep the same animation epoch and no random expressions',async()=>{
 const f=fixture();f.begin();await f.end();const epoch=f.clock.animationEpoch;
 for(let n=2;n<=5;n++){f.begin('g'+n);await f.end('g'+n);assert.equal(f.clock.animationEpoch,epoch);}
 assert.equal(f.expressionCalls(),0);assert.equal(f.touches().length,5);assert.equal(f.glove.sample().pokeCount,5);
 assert.equal(f.touches().every(x=>x.playExpression===false),true);assert.equal(new Set(f.awards.map(x=>x.eventId)).size,5);
});

test('moving a sleeping left gesture uses walking without a touch reward or poke',async()=>{
 const f=fixture();f.begin();f.move(170,150);assert.equal(f.motion.mode,'dragging');
 assert.equal(f.frames.at(-1).id,'move-right');const result=await f.end();
 assert.equal(result.touch,false);assert.equal(f.touches().length,0);assert.equal(f.awards.length,0);assert.equal(f.glove.sample().pokeCount,0);
});

test('cancelled sleeping gestures cannot later release into a touch',async()=>{
 const f=fixture();f.begin();assert.equal(f.cancel(),true);const result=await f.end();
 assert.equal(result.ignored,true);assert.equal(f.touches().length,0);assert.equal(f.awards.length,0);assert.equal(f.glove.sample().pokeCount,0);
});

test('a sleeping right tap wakes without left-touch feedback, reward, poke or menu',async()=>{
 const f=fixture();f.begin('right',2);const result=await f.end('right',2);
 assert.equal(result.wakeOnly,true);assert.equal(result.context,false);assert.equal(f.touches().length,0);assert.equal(f.awards.length,0);assert.equal(f.glove.sample().pokeCount,0);
});

test('a quick sleeping right drag still flies and never becomes a rewarded wake tap',async()=>{
 const f=fixture();f.begin('throw',2);f.advance(20);f.move(250,150,'throw');
 f.advance(20);f.move(350,150,'throw');const result=await f.end('throw',2);
 assert.equal(result.flying,true);assert.equal(f.motion.mode,'flying');
 assert.equal(result.touch,false);assert.equal(f.touches().length,0);assert.equal(f.awards.length,0);assert.equal(f.glove.sample().pokeCount,0);
});

test('a sleeping right-owned slingshot still fires on left release without a wake reward',async()=>{
 const f=fixture();f.begin('sling',2);f.advance(20);f.move(180,150,'sling');
 assert.equal(f.motion.right({x:180,y:150}),true);f.move(400,300,'sling');
 const result=await f.end('sling',0);assert.equal(result.slingshot,true);assert.equal(result.flying,true);
 assert.equal(f.motion.mode,'flying');assert.equal(result.touch,false);assert.equal(f.touches().length,0);assert.equal(f.awards.length,0);
});

test('reduced-motion wake taps retain brief contact feedback without a character expression',async()=>{
 const f=fixture();f.glove.setContext({reducedMotion:true});f.begin();await f.end();
 assert.equal(f.expressionCalls(),0);assert.equal(f.glove.sample().frame,3);f.advance(80);assert.equal(f.glove.sample().active,false);
});
