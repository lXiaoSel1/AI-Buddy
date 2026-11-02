import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CommunityComponentPreparation} from '../src/community-center.mjs';
import {setLocale} from '../src/i18n.mjs';

test('component preparation exposes online default and advanced local archive before installation', () => {
  setLocale('zh-CN'); const markup = renderToStaticMarkup(React.createElement(CommunityComponentPreparation, {busy: false}));
  assert.match(markup, /class="ui-btn primary"[^>]*>准备运行组件…/); assert.match(markup, /从本地组件安装（高级）/); assert.doesNotMatch(markup, /取消准备|progressbar/);
});
test('component preparation remains cancellable while busy and disables duplicate cancellation', () => {
  const render = working => renderToStaticMarkup(React.createElement(CommunityComponentPreparation, {working, busy: true}));
  setLocale('zh-CN'); const installing = render({bytes: 1024}); assert.match(installing, /role="progressbar"/); assert.match(installing, /<button[^>]*>取消准备<\/button>/); assert.doesNotMatch(installing, /不能中途取消|disabled=""/);
  const cancelling = render({cancelling: true}); assert.match(cancelling, /<button[^>]*disabled=""[^>]*>正在取消…<\/button>/);
});
test('new component controls translate to English without exposing an editable download URL', () => {
  setLocale('en'); try { const initial = renderToStaticMarkup(React.createElement(CommunityComponentPreparation, {})), working = renderToStaticMarkup(React.createElement(CommunityComponentPreparation, {working: {bytes: 2048}})); assert.match(initial, /Install from a local component archive \(advanced\)/); assert.match(working, /Cancel preparation/); assert.doesNotMatch(initial + working, /[\u3400-\u9fff]|type="url"/); } finally { setLocale('zh-CN'); }
});
