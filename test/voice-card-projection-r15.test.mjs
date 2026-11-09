import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCardGameService} from '../src/voice-games/game-service.mjs';
import {createNativeVoiceGamesFacade} from '../src/voice-games/native-facade.mjs';
import {CONTRACT_HASH,CONTRACT_VERSION} from '../src/voice-games/contract.mjs';

function fixture(t,{admission=()=>new Promise(()=>{}),presentation=()=>({available:true,records:[]})}={}){
 const player={id:'ai',kind:'ai',characterId:'whale',personaId:'persona',lifeId:'life',operationId:'operation'};
 const row={id:'table',type:'texas',status:'active',version:1,hand:1,players:[{id:'user',kind:'user',personaId:'persona'},player],history:[],
  state:{type:'texas',phase:'preflop',handId:'hand',actorId:'user',hands:{ai:['SECRET-HIDDEN-HAND']},players:[]},
  presentation:{events:[],emotions:{},lastSpeech:null},chat:[{id:'input:reply',role:'assistant',characterId:'whale',text:'public reply'}]};
 let personaId='persona',lifeId='life',denyHeavy=false,checked=0;const admitted=[];
 const heavy=()=>{if(denyHeavy)throw Error('voiceOnly must not copy/project/flush the full game');};
 const economy={registerRules(){},recover(){},table(id){if(id!==row.id)throw Error('unknown table');return row;},request(id){if(id==='input:reply')return {state:'completed',result:{text:'public reply'}};return null;},
  chat(){return {inputAccepted:true};},appendChat(message){if(!row.chat.some(item=>item.id===message.id))row.chat.push({role:'assistant',...message});},
  project(){heavy();return {type:'texas',phase:'preflop',handId:'hand',players:[{id:'user',kind:'user'},{id:'ai',kind:'ai'}],board:[],ownHand:[]};},account(){heavy();return {};},relationshipProgress(){heavy();return {};},pendingRelationshipFacts(){heavy();return [];},outbox(){heavy();return [];},list(){heavy();return [row];},commandReceipt(){return null;}};
 const game={gameEconomy:economy,context:()=>({personaId,characterId:'whale'}),pluginScope:()=>({...player,lifeId}),viewState:()=>({characters:[{id:'whale',name:'Whale'}]}),gameContext(){throw Error('No model context or request is allowed');}};
 const service=createCardGameService({getGame:()=>game,getProvider(){throw Error('No model calls are allowed');},onCommittedSpeech:fact=>{admitted.push(fact);return admission(fact);},onSpeechPresentation:presentation});
 service.registerRuleArtifact({module:{RULE_MANIFEST:{},STANDARD_DECK:{}},sha256:'a'.repeat(64)});
 t.after(async()=>{denyHeavy=false;await service.close();});
 const checks={async check(){checked++;},checkSync(){checked++;}};
 return {service,row,admitted,checks,get checked(){return checked;},denyHeavy(){denyHeavy=true;},persona(value){personaId=value;},life(value){lifeId=value;}};
}
const voiceRead={tableId:'table',handId:'hand',voiceOnly:true};

test('R15 committed chat send/read keep a synchronous pending-admission placeholder until the host can correlate audio',async t=>{
 let settle;const deferred=new Promise(resolve=>{settle=resolve;});
 const f=fixture(t,{admission:()=>deferred});
 const sent=await f.service.invoke('games.chat.send',{tableId:'table',submissionId:'input',text:'persisted input'},f.checks);
 const record=sent.presentation.voice.records[0];assert.equal(record.eventId,'input:reply');assert.equal(record.state,'waiting');
 assert.equal(f.admitted[0].deadlineAt,record.deadlineAt);assert.ok(record.deadlineAt>Date.now());
 assert.equal((await f.service.invoke('games.chat.read',{tableId:'table'},f.checks)).presentation.voice.records[0].state,'waiting');
 assert.equal((await f.service.invoke('games.table.read',voiceRead,f.checks)).presentation.voice.records[0].state,'waiting');
 settle({accepted:false,reason:'queue-full'});await delay(0);
 assert.equal((await f.service.invoke('games.table.read',voiceRead,f.checks)).presentation.voice.records[0].state,'fallback');
 await f.service.invoke('games.chat.send',{tableId:'table',submissionId:'input',text:'persisted input'},f.checks);
 assert.equal(f.admitted.filter(row=>row.eventId==='input:reply').length,1,'re-read must not re-admit or resubmit the line');
});

