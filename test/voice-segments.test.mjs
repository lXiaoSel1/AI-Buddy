import assert from 'node:assert/strict';
import test from 'node:test';
import {createVoiceSegmentDecoder} from '../src/voice/segments.mjs';

test('async decoding waits for the installed voice queue before admitting the next line',async()=>{
  let release;const seen=[];
  const decoder=createVoiceSegmentDecoder({onSegment:async row=>{seen.push(row.text);if(seen.length===1)await new Promise(resolve=>release=resolve);}});
  const task=decoder.feedAsync('{"type":"segment","text":"one"}\n{"type":"segment","text":"two"}\n');
  await Promise.resolve();assert.deepEqual(seen,['one']);release();await task;
  assert.deepEqual(seen,['one','two']);assert.equal((await decoder.finishAsync()).text,'onetwo');
});

test('a damaged body segment cannot be silently omitted from a successful reply',()=>{
  const decoder=createVoiceSegmentDecoder();
  decoder.feed('{"type":"segment","text":"first"}\n{"type":"segment","text":"lost\n{"type":"segment","text":"third"}\n{"type":"control","emotion":"normal"}');
  assert.throws(()=>decoder.finish(),{code:'VOICE_REPLY_FORMAT'});
});

test('private voice emits complete spoken lines before the model ends and drops malformed control data', () => {
  const seen = [];
  const decoder = createVoiceSegmentDecoder({onSegment: segment => seen.push(segment)});
  decoder.feed('{"type":"segment","text":"我替你开心。","perfor');
  assert.deepEqual(seen, []);
  decoder.feed('mance":{"emotion":"happy","strength":"mild","delivery":"温柔。"}}\n');
  assert.equal(seen[0].text, '我替你开心。');
  assert.equal(seen[0].performance.emotion, 'happy');
  decoder.feed('{"type":"segment","text":"先歇会儿。","performance":null,"delivery":"大声吼叫"}\n');
  decoder.feed('{"type":"control","secret":\n');
  assert.equal(decoder.finish().text, '我替你开心。先歇会儿。');
  assert.equal(seen[1].performance.emotion, 'neutral');
  assert.doesNotMatch(seen[1].performance.delivery, /大声吼叫/);
});

test('group voice is gated by an explicit decision and retains end controls', () => {
  const seen = [];
  const decoder = createVoiceSegmentDecoder({group: true, allowSilence: true, onSegment: segment => seen.push(segment.text)});
  decoder.feed('{"type":"decision","speak":true}\n{"type":"segment","text":"我同意。"}\n');
  assert.deepEqual(seen, ['我同意。']);
  decoder.feed('{"type":"control","emotion":"cheerful","interactionTarget":"gemini","affectionTarget":"member","affection":1,"topicEnded":true}');
  assert.deepEqual(decoder.finish(), {text:'我同意。', speak:true, emotion:'cheerful', interactionTarget:'gemini', affectionTarget:'member', affection:1, topicEnded:true});
});

test('silent and undecided group replies do not send audio', () => {
  const seen = [];
  const silent = createVoiceSegmentDecoder({group: true, allowSilence: true, onSegment: segment => seen.push(segment)});
  silent.feed('{"type":"decision","speak":false}\n{"type":"control","topicEnded":true}');
  assert.deepEqual(silent.finish(), {speak:false,text:'',topicEnded:true});
  const missing = createVoiceSegmentDecoder({group: true, onSegment: segment => seen.push(segment)});
  assert.throws(() => missing.feed('{"type":"segment","text":"未获发言许可"}\n'), {code:'VOICE_REPLY_FORMAT'});
  assert.deepEqual(seen, []);
});

test('legacy plain dialogue and old group JSON remain usable', () => {
  const seen = [];
  const plain = createVoiceSegmentDecoder({onSegment: segment => seen.push(segment)});
  plain.feed('好久不见。[[emotion:cheerful]]');
  assert.deepEqual(plain.finish(), {text:'好久不见。',emotion:'cheerful'});
  const oldGroup = createVoiceSegmentDecoder({group: true, onSegment: segment => seen.push(segment)});
  oldGroup.feed('{"text":"好久不见。","emotion":"cheerful","affection":0}');
  assert.deepEqual(oldGroup.finish(), {text:'好久不见。',speak:true,emotion:'cheerful',affection:0});
  assert.deepEqual(seen.map(row=>row.performance.emotion), ['neutral','neutral']);
});

