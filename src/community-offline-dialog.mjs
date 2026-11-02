// Confirmation for an offline plugin file (approved design B6, review 中-1): what the signed file holds, the date its catalog
// was signed, whether it replaces the catalog in use, and a warning when it is old. Nothing is stored before 「导入」.
import React from 'react';
import {locale,t as coreT} from './i18n.mjs';
import {communityMessages} from './community/messages.mjs';
import {Icon} from './ui-icons.mjs';
import {Dialog} from './ui-dialog.mjs';
import {PluginLogo} from './community-install-page.mjs';
import {pluginName} from './community-capabilities.mjs';
const h=React.createElement;
const t=value=>locale()==='en'?communityMessages[value]??coreT(value):coreT(value);
export const signedDate=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleDateString(locale()==='en'?'en-GB':'zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'}):'';};
export function OfflineImportDialog({preview,sourceName,busy,onConfirm,onCancel}){
 const older=!preview.replaceCatalog&&preview.keptReason,works=preview.works??[];
 return h(Dialog,{title:t('导入插件包'),onClose:onCancel,busy,'data-offline-confirm':true,footer:h(React.Fragment,null,h('span',{className:'spacer'}),h('button',{type:'button',className:'ui-btn ghost',disabled:busy,onClick:onCancel},t('取消')),h('button',{type:'button',className:'ui-btn primary',disabled:busy,onClick:onConfirm},t('导入')))},
  h('div',{className:'ext-col'},
   h('p',{className:'ext-cap'},t('签名已核对。导入后会显示正常的安装计划，权限仍要你逐项勾选。')),
   h('dl',{className:'ext-facts'},
    h('dt',null,t('来源')),h('dd',null,sourceName??t('来源待确认')),
    preview.generatedAt&&h(React.Fragment,null,h('dt',null,t('目录签名日期')),h('dd',{'data-signed-date':preview.generatedAt},signedDate(preview.generatedAt))),
    preview.activeGeneratedAt&&h(React.Fragment,null,h('dt',null,t('正在用的目录')),h('dd',null,signedDate(preview.activeGeneratedAt)))),
   older?h('div',{className:'ui-alert warn',role:'status','data-offline-older':true},Icon('alert',{size:16}),h('div',null,h('b',null,t('这份文件里的目录比正在用的旧')),h('p',null,t('不会替换正在用的目录；文件里的插件包按正在用的目录核对。'))))
    :preview.warnOld&&h('div',{className:'ui-alert warn',role:'status','data-offline-stale':true},Icon('alert',{size:16}),h('div',null,h('b',null,t('这份目录已经签名 {n} 天了').replace('{n}',preview.ageDays)),h('p',null,t('之后发布方可能撤回过其中的版本。能联网的话，先刷新目录更稳妥。')))),
   preview.replaceCatalog&&!preview.warnOld&&h('p',{className:'ext-cap'},t('导入后，这份目录会成为这个来源正在用的目录。')),
   works.length?h('div',{className:'ext-col'},h('b',{className:'ext-sm'},t('文件里的插件包')),...works.map(work=>h('div',{key:work.sourceId+':'+work.id+'@'+work.version,className:'ext-row'},h(PluginLogo,{packageName:work.packageName,size:28}),h('span',null,pluginName(work.packageName,work.packageName)+' '+work.version))))
    :h('p',{className:'ext-cap'},t('文件里只有签名目录，没有插件包；装的时候会联网下载。'))));
}
