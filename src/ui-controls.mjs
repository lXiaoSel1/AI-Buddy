// Shared controls of the approved design; styles live in appearance.css (.ui-*).
// Toasts, snackbars and menus are never <dialog>: an open dialog holds back chat replies.
import React from 'react';
import {Icon} from './ui-icons.mjs';
const h=React.createElement;
const pick=props=>Object.fromEntries(Object.entries(props).filter(([k])=>k.startsWith('data-')||k.startsWith('aria-')||k==='id'||k==='title'));

// options: [[value,label],...]; extra data-*/aria-* props go to the group.
export function Segmented({value,options,onChange,disabled=false,size='',label,...rest}){
 return h('div',{className:'ui-seg'+(size?' '+size:''),role:'radiogroup','aria-label':label,...pick(rest)},
  ...options.map(([v,text])=>h('button',{key:String(v),type:'button',role:'radio','aria-checked':v===value,disabled,onClick:()=>{if(v!==value)onChange?.(v);}},text)));
}
export function Switch({checked,onChange,disabled=false,label,...rest}){
 return h('button',{type:'button',className:'ui-switch',role:'switch','aria-checked':!!checked,'aria-label':label,disabled,onClick:()=>onChange?.(!checked),...pick(rest)});
}
// tone: ok | warn | err | busy | idle
export function StatusPill({tone='idle',children,...rest}){
 return h('span',{className:'ui-pill'+(tone==='idle'?'':' '+tone),...pick(rest)},tone==='busy'?h('span',{className:'ui-spinner','aria-hidden':true}):h('span',{className:'ui-dot','aria-hidden':true}),children);
}
// tabs: [[id,label,icon?],...]; the label stays the button's whole text.
export function Tabs({tabs,active,onSelect,label,idPrefix='ui-tab'}){
 const move=(event,index)=>{const keys={ArrowRight:1,ArrowLeft:-1};let next=null;if(event.key in keys)next=(index+keys[event.key]+tabs.length)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;if(next===null)return;event.preventDefault();onSelect(tabs[next][0]);setTimeout(()=>event.currentTarget?.parentElement?.querySelector('[aria-selected=true]')?.focus(),0);};
 return h('div',{className:'ui-tabs',role:'tablist','aria-label':label},...tabs.map(([id,text,icon],index)=>h('button',{key:id,type:'button',role:'tab','aria-selected':active===id,'aria-controls':idPrefix+'-'+id,tabIndex:active===id?0:-1,onClick:()=>onSelect(id),onKeyDown:e=>move(e,index)},icon&&Icon(icon,{size:15}),text)));
}
export function EmptyState({icon,title,children,action=null}){
 return h('div',{className:'ui-empty'},icon&&Icon(icon,{size:36}),title&&h('b',null,title),children&&h('p',{style:{margin:0}},children),action);
}
export const Spinner=({label})=>h('span',{className:'ui-spinner',role:label?'status':undefined,'aria-label':label});
export function Notice({tone='info',icon,children,action=null,...rest}){
 return h('div',{className:tone==='info'?'ui-note':'ui-alert'+(tone==='warn'?' warn':''),role:tone==='err'?'alert':'status',...pick(rest)},Icon(icon||(tone==='info'?'info':'alert'),{size:16}),h('div',{style:{flex:1,minWidth:0}},children),action);
}
export function Toast({tone='',icon,busy=false,children,...rest}){
 return h('div',{className:'ui-toast'+(tone?' '+tone:''),role:tone==='err'?'alert':'status',...pick(rest)},busy?h('span',{className:'ui-spinner','aria-hidden':true}):icon&&Icon(icon,{size:18}),h('div',{style:{flex:1,minWidth:0,display:'flex',flexDirection:'column',gap:6}},children));
}
export function Snackbar({children,actionLabel,onAction,...rest}){
 return h('div',{className:'ui-snackbar',role:'status',...pick(rest)},h('span',{style:{flex:1}},children),actionLabel&&h('button',{type:'button',onClick:onAction},actionLabel));
}
// items: [{label,icon,onSelect,danger,disabled,checked}] or 'separator'
export function Menu({items,label,style,onClose}){
 const keys=event=>{if(event.key==='Escape'){event.preventDefault();onClose?.();return;}if(!['ArrowDown','ArrowUp'].includes(event.key))return;event.preventDefault();const list=[...event.currentTarget.querySelectorAll('[role^=menuitem]:not(:disabled)')],i=list.indexOf(document.activeElement);list[(i+(event.key==='ArrowDown'?1:list.length-1))%list.length]?.focus();};
 return h('div',{className:'ui-menu',role:'menu','aria-label':label,style,onKeyDown:keys},...items.map((item,index)=>item==='separator'?h('hr',{key:'s'+index}):h('button',{key:item.label,type:'button',role:item.checked===undefined?'menuitem':'menuitemcheckbox','aria-checked':item.checked===undefined?undefined:!!item.checked,className:item.danger?'danger':undefined,disabled:item.disabled,onClick:()=>{item.onSelect?.();onClose?.();}},item.icon&&Icon(item.icon,{size:16}),item.label,item.shortcut&&h('kbd',null,item.shortcut))));
}
