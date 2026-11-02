import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CommunityCategoryOptions, CommunityRuntimeNotice, CommunityInstallationStatus, CommunityBusyNotice} from '../src/community-center.mjs';
import {setLocale} from '../src/i18n.mjs';

test('community missing-runtime state explains recovery and keeps machine errors in closed details', () => {
  setLocale('zh-CN'); const markup = renderToStaticMarkup(React.createElement(CommunityRuntimeNotice, {state: {ready: false, code: 'DSH_RUNTIME_NOT_READY', message: 'component absent'}, onPrepare() {}}));
  assert.match(markup, /需要准备 DSH 运行组件/); assert.match(markup, /<button[^>]*>准备运行组件<\/button>/); assert.match(markup, /<details><summary>技术详情<\/summary>/); assert.equal(markup.includes('<details open'), false); assert.match(markup, /DSH_RUNTIME_NOT_READY/);
});
test('community runtime recovery labels translate to English and readiness removes the recovery banner', () => {
  setLocale('en'); const missing = renderToStaticMarkup(React.createElement(CommunityRuntimeNotice, {state: {ready: false}})); assert.match(missing, /Prepare runtime component/); assert.equal(/[\u3400-\u9fff]/.test(missing), false);
  assert.equal(renderToStaticMarkup(React.createElement(CommunityRuntimeNotice, {state: {ready: true}})), ''); setLocale('zh-CN');
});
test('community category controls permit implemented backends and disable planned-only categories', () => {
  const markup = renderToStaticMarkup(React.createElement('select', null, React.createElement(CommunityCategoryOptions, {capabilities: {function: {installable: true}, 'work-engine': {installable: true}, voice: {installable: false}}})));
  assert.match(markup, /<option value="function">/); assert.match(markup, /<option value="work-engine">/); assert.match(markup, /<option value="voice" disabled="">/); assert.match(markup, /<option value="character-motion" disabled="">/);
});

test('community inspection status exposes actual phases without synthetic percentages', () => {
  setLocale('zh-CN');const view=props=>renderToStaticMarkup(React.createElement(CommunityBusyNotice,props));
  assert.equal(view({pending:false,phase:'verifying-component'}),'');
  const verify=view({pending:true,phase:'verifying-component'});assert.match(verify,/正在核验 DSH 运行组件/);assert.match(verify,/role="status"/);assert.match(verify,/aria-busy="true"/);assert.doesNotMatch(verify,/[0-9]+%/);
  assert.match(view({pending:true,phase:'checking-plugin'}),/正在启动原生宿主并检查插件/);
  assert.match(view({maintenance:{jobs:[{state:'running',operation:'install'}]},phase:'applying'}),/正在应用插件变更/);
  setLocale('en');const english=view({pending:true,phase:'verifying-component'});assert.match(english,/Verifying the DSH runtime/);assert.doesNotMatch(english,/[\u3400-\u9fff]/);setLocale('zh-CN');
});

test('installed native status separates enabled intent from observed runtime availability', () => {
  setLocale('zh-CN'); const markup = record => renderToStaticMarkup(React.createElement(CommunityInstallationStatus, {record}));
  const pending = markup({enabled: true, runtimeVerified: false, phase: 'enable-unconfirmed'}); assert.match(pending, /加载中/); assert.match(pending, /启用设置：已开启/); assert.doesNotMatch(pending, /运行中|enable-unconfirmed|已启用/);
  assert.match(markup({enabled: true, runtimeVerified: true}), /运行中/); assert.match(markup({enabled: false, runtimeVerified: false}), /已停用/);
  const failed = markup({enabled: true, runtimeVerified: false, runtimeFailure: {code: 'DSH_ACTIVATION_FAILED', message: 'actual failure'}}); assert.match(failed, /加载失败/); assert.match(failed, /<details><summary>技术详情/);
  setLocale('en'); assert.match(markup({enabled: true, runtimeVerified: false}), /Loading/); assert.match(markup({enabled: true, runtimeVerified: true}), /Running/); setLocale('zh-CN');
});
