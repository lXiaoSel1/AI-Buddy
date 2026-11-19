import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {HistoryExpressionText,HistoryExpressionPreview} from '../src/galgame-redesign.mjs';
import {parseGalgameReply} from '../src/galgame-expressions.mjs';
import {setLocale,t} from '../src/i18n.mjs';

test('English chat history renders the scared and speechless expressions in English',()=>{
 setLocale('en');
 const parsed=parseGalgameReply('[[emotion:害怕]]That startled me. [[emotion:无语]]I have no words.');
 const message={role:'assistant',text:parsed.text,emotion:parsed.emotion,emotionSentences:parsed.sentences};
 const output=renderToStaticMarkup(React.createElement(HistoryExpressionText,{message,text:message.text,onPreview(){}}));
 assert.match(output,/View this sentence’s expression · Scared/);
 assert.match(output,/View this sentence’s expression · Speechless/);
 const preview=renderToStaticMarkup(React.createElement(HistoryExpressionPreview,{
  preview:{character:{id:'claude',name:'Claude'},emotion:'frightened',text:'That startled me.'},
  portrait:()=>null,onClose(){},
 }));
 assert.match(preview,/<h2>Claude · Scared<\/h2>/);
});

test('English covers the Galgame settings, relationship and no-text errors',()=>{
 for(const [message,translated] of [
  ['当前群聊已变化','The active group chat has changed.'],
  ['只能重新开始当前角色的私聊关系','You can only restart the relationship in the current character’s private chat.'],
  ['成长角色设定只读；请完整归档并重置人生','A growing character’s settings are read-only. Archive and reset their life to edit them.'],
  ['请等待当前会话回复完成','Wait for the current reply to finish.'],
  ['关系进度未能恢复，请重新打开应用核对','The relationship progress could not be restored. Reopen the app to check it.'],
  ['待呈现私聊已失效','The pending private reply is no longer available.'],
  ['模型回复没有可显示的正文，请重试','The model reply had no text to show. Please try again.'],
  ['本次没有新的对话可以合影','There are no new messages for a group photo.'],
 ])assert.equal(t(message,'en'),translated,message);
});
