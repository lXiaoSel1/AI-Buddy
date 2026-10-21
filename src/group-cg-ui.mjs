import React,{useEffect,useRef,useState} from 'react';
import {t} from './i18n.mjs';
import {CgImageViewer} from './cg-image-viewer.mjs';
const h=React.createElement;
export const activeGroupCg=item=>['queued','planning','generating'].includes(item?.status);
export function groupCgLabel(item){if(item?.status==='generating'&&!item.submittedAt)return t('正在准备绘图请求');return t(({queued:'排队中',planning:'正在设计合影主题',generating:'请求中 · 等待绘图服务返回',ready:'生成成功',failed:'生成失败',cancelled:'已取消'})[item?.status]||'状态未知');}
export function groupCgItems(items,groupId){return (items||[]).filter(row=>row.kind==='group'&&row.groupId===groupId&&!row.deletedAt).sort((a,b)=>b.at-a.at);}
export function useGroupCg(group,request){
 const [items,setItems]=useState([]),[error,setError]=useState(''),[loading,setLoading]=useState(true),requestRef=useRef(request),refreshRef=useRef(()=>{});requestRef.current=request;
 useEffect(()=>{
  if(!group?.id)return;let live=true,busy=false,again=false,timer;setItems([]);setLoading(true);setError('');
  const refresh=async()=>{if(!live)return;if(busy){again=true;return;}busy=true;try{const result=await requestRef.current('cg-gallery',{groupId:group.id});if(result.ok===false)throw Error(result.error);if(live){setItems(groupCgItems(result.items,group.id));setError('');}}catch(e){if(live)setError(e.message);}finally{busy=false;if(live)setLoading(false);if(again){again=false;void refresh();}}};
  refreshRef.current=refresh;void refresh();
  const unsubscribe=window.whale?.onCgUpdated?.(()=>{clearTimeout(timer);timer=setTimeout(refresh,80);});
  // A missed notification must not leave an in-flight task frozen forever.
  const poll=setInterval(()=>{if(!document.hidden)void refresh();},2500);
  return()=>{live=false;clearTimeout(timer);clearInterval(poll);unsubscribe?.();};
 },[group?.id]);
 useEffect(()=>{void refreshRef.current();},[group?.photos?.length]);
 return {items,error,loading,refresh:()=>refreshRef.current()};
}
function Thumb({item,request}){
 const ref=useRef(null),[src,setSrc]=useState(null);
 useEffect(()=>{if(item.status!=='ready')return;let live=true;const observer=new IntersectionObserver(entries=>{if(!entries.some(e=>e.isIntersecting))return;observer.disconnect();request('cg-thumbnail',{id:item.id}).then(r=>{if(live&&r.dataUrl)setSrc(r.dataUrl);}).catch(()=>{});});observer.observe(ref.current);return()=>{live=false;observer.disconnect();};},[item.id,item.status]);
 return h('div',{ref,className:'buddy-group-cg-thumb'},src?h('img',{src,alt:'',loading:'lazy'}):h('span',null,groupCgLabel(item)));
}
export function GroupCgGallery({catalog,request,loadImage,onClose,Dialog,selectedId}){
 const [selected,setSelected]=useState(selectedId||null),[detail,setDetail]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reading,setReading]=useState(false);
 const item=catalog.items.find(row=>row.id===selected);
 useEffect(()=>{setSelected(selectedId||null);},[selectedId]);
 useEffect(()=>{let live=true;setDetail(null);setError('');setReading(false);if(item?.status==='ready'){setReading(true);loadImage(item.id).then(r=>{if(live)setDetail(r);}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setReading(false);});}return()=>{live=false;};},[item?.id,item?.status]);
 return h(Dialog,{title:'群聊 CG 图鉴',onClose,kind:'gallery',busy},
  h('div',{className:'buddy-group-cg-tools'},h('span',null,t('只显示本群合影，含历史生成与重试记录。')),h('button',{type:'button',onClick:catalog.refresh},t('刷新'))),
  (catalog.error||error)&&h('p',{role:'alert',className:'buddy-error'},catalog.error||error),
  catalog.loading&&h('p',{role:'status'},t('正在读取 CG…')),
  !catalog.loading&&!catalog.items.length&&h('p',null,t('本群还没有合影 CG。')),
  h('div',{className:'buddy-group-cg-grid'},...catalog.items.map(row=>h('button',{type:'button',key:row.id,className:'buddy-group-cg-card','data-group-cg-id':row.id,'aria-pressed':selected===row.id,onClick:()=>setSelected(row.id)},h(Thumb,{item:row,request}),h('strong',null,row.theme?.name||row.label||t('群聊合影 CG')),h('span',{'data-cg-status':row.status},groupCgLabel(row)),h('small',null,[row.connectionName,row.model].filter(Boolean).join(' · ')),h('small',null,new Date(row.at).toLocaleString())))),
  item&&h('section',{className:'buddy-group-cg-detail'},h('h3',null,item.theme?.name||item.label||t('群聊合影 CG')),h('p',{role:'status','data-selected-cg-status':item.status},groupCgLabel(item)),item.error&&h('p',{role:'alert',className:'buddy-error'},item.error),reading&&h('p',null,t('正在读取 CG…')),detail?.dataUrl&&h(CgImageViewer,{src:detail.dataUrl,alt:item.theme?.name||item.label||t('群聊合影 CG')}),item.referenceNotice&&h('p',null,t(item.referenceNotice)),['failed','cancelled'].includes(item.status)&&h('button',{type:'button',disabled:busy,onClick:async()=>{if(busy)return;setBusy(true);setError('');try{const r=await request('cg-retry',{id:item.id});if(r.ok===false)throw Error(r.error);await catalog.refresh();setSelected(r.cgId);}catch(e){setError(e.message);}finally{setBusy(false);}}},t('重试此合影')),item.prompt&&h('details',null,h('summary',null,t('查看提示词')),h('p',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},item.prompt))));
}
export const GroupCgCSS=`
.buddy-group-cg-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap;max-width:100%;font-size:12px}.buddy-group-cg-status>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:440px}.buddy-group-cg-status[data-status=failed]{color:#ffd0c5}.buddy-group-cg-status button{font-size:12px!important;padding:5px 9px!important}.buddy-group-cg-tools{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px}.buddy-group-cg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-top:14px}.buddy-group-cg-card{display:flex;flex-direction:column;gap:6px;min-width:0;text-align:left;font:inherit;padding:10px!important;border-radius:10px;overflow-wrap:anywhere}.buddy-group-cg-card[aria-pressed=true]{outline:2px solid #9cd9ee}.buddy-group-cg-card small{font-size:11px;opacity:.8}.buddy-group-cg-thumb{aspect-ratio:16/9;width:100%;display:grid;place-items:center;background:#0b1523;border-radius:7px;overflow:hidden;font-size:12px;color:#dce8f5}.buddy-group-cg-thumb img{width:100%;height:100%;object-fit:contain}.buddy-group-cg-detail{margin-top:20px;padding-top:12px;border-top:1px solid var(--buddy-border,#7893ac55)}.buddy-group-cg-detail .buddy-cg-open img{width:100%;height:auto;max-height:380px;object-fit:contain}.buddy-group-cg-detail .buddy-error{white-space:pre-wrap}
`;
