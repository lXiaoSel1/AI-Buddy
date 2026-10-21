import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mentionQuery,mentionCandidates,insertMention,updateMentionBindings,resolveMentionIds} from '../src/group-mentions.mjs';
import {createGalgame} from '../src/galgame-host.mjs';
const members=[{id:'deepseek',name:'DeepSeek'},{id:'claude',name:'Claude'},{id:'chatgpt',name:'GPT'},{id:'hunyuan',name:'混元'},{id:'space',name:'名字 带空格'}];
const until=async fn=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,8));}throw Error('timeout');};
test('mentions support mid-text caret, Chinese, case-insensitive names and spaces without matching email or prefixes',()=>{
 assert.deepEqual(mentionQuery('你好@Cl 后面的文字',5),{start:2,end:5,query:'Cl'});
 assert.equal(mentionQuery('a@claude.com',12),null);
 assert.deepEqual(mentionCandidates(members,'gpt').map(c=>c.id),['chatgpt']);
 assert.deepEqual(resolveMentionIds('你好@Deepseek 你说呢 @Claude @GPT，@混元！ @名字 带空格',members),['deepseek','claude','chatgpt','hunyuan','space']);
 assert.deepEqual(resolveMentionIds('a@Claude @GPTx @Deepseek2',members),[]);
});
test('chosen identities survive edits elsewhere; edited or deleted mentions cannot silently target an old member',()=>{
 const duplicate=[{id:'a',name:'同名'},{id:'b',name:'同名'}];
 assert.deepEqual(resolveMentionIds('@同名',duplicate),[]);
 const inserted=insertMention('你好 @ 后面',{start:3,end:4},duplicate[1]);
 assert.deepEqual(resolveMentionIds(inserted.text,duplicate,inserted.bindings),['b']);
 const reselected=insertMention(inserted.text,{start:3,end:6},duplicate[0],inserted.bindings);assert.deepEqual(resolveMentionIds(reselected.text,duplicate,reselected.bindings),['a']);
 const prefix='先说：'+inserted.text,shift=updateMentionBindings(inserted.text,prefix,inserted.bindings);
 assert.deepEqual(resolveMentionIds(prefix,duplicate,shift),['b']);
 const edited=prefix.replace('@同名','@别人');assert.deepEqual(resolveMentionIds(edited,duplicate,updateMentionBindings(prefix,edited,shift)),[]);
 const deleted=prefix.replace('@同名','');assert.deepEqual(resolveMentionIds(deleted,duplicate,updateMentionBindings(prefix,deleted,shift)),[]);
 assert.deepEqual(resolveMentionIds('@同名',duplicate,[{id:'b',start:0,end:999}]),[]);
});
test('title edits are per-character, survive restart, and do not rename cards or modify history; reset removes override',async()=>{
 const root=mkdtempSync(join(tmpdir(),'buddy-title-')),provider={enabled:false};let game=await createGalgame({dataRoot:root,provider,model:'fixture'});
 try{const before=await game.action('view');await game.action('companion-title-set',{characterId:'hunyuan',title:'我们的山水茶会'});let s=(await game.action('companion-state')).companion;assert.equal(s.settings.galgameTitles.hunyuan,'我们的山水茶会');assert.equal(s.settings.galgameTitles.claude,undefined);assert.equal(s.characters.find(c=>c.id==='hunyuan').name,'混元');assert.deepEqual((await game.action('view')).history,before.history);game.close();game=await createGalgame({dataRoot:root,provider,model:'fixture'});assert.equal((await game.action('companion-state')).companion.settings.galgameTitles.hunyuan,'我们的山水茶会');await assert.rejects(()=>game.action('companion-title-set',{characterId:'constructor',title:'bad'}));await assert.rejects(()=>game.action('companion-title-set',{characterId:'hunyuan',title:'x'.repeat(81)}));await game.action('companion-title-set',{characterId:'hunyuan',title:''});assert.equal((await game.action('companion-state')).companion.settings.galgameTitles.hunyuan,undefined);
 }finally{game.close();}
});
test('typed mentions start the first reply automatically even at 0% talkativeness, but next member still waits for Continue',async()=>{
 const calls=[],provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'fixture'}),listProviders:()=>[{id:'fixture'}],listModels:()=>[{id:'fixture'}],runTurn:async fn=>fn(),async *stream(options){calls.push(options);yield{type:'text-delta',text:JSON.stringify({text:'本轮自动首条回复',emotion:'cheerful',affection:0})};yield{type:'finish',reason:{kind:'stop'}};}};
 const root=mkdtempSync(join(tmpdir(),'buddy-mention-send-')),game=await createGalgame({dataRoot:root,provider,model:'fixture'});
 try{for(const id of ['deepseek','claude','chatgpt'])await game.action('companion-character-save',{id,talkativeness:0});const g=(await game.action('companion-group-save',{name:'点名回归',memberIds:['deepseek','claude','chatgpt'],mode:'natural'})).group;await game.action('companion-group-select',{id:g.id});await game.action('companion-group-send',{id:g.id,text:'@Claude @GPT 说说吧',clientRequestId:'one'});
 const state=async()=>(await game.action('companion-state')).companion;await until(async()=>(await state()).groupRuntime.status==='awaiting-presentation');let s=await state();assert.equal(calls.length,1);assert.equal(s.groupRuntime.pendingMessage.characterId,'claude');assert.deepEqual(s.groupMessages[0].mentionIds,['claude','chatgpt']);await game.action('companion-group-present',{id:g.id,requestId:s.groupRuntime.pendingMessage.id});s=await state();assert.equal(s.groupRuntime.status,'awaiting-continue');assert.equal(calls.length,1);await game.action('companion-group-send',{id:g.id,text:'@Claude @GPT 说说吧',clientRequestId:'one'});assert.equal(calls.length,1);await game.action('companion-group-continue',{id:g.id});await until(async()=>(await state()).groupRuntime.status==='awaiting-presentation');s=await state();assert.equal(s.groupRuntime.pendingMessage.characterId,'chatgpt');assert.equal(calls.length,2);await game.action('companion-group-present',{id:g.id,requestId:s.groupRuntime.pendingMessage.id});assert.equal((await state()).groupRuntime.status,'idle');
 await game.action('companion-group-save',{id:g.id,mutedIds:g.memberIds});await assert.rejects(()=>game.action('companion-group-send',{id:g.id,text:'没人回应'}),/静音/);assert.equal(calls.length,2);assert.equal((await state()).groupMessages.length,3);
 }finally{game.close();}
});