test('R15 disabled voice and admission exceptions immediately expose fallback; records reveal no speech or private identity',async t=>{
 for(const scenario of ['disabled','rejected'])await t.test(scenario,async t=>{
  const f=fixture(t,scenario==='disabled'?{presentation:()=>({available:false,records:[]})}:{admission:()=>Promise.reject(Error('Synthetic reject'))});
  const sent=await f.service.invoke('games.chat.send',{tableId:'table',submissionId:'input',text:'persisted input'});
  await delay(0);const value=await f.service.invoke('games.table.read',voiceRead);
  assert.equal(value.presentation.voice.records[0].state,'fallback');
  assert.deepEqual(Object.keys(value.presentation.voice.records[0]).sort(),['deadlineAt','eventId','state']);
  const serialized=JSON.stringify(value);for(const hidden of ['SECRET-HIDDEN-HAND','public reply','personaId','lifeId','operationId','credential'])assert.equal(serialized.includes(hidden),false);
  if(scenario==='disabled')assert.equal(sent.presentation.voice.records[0].state,'fallback');
 });
});

test('R15 the 50 ms metadata read never builds full game/chat state or flushes other tasks, and retains current identity guards',async t=>{
 const f=fixture(t);f.denyHeavy();
 Object.defineProperty(f.row,'chat',{configurable:true,get(){throw Error('voiceOnly must not read or copy chat');}});
 Object.defineProperty(f.row,'presentation',{configurable:true,get(){throw Error('voiceOnly must not read/copy game presentation');}});
 const value=await f.service.invoke('games.table.read',voiceRead,f.checks);
 assert.deepEqual(value,{tableId:'table',handId:'hand',presentation:{voice:{version:1,tableId:'table',handId:'hand',records:[]}}});
 assert.ok(f.checked>=3);
 f.persona('other-persona');await assert.rejects(f.service.invoke('games.table.read',voiceRead),{code:'GAME_PERSONA_DENIED'});
 f.persona('persona');f.life('new-life');await assert.rejects(f.service.invoke('games.table.read',voiceRead),{code:'GAME_LIFE_CHANGED'});
 f.life('life');await assert.rejects(f.service.invoke('games.table.read',{...voiceRead,handId:'old-hand'}),{code:'GAME_CHAT_HAND_CHANGED'});
 // Restore only the fixture's getters for the ordinary close/lifecycle path.
 delete f.row.chat;delete f.row.presentation;
});

test('R15 voiceOnly stays behind the existing native session and principal authorization',async t=>{
 const f=fixture(t),identity={packageName:'@ai-buddy/card-games',pluginId:'cards',sourceDigest:'b'.repeat(64),exactVersion:'1'},origin={runtimeId:'runtime',profileId:'profile',pid:123};
 const root=await mkdtemp(join(tmpdir(),'r15-facade-'));
 const facade=createNativeVoiceGamesFacade({dataRoot:root,games:f.service,resolveGrant:()=>({enabled:true,sourceDigest:identity.sourceDigest,exactVersion:'1',generation:1,granted:['games.table'],declared:['games.table']}),authorizeUI:async()=>true});
 t.after(async()=>{await facade.close();await rm(root,{recursive:true,force:true});});
 // Forged/absent session and principal fail before this feature reaches games.
 await assert.rejects(facade.dispatch({sessionToken:'forged',method:'games.table.read',payload:voiceRead},origin),{code:'VOICE_GAMES_RUNTIME_DENIED'});
 const opened=await facade.open({identity,origin,contractHash:CONTRACT_HASH,contractVersion:CONTRACT_VERSION});
 await assert.rejects(facade.dispatch({sessionToken:opened.sessionToken,method:'games.table.read',payload:voiceRead},origin),{code:'VOICE_GAMES_PRINCIPAL_REQUIRED'});
 const principal=await facade.dispatch({sessionToken:opened.sessionToken,method:'ui.authorize',payload:{request:{method:'POST'},action:'games.table.read'}},origin);
 const value=await facade.dispatch({sessionToken:opened.sessionToken,method:'games.table.read',payload:{...voiceRead,principal}},origin);
 assert.equal(value.tableId,'table');assert.equal(value.presentation.voice.records.length,0);
 f.persona('changed-persona');await assert.rejects(facade.dispatch({sessionToken:opened.sessionToken,method:'games.table.read',payload:{...voiceRead,principal}},origin),{code:'VOICE_GAMES_PRINCIPAL_REQUIRED'});
});
