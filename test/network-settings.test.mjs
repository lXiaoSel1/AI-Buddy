import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeNetworkSettings,downloadRequestPlan} from '../src/network-settings.mjs';
test('network defaults follow system; mirrors rewrite only an approved download authority',()=>{
  assert.deepEqual(normalizeNetworkSettings(),{schemaVersion:1,mode:'system',proxyUrl:'',githubMirror:'',huggingFaceMirror:''});
  const settings=normalizeNetworkSettings({mode:'manual',proxyUrl:'http://127.0.0.1:7890',githubMirror:'https://mirror.example'});
  const plan=downloadRequestPlan('https://github.com/o/r/releases/download/v1/a.zip?x=1',settings);
  assert.equal(plan.logicalUrl,'https://github.com/o/r/releases/download/v1/a.zip?x=1');
  assert.equal(plan.requestUrl,'https://mirror.example/o/r/releases/download/v1/a.zip?x=1');
  assert.equal(downloadRequestPlan('https://api.example/v1/models',settings).mirror,null);
  assert.throws(()=>normalizeNetworkSettings({githubMirror:'https://mirror.example/prefix'}));
  assert.throws(()=>normalizeNetworkSettings({mode:'manual',proxyUrl:'socks5://127.0.0.1:1080'}));
});
