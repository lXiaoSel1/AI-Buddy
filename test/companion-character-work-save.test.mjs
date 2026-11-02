import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createGalgame} from '../src/galgame-host.mjs';
import {companionCardDraft} from '../src/companion-ui.mjs';
import {createCompanionLives} from '../src/companion-life-service.mjs';
import {makeCard} from '../src/companion-store.mjs';
import {ensureLives} from '../src/companion-life.mjs';

const copy=value=>structuredClone(value),raw=async game=>(await game.action('companion-state')).companion;
const workBusy=()=>Object.assign(Error('Pause active character work before archiving'),{code:'AGENT_LIFE_BUSY'});
function root(t,close=()=>{}){const value=mkdtempSync(join(tmpdir(),'buddy-character-work-save-'));t.after(async()=>{await close();await new Promise(resolve=>setTimeout(resolve,10));assert(resolve(value).startsWith(resolve(tmpdir())+sep+'buddy-character-work-save-'));rmSync(value,{recursive:true,force:true});});return value;}
async function fixture(t,{snapshot,online=false}={}){
 let busy=false,checks=0,game;game=await createGalgame({dataRoot:root(t,()=>game?.close()),model:'fixture',provider:{enabled:online,currentSelection:()=>({provider:'local',model:'fixture'}),resolveConnection:binding=>({connectionId:binding?.enabled?binding.connectionId:'global',model:'fixture'}),listProviders:()=>[],listModels:()=>[],async *stream(){if(!online)throw Error('No model may be called by this fixture');yield {type:'text-delta',text:'Working chat fixture response'};}},workBridge:{...(snapshot?{snapshot}:{}),assertIdle(){checks++;if(busy)throw workBusy();}}});
 return {game,setBusy:value=>{busy=value;},get checks(){return checks;}};
}

test('a busy work task does not prevent saving the complete editor draft with only a chat model change',async t=>{
 const f=await fixture(t),before=await raw(f.game),card=before.characters.find(row=>row.id==='deepseek'),draft=companionCardDraft(card);draft.modelBinding={enabled:true,connectionId:'different-chat-model'};f.setBusy(true);
 const result=await f.game.action('companion-character-save',draft),after=await raw(f.game);
 assert.deepEqual(result.card.modelBinding,draft.modelBinding);assert.equal(after.characters.find(row=>row.id===card.id).life.id,card.life.id);assert.equal(after.activeConversationId,before.activeConversationId);assert.deepEqual(after.messages,before.messages);assert.equal(f.checks,0);
});

test('growth characters keep model, appearance and talkativeness editable while work is busy',async t=>{
 const f=await fixture(t);await f.game.action('companion-growth-mode',{characterId:'deepseek',mode:'seed'});const before=await raw(f.game),card=before.characters.find(row=>row.id==='deepseek'),draft=companionCardDraft(card),checks=f.checks;draft.modelBinding={enabled:true,connectionId:'new-chat-model'};draft.talkativeness=.8;draft.fields.visual={mode:'custom',value:'Only the appearance changed'};f.setBusy(true);
 const result=await f.game.action('companion-character-save',draft);assert.deepEqual(result.card.modelBinding,draft.modelBinding);assert.equal(result.card.talkativeness,.8);assert.equal(result.card.effective.visual,'Only the appearance changed');assert.equal(result.card.effective.personality,card.effective.personality);assert.equal(f.checks,checks);assert.equal((await raw(f.game)).characters.find(row=>row.id===card.id).life.id,card.life.id);
 await assert.rejects(f.game.action('companion-character-save',{id:card.id,fields:{personality:{mode:'custom',value:'Rewrite the person'}}}),/成长角色设定只读/);
});

