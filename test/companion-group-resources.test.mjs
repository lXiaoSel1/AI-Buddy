import {presentedState} from './support/presented-state.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGalgame} from '../src/galgame-host.mjs';
import {openCompanionStore} from '../src/companion-store.mjs';
import {PET_CHARACTERS} from '../src/pet-characters.mjs';
const until=async fn=>{for(let n=0;n<300;n++){if(await fn())return;await new Promise(r=>setTimeout(r,4));}throw Error('fixture timeout');};
const state=presentedState;
async function fixture(installed=['deepseek'],{gate=false}={}){
 const root=mkdtempSync(join(tmpdir(),'buddy-group-resources-')),required=[],calls=[];let release,started=false,aborted=false;const wait=new Promise(r=>release=r),set=new Set(installed);
 const resources={available:id=>set.has(id),fallback:()=>installed[0],status:()=>({initialCharacter:installed[0],characters:PET_CHARACTERS.map(c=>({...c,installed:set.has(c.id)}))}),require(ids){required.push([...ids]);const missing=ids.filter(id=>!set.has(id));if(missing.length)throw Object.assign(Error('角色资源待安装'),{code:'CHARACTER_NOT_INSTALLED',characterIds:missing});}};
 const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'fixture'}),listProviders:()=>[{id:'fixture'}],listModels:()=>[{id:'fixture'}],runTurn:async fn=>fn(),async *stream(o){calls.push(o);if(o.purpose==='group-chat'){started=true;o.signal.addEventListener('abort',()=>{aborted=true;release();},{once:true});if(gate)await wait;yield{type:'text-delta',text:'{"text":"合法成员回复","emotion":"normal","affection":0}'};}}};
 const game=await createGalgame({dataRoot:root,provider,model:'fixture',resources});return {root,game,calls,required,get started(){return started;},get aborted(){return aborted;},release};
}

test('Selecting a group with missing built-ins returns the existing resource-install result without stopping the current group',async()=>{
 const f=await fixture(['deepseek'],{gate:true});try{const current=(await f.game.action('companion-group-save',{memberIds:['deepseek'],mode:'list'})).group,target=(await f.game.action('companion-group-save',{memberIds:['deepseek','claude','kimi'],mode:'list'})).group;await f.game.action('companion-group-select',{id:current.id});await f.game.action('companion-group-send',{id:current.id,text:'当前请求继续'});await until(()=>f.started);const before=await state(f.game),result=await f.game.action('companion-group-select',{id:target.id});assert.equal(result.ok,false);assert.equal(result.code,'CHARACTER_NOT_INSTALLED');assert.deepEqual(result.characterIds,['claude','kimi']);assert.equal(f.aborted,false);assert.equal(result.companion.activeGroupId,current.id);assert.equal(result.companion.activeCharacterId,before.activeCharacterId);assert.equal(result.companion.groupRuntime.status,'generating');assert.equal(f.calls.length,1);assert.equal(result.companion.characters.find(c=>c.id==='claude').resourceInstalled,false);assert.equal(result.companion.characters.find(c=>c.id==='claude').needsInstall,true);f.release();await until(async()=>(await state(f.game)).groupRuntime.status==='idle');}finally{f.release();f.game.close();}
});

test('A direct new-turn request cannot bypass missing-member checks or append an unsubmitted user message',async()=>{
 const f=await fixture();try{const group=(await f.game.action('companion-group-save',{memberIds:['deepseek','claude'],mode:'list'})).group,before=await state(f.game),result=await f.game.action('companion-group-send',{id:group.id,text:'不能暗中发起请求'});assert.equal(result.ok,false);assert.equal(result.code,'CHARACTER_NOT_INSTALLED');assert.deepEqual(result.characterIds,['claude']);assert.equal(result.companion.activeGroupId,before.activeGroupId);assert.equal(f.calls.length,0);const disk=await openCompanionStore(f.root),saved=disk.state.groups[group.id];assert.equal(saved.seq,0);assert.equal(saved.messages.length,0);assert.equal(saved.pending,undefined);assert.equal(result.companion.relationship.affection,before.relationship.affection);}finally{f.game.close();}
});

test('A text-only custom member bypasses built-in package checks and can speak alongside installed DeepSeek',async()=>{
 const f=await fixture();try{const custom=(await f.game.action('companion-character-save',{name:'纯文字成员'})).card,group=(await f.game.action('companion-group-save',{memberIds:[custom.id,'deepseek'],mode:'list'})).group;const selected=await f.game.action('companion-group-select',{id:group.id});assert.equal(selected.ok,true);const card=selected.companion.characters.find(c=>c.id===custom.id);assert.equal(card.builtin,false);assert.equal(card.resourceInstalled,true);assert.equal(card.needsInstall,false);await f.game.action('companion-group-send',{id:group.id,text:'有图与无图角色都可聊天'});await until(async()=>(await state(f.game)).groupRuntime.status==='awaiting-continue');await f.game.action('companion-group-continue',{id:group.id});await until(async()=>(await state(f.game)).groupRuntime.status==='idle');assert.equal(f.calls.length,2);assert.equal((await state(f.game)).groupMessages.filter(m=>m.role==='assistant').length,2);assert.ok(f.required.every(ids=>ids.length===1&&ids[0]==='deepseek'));}finally{f.game.close();}
});

test('A fully installed group retains normal sequential playback and checks the entire cast once per select or new turn',async()=>{
 const f=await fixture(['deepseek','claude','kimi']);try{const group=(await f.game.action('companion-group-save',{memberIds:['deepseek','claude','kimi'],mode:'list'})).group;await f.game.action('companion-group-select',{id:group.id});await f.game.action('companion-group-send',{id:group.id,text:'全部角色已安装'});for(let n=0;n<2;n++){await until(async()=>(await state(f.game)).groupRuntime.status==='awaiting-continue');await f.game.action('companion-group-continue',{id:group.id});}await until(async()=>(await state(f.game)).groupRuntime.status==='idle');assert.equal(f.calls.length,3);assert.equal(f.required.length,2);assert.deepEqual(f.required,[['deepseek','claude','kimi'],['deepseek','claude','kimi']]);assert.ok((await state(f.game)).characters.filter(c=>group.memberIds.includes(c.id)).every(c=>c.resourceInstalled&&!c.needsInstall));}finally{f.game.close();}
});
