import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {InstallPage} from '../src/community-install-page.mjs';
import {WorkRelease} from '../src/community-detail.mjs';
import {setLocale} from '../src/i18n.mjs';
import {PluginVersionMenu} from '../src/plugin-center.mjs';
import {pluginErrorText} from '../src/plugin-center-helpers.mjs';
import {communityErrorText} from '../src/community/messages.mjs';
const breeze = 'ai-buddy.voice-breeze';
const render = props => renderToStaticMarkup(React.createElement(InstallPage, {work: {packageName: breeze, authorName: 'lXiaoSel1', releases: ['1.0.1', '1.0.2', '1.0.3'].map(version => ({version}))}, granted: [], stage: 'plan', ...props}));

test('voice install title names the engine version in the actual plan', () => {
  setLocale('zh-CN');
  const html = render({plan: {planId: 'p', packages: [{manifest: {id: 'ai-buddy.voice-shared-runtime', version: '1.0.2'}}, {manifest: {id: breeze, version: '1.0.3'}}]}});
  assert.match(html, /data-install-meta="true">lXiaoSel1 · 1\.0\.3</);
});

test('finished DSH install title names the installed release after its plan is cleared', () => {
  const html = render({work: {packageName: '@ai-buddy/qq-connect', authorName: 'lXiaoSel1', releases: [{version: '2.0.6'}, {version: '2.0.10'}]}, record: {exactVersion: '2.0.10'}, stage: 'installed'});
  assert.match(html, /data-install-meta="true">lXiaoSel1 · 2\.0\.10</);
});

test('pending install title uses the service-selected compatible release', () => {
  const html = render({work: {packageName: breeze, authorName: 'lXiaoSel1', installationVersion: '1.0.2', releases: [{version: '1.0.1'}, {version: '1.0.2'}, {version: '1.0.3'}]}});
  assert.match(html, /data-install-meta="true">lXiaoSel1 · 1\.0\.2</);
});

test('an explicitly requested old version remains visible while its install plan is loading', () => {
  const html = render({requestedVersion: '1.0.1', work: {packageName: breeze, authorName: 'lXiaoSel1', installationVersion: '1.0.3'}});
  assert.match(html, /data-install-meta="true">lXiaoSel1 · 1\.0\.1</);
});

test('a failed plan offers an explicit retry instead of an indefinite reading state', () => {
  setLocale('zh-CN');
  const html = render({plan: null, planError: '读取失败'});
  assert.match(html, /重新查看安装计划/);
  assert.doesNotMatch(html, /正在读取安装计划…/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""/);
});

test('an unsupported future voice version is disabled and explains the required app update', () => {
  setLocale('zh-CN');
  const html = renderToStaticMarkup(React.createElement(PluginVersionMenu, {row: {versions: [{manifest: {id: breeze, version: '1.0.4', appRange: '>=2.0.13'}, compatible: true, activation: {supported: false, state: 'unsupported'}}]}}));
  assert.match(html, /disabled=""/);
  assert.match(html, /需要更新 AI 酱/);
});

test('install failures give the specified bilingual dependency and version guidance', () => {
  for (const [language, dependency, unavailable] of [
    ['zh-CN', '这个版本和当前的 AI 酱不兼容，或者缺少它依赖的组件。', '这个插件的最新版需要更新的 AI 酱。先更新 AI 酱，或者在「版本」里选一个能用的旧版。'],
    ['en', 'This version is not compatible with this AI Buddy, or a required component is missing.', 'The latest version of this plugin needs a newer AI Buddy. Update AI Buddy first, or pick an older version under Versions.'],
  ]) {
    assert.equal(pluginErrorText({code: 'PLUGIN_DEPENDENCY_ERROR'}, language), dependency);
    assert.equal(communityErrorText('PLUGIN_DEPENDENCY_ERROR', language), dependency);
    assert.equal(pluginErrorText({code: 'COMMUNITY_NO_COMPATIBLE_RELEASE'}, language), unavailable);
    assert.equal(communityErrorText('COMMUNITY_NO_COMPATIBLE_RELEASE', language), unavailable);
  }
});

test('plugin failure presentation preserves response timeout semantics', () => {
  const expected = 'model.fixture.test did not respond. Try again later. You can also import offline.';
  assert.equal(pluginErrorText({code: 'NETWORK_RESPONSE_TIMEOUT', host: 'model.fixture.test'}, 'en'), expected);
  assert.equal(communityErrorText('NETWORK_RESPONSE_TIMEOUT', 'en'), 'the service did not respond. Try again later. You can also import offline.');
});

test('the discovery version row shows the host requirement beside its disabled install action in both languages', () => {
  for (const [language, label] of [['zh-CN', '需要 AI 酱 2.0.13'], ['en', 'Requires AI Buddy 2.0.13']]) {
    setLocale(language);
    const html = renderToStaticMarkup(React.createElement(WorkRelease, {work: {packageName: breeze}, release: {version: '1.0.3', compatibility: {compatible: false, reasons: ['app-version'], requiredAppRange: '>=2.0.13'}}, installable: true}));
    assert.ok(html.includes(label));
    assert.match(html, /<button[^>]*disabled=""/);
  }
});
