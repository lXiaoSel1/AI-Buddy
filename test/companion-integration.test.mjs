import {presentedState} from './support/presented-state.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGalgame} from '../src/galgame-host.mjs';
import {groupSpeakers,visibleGroupMessages} from '../src/companion-store.mjs';

const until=async predicate=>{for(let n=0;n<400;n++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('fixture timeout');};
function fixture(overrides={}){const calls=[],events=[],provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'test-model'}),listProviders:()=>[{id:'fixture',name:'fixture'}],listModels:()=>[{id:'test-model'}],runTurn:async fn=>fn(),async *stream(options){calls.push(options);let response;if(options.purpose==='group-chat')response=JSON.stringify({text:'公开发言 '+calls.length,emotion:'cheerful',affection:1});else if(/情绪分类器/.test(options.system))response='cheerful';else if(/选项生成器/.test(options.system))response=JSON.stringify({positive:'一起休息',neutral:'继续聊',negative:'先安静'});else response='固定角色回复';yield {type:'text-delta',text:response};yield {type:'finish',reason:{kind:'stop'}};},...overrides};return {calls,events,provider};}
async function setup(options={}){const root=mkdtempSync(join(tmpdir(),'ai-buddy-companion-')),f=fixture(options);let game=await createGalgame({dataRoot:root,provider:f.provider,model:'test-model',onChatCommitted:event=>f.events.push(event)});return {root,...f,get game(){return game;},async restart(){game.close();game=await createGalgame({dataRoot:root,provider:f.provider,model:'test-model',onChatCommitted:event=>f.events.push(event)});return game;}};}
const state=presentedState;
const groupIdle=async(game,id,phase='idle')=>until(async()=>(await state(game)).groupRuntime?.status===phase);

test('Dynamic cards preserve multiline, explicit empty and stable identity across rename/restart; image-free chat is usable',async()=>{
 const f=await setup();try{
  const created=await f.game.action('companion-character-save',{name:'第十二位',fields:{personality:{mode:'custom',value:'第一段。\n\n第二段。'},greeting:{mode:'empty'},tone:{mode:'custom',value:'简洁'},visual:{mode:'empty'}},examples:[{scene:'初遇',speaker:'角色',text:'你好。'}]});const id=created.card.id;
  await f.game.action('companion-character-select',{id});let view=await f.game.action('view');assert.equal(view.current,id);assert.equal(view.sprite,null);assert.equal(view.hasCustomSprite,false);assert.equal(view.name,'第十二位');
  const reply=await f.game.action('chat',{text:'你好'});assert.ok(reply.history.some(row=>row.text==='固定角色回复'));const request=f.calls.find(row=>!row.purpose&&!/情绪分类器|选项生成器/.test(row.system));assert.ok(request.system.includes('第一段。\\n\\n第二段。'));assert.ok(!request.system.includes('你是一位深海女仆'));
  await f.game.action('companion-character-save',{id,name:'改名后'});await f.restart();const s=await state(f.game);assert.equal(s.activeCharacterId,id);assert.equal(s.characters.find(row=>row.id===id).name,'改名后');assert.equal(s.characters.find(row=>row.id===id).effective.greeting,'');assert.equal(s.characters.find(row=>row.id===id).effective.personality,'第一段。\n\n第二段。');assert.equal(s.messages.filter(row=>row.role==='assistant').length,1);
 }finally{f.game.close();}
});

test('Persona conversations and drafts isolate full originals while bounded model context never crosses identities',async()=>{
 const f=await setup();try{
  const body='私密经历甲'.repeat(140);await f.game.action('chat',{text:body});let s=await state(f.game);const defaultConversation=s.activeConversationId;assert.equal(s.messages.find(row=>row.role==='user').text,body);
  await f.game.action('companion-conversation-update',{id:defaultConversation,draft:'身份甲的草稿'});const added=await f.game.action('companion-persona-save',{name:'身份乙',nickname:'乙',background:'乙的人生'});await f.game.action('companion-persona-select',{id:added.persona.id});s=await state(f.game);assert.equal(s.messages.length,0);assert.equal(s.draft,'');await f.game.action('chat',{text:'身份乙的第一句'});const primary=f.calls.filter(row=>!row.purpose&&!/情绪分类器|选项生成器/.test(row.system)).at(-1);assert.ok(!JSON.stringify(primary.messages).includes('私密经历甲'));assert.ok(primary.system.includes('乙的人生'));
  await f.game.action('companion-persona-select',{id:'default'});s=await state(f.game);assert.equal(s.activeConversationId,defaultConversation);assert.equal(s.draft,'身份甲的草稿');assert.equal(s.messages.find(row=>row.role==='user').text,body);await f.restart();assert.equal((await state(f.game)).draft,'身份甲的草稿');
 }finally{f.game.close();}
});

