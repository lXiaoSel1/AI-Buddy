import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {voicePythonEnvironment,pythonFilePath} from '../src/voice/python-environment.mjs';
test('Windows portable Python imports retain extended-length paths without inheriting API credentials',()=>{
  const assets={python:'E:\\candidate\\python\\python.exe',sharedDirectory:'E:\\candidate\\shared',ffmpegDirectory:'E:\\candidate\\ffmpeg'};
  const env=voicePythonEnvironment(assets,{Path:'C:\\Windows',SystemRoot:'C:\\Windows',MINIMAX_API_KEY:'private',PYTHONPATH:'untrusted'},'win32');
  assert.equal(env.PYTHONHOME,'\\\\?\\E:\\candidate\\python');
  assert.equal(env.PYTHONPATH,'\\\\?\\E:\\candidate\\python\\Lib\\site-packages;\\\\?\\E:\\candidate\\shared;\\\\?\\E:\\candidate\\python\\python312.zip;\\\\?\\E:\\candidate\\python\\DLLs;\\\\?\\E:\\candidate\\python\\Lib;\\\\?\\E:\\candidate\\python');
  assert.equal(env.Path,'E:\\candidate\\ffmpeg;C:\\Windows');
  assert.equal(env.MINIMAX_API_KEY,undefined);assert.equal(env.PYTHONPATH.includes('untrusted'),false);
  assert.equal(pythonFilePath('/tmp/voice','linux'),'/tmp/voice');
});

test('fixed Windows Python imports stdlib and the signed cloud worker beyond MAX_PATH',{
  skip: process.platform!=='win32'||!process.env.AI_BUDDY_VOICE_PYTHON_FIXTURE ? 'Set AI_BUDDY_VOICE_PYTHON_FIXTURE to the isolated original Python/shared/cwd fixture JSON' : false,
},t=>{
  const fixture=JSON.parse(process.env.AI_BUDDY_VOICE_PYTHON_FIXTURE);
  assert.equal(typeof fixture.python,'string');assert.equal(typeof fixture.sharedDirectory,'string');assert.equal(typeof fixture.cwd,'string');
  const system=process.env.SystemRoot??'C:\\Windows';
  const environment=voicePythonEnvironment(fixture,{SystemRoot:system,WINDIR:system,ComSpec:system+'\\System32\\cmd.exe',PATH:system+'\\System32',TEMP:fixture.cwd,TMP:fixture.cwd,MINIMAX_API_KEY:'must-not-inherit',PYTHONPATH:'untrusted',PYTHONSTARTUP:'untrusted',PYTHONINSPECT:'1'},'win32');
  const code=`import sys
import asyncio, json, ssl, sqlite3, cloud_speech, os
assert sys.version_info[:3] == (3, 12, 10), sys.version
assert 'MINIMAX_API_KEY' not in os.environ and 'PYTHONSTARTUP' not in os.environ and 'PYTHONINSPECT' not in os.environ
modules = {m.__name__: m.__file__ for m in (asyncio, json, ssl, sqlite3, cloud_speech)}
assert all(p.startswith('\\\\\\\\?\\\\') for p in modules.values()), modules
print(json.dumps({'version': list(sys.version_info[:3]), 'modules': modules, 'sysPath': sys.path}, ensure_ascii=False))
`;
  const result=spawnSync(pythonFilePath(fixture.python,'win32'),['-c',code],{cwd:fixture.cwd,env:environment,encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(result.error,undefined,result.error?.message);
  assert.equal(result.status,0,'Real fixed Python import failed:\n'+result.stderr);
  const imported=JSON.parse(result.stdout.trim());
  assert.deepEqual(imported.version,[3,12,10]);
  assert.ok(imported.modules.asyncio.length>260,'fixture must exercise the actual long installation path');
  t.diagnostic(JSON.stringify({python:fixture.python,version:imported.version,imported:Object.keys(imported.modules),allModulePathsNamespaced:true,longestModulePath:Math.max(...Object.values(imported.modules).map(path=>path.length)),network:false,gpu:false}));
});

test('non-Windows voice Python keeps the existing site/shared path order and safe environment',()=>{
  const env=voicePythonEnvironment({python:'/opt/voice/python/bin/python3',sharedDirectory:'/opt/voice/shared'},{PATH:'/usr/bin',PYTHONPATH:'/untrusted',API_KEY:'private'},'linux');
  assert.equal(env.PYTHONHOME,'/opt/voice/python/bin');
  assert.equal(env.PYTHONPATH,'/opt/voice/python/bin/Lib/site-packages:/opt/voice/shared');
  assert.equal(env.API_KEY,undefined);assert.equal(env.PATH,'/usr/bin');
});
