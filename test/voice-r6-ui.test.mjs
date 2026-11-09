import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale} from '../src/i18n.mjs';
import {VoiceSettingsPanel} from '../src/voice/client.mjs';
import {CloudVoiceBatchStatus} from '../src/voice/cloud-settings-ui.mjs';
import {createVoiceR6Fixture} from './support/voice-r6-ui-fixture.mjs';

setLocale('zh-CN');
test('cloud settings begin with no selected characters and require an explicit existing-voice refresh',async()=>{
  const fixture=createVoiceR6Fixture();
  try{
    await fixture.session.refresh();
    const html=renderToStaticMarkup(React.createElement(VoiceSettingsPanel,{snapshot:fixture.session.snapshot(),session:fixture.session}));
    assert.match(html,/data-cloud-open-voices="true"/);
    assert.match(html,/给 DeepSeek 换音色/);
    assert.match(html,/角色的云端声音/);
    assert.equal((html.match(/data-cloud-character=/g)??[]).length,0,'selection is in the explicit batch dialog');
    assert.doesNotMatch(html,/<input[^>]*type="checkbox"[^>]*checked/);
    assert.match(html,/data-cloud-open-batch="true"/);
    assert.doesNotMatch(html,/准备全部角色云音色|免费/);
    assert.deepEqual(fixture.calls.filter(row=>!['state','component-status'].includes(row.op)),[],'opening settings must not query voices, preview, clone, upload or synthesize');
  }finally{await fixture.dispose();}
});

test('the public cloud action returns the selected-character plan without expanding the selection',async()=>{
  const fixture=createVoiceR6Fixture();
  try{
    await fixture.session.refresh();
    const result=await fixture.session.runAction('cloud-batch-preview',{selectedCharacterIds:['claude']});
    assert.deepEqual(result.plan.selectedCharacterIds,['claude']);
    assert.equal(result.plan.cloneCount,1);
    assert.equal(result.plan.pricing.cloneEstimate,9.9);
    assert.equal(result.plan.pricing.currency,'CNY');
    assert.deepEqual(fixture.calls.find(row=>row.op==='cloud-batch-preview').payload,{selectedCharacterIds:['claude']});
  }finally{await fixture.dispose();}
});

test('a failed existing-voice query preserves its provider code and is not returned as success',async()=>{
  const fixture=createVoiceR6Fixture();
  try{
    await fixture.session.refresh();
    fixture.rejectNext('cloud-voices',{code:'CLOUD_REMOTE_1008',message:'云配音服务返回错误，请检查连接与声音配置'});
    const result=await fixture.session.runAction('cloud-voices',{});
    assert.equal(result,undefined);
    assert.match(fixture.session.snapshot().error,/余额不足/);
    assert.match(fixture.session.snapshot().error,/1008/);
  }finally{await fixture.dispose();}
});

test('batch failure rows show the stable account reason and code ahead of a generic message',()=>{
  const html=renderToStaticMarkup(React.createElement(CloudVoiceBatchStatus,{batch:{state:'failed',items:[{characterId:'claude',label:'Claude',status:'failed',code:'CLOUD_REMOTE_1008',message:'云配音服务返回错误，请检查连接与声音配置'}]}}));
  assert.match(html,/Claude · 失败/);
  assert.match(html,/余额不足/);
  assert.match(html,/CLOUD_REMOTE_1008/);
});

test('a late voice-list failure for the previous character does not replace the current settings status',async()=>{
  const fixture=createVoiceR6Fixture();let release;
  try{
    await fixture.session.refresh();release=fixture.holdNext('cloud-voices');
    const pending=fixture.session.runAction('cloud-voices',{});
    await new Promise(resolve=>setImmediate(resolve));await fixture.switchCharacter('claude');
    release({code:'CLOUD_REMOTE_1008',message:'MiniMax query failed'});await pending;
    assert.equal(fixture.session.snapshot().error,'');
  }finally{release?.();await fixture.dispose();}
});