test('Independent and shared relationship records round-trip without summing; touch quota belongs to actual role across Personas/restart',async()=>{
 const f=await setup();try{const initial=(await state(f.game)).relationship;assert.deepEqual({level:initial.level,affection:initial.affection},{level:1,affection:0});
  const t=Date.now();assert.equal((await f.game.touch({characterId:'claude',personaId:'default',eventId:'touch1',at:t})).awarded,true);
  const added=await f.game.action('companion-persona-save',{name:'乙'});await f.game.action('companion-persona-select',{id:added.persona.id});assert.equal((await f.game.touch({characterId:'claude',personaId:added.persona.id,eventId:'touch2',at:t+1000})).reason,'cooldown');assert.equal((await f.game.touch({characterId:'claude',personaId:added.persona.id,eventId:'touch3',at:t+60000})).awarded,true);
  await f.game.action('companion-character-select',{id:'claude'});assert.equal((await state(f.game)).relationship.affection,1);await f.game.action('companion-relationship-mode',{characterId:'claude',mode:'shared',sourcePersonaId:'default'});assert.equal((await state(f.game)).relationship.affection,1);await f.game.touch({characterId:'claude',personaId:added.persona.id,eventId:'touch4',at:t+120000});assert.equal((await state(f.game)).relationship.affection,2);
  await f.game.action('companion-relationship-mode',{characterId:'claude',mode:'independent'});assert.equal((await state(f.game)).relationship.affection,1);await f.game.action('companion-persona-select',{id:'default'});assert.equal((await state(f.game)).relationship.affection,1);await f.restart();assert.equal((await f.game.touch({characterId:'claude',personaId:'default',eventId:'touch4',at:t+180000})).reason,'duplicate');
 }finally{f.game.close();}
});

test('User-only correction preserves original and request input versions; no AI edit, regeneration or extra request',async()=>{
 const f=await setup();try{await f.game.action('chat',{text:'原句'});let s=await state(f.game),user=s.messages.find(row=>row.role==='user'),ai=s.messages.find(row=>row.role==='assistant'&&row.request);await assert.rejects(()=>f.game.action('companion-message-edit',{id:user.id,text:'修正'}),/设置/);await f.game.action('companion-settings',{allowUserMessageEdit:true});const before=f.calls.length;await assert.rejects(()=>f.game.action('companion-message-edit',{id:ai.id,text:'伪造'}),/只能更正/);await f.game.action('companion-message-edit',{id:user.id,text:'修正'});assert.equal(f.calls.length,before);s=await state(f.game);user=s.messages.find(row=>row.id===user.id);assert.equal(user.originalText,'原句');assert.equal(user.revisions[0].text,'原句');assert.equal(user.text,'修正');assert.equal(s.messages.find(row=>row.id===ai.id).request.inputUserText,'原句');await f.game.action('chat',{text:'下一句'});assert.ok(JSON.stringify(f.calls.filter(row=>!row.purpose&&!/情绪分类器|选项生成器/.test(row.system)).at(-1).messages).includes('用户更正记录'));
 }finally{f.game.close();}
});

test('Group natural/list roster can exceed three; only continue executes next member and prompts omit private transcript',async()=>{
 const f=await setup();try{await f.game.action('chat',{text:'私聊机密ABC'});const saved=await f.game.action('companion-group-save',{name:'四人',memberIds:['deepseek','claude','qwen','kimi'],mode:'list',scene:'只谈公开事务'});await f.game.action('companion-group-select',{id:saved.group.id,entryCharacterId:'qwen'});await f.game.action('companion-group-send',{id:saved.group.id,text:'大家好'});await groupIdle(f.game,saved.group.id,'awaiting-continue');assert.equal(f.calls.filter(row=>row.purpose==='group-chat').length,1);assert.equal((await state(f.game)).groupRuntime.queue.length,3);
  for(let index=0;index<3;index++){await f.game.action('companion-group-continue',{id:saved.group.id});await groupIdle(f.game,saved.group.id,index===2?'idle':'awaiting-continue');}
  const calls=f.calls.filter(row=>row.purpose==='group-chat');assert.equal(calls.length,4);assert.ok(calls.every(row=>!JSON.stringify(row).includes('私聊机密ABC')));assert.ok(JSON.stringify(calls[1].messages).includes('公开发言'));assert.equal((await state(f.game)).activeCharacterId,'deepseek');assert.equal((await state(f.game)).groupMessages.filter(row=>row.role==='assistant').length,4);
 }finally{f.game.close();}
});

