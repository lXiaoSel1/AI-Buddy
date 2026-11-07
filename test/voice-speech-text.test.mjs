import test from 'node:test';
import assert from 'node:assert/strict';
import {voiceSpeechText} from '../src/voice/speech-text.mjs';
test('the spoken copy removes known faces and fenced code while preserving ordinary brackets and numbers',()=>{
  assert.equal(voiceSpeechText('(^_^) 😊'), '');
  assert.equal(voiceSpeechText('你好(^_^)！'),'你好！');
  assert.equal(voiceSpeechText('结果 (x+1) 是 20 元。'),'结果 (x+1) 是 20 元。');
  assert.equal(voiceSpeechText('看结果。\n```js\nconsole.log(1)\n```\n完成。'),'看结果。完成。');
});
