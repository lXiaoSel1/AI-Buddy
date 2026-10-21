import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGalgame} from '../src/galgame-host.mjs';
import {groupSpeakers} from '../src/companion-store.mjs';

const until=async predicate=>{for(let n=0;n<400;n++){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,4));}throw Error('group speaking mode fixture timeout');};
const state=async game=>(await game.action('companion-state')).companion;
const pending=game=>until(async()=>{const current=await state(game);return current.groupRuntime?.status==='awaiting-presentation'&&current;});
async function fixture(mode='list',memberIds=['deepseek','claude','kimi']){
 const root=mkdtempSync(join(tmpdir(),'buddy-speaking-modes-')),calls=[],events=[];let hold=false,release,entered=false;
 const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'fixture'}),listProviders:()=>[{id:'fixture'}],listModels:()=>[{id:'fixture'}],runTurn:async fn=>fn(),async *stream(options){calls.push(options);if(hold){entered=true;await Promise.race([new Promise(resolve=>release=resolve),new Promise(resolve=>{if(options.signal.aborted)resolve();else options.signal.addEventListener('abort',resolve,{once:true});})]);}yield{type:'text-delta',text:'{"text":"本地模拟群聊台词","emotion":"normal","affection":1}'};yield{type:'finish',reason:{kind:'stop'}};}};
 let game=await createGalgame({dataRoot:root,provider,model:'fixture',onChatCommitted:event=>events.push(event)});
 const group=(await game.action('companion-group-save',{name:'发言模式检查',mode,memberIds})).group;
 await game.action('companion-group-select',{id:group.id});
 return{root,calls,events,group,get game(){return game;},get entered(){return entered;},block(){hold=true;},unblock(){hold=false;release?.();},async restart(){game.close();game=await createGalgame({dataRoot:root,provider,model:'fixture',onChatCommitted:event=>events.push(event)});},close(){hold=false;release?.();game.close();}};
}
async function send(f,args={}){await f.game.action('companion-group-send',{id:f.group.id,text:'使用本地模拟回复检查发言',...args});return pending(f.game);}
async function present(f){const current=await state(f.game);await f.game.action('companion-group-present',{id:f.group.id,requestId:current.groupRuntime.pendingMessage.id});return state(f.game);}

test('Natural mode reads player talkativeness from cards and ignores former per-group overrides',()=>{
 const group={memberIds:['a','b','c','d'],mutedIds:['d'],talkativeness:{a:1,b:0,c:0,d:1},mode:'natural'},cards={a:{talkativeness:0},b:{talkativeness:1},c:{talkativeness:1},d:{talkativeness:1}};
 assert.deepEqual(groupSpeakers(group,{cards,random:()=>.9}),['b','c']);
 assert.deepEqual(groupSpeakers(group,{cards,mentionIds:['a','a','d'],random:()=>.9}),['a','b','c']);
 assert.deepEqual(groupSpeakers({...group,mutedIds:[]},{cards:{},random:()=>.49}),['a','b','c','d']);
 assert.deepEqual(groupSpeakers(group,{cards:{a:{talkativeness:0},b:{talkativeness:0},c:{talkativeness:0}},random:()=>.9}),['c']);
});

test('List, manual and pool schedules ignore talkativeness; explicit force retains muted override',()=>{
 const group={memberIds:['a','b','c'],stageOrder:['a','b','c'],mutedIds:['c'],talkativeness:{},mode:'list'},cards={a:{talkativeness:0},b:{talkativeness:0},c:{talkativeness:0}};
 assert.deepEqual(groupSpeakers(group,{cards,mentionIds:['b']}),['a','b']);
 assert.deepEqual(groupSpeakers({...group,mode:'manual'},{cards,mentionIds:['b','b','c']}),['b']);
 assert.deepEqual(groupSpeakers({...group,mode:'manual'},{cards}),[]);
 assert.deepEqual(groupSpeakers({...group,mode:'pool'},{cards}),['a']);
 for(const mode of ['natural','list','manual','pool'])assert.deepEqual(groupSpeakers({...group,mode},{cards,forceCharacterId:'c'}),['c']);
});

