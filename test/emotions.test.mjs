import test from 'node:test';
import assert from 'node:assert/strict';
import {EMOTION_KEYS,resolveEmotion,keywordEmotion,messageEmotion,shortReply} from '../src/emotions.mjs';
test('Valid model labels including neutral are authoritative; invalid responses use a local fallback',()=>{
 for(const emotion of [...EMOTION_KEYS,'normal'])assert.deepEqual(resolveEmotion('我很生气？',emotion),{emotion,emotionSource:'model'});
 assert.deepEqual(resolveEmotion('脸红了',null),{emotion:'shy',emotionSource:'keyword'});
 assert.deepEqual(resolveEmotion('今天几点？','害羞'),{emotion:'normal',emotionSource:'default'});
});
test('Fallback excludes negated or quoted feelings and an ordinary question mark',()=>{
 for(const text of ['我不生气','一点也不害怕','我不困惑','我并不感到无奈','没觉得开心','并没觉得害羞','我不累','我没有心动','今天几点？','为什么会下雨？','他说“我很生气”',"他说'我很生气'"])assert.equal(keywordEmotion(text),'normal',text);
 assert.equal(keywordEmotion('我不生气，想认真讨论方案'),'serious');assert.equal(keywordEmotion('这个方案我没看懂'),'confused');
 for(const text of ['好吧','别这样','才不','项目在哪里？','报告是哪个文件？','鬼是什么？'])assert.equal(keywordEmotion(text),'normal',text);
 assert.equal(keywordEmotion('太过分了，但也好开心'),'angry');
 const examples={cheerful:'太好了，好棒',shy:'不好意思，脸红了',serious:'认真分析方案',confused:'没听懂',angry:'太过分了',frightened:'别吓我',exasperated:'唉，累死了',starry:'好美，好浪漫'};
 for(const [emotion,text] of Object.entries(examples))assert.equal(keywordEmotion(text),emotion);
});
test('Historical labels survive; new neutral labels stay neutral; bubbles use a short real reply',()=>{
 assert.equal(messageEmotion({emotion:'shy',text:'生气'}),'shy');assert.equal(messageEmotion({emotion:'normal',emotionSource:'model',text:'生气'}),'normal');assert.equal(messageEmotion({text:'没听懂'}),'confused');
 assert.equal(shortReply('主人，今天辛苦了！ 后面是完整回答。'),'主人，今天辛苦了！');assert.equal(Array.from(shortReply('鲸'.repeat(50))).length,40);
 assert.equal(shortReply('Hello. A longer reply follows.'),'Hello.');
});
