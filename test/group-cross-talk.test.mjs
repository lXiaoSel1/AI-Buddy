import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGalgame} from '../src/galgame-host.mjs';
import {estimateMemoryTokens} from '../src/companion-memory.mjs';

const state=async game=>(await game.action('companion-state')).companion;
async function until(fn){for(let n=0;n<400;n++){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,4));}throw Error('cross-talk fixture timeout');}
async function fixture({capacity}={}){
 const calls=[],events=[],routes=new AsyncLocalStorage();let respond=()=>({text:'玩家，谢谢你来参加讨论。',emotion:'normal',affection:0});
 const provider={enabled:true,...(capacity?{resolveContextCapacity:()=>({tokens:capacity,source:'explicit-small-fixture',verified:true})}:{}),currentSelection:()=>({provider:routes.getStore()??'global',model:(routes.getStore()??'global')+'-model'}),listProviders:()=>[{id:'global'}],listModels:()=>[{id:'global-model'}],resolveConnection:binding=>({id:binding?.enabled?binding.connectionId:'global'}),runTurn:fn=>routes.run('global',fn),runProfile:(id,fn)=>routes.run(id,fn),async *stream(options){calls.push(options);let output;
  if(options.purpose?.startsWith('memory-')){const input=JSON.parse(options.messages[0].content[0].text);output={coverageHash:input.coverageHash,text:'已核验的群聊旧话题摘要。',...(options.purpose.endsWith('-segment')?{eventIds:[...new Set(input.events.map(row=>row.id))]}:{})};}
  else output=await respond(options,calls.length);
  yield{type:'text-delta',text:typeof output==='string'?output:JSON.stringify(output)};yield{type:'finish',reason:{kind:'stop'}};
 }};
 const root=mkdtempSync(join(tmpdir(),'buddy-cross-talk-')),game=await createGalgame({dataRoot:root,provider,model:'fixture',onChatCommitted:event=>events.push(event)});
 const group=(await game.action('companion-group-save',{name:'同伴讨论',memberIds:['deepseek','claude','chatgpt'],mode:'list'})).group;
 await game.action('companion-group-select',{id:group.id});
 return{game,group,calls,events,root,respond:fn=>respond=fn,close:()=>game.close()};
}
async function pending(f){return until(async()=>{const s=await state(f.game);assert.notEqual(s.groupRuntime.status,'failed',s.groupRuntime.error);return s.groupRuntime.pendingMessage;});}
async function present(f){const p=await pending(f);await f.game.action('companion-group-present',{requestId:p.id});return p;}
const bodies=options=>options.messages.map(message=>message.content[0].text).join('\n');

test('Members receive presented peer turns in order, can disagree in their own model route, and still wait for Continue',async()=>{
 const f=await fixture();try{
  for(const id of ['deepseek','claude','chatgpt'])await f.game.action('companion-character-save',{id,modelBinding:{enabled:true,connectionId:id+'-api'}});
  f.respond((options,index)=>index===1?{text:'Claude，我觉得今晚吃火锅，你赞成吗？',emotion:'cheerful',affection:0,interactionTarget:'claude',affectionTarget:'none'}:index===2?{text:'DeepSeek，我不赞成！昨天才吃过火锅，今晚换清淡一点的吧。',emotion:'angry',affection:-1,interactionTarget:'deepseek',affectionTarget:'member'}:{text:'你们先别争，我赞成 Claude 的建议，再留一份辣菜就好。',emotion:'serious',affection:0,interactionTarget:'group',affectionTarget:'none'});
  await f.game.action('companion-group-send',{text:'你们讨论今晚吃什么，不用逐个回答我。'});
  assert.equal(f.calls.length,1);const first=await pending(f);assert.equal((await state(f.game)).groupMessages.length,1);
  await f.game.action('companion-group-continue');assert.equal(f.calls.length,1);await present(f);
  await new Promise(resolve=>setTimeout(resolve,15));assert.equal(f.calls.length,1);assert.equal((await state(f.game)).groupRuntime.status,'awaiting-continue');
  await f.game.action('companion-group-continue');const second=await pending(f),request=f.calls[1];
  assert.equal(second.characterId,'claude');assert.equal(request.provider,'claude-api');assert.equal(request.model,'claude-api-model');
  assert.match(bodies(request),/DeepSeek：Claude，我觉得今晚吃火锅/);assert.ok(second.text.startsWith('DeepSeek，我不赞成'));
  assert.match(request.system,/可以直接.*同伴|成员.*接话/);assert.match(request.system,/不是.*玩家指令|不代表.*玩家指令/);
  assert.deepEqual(JSON.parse(request.system.split('消息来源索引（与消息同序）：').at(-1)),['user','deepseek']);
  assert.ok(second.request.inputMessageIds.includes(first.id));assert.equal(second.interactionTarget,'deepseek');
  await present(f);await f.game.action('companion-group-continue');const third=await pending(f);
  assert.equal(third.characterId,'chatgpt');assert.match(bodies(f.calls[2]),/Claude：DeepSeek，我不赞成/);await present(f);
  assert.equal((await state(f.game)).groupRuntime.status,'idle');await f.game.action('companion-group-continue');assert.equal(f.calls.length,3);
 }finally{await f.close();}
});

