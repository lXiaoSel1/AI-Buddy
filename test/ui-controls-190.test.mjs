import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ICONS,Icon} from '../src/ui-icons.mjs';
import {Segmented,Switch,StatusPill,Tabs,EmptyState,Notice,Toast,Snackbar,Menu} from '../src/ui-controls.mjs';

const render=(Component,props)=>renderToStaticMarkup(React.createElement(Component,props));
const text=html=>html.replace(/<svg[\s\S]*?<\/svg>/g,'').replace(/<[^>]+>/g,'');

test('icons are decorative line drawings with no text of their own',()=>{
 for(const name of ['nav-overview','nav-usage','nav-history','nav-galgame','nav-actions','nav-api','nav-token','nav-settings','close','more','refresh'])assert.ok(ICONS[name],name);
 for(const [name,markup] of Object.entries(ICONS)){
  assert.doesNotMatch(markup,/<(title|text|desc|script|foreignObject)/i,name);
  assert.match(markup,/^(<(path|circle|rect|line|polyline|polygon|ellipse)\b[^>]*\/>)+$/,name);
 }
 const html=renderToStaticMarkup(Icon('close',{size:20}));
 assert.match(html,/^<svg class="ui-icon"[^>]*aria-hidden="true"[^>]*focusable="false"/);
 assert.match(html,/width="20" height="20"/);
 assert.throws(()=>Icon('missing'),/Unknown icon/);
});

test('segmented control and switch expose their state to assistive tech',()=>{
 const seg=render(Segmented,{value:'b',options:[['a','甲'],['b','乙']],label:'模式','data-x':'1'});
 assert.match(seg,/role="radiogroup" aria-label="模式" data-x="1"/);
 assert.match(seg,/role="radio" aria-checked="false"[^>]*>甲</);
 assert.match(seg,/role="radio" aria-checked="true"[^>]*>乙</);
 assert.match(render(Switch,{checked:true,label:'联网'}),/role="switch" aria-checked="true" aria-label="联网"/);
 assert.match(render(Switch,{checked:false,disabled:true}),/aria-checked="false"[^>]*disabled/);
});

test('tab buttons keep their label as their whole text',()=>{
 const html=render(Tabs,{tabs:[['a','用量','nav-usage'],['b','费用']],active:'a',label:'统计'});
 assert.match(html,/role="tablist" aria-label="统计"/);
 const buttons=[...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(m=>text(m[1]));
 assert.deepEqual(buttons,['用量','费用']);
 assert.match(html,/aria-selected="true"[^>]*tabindex="0"/i);
 assert.match(html,/aria-selected="false"[^>]*tabindex="-1"/i);
});

test('status pill, notices, toasts and menus render without any <dialog>',()=>{
 const parts=[
  render(StatusPill,{tone:'ok',children:'运行中'}),render(StatusPill,{tone:'busy',children:'刷新中'}),
  render(EmptyState,{icon:'info',title:'还没有记录',children:'说明'}),render(Notice,{tone:'err',children:'出错了'}),
  render(Toast,{tone:'err',icon:'alert',children:'失败'}),render(Snackbar,{children:'已移除',actionLabel:'撤销'}),
  render(Menu,{label:'更多',items:[{label:'刷新',icon:'refresh'},'separator',{label:'删除',danger:true},{label:'显示状态条',checked:true}]}),
 ];
 for(const html of parts)assert.doesNotMatch(html,/<dialog/);
 assert.match(parts[0],/class="ui-pill ok"/);assert.match(parts[1],/ui-spinner/);
 assert.match(parts[3],/class="ui-alert" role="alert"/);
 assert.match(parts[4],/role="alert"/);
 assert.match(parts[6],/role="menu" aria-label="更多"/);
 assert.match(parts[6],/role="menuitem"[^>]*>.*刷新</);
 assert.match(parts[6],/role="menuitemcheckbox" aria-checked="true"/);
 assert.match(parts[6],/class="danger"/);
});
