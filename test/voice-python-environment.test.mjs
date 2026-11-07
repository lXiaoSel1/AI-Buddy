import test from 'node:test';
import assert from 'node:assert/strict';
import {voicePythonEnvironment,pythonFilePath} from '../src/voice/python-environment.mjs';
test('Windows portable Python imports retain extended-length paths without inheriting API credentials',()=>{
  const assets={python:'E:\\candidate\\python\\python.exe',sharedDirectory:'E:\\candidate\\shared',ffmpegDirectory:'E:\\candidate\\ffmpeg'};
  const env=voicePythonEnvironment(assets,{Path:'C:\\Windows',SystemRoot:'C:\\Windows',MINIMAX_API_KEY:'private',PYTHONPATH:'untrusted'},'win32');
  assert.equal(env.PYTHONHOME,'\\\\?\\E:\\candidate\\python');
  assert.equal(env.PYTHONPATH,'\\\\?\\E:\\candidate\\python\\Lib\\site-packages;\\\\?\\E:\\candidate\\shared');
  assert.equal(env.Path,'E:\\candidate\\ffmpeg;C:\\Windows');
  assert.equal(env.MINIMAX_API_KEY,undefined);assert.equal(env.PYTHONPATH.includes('untrusted'),false);
  assert.equal(pythonFilePath('/tmp/voice','linux'),'/tmp/voice');
});