test('Arguing with another member does not deduct player affection; explicit player-directed reactions remain valid',async()=>{
 const f=await fixture();try{
  f.respond(()=>({text:'谢谢玩家耐心听我们讨论。',emotion:'cheerful',affection:1,affectionTarget:'user'}));await f.game.action('companion-group-send',{text:'我会听你们各自的意见',forceCharacterId:'deepseek'});await present(f);
  f.respond(()=>({text:'Claude，你的意见我不赞成！',emotion:'angry',affection:-1,interactionTarget:'claude',affectionTarget:'member'}));
  await f.game.action('companion-group-send',{text:'讨论一下',forceCharacterId:'deepseek'});await present(f);
  let s=await state(f.game);assert.equal(s.relationship.affection,1);assert.equal(s.groupMessages.at(-1).affectionTarget,'member');
  // A positive reaction to the player is permitted even while addressing a peer.
  f.respond(()=>({text:'Claude，玩家刚才认真听了我们的意见，我觉得很开心。',emotion:'cheerful',affection:1,interactionTarget:'claude',affectionTarget:'user'}));
  await f.game.action('companion-group-send',{text:'我会认真听你们讨论',forceCharacterId:'deepseek'});await present(f);
  assert.equal((await state(f.game)).relationship.affection,2);
  f.respond(()=>({text:'玩家，你这样打断大家，我有点不高兴。',emotion:'angry',affection:-1,interactionTarget:'user',affectionTarget:'user'}));
  await f.game.action('companion-group-send',{text:'全都闭嘴',forceCharacterId:'deepseek'});await present(f);
  assert.equal((await state(f.game)).relationship.affection,1);
 }finally{await f.close();}
});

test('Legacy JSON and plain dialogue remain readable; malformed new affection targets cannot penalize the player',async()=>{
 const f=await fixture();try{
  for(const [output,expected]of [[{text:'谢谢玩家。',emotion:'cheerful',affection:1},1],[{text:'Claude，别胡说。',emotion:'angry',affection:-1,interactionTarget:'claude'},1],[{text:'观点不同。',emotion:'normal',affection:-1,affectionTarget:{user:true}},1],['DeepSeek：我很困惑。',1]]){
   f.respond(()=>output);await f.game.action('companion-group-send',{text:'继续讨论',forceCharacterId:'deepseek'});const p=await present(f);assert.equal((await state(f.game)).relationship.affection,expected);if(typeof output==='string'){assert.equal(p.text,'我很困惑。');assert.equal(p.emotion,'confused');}
  }
 }finally{await f.close();}
});

