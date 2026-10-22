import {t} from './i18n.mjs';
import React from 'react';
import {ModelSettings} from './model-settings.mjs';
import {CgSettings} from './cg-settings.mjs';
import {QuotaSettings} from './quota-ui.mjs';
const h=React.createElement;
// Each tab's own "add" button sits at the page head's right edge (.ws-head-action).
export function ApiSettings({view,tab,onTab}){
 return h('div',{className:'api-settings ws-page ws-has-head-action'},h('div',{className:'ws-page-head'},h('div',null,h('h1',{className:'ws-ptitle'},t("API 配置")),h('p',{className:'ws-meta subtitle'},t("管理已保存的配置，聊天和绘图分别选择。")))),
  h('div',{className:'ui-seg ws-seg api-tabs',role:'tablist','aria-label':t("配置类型")},...['model','cg','quota'].map(type=>h('button',{key:type,type:'button','data-api-tab':type,id:'api-tab-'+type,role:'tab','aria-selected':tab===type,'aria-controls':'api-tab-panel',className:tab===type?'active':'',onClick:()=>onTab(type)},type==='model'?t("聊天 API"):type==='cg'?t("CG 绘图"):t("额度连接")))),
  h('div',{id:'api-tab-panel',role:'tabpanel','aria-labelledby':'api-tab-'+tab},tab==='quota'?h(QuotaSettings):tab==='cg'?h(CgSettings,{initial:view?.cgConnections}):h(ModelSettings,{initial:view?.modelConnections})));
}