test('Pool follows stable stage order after last speaker despite mute, leave and return',()=>{
 const group={memberIds:['a','b','c'],stageOrder:['a','b','c'],mutedIds:[],talkativeness:{},mode:'pool',poolLastSpeakerId:'a',poolIndex:1};
 assert.deepEqual(groupSpeakers({...group,mutedIds:['a']}),['b']);
 assert.deepEqual(groupSpeakers({...group,memberIds:['c','b']}),['b']);
 assert.deepEqual(groupSpeakers({...group,poolLastSpeakerId:'b',mutedIds:['c']}),['a']);
 assert.deepEqual(groupSpeakers({...group,poolLastSpeakerId:'a',mutedIds:[]}),['b']);
 assert.deepEqual(groupSpeakers({...group,poolLastSpeakerId:'c',mutedIds:['c']}),['a']);
 assert.deepEqual(groupSpeakers({...group,poolLastSpeakerId:undefined,poolIndex:2}),['c']);
});

test('Player card settings apply across groups and survive restart, while non-natural modes remain independent',async()=>{
 const f=await fixture('natural',['deepseek','claude']);try{
  await f.game.action('companion-character-save',{id:'deepseek',talkativeness:0});await f.game.action('companion-character-save',{id:'claude',talkativeness:1});
  let current=await send(f);assert.equal(current.groupRuntime.pendingMessage.characterId,'claude');assert.equal((await present(f)).groupRuntime.status,'idle');
  const other=(await f.game.action('companion-group-save',{memberIds:['deepseek','claude'],mode:'natural'})).group;await f.game.action('companion-group-select',{id:other.id});
  await f.game.action('companion-group-send',{id:other.id,text:'第二个群也使用同一角色设定'});current=await pending(f.game);assert.equal(current.groupRuntime.pendingMessage.characterId,'claude');await f.game.action('companion-group-present',{id:other.id,requestId:current.groupRuntime.pendingMessage.id});
  await f.restart();current=await state(f.game);assert.equal(current.characters.find(c=>c.id==='deepseek').talkativeness,0);assert.equal(current.characters.find(c=>c.id==='claude').talkativeness,1);
  await f.game.action('companion-group-save',{id:other.id,mode:'list'});await f.game.action('companion-group-send',{id:other.id,text:'列表模式仍从第一位开始'});current=await pending(f.game);assert.equal(current.groupRuntime.pendingMessage.characterId,'deepseek');assert.deepEqual(current.groupRuntime.queue,['deepseek','claude']);
 }finally{f.close();}
});

test('Pool round advances after the actual committed speaker and does not skip next when prior speaker is muted',async()=>{
 const f=await fixture('pool');try{
  assert.equal((await send(f)).groupRuntime.pendingMessage.characterId,'deepseek');await present(f);
  await f.game.action('companion-group-member',{id:f.group.id,characterId:'deepseek',op:'mute'});assert.equal((await send(f)).groupRuntime.pendingMessage.characterId,'claude');await present(f);
  await f.game.action('companion-group-member',{id:f.group.id,characterId:'claude',op:'leave'});assert.equal((await send(f)).groupRuntime.pendingMessage.characterId,'kimi');await present(f);
  await f.game.action('companion-group-member',{id:f.group.id,characterId:'claude',op:'join'});await f.game.action('companion-group-member',{id:f.group.id,characterId:'deepseek',op:'unmute'});assert.equal((await send(f)).groupRuntime.pendingMessage.characterId,'deepseek');
 }finally{f.close();}
});

