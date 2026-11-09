import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale} from '../src/i18n.mjs';
import {PluginVersionMenu} from '../src/plugin-center.mjs';
import {filterLegacyPlugins} from '../src/plugin-center-helpers.mjs';
import {InstalledVoicePluginRow,VoiceInstalledMoreMenu} from '../src/community-installed-voice.mjs';

const breeze='ai-buddy.voice-breeze';
const version=(value,extra={})=>({sourceId:'official',manifest:{id:breeze,version:value,kind:'plugin',appRange:value==='1.0.0'?'2.0.8':'^2.0.11'},compatible:true,...extra});
const versions=[version('1.0.2',{current:true}),version('1.0.1'),version('1.0.0',{compatible:false,reasons:['app-version']})];

test('installed version choices visibly name the current release and disable incompatible history',()=>{
  setLocale('zh-CN');
  const menu=PluginVersionMenu({row:{versions}}),html=renderToStaticMarkup(menu);
  assert.match(html,/1\.0\.2 · 当前/);
  assert.match(html,/1\.0\.0 · 不兼容 · 只支持 2\.0\.8/);
  assert.equal(menu.props.items[0].disabled,true);
  assert.equal(menu.props.items[2].disabled,true);
});

function elements(node){if(!node||typeof node!=='object')return [];return [node,...React.Children.toArray(node.props?.children).flatMap(elements),...React.Children.toArray(node.props?.footer).flatMap(elements)];}

test('installed voice more menu keeps policies and uninstall confirmation while routing version changes to a plan',async()=>{
  setLocale('zh-CN');
  const row={...versions[0],versions,previous:'1.0.1',enabled:true},requests=[],selected=[],confirmations=[],branches=[],closed=[];
  const props={row,record:{usable:true},call:async request=>requests.push(request),onVersionSelect:value=>selected.push(value),onConfirm:value=>confirmations.push(value),onVersionsOpen:value=>branches.push(value),onClose:()=>closed.push(true)};
  const view=VoiceInstalledMoreMenu(props),menu=elements(view).find(value=>value.props?.items),items=menu.props.items;
  await items[0].onSelect();await items[1].onSelect();
  assert.deepEqual(requests.map(value=>[value.action,value.policy]),[['community-set-update-policy','manual'],['community-set-update-policy','auto']]);
  items.find(value=>value.label==='切换版本').onSelect();menu.props.onClose();
  assert.deepEqual(branches,[true]);assert.deepEqual(closed,[]);
  items.find(value=>value.label==='回退到 1.0.1').onSelect();
  assert.deepEqual(selected,[versions[1]]);assert.equal(requests.length,2,'rollback cannot directly change a package');
  items.at(-1).onSelect();assert.equal(confirmations[0].kind,'uninstall');assert.equal(confirmations[0].record.backend,'legacy');
  assert.equal(requests.length,2,'uninstall must still await confirmation');
  const opened=VoiceInstalledMoreMenu({...props,versionsOpen:true}),submenu=elements(opened).find(value=>value.type===PluginVersionMenu);
  assert.ok(submenu);assert.match(renderToStaticMarkup(opened),/1\.0\.2 · 当前/);
  PluginVersionMenu(submenu.props).props.items[1].onSelect();assert.equal(selected.at(-1),versions[1]);
});

test('installed voice history keeps incompatible rollback disabled and retains the existing row actions',()=>{
  setLocale('zh-CN');
  const row={...versions[0],versions,previous:'1.0.0',enabled:true,activation:{supported:true}},view=VoiceInstalledMoreMenu({row});
  assert.equal(elements(view).find(value=>value.props?.items).props.items.find(value=>value.label==='回退到 1.0.0').disabled,true);
  const html=renderToStaticMarkup(React.createElement(InstalledVoicePluginRow,{row,record:{usable:true},menuOpen:true,session:{},snapshot:{state:{packages:[],settings:{}}}}));
  assert.match(html,/data-voice-installed="ai-buddy.voice-breeze"/);assert.match(html,/data-voice-enable/);assert.match(html,/data-voice-start/);assert.match(html,/切换版本/);assert.doesNotMatch(html,/旧扩展/);
});

test('the old-extension list keeps genuine legacy records while excluding registered voice engines and shared parts',()=>{
  const kimi={sourceId:'legacy',manifest:{id:'ai-buddy.kimi-engine',version:'1.0.0',kind:'plugin'},installed:true};
  const registeredKimi={...kimi,sourceId:'official'},thirdParty={...kimi,sourceId:'third-party'};
  const rows=[kimi,registeredKimi,thirdParty,{...versions[0],installed:true},{sourceId:'official',manifest:{id:'ai-buddy.voice-shared-runtime',kind:'runtime',version:'1.0.2'}}];
  assert.deepEqual(filterLegacyPlugins(rows,{legacyOnly:true}).items,[kimi,registeredKimi,thirdParty]);
  assert.equal(filterLegacyPlugins(rows.slice(3),{legacyOnly:true}).total,0);
});
