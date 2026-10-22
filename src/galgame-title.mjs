import React,{useEffect,useRef,useState} from 'react';
import {t} from './i18n.mjs';
import {Icon} from './ui-icons.mjs';
const h=React.createElement;
export function GalgameTitle({characterId,defaultTitle,value='',request}) {
  const [open,setOpen]=useState(false),[draft,setDraft]=useState(value||defaultTitle),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const dialog=useRef(null),input=useRef(null),trigger=useRef(null),lock=useRef(false);
  useEffect(()=>{if(!open)return;dialog.current?.showModal();input.current?.select();return()=>{dialog.current?.close();trigger.current?.focus();};},[open]);
  const save=async title=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await request('companion-title-set',{characterId,title});setOpen(false);}catch(e){setError(e.message);}finally{lock.current=false;setBusy(false);}};
  return h(React.Fragment,null,h('button',{type:'button',ref:trigger,className:'whg-title buddy-title-edit gx-title',title:t('编辑 Galgame 标题'),'aria-label':t('编辑 Galgame 标题'),onClick:()=>{setDraft(value||defaultTitle);setError('');setOpen(true);}},value||defaultTitle,Icon('pencil',{size:15})),
    open&&h('dialog',{ref:dialog,className:'ws-mdl buddy-title-dialog',onCancel:e=>{e.preventDefault();if(!busy)setOpen(false);},'aria-label':t('编辑 Galgame 标题')},
      h('form',{className:'ws-mdl-form',onSubmit:e=>{e.preventDefault();if(draft.trim())void save(draft.trim());}},
        h('header',null,h('h2',null,t('编辑 Galgame 标题')),h('button',{type:'button',className:'ui-icon-btn','aria-label':t('关闭'),disabled:busy,onClick:()=>setOpen(false)},Icon('close',{size:18}))),
        h('div',{className:'stats-modal-body'},
          h('label',{className:'ws-fld'},h('span',null,t('标题')),h('input',{ref:input,value:draft,maxLength:80,'aria-label':t('Galgame 标题'),disabled:busy,onChange:e=>setDraft(e.target.value)}),
            h('small',{className:'ws-fld-foot'},h('span',null,t('只修改当前角色的界面标题，不改变角色名称、人设或群名。')),h('span',{className:'ws-tabular'},draft.length+' / 80'))),
          error&&h('p',{role:'alert',className:'ws-errtxt'},error)),
        h('footer',null,
          h('button',{type:'button',className:'ui-btn ghost',disabled:busy,onClick:()=>void save('')},t('恢复默认')),
          h('span',{className:'spacer'}),
          h('button',{type:'button',className:'ui-btn',disabled:busy,onClick:()=>setOpen(false)},t('取消')),
          h('button',{type:'submit',className:'ui-btn primary',disabled:busy||!draft.trim()},t('保存')))
      )
    )
  );
}
