import React,{useEffect,useRef,useState} from 'react';
import {t} from './i18n.mjs';
const h=React.createElement;
export function GalgameTitle({characterId,defaultTitle,value='',request}) {
  const [open,setOpen]=useState(false),[draft,setDraft]=useState(value||defaultTitle),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const dialog=useRef(null),input=useRef(null),trigger=useRef(null),lock=useRef(false);
  useEffect(()=>{if(!open)return;dialog.current?.showModal();input.current?.select();return()=>{dialog.current?.close();trigger.current?.focus();};},[open]);
  const save=async title=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await request('companion-title-set',{characterId,title});setOpen(false);}catch(e){setError(e.message);}finally{lock.current=false;setBusy(false);}};
  return h(React.Fragment,null,h('button',{type:'button',ref:trigger,className:'whg-title buddy-title-edit',title:t('编辑 Galgame 标题'),'aria-label':t('编辑 Galgame 标题'),onClick:()=>{setDraft(value||defaultTitle);setError('');setOpen(true);}},value||defaultTitle,h('span',{'aria-hidden':true},' ✎')),
    open&&h('dialog',{ref:dialog,className:'buddy-dialog buddy-title-dialog',onCancel:e=>{e.preventDefault();if(!busy)setOpen(false);},'aria-label':t('编辑 Galgame 标题')},
      h('form',{onSubmit:e=>{e.preventDefault();if(draft.trim())void save(draft.trim());}},
        h('h2',null,t('编辑 Galgame 标题')),
        h('p',{className:'buddy-note'},t('只修改当前角色的界面标题，不改变角色名称、人设或群名。')),
        h('div',{className:'buddy-field'},h('input',{ref:input,value:draft,maxLength:80,'aria-label':t('Galgame 标题'),disabled:busy,onChange:e=>setDraft(e.target.value)})),
        error&&h('p',{role:'alert',className:'buddy-error'},error),
        h('div',{className:'buddy-inline-actions'},
          h('button',{type:'submit',disabled:busy||!draft.trim()},t('保存')),
          h('button',{type:'button',disabled:busy,onClick:()=>void save('')},t('恢复默认')),
          h('button',{type:'button',disabled:busy,onClick:()=>setOpen(false)},t('取消'))
        )
      )
    )
  );
}
