import React,{useState} from 'react';
import {t} from './i18n.mjs';
import {Menu} from './ui-controls.mjs';
import {legacyUpdateKey} from './plugin-update-policy.mjs';
import {PluginVersionMenu} from './plugin-center.mjs';
import {VoicePackageRow} from './voice/shell-design.mjs';

const h=React.createElement;

/** Version changes remain plan/install requests, so both installed engines are reviewed together. */
export function VoiceInstalledMoreMenu({row,record,call,run=fn=>fn(),busy=false,onClose,onConfirm,onVersionSelect,versionsOpen=false,onVersionsOpen}){
  const id=row.manifest.id,key=legacyUpdateKey(row.sourceId??'legacy',id),policy=row.updatePolicy??'manual';
  const previous=row.versions?.find(version=>version.manifest.version===row.previous);
  const unavailable=previous?.compatible===false||previous?.switchCompatible===false;
  // Menu closes after selecting a leaf; opening its version branch keeps the parent open.
  let openingBranch=false;
  const items=[
    {label:t('更新方式：手动更新'),icon:'sliders',checked:policy==='manual',disabled:busy,onSelect:()=>run(()=>call({action:'community-set-update-policy',packageKey:key,policy:'manual'}))},
    {label:t('更新方式：自动更新兼容补丁'),icon:'sliders',checked:policy==='auto',disabled:busy,onSelect:()=>run(()=>call({action:'community-set-update-policy',packageKey:key,policy:'auto'}))},
    'separator',
    {label:t('切换版本'),shortcut:versionsOpen?'▾':'›',disabled:busy||!row.versions?.length,onSelect:()=>{openingBranch=true;onVersionsOpen?.(!versionsOpen);}},
    row.previous&&{label:t('回退到 {v}').replace('{v}',row.previous),icon:'retry',disabled:busy||!previous||unavailable,onSelect:()=>onVersionSelect?.(previous)},
    {label:t('卸载（保留角色声音和设置）…'),icon:'close',danger:true,disabled:busy,onSelect:()=>onConfirm?.({kind:'uninstall',record:{...record,packageName:id,sourceId:row.sourceId,backend:'legacy'}})}
  ].filter(Boolean);
  return h('div',{className:'ext-menu-r vx-menu','data-installed-voice-menu':id,style:{width:'max-content',maxWidth:'min(540px,calc(100vw - 40px))'}},
    h(Menu,{label:t('更多'),items,onClose:()=>{if(!openingBranch)onClose?.();openingBranch=false;},style:{position:'relative'}}),
    versionsOpen&&h('div',{'data-plugin-version-submenu':true},h(PluginVersionMenu,{row,disabled:busy,onSelect:onVersionSelect,onClose,style:{position:'relative',marginTop:6}})));
}

/** The production installed row keeps its existing start/open/enable behavior and supplies this menu. */
export function InstalledVoicePluginRow(props){
  const [versionsOpen,setVersionsOpen]=useState(false);
  return h(VoicePackageRow,{...props,menu:h(VoiceInstalledMoreMenu,{...props,versionsOpen,onVersionsOpen:setVersionsOpen,onClose:()=>props.onMenu?.(false)})});
}
