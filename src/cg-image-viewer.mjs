import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {t} from './i18n.mjs';
import {Icon} from './ui-icons.mjs';
const h=React.createElement;
// A CG thumbnail that opens a full-window viewer: wheel / buttons zoom, drag pans when zoomed, double-click toggles.
export function CgImageViewer({src,alt,title,subtitle}) {
 const [open,setOpen]=useState(false),[zoom,setZoom]=useState(1),[pan,setPan]=useState({x:0,y:0}),[error,setError]=useState(false);
 const dialog=useRef(null),viewport=useRef(null),image=useRef(null),trigger=useRef(null),drag=useRef(null);
 useEffect(()=>{if(!open)return;dialog.current.showModal();const resize=()=>setPan({x:0,y:0});window.addEventListener('resize',resize);return()=>{window.removeEventListener('resize',resize);dialog.current?.close();trigger.current?.focus({preventScroll:true});};},[open]);
 useEffect(()=>{setOpen(false);},[src]);
 const fit=()=>{setZoom(1);setPan({x:0,y:0});};
 const change=value=>{setZoom(Math.max(1,Math.min(8,value)));setPan({x:0,y:0});};
 useEffect(()=>{if(!open)return;const node=viewport.current,wheel=e=>{e.preventDefault();e.stopPropagation();change(zoom*Math.exp(-e.deltaY*.001));};node.addEventListener('wheel',wheel,{passive:false});return()=>node.removeEventListener('wheel',wheel);},[open,zoom]);
 const limits=()=>{const box=viewport.current?.getBoundingClientRect(),img=image.current;if(!box||!img?.naturalWidth)return {x:0,y:0};const ratio=Math.min(box.width/img.naturalWidth,box.height/img.naturalHeight);return {x:Math.max(0,(img.naturalWidth*ratio*zoom-box.width)/2),y:Math.max(0,(img.naturalHeight*ratio*zoom-box.height)/2)};};
 const close=()=>{drag.current=null;setOpen(false);};
 const key=(cap,text)=>h('span',null,h('kbd',null,cap),text);
 return h(React.Fragment,null,h('button',{ref:trigger,type:'button',className:'buddy-cg-open',onClick:()=>{fit();setError(false);setOpen(true);},'aria-label':t('打开 CG 大图'),title:t('点击查看大图')},h('img',{className:'whg-gallery-full',src,alt,draggable:false}),h('span',{className:'buddy-cg-zoom'},Icon('zin',{size:14}),t('点击看大图'))),
 open&&createPortal(h('dialog',{ref:dialog,className:'buddy-cg-lightbox','aria-label':t('CG 大图查看'),onCancel:e=>{e.preventDefault();close();},onKeyDownCapture:e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}else if(['+','=','-','0'].includes(e.key)){e.preventDefault();e.stopPropagation();if(e.key==='0')fit();else change(zoom*(e.key==='-'?.8:1.25));}}},
  h('header',null,h('strong',null,title||alt),subtitle&&h('small',null,subtitle),h('span',{className:'buddy-cg-grow'}),
   h('div',{className:'buddy-cg-ctl',role:'group','aria-label':t('大图缩放')},h('button',{type:'button','aria-label':t('缩小'),disabled:zoom<=1,onClick:()=>change(zoom/1.25)},Icon('zout',{size:16})),h('output',{'aria-label':t('大图缩放')},Math.round(zoom*100)+'%'),h('button',{type:'button','aria-label':t('放大'),disabled:zoom>=8,onClick:()=>change(zoom*1.25)},Icon('zin',{size:16})),h('button',{type:'button',className:'lbl',disabled:zoom===1&&pan.x===0&&pan.y===0,onClick:fit},Icon('fit',{size:15}),t('适应窗口'))),
   h('button',{type:'button',className:'buddy-cg-x','aria-label':t('关闭大图'),onClick:close},Icon('close',{size:18}))),
  h('div',{ref:viewport,className:'buddy-cg-viewport','data-zoom':zoom,onDoubleClick:()=>zoom===1?change(2):fit(),onPointerDown:e=>{if(e.button!==0||zoom<=1)return;e.preventDefault();viewport.current.setPointerCapture(e.pointerId);drag.current={id:e.pointerId,x:e.clientX,y:e.clientY,pan};},onPointerMove:e=>{const d=drag.current;if(!d||d.id!==e.pointerId)return;const limit=limits();setPan({x:Math.max(-limit.x,Math.min(limit.x,d.pan.x+e.clientX-d.x)),y:Math.max(-limit.y,Math.min(limit.y,d.pan.y+e.clientY-d.y))});},onPointerUp:e=>{if(drag.current?.id===e.pointerId){drag.current=null;if(viewport.current.hasPointerCapture(e.pointerId))viewport.current.releasePointerCapture(e.pointerId);}},onPointerCancel:()=>{drag.current=null;},onLostPointerCapture:()=>{drag.current=null;}},error?h('p',{role:'alert'},t('这张 CG 暂时无法读取。')):h('img',{ref:image,src,alt,draggable:false,onError:()=>setError(true),style:{transform:`translate(${pan.x}px,${pan.y}px) scale(${zoom})`}})),
  h('footer',null,key(t('滚轮'),t('缩放')),key(t('拖动'),t('放大后移动')),key(t('双击'),t('复位 / 放大')),key('Esc',t('关闭')))),document.body));
}
// The viewer stays near-black in every theme so the picture's own colours read true.
export const CgImageViewerCSS=`
.buddy-cg-open{position:relative;display:block;width:100%;padding:0;border:0;border-radius:12px;overflow:hidden;background:transparent;color:inherit;cursor:zoom-in}
.buddy-cg-open>img{display:block;width:100%}
.buddy-cg-zoom{position:absolute;right:10px;bottom:10px;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:999px;background:rgba(0,0,0,.55);color:#fff;font:12px/1 var(--buddy-f-ui)}
.buddy-cg-open:focus-visible{outline:2px solid var(--buddy-accent);outline-offset:3px}
.buddy-cg-lightbox{box-sizing:border-box;position:fixed;inset:0;width:100vw;height:100dvh;max-width:100vw;max-height:100dvh;margin:0;padding:0;border:0;background:rgba(6,8,12,.96);color:#EEF1F6;font:14px/1.5 var(--buddy-f-ui);overflow:hidden}
.buddy-cg-lightbox[open]{display:grid;grid-template-rows:auto minmax(0,1fr) auto}
.buddy-cg-lightbox::backdrop{background:rgba(0,0,0,.6)}
.buddy-cg-lightbox header{display:flex;align-items:center;gap:8px;height:52px;padding:0 12px 0 20px;border-bottom:1px solid rgba(255,255,255,.1)}
.buddy-cg-lightbox header strong{max-width:40vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.buddy-cg-lightbox header small{font-size:12px;color:#A7B0BE;white-space:nowrap}
.buddy-cg-grow{flex:1}
.buddy-cg-ctl{display:inline-flex;align-items:center;gap:2px;padding:3px;border-radius:10px;background:rgba(255,255,255,.08)}
.buddy-cg-lightbox button{display:inline-grid;place-items:center;min-width:30px;height:28px;padding:0 6px;border:0;border-radius:7px;background:none;color:inherit;font:inherit;cursor:pointer}
.buddy-cg-lightbox button.lbl{display:inline-flex;gap:6px;padding:0 10px}
.buddy-cg-lightbox button:hover:not(:disabled){background:rgba(255,255,255,.12)}
.buddy-cg-lightbox button:disabled{opacity:.4;cursor:default}
.buddy-cg-lightbox button:focus-visible{outline:2px solid #EEF1F6;outline-offset:1px}
.buddy-cg-lightbox output{min-width:46px;text-align:center;font-variant-numeric:tabular-nums}
.buddy-cg-x{width:34px;height:34px!important}
.buddy-cg-viewport{min-height:0;min-width:0;overflow:hidden;position:relative;touch-action:none;user-select:none;display:grid;place-items:center;padding:24px;cursor:grab}
.buddy-cg-viewport:active{cursor:grabbing}
.buddy-cg-viewport img{display:block;width:100%;height:100%;min-height:0;max-width:none;object-fit:contain;transform-origin:center;pointer-events:none}
.buddy-cg-lightbox footer{display:flex;justify-content:center;align-items:center;gap:18px;height:40px;font-size:12px;color:#A7B0BE}
.buddy-cg-lightbox kbd{display:inline-grid;place-items:center;min-width:20px;height:20px;margin-right:4px;padding:0 5px;border-radius:5px;background:rgba(255,255,255,.12);font:600 11px/1 var(--buddy-f-ui);color:#EEF1F6}
`;
