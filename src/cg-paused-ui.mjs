import React,{useRef,useState} from 'react';
import {t} from './i18n.mjs';
import {Icon} from './ui-icons.mjs';
const h=React.createElement;
export function cgPauseInfo(item){if(item?.status!=='paused')return null;return {allowed:item.resumeAllowed!==false,reason:typeof item.pauseReason==='string'?item.pauseReason:typeof item.error==='string'?item.error:''};}
// Only an explicit button resumes one task. Rendering a gallery must never
// submit or resume a paid request, including when the old submission is unknown.
export function CgPausedNotice({item,onResumed,onResume,compact=false}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),working=useRef(false),info=cgPauseInfo(item);if(!info)return null;
 const resume=async()=>{if(working.current||!info.allowed)return;working.current=true;setBusy(true);setError('');try{const result=await (onResume?onResume(item.id):globalThis.window.whale.cg.resume(item.id));if(result?.ok===false)throw Error(result.error?.message||result.error||t('CG 恢复失败'));await onResumed?.(result);}catch(e){setError(e.message||String(e));}finally{working.current=false;setBusy(false);}};
 return h('div',{className:'ui-note cg-paused-notice','data-cg-paused':item.id,role:'status',style:{display:'flex',alignItems:'flex-start',gap:12,flexWrap:'wrap'}},Icon('pause',{size:18}),h('div',{style:{flex:'1 1 220px',minWidth:0}},h('b',null,t('CG 已暂停')),!compact&&h('p',{style:{margin:'6px 0',lineHeight:1.6}},t('旧存档已保留此任务，需手动继续；不会因为打开图鉴自动请求绘图。')),info.reason&&h('p',{style:{margin:'6px 0',overflowWrap:'anywhere'}},t(info.reason)),!info.allowed&&h('p',{style:{margin:'6px 0',lineHeight:1.6}},t('无法确认旧请求是否已提交。请核对服务端记录后手动重试，避免重复收费。')),error&&h('p',{role:'alert',className:'ws-errtxt'},error)),h('button',{type:'button',className:'ui-btn sm',disabled:busy||!info.allowed,onClick:resume,'data-cg-resume':item.id},busy?t('正在恢复…'):t('继续此 CG')));
}
