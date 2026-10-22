import test from 'node:test';
import assert from 'node:assert/strict';
import {makeCard,migrateCharacterTalkativeness,groupSpeakers} from '../src/companion-store.mjs';
test('Player talkativeness is validated and preserved by card edits and drafts',()=>{
 const initial=makeCard({name:'新角色'});assert.equal(initial.talkativeness,.5);
 const quiet=makeCard({talkativeness:0},initial);assert.equal(quiet.talkativeness,0);
 assert.equal(makeCard({name:'改名'},quiet).talkativeness,0);
 assert.equal(makeCard({talkativeness:1},quiet,{draft:true}).talkativeness,1);
 for(const value of [null,-.1,1.1,Infinity,NaN,'0.5',true,{},[]])assert.throws(()=>makeCard({talkativeness:value},initial),/健谈程度/);
});
test('Legacy group values migrate once to the latest edited group setting and retain conflicting source values',()=>{
 const state={cards:{a:{id:'a'},b:{id:'b'},c:{id:'c',talkativeness:0}},groups:{old:{id:'old',updatedAt:1,talkativeness:{a:.2,c:1}},recent:{id:'recent',updatedAt:2,talkativeness:{a:.8,c:1}}}};
 const original=structuredClone(state.groups);migrateCharacterTalkativeness(state,123);
 assert.equal(state.cards.a.talkativeness,.8);assert.equal(state.cards.b.talkativeness,.5);assert.equal(state.cards.c.talkativeness,0);assert.deepEqual(state.groups,original);
 const entry=state.characterTalkativenessMigration.entries.find(e=>e.characterId==='a');assert.equal(entry.sourceGroupId,'recent');assert.deepEqual(entry.legacy.map(e=>e.value),[.8,.2]);
 state.cards.a.talkativeness=.3;state.groups.recent.talkativeness.a=1;const recorded=structuredClone(state.characterTalkativenessMigration);migrateCharacterTalkativeness(state,456);assert.equal(state.cards.a.talkativeness,.3);assert.deepEqual(state.characterTalkativenessMigration,recorded);
 assert.deepEqual(groupSpeakers({mode:'natural',memberIds:['a','b'],mutedIds:[],talkativeness:{a:1,b:0}},{cards:state.cards,random:()=>.4}),['b']);
});
