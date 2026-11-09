import test from 'node:test';
import assert from 'node:assert/strict';
import {filterReplySourceLabels,createReplySourceFilter} from '../src/reply-source-labels.mjs';
import {voiceSpeechText} from '../src/voice/speech-text.mjs';

const citation='（[原文参考](https://zh.wikisource.org/zh-hans/example_%28poem%29)）';
test('dialogue removes attached source citations and reference-only lines without removing the answer',()=>{
 assert.equal(filterReplySourceLabels('背完啦！尤其喜欢那一句～'+citation),'背完啦！尤其喜欢那一句～');
 assert.equal(filterReplySourceLabels('这是我的感想。\n\n原文参考：https://example.test/poem'),'这是我的感想。');
});
test('normal parentheses, intentional links and explicitly requested source references remain visible',()=>{
 assert.equal(filterReplySourceLabels('芝士蛋糕（轻乳酪）很好吃。'),'芝士蛋糕（轻乳酪）很好吃。');
 assert.equal(filterReplySourceLabels('可以去[官网](https://example.test)看看。'),'可以去[官网](https://example.test)看看。');
 assert.equal(filterReplySourceLabels('给你原文。'+citation,{requestText:'请给我原文链接'}),'给你原文。'+citation);
});
test('streamed source citations never flash their URL in dialogue',()=>{
 const f=createReplySourceFilter();let last='';
 for(const piece of ['背完啦！','（[原','文参考](','https://zh.wiki','source.org/example',')）']){last=f.feed(piece);assert.ok(!last.includes('http'));}
 assert.equal(last,'背完啦！');assert.equal(f.finish(),'背完啦！');
});
test('speech reads the answer or intentional link label without the reference and URL',()=>{
 assert.equal(voiceSpeechText('背完啦！'+citation),'背完啦！');
 assert.equal(voiceSpeechText('去[官网](https://example.test/path?q=1)看看。'),'去官网看看。');
});
