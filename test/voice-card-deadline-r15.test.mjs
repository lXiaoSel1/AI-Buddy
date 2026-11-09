import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createCardSpeech} from '../src/voice/card-speech.mjs';
import {createCardSpeechDisplayGate} from '../../repair-suite-r3/cards-source/plugins/card-games/src/client/speech-display.mjs';
const scope={channel:'card-table',tableId:'table',handId:'hand',characterId:'whale',personaId:'persona',lifeId:'life',operationId:'operation'};
async function until(check){for(let i=0;i<160;i++){if(check())return;await delay(3);}throw Error('R15 deadline seam did not settle');}
function voice(runtime){return {runtime,engine:'breeze',speechProvider:'local',packageId:'breeze',profileId:'voice',profileVersion:1};}

test('R15 a timed-out unstarted event drops late PCM, preserves evidence and allows the next line',async t=>{
 const events=[],spoken=[];let release,cancelled=0;
 const held=new Promise(resolve=>{release=resolve;});
 const runtime={async *speak({text}){spoken.push(text);if(text==='cold')await held;yield {type:'pcm',pcm:new Uint8Array([0,0,1,0]),sampleRate:24000};},async cancelCurrent(){cancelled++;release();},async stopEngine(){release();}};
 const cards=createCardSpeech({isScopeValid:()=>true,resolveVoice:async()=>voice(runtime),emit:event=>events.push(event)});t.after(()=>cards.close());
 await cards.accept({eventId:'cold',kind:'lastSpeech',text:'cold',scope,deadlineAt:Date.now()+35});
 await cards.accept({eventId:'next',kind:'lastSpeech',text:'next',scope,deadlineAt:Date.now()+120});
 await until(()=>events.some(row=>row.type==='audio'&&row.phase==='end'&&row.envelope.messageId==='next'));
 assert.equal(cancelled,1);assert.deepEqual(spoken,['cold','next']);
 assert.equal(events.some(row=>row.phase==='pcm'&&row.envelope.messageId==='cold'),false,'late synthesis must not become playback');
 const old=cards.presentation({tableId:'table',handId:'hand',eventIds:['cold']}).records[0];assert.equal(old.state,'fallback');
 assert.equal((await cards.accept({eventId:'cold',kind:'lastSpeech',text:'cold',scope})).duplicate,true,'timeout must not replay on retries');
 const next=events.find(row=>row.type==='audio'&&row.envelope.messageId==='next').envelope;
 assert.equal((await cards.receipt({envelope:next,status:'audioStarted'})).accepted,true);
 await delay(130);assert.equal(cancelled,1,'deadline must not cancel a line that already started');
 assert.equal(cards.presentation({tableId:'table',handId:'hand',eventIds:['next']}).records[0].state,'display');
 assert.equal((await cards.receipt({envelope:next,status:'audioCompleted'})).accepted,true);
});

test('R15 queued timeout and a forged audioStarted cannot cancel or acknowledge the playing line',async t=>{
 const events=[];let cancelled=0;
 const runtime={async *speak(){yield {type:'pcm',pcm:new Uint8Array([0,0]),sampleRate:24000};},async cancelCurrent(){cancelled++;},async stopEngine(){}};
 const cards=createCardSpeech({isScopeValid:()=>true,resolveVoice:async()=>voice(runtime),emit:event=>events.push(event)});t.after(()=>cards.close());
 await cards.accept({eventId:'playing',kind:'allin',scope,deadlineAt:Date.now()+70});
 await until(()=>events.some(row=>row.phase==='end'));
 const envelope=events.find(row=>row.type==='audio').envelope;
 assert.equal((await cards.receipt({envelope:{...envelope,lifeId:'forged'},status:'audioStarted'})).accepted,false);
 assert.equal((await cards.receipt({envelope,status:'audioStarted'})).accepted,true);
 await cards.accept({eventId:'queued',kind:'trips',scope,deadlineAt:Date.now()+25});
 await until(()=>cards.presentation({tableId:'table',handId:'hand',eventIds:['queued']}).records[0].state==='fallback');
 await delay(30);assert.equal(cancelled,0);assert.equal(events.some(row=>row.envelope?.messageId==='queued'&&row.phase==='pcm'),false);
 assert.equal(cards.presentation({tableId:'other',handId:'hand',eventIds:['playing']}).records.length,0);
 assert.equal(cards.presentation({tableId:'table',handId:'other',eventIds:['playing']}).records.length,0);
});

test('R15 the client deadline releases once, remains visible under stale waiting, and scopes by view/table/hand/event',()=>{
 let now=100;const gate=createCardSpeechDisplayGate({now:()=>now});
 const observe=(state='waiting',deadlineAt=150)=>({version:1,tableId:'table',handId:'hand',records:[{eventId:'one',state,deadlineAt}]});
 gate.scope({key:'view1',tableId:'table',handId:'hand'});gate.observe(observe());
 assert.equal(gate.allows('one'),false);assert.equal(gate.allows('banter-without-audio'),true);
 gate.observe({...observe('display'),handId:'old-hand'});assert.equal(gate.allows('one'),false);
 now=151;assert.equal(gate.expire(['one']),true);assert.equal(gate.allows('one'),true);
 gate.observe(observe('waiting',300));assert.equal(gate.allows('one'),true);assert.deepEqual(gate.pending(['one']),[]);
 gate.scope({key:'view2',tableId:'other',handId:'other-hand'});gate.observe(observe());assert.equal(gate.allows('one'),true);assert.equal(gate.current('view1'),false);
});
