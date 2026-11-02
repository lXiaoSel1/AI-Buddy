import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseGroupReply,groupTextDecoder} from '../src/output-events.mjs';
import {lenientReplyText} from '../src/companion-service.mjs';
import {groupSpeakerState} from '../src/group-stage.mjs';
import {autoProgress,AutoRoundStrip} from '../src/chat-r95-ui.mjs';
import {setLocale} from '../src/i18n.mjs';

test('GG-C1 plain compatibility is neutral at all chunk boundaries and preserves dialogue literally',()=>{
 for(const raw of ['DeepSeek：「我很开心，也喜欢你。」','{叹气} 我再想想。','[停顿] 好吧。'])for(let size=1;size<=raw.length;size++){
  const decoder=groupTextDecoder();for(let offset=0;offset<raw.length;offset+=size)decoder.feed(raw.slice(offset,offset+size));
  assert.deepEqual(decoder.finish(),{text:raw,emotion:'normal',emotionSource:'compatibility',affection:0,format:'plain'});
 }
});
test('GG-C1 damaged or incomplete structured replies never become plain compatibility dialogue',()=>{
 for(const raw of ['{"text":"cut off','{"text":"complete text"','{"emotion":"shy"}','{"text":null}','{"text":""}','{text:"wrong key syntax"}',"{'text':'wrong quotes'}",'[{"text":"wrong shape"}]','"wrong shape"','```json\n{"text":"cut off','{"text":"ok"} trailing'])assert.throws(()=>parseGroupReply(raw),{code:'GROUP_REPLY_FORMAT'},raw);
 assert.throws(()=>parseGroupReply('普通但传输未结束的台词',{complete:false}),{code:'GROUP_REPLY_FORMAT'});
 assert.throws(()=>parseGroupReply('{"speak":false}'),{code:'GROUP_REPLY_FORMAT'});assert.equal(parseGroupReply('{"speak":false}',{allowSilence:true}).speak,false);
 assert.equal(parseGroupReply('```json\n{"text":"完整台词","emotion":"shy"}\n```').emotion,'shy');
});
test('GG-C1 group strictness does not change the private text extraction contract',()=>{
 assert.equal(lenientReplyText('普通私聊台词'),null);assert.equal(lenientReplyText('{叹气} 普通私聊台词'),null);assert.equal(lenientReplyText('{"text":"私聊已有兼容路径"'),'私聊已有兼容路径');
});
test('GG-C1 historical display, waiting request and failed member remain distinct',()=>{
 const old={id:'old',role:'assistant',characterId:'claude',emotion:'cheerful'},runtime={status:'waiting-model',queue:['deepseek'],currentMessage:old};let value=groupSpeakerState(runtime);assert.equal(value.activeId,'deepseek');assert.equal(value.displayId,'claude');assert.equal(value.speakingId,null);
 value=groupSpeakerState({...runtime,status:'generating'});assert.equal(value.speakingId,'deepseek');value=groupSpeakerState({...runtime,status:'failed'});assert.equal(value.activeId,null);assert.equal(value.failedId,'deepseek');assert.equal(value.displayId,'claude');assert.equal(value.speakingId,null);
});
test('GG-C1 unresolved Auto pending overrides global busy and wait hints without claiming a speaker or following member',()=>{
 setLocale('zh-CN');for(const status of ['failed','unknown','cancelled']){const auto={status:'active',mode:'rounds',roundLimit:6,roundIndex:0,opportunityIndex:0,members:['deepseek','gpt'],pending:{characterId:'deepseek',status}},value=autoProgress(auto);assert.equal(value.status,'paused');assert.equal(value.speaking,null);assert.equal(value.next,null);
  const html=renderToStaticMarkup(React.createElement(AutoRoundStrip,{view:{groupId:'g',auto,autoWait:{reason:'presenting'}},onAction(){},busy:true,speaker:'Claude'}));assert.match(html,/Auto 已暂停/);assert.doesNotMatch(html,/Claude|下一位|正在说|正在回复|等待上一句显示|ui-spinner/);
 }
});
