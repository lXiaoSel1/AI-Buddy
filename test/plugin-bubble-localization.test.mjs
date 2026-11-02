import test from 'node:test';
import assert from 'node:assert/strict';
import {bubbleView} from '../src/pet-badge.mjs';
test('a real Bilibili system detail is translated after hint deduplication while the video title stays original',()=>{for(const detail of ['看完了','点一下打开 · 看完了','Click to open · 看完了']){const original='海洋与潮汐：一次合成阅读',view=bubbleView({source:'plugin',pluginId:'@ai-buddy/bilibili-companion',text:original,detail},{language:'en'});assert.equal(view.title,original);assert.equal(view.detail,'Click to open · finished');assert.doesNotMatch(view.detail,/[\u3400-\u9fff]/);}});
test('unknown plugin prose is preserved and still gets one localized hint',()=>{assert.equal(bubbleView({source:'plugin',detail:'Custom user text'},{language:'en'}).detail,'Click to open · Custom user text');assert.equal(bubbleView({source:'plugin',detail:'用户原文'},{language:'zh-CN'}).detail,'点一下打开 · 用户原文');});
