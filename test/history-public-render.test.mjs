import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {HistoryExpressionText,HistoryExpressionPreview} from '../src/galgame-redesign.mjs';
import {parseGalgameReply} from '../src/galgame-expressions.mjs';
import {setLocale} from '../src/i18n.mjs';

const render=(Component,props)=>renderToStaticMarkup(React.createElement(Component,props));
setLocale('zh-CN');

function sentReply(id,taggedText,characterId){
 const parsed=parseGalgameReply(taggedText,'normal');
 return {id,role:'assistant',characterId,text:parsed.text,emotion:parsed.emotion,emotionSentences:parsed.sentences};
}

function previewMarkup(message,name,emotion,text){
 return render(HistoryExpressionPreview,{
  preview:{character:{id:message.characterId,name},emotion,text},
  portrait:(character,id)=>React.createElement('span',{'aria-label':character.name+' '+id+' portrait'}),
  onClose(){},
 });
}

test('plain imported history remains readable without sentence-emotion metadata',()=>{
 const message={id:'plain',role:'assistant',text:'你好。'};
 assert.equal(render(HistoryExpressionText,{message,text:message.text}),'你好。');
});

test('private emotional history names the expression on the transcript and inside the preview',()=>{
 const message=sentReply('private','[[emotion:gentle]]你好。','deepseek');
 const html=render(HistoryExpressionText,{message,text:message.text,onPreview(){}});
 assert.match(html,/<button[^>]*title="查看这句的表情 · 温柔"[^>]*>你好。<\/button>/);
 const preview=previewMarkup(message,'DeepSeek','gentle','你好。');
 assert.match(preview,/<h2>DeepSeek · 温柔<\/h2>/);
 assert.match(preview,/<p[^>]*>你好。<\/p>/);
});

test('group emotional history opens a named expression preview for each participant sentence',()=>{
 const message=sentReply('group','[[emotion:温柔]]大家好。[[emotion:思考]]我想想。','claude');
 const html=render(HistoryExpressionText,{message,text:message.text,onPreview(){}});
 assert.match(html,/<button[^>]*title="查看这句的表情 · 温柔"[^>]*>大家好。<\/button>/);
 assert.match(html,/<button[^>]*title="查看这句的表情 · 思考"[^>]*>我想想。<\/button>/);
 const preview=previewMarkup(message,'Claude','thinking','我想想。');
 assert.match(preview,/<h2>Claude · 思考<\/h2>/);
 assert.match(preview,/<p[^>]*>我想想。<\/p>/);
});

test('the normal-expression preview names the standard plain emotion',()=>{
 const message={id:'old',characterId:'deepseek'};
 assert.match(previewMarkup(message,'DeepSeek','normal','你好。'),/<h2>DeepSeek · 平常<\/h2>/);
});
