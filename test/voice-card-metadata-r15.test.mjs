import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createGameEconomy} from '../src/voice-games/game-economy.mjs';
import {createCardGameService} from '../src/voice-games/game-service.mjs';
import * as rules from '../src/voice-games/rules/index.mjs';

test('R15 real SQLite economy polls metadata without decoding large chat, and refreshes identity only on persisted version/status/instance changes',async t=>{
 const database=new DatabaseSync(':memory:');let forbidFull=false,fullReads=0,metadataReads=0,personaId='persona',lifeId='life',operationId='operation';
 const db={exec:sql=>database.exec(sql),prepare(sql){
  if(/^SELECT value FROM game_tables WHERE id=\?$/.test(sql)){fullReads++;if(forbidFull)throw Error('R15 sentinel: attempted to decode the full game table and its unbounded chat');}
  if(/^SELECT id,type,version,status FROM game_tables WHERE id=\?$/.test(sql))metadataReads++;
  return database.prepare(sql);
 }};
 const makeEconomy=()=>createGameEconomy({db,transaction:run=>run(),wallet:()=>({balance:2000}),setWallet(){},ledger(){}});
 const scope={channel:'card-table',tableId:'table',handId:'hand',characterId:'whale',personaId:'persona',lifeId:'life',operationId:'operation'};
 const player={id:'ai',kind:'ai',characterId:'whale',personaId:'persona',lifeId:'life',operationId:'operation'};
 const game={gameEconomy:makeEconomy(),context:()=>({personaId,characterId:'whale'}),pluginScope:()=>({...player,lifeId,operationId})};
 const service=createCardGameService({getGame:()=>game,getProvider(){throw Error('Models are forbidden');},onSpeechPresentation:()=>({available:true,records:[]})});
 service.registerRuleArtifact({module:rules,sha256:'a'.repeat(64)});assert.equal(service.describe().gamesReady,true);
 t.after(async()=>{forbidFull=false;await service.close();database.close();});
 const row={id:'table',type:'texas',version:1,status:'active',players:[{id:'user',kind:'user',personaId:'persona'},player],state:{handId:'hand'},chat:[{id:'large',role:'assistant',text:'R15-LARGE-CHAT-'+ 'x'.repeat(2_000_000)}]};
 database.prepare('INSERT INTO game_tables VALUES(?,?,?,?,?)').run(row.id,row.type,row.version,row.status,JSON.stringify(row));
 assert.equal(service.voiceScopeValid(scope),true);const warmedReads=fullReads;
 const poll=handId=>service.invoke('games.table.read',{tableId:'table',handId,voiceOnly:true});
 forbidFull=true;
 for(let i=0;i<4;i++)assert.equal((await poll('hand')).presentation.voice.handId,'hand');
 assert.equal(fullReads,warmedReads,'steady waiting must not read game_tables.value');assert.ok(metadataReads>=8);
 // Real chat append rewrites a large value at the same version; it does not
 // change players/hand and must not force subsequent polls to decode it again.
 forbidFull=false;game.gameEconomy.appendChat({tableId:'table',id:'another-chat',characterId:'whale',text:'persisted public line'});
 const afterChat=fullReads;forbidFull=true;await poll('hand');assert.equal(fullReads,afterChat);
 personaId='foreign';await assert.rejects(poll('hand'),{code:'GAME_PERSONA_DENIED'});personaId='persona';
 lifeId='new-life';await assert.rejects(poll('hand'),{code:'GAME_LIFE_CHANGED'});lifeId='life';
 operationId='new-operation';await assert.rejects(poll('hand'),{code:'GAME_LIFE_CHANGED'});operationId='operation';
 // A committed new version/hand invalidates the snapshot exactly once.
 forbidFull=false;row.version=2;row.state.handId='next-hand';
 database.prepare('UPDATE game_tables SET version=?,value=? WHERE id=?').run(row.version,JSON.stringify(row),row.id);
 const beforeVersion=fullReads;await assert.rejects(poll('hand'),{code:'GAME_CHAT_HAND_CHANGED'});assert.equal(fullReads,beforeVersion+1);
 forbidFull=true;await poll('next-hand');assert.equal(fullReads,beforeVersion+1);
 // Recovery can change status without incrementing version. It also invalidates.
 forbidFull=false;row.status='paused';database.prepare('UPDATE game_tables SET status=?,value=? WHERE id=?').run(row.status,JSON.stringify(row),row.id);
 const beforeStatus=fullReads;await poll('next-hand');assert.equal(fullReads,beforeStatus+1);
 forbidFull=true;await poll('next-hand');assert.equal(fullReads,beforeStatus+1);
 // A new economy owner cannot reuse an old owner's authorized snapshot even
 // when table id/version/status happen to match.
 forbidFull=false;row.players[0].personaId='foreign';database.prepare('UPDATE game_tables SET value=? WHERE id=?').run(JSON.stringify(row),row.id);
 game.gameEconomy=makeEconomy();await assert.rejects(poll('next-hand'),{code:'GAME_PERSONA_DENIED'});
 console.log('R15 real-economy metadata sentinel',JSON.stringify({largeChatBytes:2_000_000,steadyPolls:4,fullTableReadsDuringSteadyPolls:0,metadataReads}));
});
