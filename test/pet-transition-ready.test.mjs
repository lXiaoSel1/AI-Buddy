import test from 'node:test';
import assert from 'node:assert/strict';
import * as transitions from '../src/pet-interaction-view.mjs';

const asleepTransition=(phase='waking',mode='rest')=>({characterId:'deepseek',phase,animationWaiting:true,animationEpoch:4,motion:{mode,button:0}});
const ack=patch=>({characterId:'deepseek',scope:'sleep',epoch:4,id:'wake',...patch});

test('a wake transition keeps its ready identity while a light press is held',()=>{
 for(const mode of ['rest','pressed'])assert.deepEqual(transitions.expectedInteractionTransition(asleepTransition('waking',mode)),{id:'wake',scope:'sleep',epoch:4});
 assert.deepEqual(transitions.expectedInteractionTransition(asleepTransition('sleep-enter','pressed')),{id:'sleep-enter',scope:'sleep',epoch:4});
});
test('real dragging or charging cannot acknowledge a sleep transition hidden behind a physical pose',()=>{
 for(const mode of ['dragging','charging']){
  const state=asleepTransition('waking',mode);
  assert.equal(transitions.expectedInteractionTransition(state),null);
  assert.equal(transitions.matchesInteractionReady(state,ack()),false);
 }
});
test('only matching action, scope, epoch and character can release the first-frame barrier',()=>{
 const state=asleepTransition();
 assert.equal(transitions.matchesInteractionReady(state,ack()),true);
 for(const patch of [{id:'idle'},{id:'sleep-loop'},{scope:'motion'},{scope:'unknown'},{epoch:3},{epoch:'4'},{characterId:'claude'}]){
  assert.equal(transitions.matchesInteractionReady(state,ack(patch)),false,JSON.stringify(patch));
  assert.equal(transitions.matchesInteractionReady(state,ack({...patch,failed:true})),false,'late failure '+JSON.stringify(patch));
 }
});
test('a repeated ready is ignored after its barrier has already been consumed',()=>{
 const state={...asleepTransition(),animationWaiting:false};
 assert.equal(transitions.expectedInteractionTransition(state),null);
 assert.equal(transitions.matchesInteractionReady(state,ack()),false);
 assert.equal(transitions.expectedInteractionTransition(null),null);
});
test('flight and landing use their physical epoch and action rather than the sleeping clock',()=>{
 for(const [mode,id] of [['flying','throw-loop'],['landing','land-recover']]){
  const state={...asleepTransition(),motion:{mode,animationWaiting:true,animationEpoch:12}};
  assert.deepEqual(transitions.expectedInteractionTransition(state),{id,scope:'motion',epoch:12});
  assert.equal(transitions.matchesInteractionReady(state,ack({scope:'motion',epoch:12,id})),true);
  assert.equal(transitions.matchesInteractionReady(state,ack()),false);
 }
});
test('idle, sleeping loops and malformed state cannot arm a transition-ready barrier',()=>{
 for(const phase of ['awake','asleep','invalid'])assert.equal(transitions.expectedInteractionTransition(asleepTransition(phase)),null);
 assert.equal(transitions.expectedInteractionTransition({...asleepTransition(),animationEpoch:NaN}),null);
 assert.equal(transitions.matchesInteractionReady(asleepTransition(),null),false);
});
