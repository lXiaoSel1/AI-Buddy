import React,{useState} from 'react';
import {t,locale} from './i18n.mjs';
import {Dialog} from './ui-dialog.mjs';
import {Segmented} from './ui-controls.mjs';
import {DSH_PREVIEW_NOTICE} from './dsh-preview-notice.mjs';
const h=React.createElement;
export function DshPreviewNotice({language=locale(),onClose}){
 const [selected,setSelected]=useState(language==='en'?'en':'zh-CN'),notice=DSH_PREVIEW_NOTICE.locales[selected];
 return h(Dialog,{title:t('DSH 预览版说明'),onClose,'data-dsh-preview-notice':selected,footer:h('button',{type:'button',className:'ui-btn primary',onClick:onClose},t('关闭'))},h(Segmented,{value:selected,options:[['zh-CN','简体中文'],['en','English']],onChange:setSelected,label:t('说明语言')}),h('p',{className:'ws-muted'},t('仅社区运行时自动确认；查看说明不会修改其他设置。')),h('div',{className:'ws-col','data-upstream-notice-version':DSH_PREVIEW_NOTICE.version},h('h3',{'data-upstream-notice-title':true},notice.title),...notice.body.split('\n\n').map((p,i)=>h('p',{key:i},p))));
}
export function DshPreviewNoticeSetting(){const [open,setOpen]=useState(false);return h(React.Fragment,null,h('div',{className:'ws-srow','data-setting-row':'dsh-preview-notice'},h('div',null,h('b',null,t('DSH 预览版说明')),h('small',null,t('查看社区运行时自带的完整预览版说明。'))),h('button',{type:'button',className:'ui-btn sm','data-view-dsh-notice':true,onClick:()=>setOpen(true)},t('查看'))),open&&h(DshPreviewNotice,{onClose:()=>setOpen(false)}));}
