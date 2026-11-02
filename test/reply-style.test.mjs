import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGalgame} from '../src/galgame-host.mjs';
import {normalizePreferences,validatePreferencesPatch} from '../src/preferences.mjs';
import {replyStyleInstruction,REPLY_STYLES} from '../src/reply-style.mjs';
import {presentedState} from './support/presented-state.mjs';

const longReply='第一段：'+ '完整内容与角色口吻都保留。'.repeat(60)+'\n\n第二段：保留原来的换行。\n```js\nconst answer = 42;\nconsole.log(answer);\n```\n🙂';
const until=async fn=>{for(let i=0;i<300;i++){if(await fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('fixture timeout');};
async function fixture(t,{language='zh-CN',beforeTurn}={}){
 const root=mkdtempSync(join(tmpdir(),'buddy-reply-style-')),calls=[];let style='natural',turn=0;
 const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'fixture'}),listProviders:()=>[{id:'fixture'}],listModels:()=>[{id:'fixture'}],runTurn:async fn=>{await beforeTurn?.(++turn);return fn();},async *stream(options){
  calls.push(options);
  const output=options.purpose==='group-chat'?JSON.stringify({text:longReply,emotion:'serious',affection:0}):/情绪分类器/.test(options.system)?'serious':/选项生成器/.test(options.system)?'{"positive":"好呀","neutral":"继续聊","negative":"先休息"}':longReply+' [[emotion:serious]]';
  yield {type:'text-delta',text:output};yield {type:'finish',reason:{kind:'stop'}};
 }};
 let game=await createGalgame({dataRoot:root,provider,model:'fixture',getLanguage:()=>language,getReplyStyle:()=>style});
 t.after(async()=>{await game.close();await new Promise(r=>setTimeout(r,30));rmSync(root,{recursive:true,force:true});});
 return {calls,root,get game(){return game;},setStyle:value=>style=value,async reopen(){await game.close();await new Promise(r=>setTimeout(r,30));game=await createGalgame({dataRoot:root,provider,model:'fixture',getLanguage:()=>language,getReplyStyle:()=>style});}};
}

test('Reply style defaults and validation preserve the independent output token setting',()=>{
 for(const maxOutputTokens of ['auto',256,8192,65536]){
  const old=normalizePreferences({maxOutputTokens});assert.equal(old.replyStyle,'natural');assert.equal(old.maxOutputTokens,maxOutputTokens);
  for(const replyStyle of REPLY_STYLES){const patch=validatePreferencesPatch({replyStyle});assert.equal(normalizePreferences({...old,...patch}).replyStyle,replyStyle);assert.equal(old.maxOutputTokens,maxOutputTokens);}
 }
 for(const replyStyle of ['long',null,0,{},''])assert.throws(()=>validatePreferencesPatch({replyStyle}),/无效/);
 assert.equal(normalizePreferences({replyStyle:'bad'}).replyStyle,'natural');
});

for(const language of ['zh-CN','en'])test(`Private and group final requests share all three styles without auxiliary prompt leakage (${language})`,async t=>{
 const f=await fixture(t,{language});
 for(const replyStyle of REPLY_STYLES){
  f.setStyle(replyStyle);const start=f.calls.length;
  await f.game.action('chat',{text:'请按照这个话题自然回应，必要时详细说明。'});
  const calls=f.calls.slice(start),privateCall=calls.find(c=>!c.purpose);
  assert.ok(privateCall.system.includes(replyStyleInstruction(replyStyle,language)));
  assert.ok(!/每次只回复一句话|不超过40|35 words/.test(privateCall.system));
  assert.ok(privateCall.system.includes('不执行任何任务，不写文件、不调用工具'));
  assert.equal(privateCall.maxTokens,1200);assert.equal(privateCall.userLimit,true);
  for(const auxiliary of calls.filter(c=>c!==privateCall))assert.ok(!auxiliary.system.includes('Reply style:')&&!auxiliary.system.includes('回复风格：'));
  const saved=await presentedState(f.game),last=saved.messages.at(-1);assert.equal(last.text,longReply);assert.equal(last.request.replyStyle,replyStyle);assert.equal(last.emotion,'serious');
  const group=(await f.game.action('companion-group-save',{memberIds:['deepseek'],mode:'list'})).group;
  await f.game.action('companion-group-select',{id:group.id});await f.game.action('companion-group-send',{text:'聊聊这个话题'});
  await until(async()=>(await presentedState(f.game)).groupRuntime.status==='idle');
  const groupCall=f.calls.filter(c=>c.purpose==='group-chat').at(-1);assert.ok(groupCall.system.includes(replyStyleInstruction(replyStyle,language)));assert.equal(groupCall.maxTokens,1600);assert.equal(groupCall.userLimit,true);
  const state=await presentedState(f.game);assert.equal(state.groupMessages.at(-1).text,longReply);assert.equal(state.groupMessages.at(-1).request.replyStyle,replyStyle);
  await f.game.action('companion-group-close');
 }
});

test('A queued private request captures its style; the next request sees the changed preference',async t=>{
 let entered=false,release;const gate=new Promise(r=>release=r),f=await fixture(t,{beforeTurn:async turn=>{if(turn===1){entered=true;await gate;}}});
 f.setStyle('brief');const pending=f.game.action('chat',{text:'第一个请求'});await until(()=>entered);f.setStyle('detailed');release();await pending;
 assert.ok(f.calls.find(c=>!c.purpose).system.includes(replyStyleInstruction('brief')));
 await f.game.action('chat',{text:'第二个请求'});assert.ok(f.calls.filter(c=>!c.purpose).at(-1).system.includes(replyStyleInstruction('detailed')));
});

test('Custom card instructions and full multi-paragraph messages survive reload and export',async t=>{
 const f=await fixture(t),custom='自定义寡言设定：每次只回复一句话，不超过40字。用户自己写的内容必须保留。';
 const card=(await f.game.action('companion-character-save',{name:'保留卡片',fields:{personality:{mode:'custom',value:custom}},select:true})).card;
 f.setStyle('detailed');await f.game.action('chat',{text:'请给我完整的说明。'});
 const state=await presentedState(f.game),id=state.activeConversationId;
 assert.equal(state.characters.find(c=>c.id===card.id).fields.personality.value,custom);
 assert.ok(f.calls.find(c=>!c.purpose).system.includes(custom));
 const exported=(await f.game.action('companion-conversation-export',{id})).data;
 assert.equal(exported.conversations[0].messages.at(-1).text,longReply);
 await f.reopen();const reopened=await presentedState(f.game);
 const savedReply=reopened.messages.filter(m=>m.role==='assistant').at(-1);
 assert.equal(savedReply.text,longReply);assert.equal(reopened.characters.find(c=>c.id===card.id).fields.personality.value,custom);
 assert.equal(savedReply.request.replyStyle,'detailed');
});
