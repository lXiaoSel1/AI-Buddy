import test from 'node:test';
import assert from 'node:assert/strict';
import {committedCardSpeechFacts,committedTableChatFact} from '../src/voice/card-speech-facts.mjs';
const table=()=>({id:'table',version:3,status:'active',state:{type:'texas',handId:'hand',hands:{a:[50,51]},history:[]},players:[{id:'user',kind:'user',personaId:'p'},{id:'a',kind:'ai',characterId:'deepseek',personaId:'p',lifeId:'life-a',operationId:'op-a'},{id:'b',kind:'ai',characterId:'kimi',personaId:'p',lifeId:'life-b',operationId:'op-b'}],presentation:{events:[],lastSpeech:null}});
test('committed All-in and showdown facts bind the actual AI and never expose private hands',()=>{
  const value=table();value.presentation={events:[{id:'event',kind:'allin',actorId:'b',cards:[1,2,3]}],lastSpeech:{id:'say',actorId:'b',characterId:'kimi',text:'All in!'}};
  const facts=committedCardSpeechFacts(value,{type:'all-in',actorId:'b'});
  assert.equal(facts.length,2);assert.equal(facts[1].scope.characterId,'kimi');assert.equal(facts[1].scope.lifeId,'life-b');
  assert.equal(JSON.stringify(facts).includes('cards'),false);assert.equal(JSON.stringify(facts).includes('hands'),false);
  value.presentation.events=[{id:'trips',kind:'trips',actorId:'a'}];value.presentation.lastSpeech=null;
  assert.equal(committedCardSpeechFacts(value,{type:'call',actorId:'a'})[1].kind,'trips');
});
test('only a committed public triple is announced; lifecycle checks do not replay old calls',()=>{
  const value=table();value.state.type='doudizhu';value.state.history=[{type:'play',actorId:'b',pattern:'triple',cards:[1,2,3]}];
  assert.equal(committedCardSpeechFacts(value,{type:'play',actorId:'b'})[1].kind,'triple');
  assert.equal(committedCardSpeechFacts(value,null).length,1);
  value.state.history[0].actorId='user';assert.equal(committedCardSpeechFacts(value,{type:'play',actorId:'user'}).length,1);value.state.history[0].actorId='b';
  value.state.history[0].pattern='pair';assert.equal(committedCardSpeechFacts(value,{type:'play',actorId:'b'}).length,1);
});
test('table chat uses the persisted reply identity and does not generate new model text',()=>{
  const value=table(),fact=committedTableChatFact(value,value.players[2],{id:'reply-id',text:'刚才你打得不错。'});
  assert.equal(fact.eventId,'reply-id');assert.equal(fact.text,'刚才你打得不错。');assert.equal(fact.scope.characterId,'kimi');
  assert.equal(committedTableChatFact(value,value.players[0],{id:'user',text:'不要念我这句'}),null);
});
