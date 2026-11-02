import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {t} from './i18n.mjs';
import {Icon} from './ui-icons.mjs';
import {clock,fill,tn} from './chat-r95-ui.mjs';
const h=React.createElement;
export const paragraphCount=text=>String(text??'').split(/\n\s*\n|\n/).filter(part=>part.trim()).length;
// The button only appears when the line box could not show it all at a glance (approved design C9).
export const needsFullView=text=>!!text&&(paragraphCount(text)>1||String(text).length>120);
export const fullTextLabel=text=>{const count=paragraphCount(text);return count>1?fill(t('查看全文（{n} 段）'),{n:count}):t('查看全文');};
// Under the title: when, how many paragraphs, and whether the reply was stopped part-way.
export function fullMessageMeta({text,at,interrupted=false}){return [clock(at),tn('{n} 段',paragraphCount(text)),interrupted&&t('已中断，保留了已生成的部分')].filter(Boolean).join(' · ');}

// Uses the displayed message verbatim (after a stop: the kept partial text). Opening this reader has no model or
// presentation side effects; a different message/scope closes the old reader.
export function FullMessageButton({text,messageId,title,name,at,interrupted=false}){
 const [snapshot,setSnapshot]=useState(null),[copied,setCopied]=useState(false),dialog=useRef(null),trigger=useRef(null);
 useEffect(()=>setSnapshot(null),[messageId]);
 useEffect(()=>{
  if(!snapshot)return;
  const node=dialog.current;node?.showModal();
  return()=>{node?.close();if(trigger.current?.isConnected)trigger.current.focus({preventScroll:true});};
 },[snapshot]);
 if(!needsFullView(text))return null;
 const close=()=>{setSnapshot(null);setCopied(false);};
 const copy=async()=>{try{await navigator.clipboard.writeText(snapshot.text);setCopied(true);}catch{const range=document.createRange();range.selectNodeContents(dialog.current.querySelector('.buddy-full-message-text'));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);}};
 const open=()=>setSnapshot({text:String(text),title:name?fill(t('{name} 的这条回复'),{name}):title||t('完整正文'),meta:fullMessageMeta({text,at,interrupted}),interrupted:!!interrupted});
 return h(React.Fragment,null,
  h('div',{className:'buddy-full-message-control'},h('button',{ref:trigger,type:'button',className:'gx-gbtn','data-view-full-message':messageId,'data-interrupted':interrupted||undefined,onClick:open},fullTextLabel(text))),
  snapshot&&createPortal(h('dialog',{ref:dialog,className:'buddy-dialog buddy-full-message','aria-label':snapshot.title,onCancel:event=>{event.preventDefault();close();},onKeyDownCapture:event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}}},
   h('div',{className:'buddy-dialog-shell'},
    h('header',{className:'buddy-dialog-head'},h('div',{className:'buddy-full-message-t'},h('h2',null,snapshot.title),h('small',{'data-full-message-meta':true},snapshot.meta)),h('button',{type:'button',className:'buddy-dialog-close ui-icon-btn','aria-label':t('关闭'),onClick:close},Icon('close',{size:18}))),
    h('div',{className:'buddy-dialog-body buddy-full-message-body',tabIndex:0},h('div',{className:'buddy-full-message-text'},snapshot.text),snapshot.interrupted&&h('p',{className:'buddy-full-message-cut'},t('（这里中断了）'))),
    h('footer',{className:'buddy-full-message-foot'},snapshot.interrupted&&h('span',{className:'buddy-full-message-note'},t('已中断 · 不会自动续写')),copied&&h('span',{role:'status'},t('已复制')),h('span',{className:'grow'}),h('button',{type:'button',className:'ui-btn sm',onClick:()=>void copy()},Icon('file',{size:14}),t('复制全文')),h('button',{type:'button',className:'ui-btn sm primary',onClick:close},t('关闭'))))),document.body));
}

export const FullMessageCSS=`
.whg-panel .whg-line-now:not(.gx-typing){white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;min-height:0}
/* approved design C9, one height rule: the box grows with the line up to 40% of the stage; longer text scrolls in
   the box (the stage height and the rest of the box are measured by the Galgame page) */
.galgame-page .whg-root-tab .whg-panel .whg-line-now:not(.gx-typing){flex:0 1 auto;max-height:var(--gx-line-room,3.1em)}
.buddy-full-message-control{display:flex;justify-content:flex-end;flex:none;min-height:24px}
.buddy-dialog.buddy-full-message{height:fit-content;min-height:0;margin:auto;max-height:min(80dvh,820px);width:min(760px,calc(100vw - 32px))}
.buddy-full-message .buddy-dialog-shell{display:flex;flex-direction:column;max-height:inherit}
.buddy-full-message .buddy-full-message-t{display:grid;gap:2px;min-width:0}
.buddy-full-message .buddy-full-message-t small{color:var(--buddy-muted);font-size:var(--buddy-fs-sm)}
.buddy-full-message .buddy-full-message-body{flex:1;min-height:0;overflow:auto}
.buddy-full-message .buddy-full-message-text{max-width:68ch;margin:0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;font:15px/1.7 var(--buddy-f-ui,system-ui);user-select:text}
.buddy-full-message-cut{max-width:68ch;margin:10px 0 0;color:var(--buddy-muted);font-style:italic}
.buddy-full-message-foot{display:flex;align-items:center;gap:8px;padding:12px 20px;border-top:1px solid var(--buddy-border)}
.buddy-full-message-foot .grow{flex:1}
.buddy-full-message-foot [role=status]{color:var(--buddy-ok);font-size:var(--buddy-fs-sm)}
.buddy-full-message-note{color:var(--buddy-muted);font-size:var(--buddy-fs-cap)}
`;