test('changes to the working character identity and examples still require work to be idle',async t=>{
 const f=await fixture(t),before=await raw(f.game),card=before.characters.find(row=>row.id==='deepseek');f.setBusy(true);
 for(const patch of [{name:'Another identity'},{fields:{personality:{mode:'custom',value:'A different personality'}}},{examples:[{scene:'Example',speaker:'DeepSeek',text:'Different example'}]}])await assert.rejects(f.game.action('companion-character-save',{id:card.id,...patch}),{code:'AGENT_LIFE_BUSY'});
 const after=(await raw(f.game)).characters.find(row=>row.id===card.id);assert.equal(after.name,card.name);assert.deepEqual(after.effective,card.effective);assert.equal(after.revision,card.revision);
});

test('saving a model and appearance draft while work is busy does not change the applied card',async t=>{
 const f=await fixture(t),before=await raw(f.game),card=before.characters.find(row=>row.id==='deepseek'),draft=companionCardDraft(card);draft.modelBinding={enabled:true,connectionId:'draft-chat-model'};draft.fields.visual={mode:'custom',value:'Draft appearance'};f.setBusy(true);
 const result=await f.game.action('companion-character-draft',draft),after=await raw(f.game);assert.deepEqual(result.card.modelBinding,draft.modelBinding);assert.deepEqual(after.characters.find(row=>row.id===card.id),card);assert.equal(f.checks,0);
 await assert.rejects(f.game.action('companion-character-draft',{...draft,name:'Another identity'}),{code:'AGENT_LIFE_BUSY'});assert.equal((await raw(f.game)).draftCharacters.find(row=>row.id===card.id).name,card.name);
});

test('an in-progress life archive blocks both applied-card and draft saves',async t=>{
 let entered,release;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;}),f=await fixture(t,{snapshot:async()=>{entered();await gate;return null;}});t.after(()=>release());const archive=f.game.action('companion-life-save',{characterId:'deepseek'});await started;
 try{for(const action of ['companion-character-save','companion-character-draft'])await assert.rejects(f.game.action(action,{id:'deepseek',modelBinding:{enabled:true,connectionId:'new-model'}}),/正在保存或切换/);}finally{release();await archive;}
});

test('actual life save, reset and restore retain the work-idle guard',async t=>{
 const f=await fixture(t),before=await raw(f.game),id='deepseek',archive=(await f.game.action('companion-life-save',{characterId:id})).archive;f.setBusy(true);
 for(const [action,args]of [['companion-life-save',{characterId:id}],['companion-life-reset',{characterId:id,mode:'normal'}],['companion-life-restore',{id:archive.id}]])await assert.rejects(f.game.action(action,args),{code:'AGENT_LIFE_BUSY'});
 const after=await raw(f.game);assert.equal(after.characters.find(row=>row.id===id).life.id,before.characters.find(row=>row.id===id).life.id);
});

test('the stable-card guard still refuses active and failed life transactions',async t=>{
 let state={cards:{deepseek:makeCard({id:'deepseek',name:'DeepSeek'})},personas:{default:{id:'default',name:'Default'}},conversations:{},groups:{},relationships:{},activeCharacterId:'deepseek',activePersonaId:'default',lifeArchives:{}};ensureLives(state,1);const store={get state(){return state;},snapshot:()=>copy(state),async mutate(fn){const next=copy(state),result=await fn(next);state=next;return result;},async flush(){}};
 const service=await createCompanionLives({store,dataRoot:root(t),call:async()=>({ok:true}),syncCard:async()=>{},projectPersona:async()=>{},enableGrowth:()=>{}});
 assert.doesNotThrow(()=>service.assertStable('deepseek'));state.lifeTransaction={characterId:'deepseek'};assert.throws(()=>service.assertStable('deepseek'),/正在保存或切换/);state.lifeTransaction.replayFailed={at:1};assert.throws(()=>service.assertStable('deepseek'),/人生切换没有完成/);
});

test('ordinary private messages are accepted while work owns the character',async t=>{
 const f=await fixture(t,{online:true});f.setBusy(true);await f.game.action('chat',{text:'hello during work'});const view=await raw(f.game);assert.ok(view.messages.some(m=>m.text==='hello during work'));assert.equal(f.checks,0);
});
