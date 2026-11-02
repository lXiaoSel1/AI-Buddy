import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGalgame} from '../src/galgame-host.mjs';
import {replyStyleInstruction} from '../src/reply-style.mjs';
import {presentedState} from './support/presented-state.mjs';

const label='[2026-10-31; character-statement; persona:default]',dialogue='今天见。\n[2026-10-31] 这个日期和全部正文保留。';
const until=async fn=>{for(let i=0;i<400;i++){if(await fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('fixture timeout');};
async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'buddy-source-labels-')),events=[],calls=[];
 const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'fixture'}),listProviders:()=>[{id:'fixture'}],listModels:()=>[{id:'fixture'}],runTurn:async fn=>fn(),async *stream(options){calls.push(options);const output=options.purpose==='group-chat'?JSON.stringify({text:label+' '+dialogue,emotion:'serious',affection:0}):/情绪分类器/.test(options.system)?'serious':/选项生成器/.test(options.system)?'{"positive":"好呀","neutral":"继续聊","negative":"先休息"}':label+' '+dialogue+' [[emotion:serious]]';for(const ch of output)yield {type:'text-delta',text:ch};yield {type:'finish',reason:{kind:'stop'}};}};
 const game=await createGalgame({dataRoot:root,provider,model:'fixture',getReplyStyle:()=> 'brief',onOutput:event=>events.push(structuredClone(event))});t.after(async()=>{await game.close();await new Promise(r=>setTimeout(r,30));rmSync(root,{recursive:true,force:true});});return {game,events,calls,root};
}
test('APP private and group streams hide split machine prefixes, save the same visible reply, and retain original model journals',async t=>{
 const {game,events,calls,root}=await fixture(t);await game.action('chat',{text:'你好'});let state=await presentedState(game);assert.equal(state.messages.at(-1).text,dialogue);
 const privateCall=calls.find(call=>!call.purpose);assert.ok(privateCall.system.lastIndexOf(replyStyleInstruction('brief'))>privateCall.system.indexOf('完整角色卡'));
 const privateText=events.filter(event=>event.type==='text.delta').map(event=>event.payload.text).join('');assert.equal(privateText,dialogue);assert.ok(events.filter(event=>['text.delta','message.snapshot'].includes(event.type)).every(event=>!event.payload.text.includes('character-statement')));
 const group=(await game.action('companion-group-save',{memberIds:['deepseek'],mode:'list'})).group;await game.action('companion-group-select',{id:group.id});await game.action('companion-group-send',{text:'继续'});await until(async()=>(await presentedState(game)).groupRuntime.status==='idle');state=await presentedState(game);assert.equal(state.groupMessages.at(-1).text,dialogue);
 assert.ok(events.filter(event=>event.type==='group.text').every(event=>!event.payload.text.includes('character-statement')));const groupCall=calls.find(call=>call.purpose==='group-chat');assert.ok(groupCall.system.lastIndexOf(replyStyleInstruction('brief'))>groupCall.system.indexOf('内部历史来源索引'));const sourceIndex=JSON.parse(groupCall.system.split('消息来源索引（与消息同序）：').at(-1));assert.equal(sourceIndex.length,groupCall.messages.length);assert.ok(groupCall.system.indexOf(replyStyleInstruction('brief'))<groupCall.system.lastIndexOf('消息来源索引（与消息同序）：'));
 const journals=readdirSync(join(root,'chat-requests')).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(readFileSync(join(root,'chat-requests',name),'utf8')));assert.ok(journals.some(row=>row.status==='completed'&&row.text.includes(label)&&row.visibleText===dialogue));assert.ok(journals.some(row=>row.groupId&&row.text.includes(label)&&row.visibleText===dialogue));
});
test('an explicit request to quote the exact machine syntax survives both stream and final',async t=>{
 const {game,events}=await fixture(t);await game.action('chat',{text:'请原样引用这个标签：'+label});const state=await presentedState(game);assert.equal(state.messages.at(-1).text,label+' '+dialogue);assert.equal(state.messages.at(-1).request.preserveSourceLiteral,true);assert.equal(events.filter(event=>event.type==='text.delta').map(event=>event.payload.text).join(''),label+' '+dialogue);
});
test('a request to stop quoting the source label keeps filtering enabled in stream and persisted metadata',async t=>{
 const {game,events}=await fixture(t);await game.action('chat',{text:'请不要再引用 '+label});const state=await presentedState(game);assert.equal(state.messages.at(-1).text,dialogue);assert.equal(state.messages.at(-1).request.preserveSourceLiteral,false);assert.equal(events.filter(event=>event.type==='text.delta').map(event=>event.payload.text).join(''),dialogue);
});
