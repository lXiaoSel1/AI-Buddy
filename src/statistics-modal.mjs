import {t} from './i18n.mjs';
import React,{useEffect,useRef} from 'react';
import {Icon} from './ui-icons.mjs';
const h=React.createElement;
// One dialog style for the statistics pages: title with an optional one-line note, an icon close
// button, and a footer kept apart from the scrolling body.
export function StatisticsModal({title,subtitle,onClose,children,footer,wide=false}){
 const ref=useRef(null),callback=useRef(onClose);callback.current=onClose;
 useEffect(()=>{const before=document.activeElement,node=ref.current;node.showModal();const wheel=e=>{if(!node.contains(e.target)){e.preventDefault();return;}let target=e.target;while(target&&target!==node){if(target.scrollHeight>target.clientHeight+1&&(e.deltaY<0?target.scrollTop>0:target.scrollTop+target.clientHeight<target.scrollHeight-1))return;target=target.parentElement;}e.preventDefault();};document.addEventListener('wheel',wheel,{capture:true,passive:false});return()=>{document.removeEventListener('wheel',wheel,true);node.close();queueMicrotask(()=>before?.isConnected&&before.focus());};},[]);
 return h('dialog',{ref,className:'stats-modal ws-mdl'+(wide?' stats-modal-wide wide':''),'aria-label':title,onCancel:e=>{e.preventDefault();callback.current();},onClick:e=>{if(e.target===ref.current){const r=ref.current.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)callback.current();}}},
  h('header',null,h('h2',null,title),subtitle&&h('span',{className:'ws-sub'},subtitle),h('button',{type:'button',className:'ui-icon-btn','aria-label':t("关闭"),onClick:onClose},Icon('close',{size:18}))),
  h('div',{className:'stats-modal-body'},children),
  h('footer',null,footer||h(React.Fragment,null,h('span',{className:'spacer'}),h('button',{className:'ui-btn',onClick:onClose},t("关闭")))));
}
