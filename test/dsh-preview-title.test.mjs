import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DshPreviewNotice} from '../src/dsh-preview-notice-ui.mjs';
import {DSH_PREVIEW_NOTICE} from '../src/dsh-preview-notice.mjs';
for(const language of ['zh-CN','en'])test('the upstream preview title remains visible with its original body in '+language,()=>{const html=renderToStaticMarkup(React.createElement(DshPreviewNotice,{language,onClose(){}}));assert.match(html,new RegExp('<h3 data-upstream-notice-title="true">'+DSH_PREVIEW_NOTICE.locales[language].title+'</h3>'));});
