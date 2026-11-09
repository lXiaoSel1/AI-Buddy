import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {createGameEconomy} from '../src/voice-games/game-economy.mjs';
const rules=await import(process.env.AI_BUDDY_CARD_RULES_SOURCE?pathToFileURL(process.env.AI_BUDDY_CARD_RULES_SOURCE).href:'../src/voice-games/rules/index.mjs');
const player=id=>id==='p0'?{id,kind:'user',personaId:'persona'}:{id,kind:'ai',characterId:id,personaId:'persona',lifeId:'life-'+id,operationId:'op-'+id};
function fixture(t){
 const db=new DatabaseSync(':memory:');let wallet={balance:2000},serial=0;
 const transaction=fn=>{const id='tx'+serial++;db.exec('SAVEPOINT '+id);try{const value=fn();db.exec('RELEASE '+id);return value;}catch(error){db.exec('ROLLBACK TO '+id);db.exec('RELEASE '+id);throw error;}};
 const economy=createGameEconomy({db,transaction,wallet:()=>structuredClone(wallet),setWallet:value=>{wallet=value;},ledger:()=>{},now:()=>1800000000000});
 economy.registerRules({...rules,versions:rules.RULE_MANIFEST,deck:type=>rules.STANDARD_DECK[type],sourceHash:'d03d283bdf6c748fcfbdcbcf4eca7f959ca29cbe4ebfbf87f3b53a51d94f16e4',synthetic:true});
 t.after(()=>db.close());let commands=0;
 const create=ids=>economy.create({tableId:'table',commandId:'create',type:'texas',players:ids.map(player),buyIn:200,deck:rules.STANDARD_DECK.texas});
 const settle=current=>{while(current.status==='active')current=economy.action({tableId:current.id,expectedVersion:current.version,commandId:'fold-'+commands++,action:{type:'fold',actorId:current.state.actorId}});return current;};
 const next=(current,ids)=>{current=economy.control({tableId:current.id,expectedVersion:current.version,commandId:'seats-'+commands++,op:'seats',players:ids.map(player)});const input={tableId:current.id,expectedVersion:current.version,commandId:'next-'+commands++,deck:rules.STANDARD_DECK.texas};return {value:economy.next(input),input};};
 return {db,economy,create,settle,next};
}
for(const count of [3,4])test('heads-up to '+count+' retains blind progression and preserves the completed hand',t=>{
 const f=fixture(t),completed=f.settle(f.create(['p0','p1'])),saved=f.economy.replay(completed.state.handId),ids=Array.from({length:count},(_,i)=>'p'+i);
 const {value,input}=f.next(completed,ids),plan=value.state.blindPlan;
 assert.deepEqual([plan.buttonSeat,plan.smallBlindSeat,plan.bigBlindSeat],['p'+(count-1),'p1','p0']);
 assert.equal(new Set([plan.buttonSeat,plan.smallBlindSeat,plan.bigBlindSeat]).size,3);
 assert.equal(value.state.players.find(p=>p.id==='p1').streetCommitted,1);assert.equal(value.state.players.find(p=>p.id==='p0').streetCommitted,2);
 assert.equal(value.state.actorId,'p2');assert.deepEqual(f.economy.replay(completed.state.handId),saved);
 assert.equal(f.economy.next(input).version,value.version);assert.equal(f.economy.table('table').hand,2);
});
test('three to heads-up to three uses actual last hand size rather than historical ring size',t=>{
 const f=fixture(t);let current=f.settle(f.create(['p0','p1','p2']));current=f.next(current,['p0','p1']).value;assert.equal(current.state.blindPlan.ring.length,3);
 current=f.settle(current);const previous=current.state.blindPlan,settled=f.economy.replay(current.state.handId);current=f.next(current,['p0','p1','p2']).value;
 const plan=current.state.blindPlan;assert.equal(new Set([plan.buttonSeat,plan.smallBlindSeat,plan.bigBlindSeat]).size,3);assert.notEqual(plan.bigBlindSeat,previous.bigBlindSeat);assert.deepEqual(f.economy.replay(settled.handId),settled);
});
test('live table chat stays bounded while the complete conversation remains paged in storage',t=>{
 const f=fixture(t);let current=f.create(['p0','p1']);
 for(let i=0;i<235;i++)f.economy.chat({tableId:current.id,submissionId:'chat-'+i,text:'line '+i,scope:{personaId:'persona'}});
 current=f.economy.table(current.id);assert.equal(current.chat.length,200);assert.equal(current.chat[0].text,'line 35');
 const recent=f.economy.chatPage(current.id),older=f.economy.chatPage(current.id,{before:recent.before});
 assert.equal(recent.messages.length,200);assert.equal(older.messages.length,35);
 assert.equal(older.messages[0].text,'line 0');assert.equal(recent.messages.at(-1).text,'line 234');
 f.economy.chat({tableId:current.id,submissionId:'chat-234',text:'line 234',scope:{personaId:'persona'}});
 assert.equal(f.economy.chatPage(current.id).messages.length,200);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM game_chat').get().n,235);
});

test('heads-up transition with departing old big blind preserves dead small blind without making the button pay big blind',t=>{
 const f=fixture(t),completed=f.settle(f.create(['p0','p1'])),saved=f.economy.replay(completed.state.handId);
 const current=f.next(completed,['p0','p2','p3']).value,plan=current.state.blindPlan;
 assert.equal(plan.smallBlindSeat,null);assert.equal(plan.smallBlindAnchor,'p1');assert.equal(plan.bigBlindSeat,'p0');assert.equal(plan.buttonSeat,'p3');
 assert.notEqual(plan.buttonSeat,plan.bigBlindSeat);assert.equal(current.state.players.find(p=>p.id==='p0').streetCommitted,2);assert.deepEqual(f.economy.replay(completed.state.handId),saved);
});
