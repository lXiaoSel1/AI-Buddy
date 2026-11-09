import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCardGameService} from '../src/voice-games/game-service.mjs';
import {createGameEconomy} from '../src/voice-games/game-economy.mjs';
import * as rules from '../src/voice-games/rules/index.mjs';
async function fixture(t){
 const db=new DatabaseSync(':memory:');let wallet={balance:2000},n=0,requests=0;
 const transaction=fn=>{const id='t'+n++;db.exec('SAVEPOINT '+id);try{const value=fn();db.exec('RELEASE '+id);return value;}catch(error){db.exec('ROLLBACK TO '+id);db.exec('RELEASE '+id);throw error;}};
 const economy=createGameEconomy({db,transaction,wallet:()=>structuredClone(wallet),setWallet:v=>{wallet=v;},ledger:()=>{}});
 const profile={id:'model',kind:'openai',protocol:'openai',baseUrl:'http://model.invalid',keyCiphertext:'before',model:'fixture',enabled:true,capabilities:{chat:true}};
 const game={gameEconomy:economy,context:()=>({personaId:'persona',characterId:'a'}),hasCharacter:id=>['a','b'].includes(id),pluginScope:(characterId,personaId)=>({characterId,personaId,lifeId:'life-'+characterId,operationId:'op-'+characterId}),viewState:()=>({characters:['a','b'].map(id=>({id,name:id}))}),gameContext:async()=>({modelBinding:'model',character:{name:'fixture'}}),recordGameFact:async fact=>({recorded:true,eventId:fact.id})};
 const provider={enabled:true,state:{profiles:[profile]},captureConnection:()=>structuredClone(profile),runCaptured:async(_,fn)=>fn(),async *stream(){requests++;yield {type:'text-delta',text:JSON.stringify({type:'fold',say:'',emotion:'neutral'})};}};
 const service=createCardGameService({getGame:()=>game,getProvider:()=>provider});service.registerRuleArtifact({module:rules,sha256:'d03d283bdf6c748fcfbdcbcf4eca7f959ca29cbe4ebfbf87f3b53a51d94f16e4'});
 t.after(async()=>{await service.close();db.close();});
 let v=await service.invoke('games.table.create',{commandId:'create',type:'texas',players:[{kind:'user'},{kind:'ai',characterId:'a'}],buyIn:200});
 if(v.actorKind==='user')v=await service.invoke('games.table.action',{tableId:v.tableId,commandId:'user-call',expectedVersion:v.version,action:{type:'call'}});
 profile.keyCiphertext='after';
 await assert.rejects(service.invoke('games.model.request',{tableId:v.tableId,expectedVersion:v.version,requestId:'revoked'}),{code:'GAME_BINDING_REVOKED'});
 v=await service.invoke('games.table.read',{tableId:v.tableId});
 return {db,economy,service,profile,view:v,requests:()=>requests};
}
test('explicit rebind continues the same hand while preserving the original binding and receipts',async t=>{
 const f=await fixture(t),v=f.view,old=f.economy.binding(v.projection.handId+':'+v.projection.actorId);
 assert.equal(v.bindingRecovery,true);const input={tableId:v.tableId,expectedVersion:v.version,commandId:'rebind',rebindCurrent:true,confirmed:true};
 const next=await f.service.invoke('games.table.resume',input);assert.equal(next.status,'active');assert.equal(next.hand,v.hand);assert.equal(next.bindingRecovery,false);
 assert.deepEqual(f.economy.binding(old.id),old);assert.equal((await f.service.invoke('games.table.resume',input)).version,next.version);
 const result=await f.service.invoke('games.model.request',{tableId:v.tableId,expectedVersion:next.version,requestId:'new-request'});
 assert.equal(result.status,'completed');assert.equal(f.requests(),1);assert.equal(f.economy.request('revoked:0'),null);
});
test('voiding a revoked hand returns all holds exactly once without settlement or affection',async t=>{
 const f=await fixture(t),v=f.view;assert.ok(f.economy.account('user').held>0);
 const input={tableId:v.tableId,expectedVersion:v.version,commandId:'void',voidHand:true,confirmed:true};
 const done=await f.service.invoke('games.table.leave',input);assert.equal(done.status,'closed');
 assert.equal(f.economy.account('user').balance,2000);assert.equal(f.economy.account('user').held,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM game_settlements').get().n,0);assert.equal(f.economy.outbox().length,0);
 assert.equal((await f.service.invoke('games.table.leave',input)).version,done.version);assert.equal(f.requests(),0);
 await assert.rejects(f.service.invoke('games.table.leave',{...input,voidHand:false}),{code:'GAME_COMMAND_CONFLICT'});
});
test('rebind and void require explicit confirmation and revoked binding',async t=>{
 const f=await fixture(t),v=f.view;
 for(const method of ['games.table.resume','games.table.leave'])await assert.rejects(f.service.invoke(method,{tableId:v.tableId,expectedVersion:v.version,commandId:method,rebindCurrent:true,voidHand:true}),{code:'GAME_RECOVERY_CONFIRMATION_REQUIRED'});
 assert.equal(f.economy.table(v.tableId).version,v.version);assert.ok(f.economy.account('user').held>0);
});
