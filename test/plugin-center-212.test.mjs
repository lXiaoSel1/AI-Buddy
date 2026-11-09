import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale} from '../src/i18n.mjs';
import * as helpers from '../src/plugin-center-helpers.mjs';
import * as center from '../src/plugin-center.mjs';
import {UpdateCard} from '../src/community-center.mjs';

const now=Date.parse('2026-11-09T20:00:00Z');
test('opening extensions refreshes expired trusted catalogs but keeps fresh and disabled sources quiet',()=>{
  assert.equal(typeof helpers.pluginSourcesNeedRefresh,'function');
  const state={sources:[{sourceId:'official',cachedAt:'2026-11-09T18:00:00Z'}]};
  assert.equal(helpers.pluginSourcesNeedRefresh(state,now),true);
  assert.equal(helpers.pluginSourcesNeedRefresh({sources:[{sourceId:'official',cachedAt:'2026-11-09T19:59:00Z'}]},now),false);
  assert.equal(helpers.pluginSourcesNeedRefresh({sources:[{sourceId:'legacy'},{sourceId:'x',enabled:false},{sourceId:'y',removed:true}]},now),false);
  assert.equal(helpers.pluginSourcesNeedRefresh({sources:[{sourceId:'official',cachedAt:'invalid'}]},now),true);
});

for(const language of ['zh-CN','en'])test(language+' version menu contains retained incompatible history without making it installable',()=>{
  setLocale(language);
  assert.equal(typeof center.PluginVersionMenu,'function');
  const make=(version,extra={})=>({sourceId:'official',manifest:{id:'ai-buddy.voice-breeze',version,appRange:version==='1.0.0'?'2.0.8':'^2.0.11'},compatible:true,...extra});
  const versions=[make('1.0.2',{current:true}),make('1.0.1'),make('1.0.0',{compatible:false,reasons:['app-version'],switchCompatible:false,switchReason:'此版本不在当前已验证来源目录中，无法切换'})],chosen=[];
  const menu=center.PluginVersionMenu({row:{...versions[0],versions},onSelect:row=>chosen.push(row.manifest.version)});
  const html=renderToStaticMarkup(menu),items=menu.props.items;
  assert.equal(items.length,3);
  assert.equal(items.find(item=>item.label.includes('1.0.0')).disabled,true);
  assert.match(html,language==='en'?/Incompatible.*Only supports 2\.0\.8/:/不兼容.*只支持 2\.0\.8/);
  items.find(item=>item.label.includes('1.0.1')).onSelect();
  assert.deepEqual(chosen,['1.0.1']);
  setLocale('zh-CN');
});

for(const language of ['zh-CN','en'])test(language+' maintenance explains the required compatible version and keeps the real update action',()=>{
  setLocale(language);
  const update={packageKey:'buddy-v1:official:ai-buddy.voice-breeze',packageName:'ai-buddy.voice-breeze',from:'1.0.0',to:'1.0.2',state:'available',requiresCompatibilityUpdate:true},calls=[];
  const element=UpdateCard({update,onReview:value=>calls.push(value),busy:false}),html=renderToStaticMarkup(element);
  assert.match(html,language==='en'?/Update to 1\.0\.2 to keep using this plugin/:/要更新到 1\.0\.2 才能继续用/);
  const children=React.Children.toArray(element.props.children),button=children.find(child=>child.type==='button');
  assert.equal(button.props.disabled,false);button.props.onClick();assert.equal(calls[0],update);
  setLocale('zh-CN');
});

test('an upgraded voice package is not called ready while its unchanged components await verification',()=>{
  const row={manifest:{id:'ai-buddy.voice-breeze',kind:'plugin'},installed:true,current:true,enabled:true,activation:{supported:true,usable:true,state:'ready'}};
  assert.equal(helpers.pluginActivation(row,{state:'verification-needed',ready:false}).state,'verification-needed');
  assert.equal(helpers.pluginActivation(row,{state:'verification-needed',ready:false}).usable,false);
  assert.equal(helpers.pluginActivation(row,{state:'ready',ready:true}).usable,true);
  assert.notEqual(helpers.pluginActivation(row,{}).state,'ready');
});

test('version choices with an unsatisfied coordinated dependency are disabled with their reason',()=>{
  const version={sourceId:'official',manifest:{id:'ai-buddy.voice-breeze',version:'1.0.1',appRange:'^2.0.9'},compatible:true,switchCompatible:false,switchReason:'语音组件没有匹配的成套版本'};
  const menu=center.PluginVersionMenu({row:{versions:[version]}});
  assert.equal(menu.props.items[0].disabled,true);
  assert.match(renderToStaticMarkup(menu),/语音组件没有匹配的成套版本/);
});
