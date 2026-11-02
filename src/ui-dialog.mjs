// A real modal on the ws-mdl dialog of the approved design: showModal (focus stays inside, the page
// behind is inert), Esc and a click on the scrim close it, focus returns to where it was.
// sheet:true slides in from the right edge (plugin details); otherwise it is centred.
import React,{useEffect,useRef} from 'react';
import {t} from './i18n.mjs';
import {Icon} from './ui-icons.mjs';
const h=React.createElement;
// actions (optional): header buttons placed before the close button, e.g. the plugin sheet's 「安装…」 (B2).
export function Dialog({title,subtitle,onClose,children,footer,sheet=false,wide=false,busy=false,className='',label,head=null,actions=null,...rest}){
 const ref=useRef(null),close=useRef(onClose),blocked=useRef(busy);close.current=onClose;blocked.current=busy;
 useEffect(()=>{const before=document.activeElement,node=ref.current;try{node.showModal();}catch{node.setAttribute('open','');}return()=>{node.close?.();queueMicrotask(()=>before?.isConnected&&before.focus({preventScroll:true}));};},[]);
 const outside=e=>{if(e.target!==ref.current||blocked.current)return;const r=ref.current.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close.current();};
 return h('dialog',{ref,className:'ws-mdl ui-dlg'+(sheet?' ui-sheet':'')+(wide?' wide':'')+(className?' '+className:''),'aria-label':label??title,onCancel:e=>{e.preventDefault();if(!blocked.current)close.current();},onClick:outside,...rest},
  h('header',null,head,h('div',{className:'ui-dlg-t'},h('h2',null,title),subtitle&&h('span',{className:'ws-sub'},subtitle)),actions&&h('div',{className:'ui-dlg-act'},actions),h('button',{type:'button',className:'ui-icon-btn','aria-label':t('关闭')+' · '+title,title:t('关闭')+'（Esc）',disabled:busy,onClick:onClose},Icon('close',{size:18}))),
  h('div',{className:'ui-dlg-body'},children),
  footer&&h('footer',null,footer));
}
