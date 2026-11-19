import test from 'node:test';
import assert from 'node:assert/strict';
import {GALGAME_EMOTIONS, galgameReplySentences, normalizeGalgameEmotion, parseGalgameReply} from '../src/galgame-expressions.mjs';
import {dialogueVisibleText, groupTextDecoder, parseGroupReply} from '../src/output-events.mjs';

test('streamed dialogue hides complete and partial sentence-emotion tags, including Chinese names', () => {
  assert.equal(dialogueVisibleText('[[emotion:温柔]]你好。[[emotion:思'), '你好。');
  assert.equal(dialogueVisibleText('[[emotion:温柔]]你好。[[emotion:思考]]再见。'), '你好。再见。');
  assert.equal(dialogueVisibleText('原文的[[引用]]要保留。'), '原文的[[引用]]要保留。');
});

test('tagged plain group dialogue is accepted without treating its first tag as an array', () => {
  const decoder = groupTextDecoder();
  assert.equal(decoder.feed('[[emo'), '');
  assert.equal(decoder.feed('tion:开心]]大家好。'), '[[emotion:开心]]大家好。');
  assert.equal(decoder.finish().text, '[[emotion:开心]]大家好。');
  assert.throws(() => parseGroupReply('[{"text":"malformed"'), /格式不完整/);
});

test('the first unmarked sentence uses a legacy reply emotion, then tags inherit or reset locally', () => {
  const raw='开场。[[emotion:RELIEVED]]温和地说。没标也沿用。[[emotion:??]]不认识。也沿用。';
  const parsed=parseGalgameReply(raw,'shy');
  assert.equal(parsed.emotion,'shy');
  assert.deepEqual(parsed.sentences.map(row=>row.emotion),['shy','gentle','gentle','normal','normal']);
  assert.ok(parsed.sentences.every(row=>parsed.text.slice(row.start,row.end)===row.text));
  assert.deepEqual(galgameReplySentences({text:parsed.text,emotion:'shy',emotionSentences:parsed.sentences},'reply').map(row=>row.emotion),Array(5).fill('shy'));
});

test('legacy replies are projected with their original whole-reply emotion without writing to history', () => {
  const message=Object.freeze({id:'old',role:'assistant',text:'第一句话。 第二句话！',emotion:'frightened'});
  assert.deepEqual(galgameReplySentences(message).map(row=>row.emotion),['frightened','frightened']);
  assert.equal(message.emotionSentences,undefined);
  const suffix=parseGalgameReply('原来的正文。 [[emotion:受惊]]');
  assert.equal(suffix.text,'原来的正文。');
  assert.equal(suffix.sentences[0].emotion,'frightened');
  const unknown=parseGalgameReply('原来的正文。 [[emotion:unknown]]','shy');
  assert.equal(unknown.sentences[0].emotion,'normal');
  assert.equal(unknown.legacyEmotion,undefined);
});

test('all 22 canonical IDs are accepted and legacy voice aliases map to approved names', () => {
  assert.equal(GALGAME_EMOTIONS.length,22);
  assert.equal(new Set(GALGAME_EMOTIONS).size,22);
  for(const id of GALGAME_EMOTIONS)assert.equal(normalizeGalgameEmotion(id),id);
  for(const [label,id] of Object.entries({温柔:'gentle',无奈:'exasperated',开心:'cheerful',哈欠:'normal',worried:'sad',relieved:'gentle',neutral:'normal',sleep:'asleep'}))assert.equal(normalizeGalgameEmotion(label),id);
});

test('quoted time and numeric punctuation do not displace the sentence starting point', () => {
  const {text,sentences}=parseGalgameReply('[[emotion:温柔]] 「是 3.14 吗？」 [[emotion:得意]] 对！');
  assert.deepEqual(sentences.map(row=>[row.text,row.emotion]),[['「是 3.14 吗？」','gentle'],['对！','smug']]);
  assert.ok(sentences.every(row=>text.slice(row.start,row.end)===row.text));
});

test('a final truncated emotion marker stays out of the stored dialogue', () => {
  const parsed=parseGalgameReply('[[emotion:温柔]]你好。[[emotion:没写完]');
  assert.equal(parsed.text,'你好。');
  assert.deepEqual(parsed.sentences.map(row=>row.emotion),['gentle']);
});

test('displayed group prefixes are removed lazily from stored sentence offsets',()=>{
  const original='DeepSeek：[[emotion:温柔]]我听着。[[emotion:smug]]我猜到了。';
  const parsed=parseGalgameReply(original);
  const offset='DeepSeek：'.length;
  const message={text:parsed.text.slice(offset),emotion:parsed.emotion,emotionSentences:parsed.sentences,emotionSentenceOffset:offset};
  assert.deepEqual(galgameReplySentences(message).map(row=>[row.text,row.emotion]),[['我听着。','gentle'],['我猜到了。','smug']]);
  assert.deepEqual(galgameReplySentences({...message,emotionSentences:undefined,emotion:'shy'}).map(row=>row.emotion),['shy','shy']);
});
