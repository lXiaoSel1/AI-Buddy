import React,{useEffect,useRef} from 'react';
import {t} from '../i18n.mjs';
import {VoiceIcon} from './design-icons.mjs';
import {PET_CHARACTERS} from '../pet-characters.mjs';
import {themeAsset} from '../appearance.mjs';
import {voiceProfileLabel} from './profile-label.mjs';

const h=React.createElement;
export function cloudIcon(name,size=16){
  return VoiceIcon(name,{size});
}
export const cloudCharacterId=row=>row?.characterId??row?.id;
export const cloudCharacterLabel=row=>voiceProfileLabel(row)??row?.name??t(PET_CHARACTERS.find(item=>item.id===cloudCharacterId(row))?.name??cloudCharacterId(row)??'角色');
export function CloudCharacterFace({row}){
  const id=cloudCharacterId(row),builtin=PET_CHARACTERS.some(item=>item.id===id);
  return h('span',{className:'mk-face vx-cface','aria-hidden':true},builtin?h('img',{src:'./'+themeAsset(id,'head.webp'),alt:''}):cloudCharacterLabel(row).slice(0,1));
}

// Native modal lifecycle, dismissal and focus restoration match StatisticsModal.
// The inner structure and dimensions are copied from secVS.js's dlg helper.
export function CloudDesignDialog({title,subtitle,onClose,children,footer,width=640,noActions=false}){
  const ref=useRef(null),callback=useRef(onClose);callback.current=onClose;
  useEffect(()=>{
    const before=document.activeElement,node=ref.current;node.showModal();
    const wheel=e=>{if(!node.contains(e.target)){e.preventDefault();return;}let target=e.target;while(target&&target!==node){if(target.scrollHeight>target.clientHeight+1&&(e.deltaY<0?target.scrollTop>0:target.scrollTop+target.clientHeight<target.scrollHeight-1))return;target=target.parentElement;}e.preventDefault();};
    document.addEventListener('wheel',wheel,{capture:true,passive:false});
    return()=>{document.removeEventListener('wheel',wheel,true);node.close();queueMicrotask(()=>before?.isConnected&&before.focus());};
  },[]);
  return h('dialog',{ref,className:'vx-cloud-dialog','aria-label':title,style:{width},onCancel:e=>{e.preventDefault();callback.current?.();},onClick:e=>{if(e.target===ref.current){const r=ref.current.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)callback.current?.();}}},
    h('div',{className:'ui-dlg vx-dlg vx-cloud'+(noActions?' vx-noact':'')},
      h('div',{className:'vx-dlg-h'},h('div',null,h('h3',{className:'ui-dlg-t'},title),subtitle&&h('p',{className:'ws-muted'},subtitle)),h('button',{type:'button',className:'ui-icon-btn','aria-label':t('关闭'),onClick:onClose},cloudIcon('close'))),
      h('div',{className:'ui-dlg-body'},children),h('div',{className:'ui-dlg-act'},footer)));
}
