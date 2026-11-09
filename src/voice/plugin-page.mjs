import React from 'react';
import {locale,t} from '../i18n.mjs';
import {StatusPill,Menu} from '../ui-controls.mjs';
import {VoiceSettingsPanel} from './client.mjs';
import {VoiceIcon} from './design-icons.mjs';
import {VOICE_PAGES,voicePackageLabel,voicePackagePresentation} from './shell-design.mjs';
const h=React.createElement;
const L=(zh,en)=>locale()==='en'?en:zh;

// Page selection is only browsing. Starting/switching remains an explicit action
// in VoiceSettingsPanel and uses the already-owned renderer session.
export function VoicePluginHeader({snapshot,selectedPackageId,onSelectPackage,onPlugins,onChat}){
 const id=selectedPackageId??snapshot?.state?.selectedPackageId??VOICE_PAGES[0].id,view=voicePackagePresentation(snapshot,id);
 const select=(event,index)=>{const delta={ArrowLeft:-1,ArrowRight:1}[event.key];let next;if(delta)next=(index+delta+VOICE_PAGES.length)%VOICE_PAGES.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=VOICE_PAGES.length-1;else return;event.preventDefault();onSelectPackage?.(VOICE_PAGES[next].id);event.currentTarget.parentElement?.querySelectorAll('[role=tab]')[next]?.focus();};
 return h('header',{className:'embed-bar vx-plugin-header'},h('span',{className:'ext-logo',style:{'--pl':'26px'},'aria-hidden':true},VoiceIcon('wave',{size:13})),h('b',{className:'embed-bar-n'},L('语音','Voice')),h(StatusPill,{tone:view.tone},view.label),
  h('div',{className:'ui-seg vx-pagetabs',role:'tablist','aria-label':L('语音插件','Voice plugins')},...VOICE_PAGES.map((value,index)=>h('button',{key:value.id,type:'button',role:'tab','aria-selected':value.id===id,'aria-checked':value.id===id,'aria-controls':'voice-plugin-panel',tabIndex:value.id===id?0:-1,'data-voice-tab':value.id,onClick:()=>onSelectPackage?.(value.id),onKeyDown:event=>select(event,index)},VoiceIcon(value.icon,{size:14}),voicePackageLabel(value.id)))),h('span',{className:'embed-grow'}),
  h('details',{className:'embed-more vx-head-menu'},h('summary',{className:'ui-icon-btn','aria-label':t('更多'),title:t('更多')},VoiceIcon('more',{size:16})),h(Menu,{label:t('更多'),className:'ext-menu-r',items:[{label:L('在扩展中心查看','View in Extensions'),icon:'nav-plugins',onSelect:()=>onPlugins?.(id)},onChat&&{label:L('打开 Galgame','Open Galgame'),icon:'nav-galgame',onSelect:onChat}].filter(Boolean)})));
}
export function VoicePluginPage({snapshot,session,selectedPackageId,onSelectPackage,onPlugins,onChat}){
 return h(VoiceSettingsPanel,{snapshot,session,selectedPackageId: selectedPackageId??snapshot?.state?.selectedPackageId??VOICE_PAGES[0].id,onSelectPackage,onPlugins,onChat});
}
