import test from 'node:test';
import assert from 'node:assert/strict';
import * as styles from '../src/reply-style.mjs';

test('shared style resolution gives valid conversation, QQ default, then global precedence',()=>{
 assert.equal(typeof styles.resolveReplyStyle,'function');
 for(const globalStyle of styles.REPLY_STYLES){
  assert.deepEqual(styles.resolveReplyStyle({globalStyle}),{style:globalStyle,source:'global'});
  for(const defaultStyle of styles.REPLY_STYLES){
   assert.deepEqual(styles.resolveReplyStyle({globalStyle,defaultStyle}),{style:defaultStyle,source:'qq-default'});
   for(const conversationStyle of styles.REPLY_STYLES)assert.deepEqual(styles.resolveReplyStyle({globalStyle,defaultStyle,conversationStyle}),{style:conversationStyle,source:'conversation'});
  }
 }
 for(const bad of ['inherit','bad','',null,{},0])assert.deepEqual(styles.resolveReplyStyle({globalStyle:'brief',defaultStyle:bad,conversationStyle:bad}),{style:'brief',source:'global'});
 assert.deepEqual(styles.resolveReplyStyle({globalStyle:'bad'}),{style:'natural',source:'global'});
 assert.deepEqual(styles.resolveReplyStyle(),{style:'natural',source:'global'});
});

test('three styles define observable expression differences and put explicit user length first',()=>{
 for(const language of ['zh-CN','en']){
  const all=styles.REPLY_STYLES.map(style=>styles.replyStyleInstruction(style,language));
  assert.equal(new Set(all).size,3);
  if(language==='en'){
   assert.match(all[0],/answer first|direct answer/i);assert.match(all[0],/unrequested|unsolicited/i);
   assert.match(all[1],/proportion|complexity/i);assert.match(all[2],/reason|steps/i);
   for(const instruction of all)assert.match(instruction,/explicit.*(?:length|detail).*precedence/i);
  }else{
   assert.match(all[0],/先.*(?:回答|回应|结论)/);assert.match(all[0],/未请求/);
   assert.match(all[1],/复杂|匹配/);assert.match(all[2],/理由|步骤/);
   for(const instruction of all)assert.match(instruction,/明确.*(?:篇幅|详略).*优先/);
  }
 }
});