test('Join/leave intervals enforce absence knowledge without deleting original history',async()=>{
 const f=await setup();try{const saved=await f.game.action('companion-group-save',{name:'区间',memberIds:['deepseek'],mode:'list'}),id=saved.group.id;await f.game.action('companion-group-select',{id});await f.game.action('companion-group-send',{id,text:'加入前秘密'});await groupIdle(f.game,id);await f.game.action('companion-group-member',{id,characterId:'claude',op:'join'});await f.game.action('companion-group-send',{id,text:'新成员能知道的第一件事',forceCharacterId:'claude'});await groupIdle(f.game,id);let last=f.calls.filter(row=>row.purpose==='group-chat').at(-1);assert.ok(!JSON.stringify(last.messages).includes('加入前秘密'));assert.ok(JSON.stringify(last.messages).includes('新成员能知道'));
  await f.game.action('companion-group-member',{id,characterId:'claude',op:'leave'});await f.game.action('companion-group-send',{id,text:'离开期间秘密'});await groupIdle(f.game,id);await f.game.action('companion-group-member',{id,characterId:'claude',op:'join'});await f.game.action('companion-group-send',{id,text:'重返后公开转述：旧秘密有一部分',forceCharacterId:'claude'});await groupIdle(f.game,id);last=f.calls.filter(row=>row.purpose==='group-chat').at(-1);assert.ok(!JSON.stringify(last.messages).includes('离开期间秘密'));assert.ok(!JSON.stringify(last.messages).includes('加入前秘密'));assert.ok(JSON.stringify(last.messages).includes('新成员能知道'));assert.ok(JSON.stringify(last.messages).includes('公开转述'));assert.ok((await state(f.game)).groupMessages.some(row=>row.text==='离开期间秘密'));
 }finally{f.game.close();}
});

test('Stopping an in-flight group cancels queued speakers and excludes undisplayed output from history',async()=>{
 let started=false;const f=await setup({async *stream(options){if(options.purpose==='group-chat'){started=true;yield {type:'text-delta',text:'不应该呈现'};await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));throw Error('aborted');}yield {type:'text-delta',text:'normal'};}});try{const saved=await f.game.action('companion-group-save',{memberIds:['deepseek','claude'],mode:'list'}),id=saved.group.id;await f.game.action('companion-group-select',{id});await f.game.action('companion-group-send',{id,text:'开始'});await until(()=>started);await f.game.action('companion-group-stop',{id});await new Promise(resolve=>setTimeout(resolve,20));const s=await state(f.game);assert.equal(s.groupRuntime.status,'idle');assert.equal(s.groupMessages.filter(row=>row.role==='assistant').length,0);assert.equal(f.events.length,0);await f.restart();assert.equal((await state(f.game)).groupRuntime.status,'idle');assert.equal((await state(f.game)).groupMessages.filter(row=>row.role==='assistant').length,0);
 }finally{f.game.close();}
});

test('Touch rolling 60-second and local daily cap survive restart without affecting Token records',async()=>{
 const f=await setup();try{const base=new Date(2026,9,18,12,0,0).getTime();for(let index=0;index<30;index++){const result=await f.game.touch({characterId:'deepseek',personaId:'default',eventId:'day-'+index,at:base+index*60000});assert.equal(result.awarded,true);}const at=base+30*60000;assert.equal((await f.game.touch({characterId:'deepseek',eventId:'limit',at})).reason,'daily-limit');assert.equal(f.calls.length,0);await f.restart();assert.equal((await f.game.touch({characterId:'deepseek',eventId:'limit2',at:at+60000})).reason,'daily-limit');const tomorrow=base+86400000;assert.equal((await f.game.touch({characterId:'deepseek',eventId:'tomorrow',at:tomorrow})).awarded,true);assert.equal(f.calls.length,0);
 }finally{f.game.close();}
});

test('Natural scheduling binds explicit member IDs, muted presence and fallback without three-person cap',()=>{
 const g={memberIds:['a','b','c','d','e'],mutedIds:['e'],talkativeness:{a:0,b:1,c:1,d:1,e:1},mode:'natural'};assert.deepEqual(groupSpeakers(g,{cards:Object.fromEntries(Object.entries(g.talkativeness).map(([id,talkativeness])=>[id,{talkativeness}])),mentionIds:['a','a','e'],random:()=>.9}),['a','b','c','d']);assert.deepEqual(groupSpeakers(g,{cards:Object.fromEntries(g.memberIds.map(id=>[id,{talkativeness:0}])),random:()=>.8}),['d']);assert.deepEqual(groupSpeakers(g,{forceCharacterId:'e'}),['e']);
 const messages=[{seq:1,text:'before'},{seq:2,text:'known'},{seq:3,text:'away'},{seq:4,text:'rejoin'}];assert.deepEqual(visibleGroupMessages({messages,intervals:{a:[{start:2,end:2},{start:4,end:null}]}},'a').map(row=>row.text),['known','rejoin']);
});
