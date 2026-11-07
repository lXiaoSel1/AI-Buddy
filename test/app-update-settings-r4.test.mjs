import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {UpdateSettingsView} from '../src/update-settings.mjs';
import {setLocale} from '../src/i18n.mjs';

const render=state=>renderToStaticMarkup(React.createElement(UpdateSettingsView,{version:'2.0.7',state,act(){},onPlugins(){},checkPlugins(){}}));
test('settings keeps check download apply and later in app, with manual help disclosed explicitly',()=>{
  setLocale('zh-CN');
  const bootstrap=render({phase:'bootstrap'});assert.match(bootstrap,/data-update-action="bootstrap"[^>]*>准备应用内更新/);assert.doesNotMatch(bootstrap,/打开官方安装器下载页/);
  const available=render({phase:'available',target:{version:'2.0.8',migration:true}});assert.match(available,/data-update-action="download"/);assert.doesNotMatch(available,/data-update-action="bootstrap"/);
  const ready=render({phase:'ready',target:{version:'2.0.8'}});assert.match(ready,/data-update-action="apply"/);assert.match(ready,/data-update-action="later"/);
  assert.match(ready,/<details><summary>手动下载与帮助<\/summary><button[^>]*data-update-action="manual-help"/);
  const waiting=render({phase:'waiting-safe-point',canCancel:true,reasons:[{capability:'chat'}]});assert.match(waiting,/data-update-action="cancel"[^>]*>稍后/);assert.match(waiting,/聊天/);
  const recovery=render({phase:'recovery-required',error:'APP_UPDATE_RECOVERY_REQUIRED'});assert.match(recovery,/手动恢复帮助/);assert.doesNotMatch(recovery,/data-update-action="(?:bootstrap|download|apply)"/);
});
