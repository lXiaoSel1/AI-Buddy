import test from 'node:test';
import assert from 'node:assert/strict';

const label='[2026-10-31; character-statement; persona:default]';
const helper=()=>import('../src/reply-source-labels.mjs');
test('only an unquoted exact legacy host source prefix is removed',async()=>{
 const {filterReplySourceLabels:filter}=await helper();
 assert.equal(filter(label+' 好的，今天见。'),'好的，今天见。');
 assert.equal(filter('[原始日期未知；迁移记录日 2026-10-31; shared-dialogue; group:abc] '+label+' 正文'),'正文');
 for(const value of ['[2026-10-31] 日程','[2026-10-31; custom-kind; persona:default] 原文','[2026-10-31; character-statement; unknown:default] 原文','“'+label+'”是你要引用的标签。','`'+label+'`','> '+label,'```txt\n'+label+'\n```','标签是 '+label,'[2026-99-99; character-statement; persona:default] 原文'])assert.equal(filter(value),value);
 assert.equal(filter(label+' 原样引用'), '原样引用');
 assert.equal(filter(label+' 原样引用',{preserveLiteral:true}),label+' 原样引用');
});
test('source prefix buffer never exposes a recognized label split at any character',async()=>{
 const {createReplySourceFilter}=await helper(),raw=label+' 保留全部正文。\n[2026-10-31] 保留日期';
 for(let split=1;split<raw.length;split++){
  const stream=createReplySourceFilter();const first=stream.feed(raw.slice(0,split)),second=stream.feed(raw.slice(split));
  assert.ok(!first.includes('character-statement')&&!first.includes('[2026-10-31;'));assert.equal(second,'保留全部正文。\n[2026-10-31] 保留日期');assert.equal(stream.finish(),second);
 }
 const chars=createReplySourceFilter();for(const ch of raw){const visible=chars.feed(ch);assert.ok(!visible.includes('character-statement'));}assert.equal(chars.finish(),'保留全部正文。\n[2026-10-31] 保留日期');
 for(const value of ['[2026-10-31] date','[2026-10-31; custom-kind; persona:default] literal','```txt\n'+label+'\n```','“'+label+'”']){const stream=createReplySourceFilter();for(const ch of value)stream.feed(ch);assert.equal(stream.finish(),value);}
 const partial=createReplySourceFilter();assert.equal(partial.feed('[2026-10-31; character-statement; persona:def'),'');assert.equal(partial.finish(),'[2026-10-31; character-statement; persona:def');
});
test('only an affirmative request for a complete known source label enables literal preservation',async()=>{
 const {replySourceLiteralRequested:wantsLiteral,filterReplySourceLabels:filter,createReplySourceFilter}=await helper();
 const positive=['请原样引用这个标签：'+label,'把 '+label+' 逐字输出。','Quote '+label+' verbatim.','Please copy this exact label: '+label,'请原样引用 '+label+'，不要添加解释。','Please quote '+label+' without adding an explanation.'];
 const negative=['请不要再引用 '+label,'Do not quote '+label,"Please don't copy "+label,'Never quote '+label,'别原样输出 '+label,'把 '+label+' 这个标签删掉。','Remove '+label+' from your replies.','为什么又引用了 '+label+'？请去掉。','你上次引用了 '+label+'，这不是我要的内容。','Do not reproduce this literal label: '+label];
 for(const requestText of positive){assert.equal(wantsLiteral(requestText),true,requestText);assert.equal(filter(label+' 正文',{requestText}),label+' 正文');}
 for(const requestText of negative){assert.equal(wantsLiteral(requestText),false,requestText);assert.equal(filter(label+' 正文',{requestText}),'正文');const stream=createReplySourceFilter({requestText});for(const ch of label+' 正文')assert.ok(!stream.feed(ch).includes('character-statement'));assert.equal(stream.finish(),'正文');}
 for(const requestText of ['Please quote [2026-10-31; character-statement; persona:default','请引用 [2026-99-99; character-statement; persona:default]','请引用 [2026-10-31; unknown-kind; persona:default]','请原样输出 [2026-10-31]','Here is a literal label: '+label])assert.equal(wantsLiteral(requestText),false,requestText);
 assert.equal(filter('```text\n'+label+'\n```',{requestText:'不要再引用标签'}),'```text\n'+label+'\n```');
});
