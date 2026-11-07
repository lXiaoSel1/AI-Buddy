import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import vm from 'node:vm';

test('production main never forwards a command-line voice test fingerprint to either trust constructor',async()=>{
  const main=await readFile(new URL('../src/main.mjs',import.meta.url),'utf8');
  const legacy=main.match(/const legacyPlugins=await (createPluginMaintenanceClient\([^\n]+\));/);assert(legacy);
  const start=main.indexOf('plugins=await createPluginPlatform('),end=main.indexOf('\n  plugins.setWorkClientOpener',start);assert(start>=0&&end>start);
  const calls=[];
  const context={join,root:'root',build:'build',dataRoot:'data',appVersion:'2.0.8',safeStorage:{},legacyPlugins:{},BrowserWindow:{},session:{},ipcMain:{},nativeImage:{},voiceHost:{},
    arg:name=>name==='voice-test-fingerprint'?'attacker-selected-test-fingerprint':undefined,
    createPluginMaintenanceClient:options=>{calls.push(options);},createPluginPlatform:options=>{calls.push(options);},
    createBiliSheetRenderer(){},createBiliFrameAnalyzer(){},publishPlugins(){},audit(){},automaticWorkAllowed(){},
  };
  await vm.runInNewContext('(async()=>{await '+legacy[1]+';'+main.slice(start,end)+'})()',context);
  assert.equal(calls.length,2);
  for(const options of calls)assert.equal(Object.hasOwn(options,'voiceTestFingerprint'),false,'production constructors must retain their default official trust');
});