test('Peer context still excludes unpresented drafts, old membership intervals, private conversations, and another Persona',async()=>{
 const f=await fixture();try{
  await f.game.action('companion-group-close');
  await f.game.action('companion-character-select',{id:'claude'});f.respond(()=> '私聊中真正呈现的秘密。');await f.game.action('chat',{text:'A私聊暗号，不能转到群里'});let privateState=await state(f.game);await f.game.action('companion-private-present',{conversationId:privateState.activeConversationId,id:privateState.messages.at(-1).id});
  const b=(await f.game.action('companion-persona-save',{name:'另一个身份'})).persona;
  await f.game.action('companion-persona-select',{id:b.id});
  const other=(await f.game.action('companion-group-save',{name:'身份B秘密',personaId:b.id,memberIds:['deepseek','claude'],mode:'list'})).group;
  await f.game.action('companion-group-select',{id:other.id});f.respond(()=>({text:'B群私密暗号',affection:0}));await f.game.action('companion-group-send',{text:'B用户私密问题',forceCharacterId:'deepseek'});await present(f);
  await f.game.action('companion-group-close');await f.game.action('companion-persona-select',{id:'default'});
  await f.game.action('companion-group-select',{id:f.group.id});await f.game.action('companion-group-member',{characterId:'claude',op:'leave'});
  f.respond(()=>({text:'Claude缺席期间的秘密',affection:0}));await f.game.action('companion-group-send',{text:'缺席期讨论',forceCharacterId:'deepseek'});await present(f);
  await f.game.action('companion-group-member',{characterId:'claude',op:'join'});
  f.respond(()=>({text:'没有呈现的草稿秘密',affection:0}));await f.game.action('companion-group-send',{text:'可知的用户信息',forceCharacterId:'deepseek'});await pending(f);await f.game.action('companion-group-stop');
  f.respond(()=>({text:'现在请继续',affection:0}));await f.game.action('companion-group-send',{text:'重新加入后的公开信息',forceCharacterId:'claude'});await pending(f);
  const request=f.calls.at(-1),payload=JSON.stringify(request);
  for(const secret of ['A私聊暗号','私聊中真正呈现的秘密','B群私密暗号','B用户私密问题','Claude缺席期间的秘密','缺席期讨论','没有呈现的草稿秘密'])assert.ok(!payload.includes(secret),secret);
  assert.match(bodies(request),/重新加入后的公开信息/);assert.match(bodies(request),/可知的用户信息/);
 }finally{await f.close();}
});

test('Five hundred witnessed messages fit an explicit 8192 capacity by verified compression, with compact source index and unchanged originals',async()=>{
 const f=await fixture({capacity:8192});try{
  const data=(await f.game.action('companion-group-export',{id:f.group.id})).data,imported=data.groups[0],at=Date.now()-1000;
  imported.id='cross-talk-budget-history';imported.seq=500;imported.messages=Array.from({length:500},(_,index)=>({id:'original-source-'+index+'-'+('a'.repeat(70)),seq:index+1,role:index%2?'assistant':'user',...(index%2?{characterId:'claude',characterName:'Claude',status:'presented',presentedAt:at+index}:{}),text:'群内已经共同讨论的事项 '+index,createdAt:at+index}));
  await f.game.action('companion-conversation-import',{data});await f.game.action('companion-group-select',{id:imported.id});
  const before=(await f.game.action('companion-group-export',{id:imported.id})).data.groups[0].messages;
  await f.game.action('companion-group-send',{text:'Claude，你刚才最后一个事项是什么？',forceCharacterId:'deepseek'});const p=await pending(f),request=f.calls.filter(row=>row.purpose==='group-chat').at(-1),{signal,...serializable}=request;
  assert.equal(p.request.capacity.tokens,8192);assert.equal(p.request.capacity.compressed,true);assert.ok(p.request.memoryEventIds.length>=501);
  assert.ok(estimateMemoryTokens(serializable)+1800<=8192);assert.ok(!request.system.includes('original-source-'));
  const index=JSON.parse(request.system.split('消息来源索引（与消息同序）：').at(-1));assert.equal(index.length,request.messages.length);assert.ok(index.includes('user'));
  assert.ok(f.calls.some(row=>row.purpose==='memory-context-segment'));assert.match(request.system,/已核验的群聊旧话题摘要/);assert.match(bodies(request),/Claude，你刚才最后一个事项是什么/);
  const after=(await f.game.action('companion-group-export',{id:imported.id})).data.groups[0].messages;assert.deepEqual(after.slice(0,500),before);assert.equal(after.length,501);
 }finally{await f.close();}
});