for(const op of ['mute','leave'])test(`Discarding pending speaker by ${op} preserves next member and never presents or rewards cancelled draft`,async()=>{
 const f=await fixture();try{
  const before=await send(f),discardedId=before.groupRuntime.pendingMessage.id;
  await f.game.action('companion-group-member',{id:f.group.id,characterId:'deepseek',op});const after=await state(f.game);
  assert.equal(after.groupRuntime.status,'awaiting-continue');assert.deepEqual(after.groupRuntime.queue,['claude','kimi']);assert.equal(after.groupRuntime.pendingMessage,null);assert.equal(after.groupMessages.filter(m=>m.role==='assistant').length,0);assert.equal(f.events.filter(event=>event.group).length,0);
  await assert.rejects(()=>f.game.action('companion-group-present',{id:f.group.id,requestId:discardedId}),/失效|待呈现|取消/);
  await f.game.action('companion-group-continue',{id:f.group.id});assert.equal((await pending(f.game)).groupRuntime.pendingMessage.characterId,'claude');const committed=await present(f);
  assert.deepEqual(committed.groupMessages.filter(m=>m.role==='assistant').map(m=>m.characterId),['claude']);assert.deepEqual(committed.groupRuntime.queue,['kimi']);assert.equal(f.events.filter(event=>event.group).length,1);assert.equal(f.calls.length,2);
 }finally{f.close();}
});

test('Saving muted members during pending presentation also discards current draft without shifting another member',async()=>{
 const f=await fixture();try{
  await send(f);await f.game.action('companion-group-save',{id:f.group.id,mutedIds:['deepseek']});const current=await state(f.game);assert.equal(current.groupRuntime.status,'awaiting-continue');assert.deepEqual(current.groupRuntime.queue,['claude','kimi']);assert.equal(current.groupRuntime.pendingMessage,null);assert.equal(f.events.length,0);
 }finally{f.close();}
});

for(const [from,to]of [['list','pool'],['pool','list']])test(`Changing ${from} to ${to} while awaiting presentation is blocked, then succeeds after stop`,async()=>{
 const f=await fixture(from);try{
  await send(f);await assert.rejects(()=>f.game.action('companion-group-save',{id:f.group.id,mode:to}),/完成|停止/);let current=await state(f.game);assert.equal(current.groups.find(g=>g.id===f.group.id).mode,from);assert.equal(current.groupRuntime.status,'awaiting-presentation');
  await f.game.action('companion-group-stop',{id:f.group.id});await f.game.action('companion-group-save',{id:f.group.id,mode:to});current=await state(f.game);assert.equal(current.groups.find(g=>g.id===f.group.id).mode,to);
 }finally{f.close();}
});

test('Changing mode while awaiting Continue or while generating is blocked without advancing pool',async()=>{
 const f=await fixture('list');try{
  await send(f);await present(f);await assert.rejects(()=>f.game.action('companion-group-save',{id:f.group.id,mode:'pool'}),/完成|停止/);const current=await state(f.game);assert.deepEqual(current.groupRuntime.queue,['claude','kimi']);assert.equal(current.groups.find(g=>g.id===f.group.id).poolLastSpeakerId,undefined);
  f.block();await f.game.action('companion-group-continue',{id:f.group.id});await until(()=>f.entered);await assert.rejects(()=>f.game.action('companion-group-save',{id:f.group.id,mode:'pool'}),/完成|停止/);assert.equal((await state(f.game)).groupRuntime.status,'generating');
 }finally{f.close();}
});

test('Pool export/import and restart preserve cursor so restored conversation continues with the next role',async()=>{
 const f=await fixture('pool');try{
  await send(f);await present(f);assert.equal((await send(f)).groupRuntime.pendingMessage.characterId,'claude');await present(f);
  const exported=(await f.game.action('companion-group-export',{id:f.group.id})).data;assert.equal(exported.groups[0].poolLastSpeakerId,'claude');assert.equal(exported.groups[0].poolIndex,2);
  await f.game.action('companion-group-save',{id:f.group.id,name:'原件保留'});await f.game.action('companion-conversation-import',{data:exported});let current=await state(f.game),restored=current.groups.find(g=>g.importedFrom===f.group.id);assert.ok(restored);assert.equal(restored.poolLastSpeakerId,'claude');assert.equal(restored.poolIndex,2);
  await f.game.action('companion-group-select',{id:restored.id});await f.restart();current=await state(f.game);restored=current.groups.find(g=>g.id===restored.id);assert.equal(restored.poolLastSpeakerId,'claude');await f.game.action('companion-group-send',{id:restored.id,text:'恢复之后继续轮换'});assert.equal((await pending(f.game)).groupRuntime.pendingMessage.characterId,'kimi');
 }finally{f.close();}
});
