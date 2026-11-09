import React,{useEffect,useState} from 'react';
import {networkLabel as L} from './network-messages.mjs';
import {NETWORK_DEFAULTS} from './network-settings.mjs';
import {networkErrorMessage} from './network-errors.mjs';import {locale} from './i18n.mjs';
const h=React.createElement;
export function NetworkSettingsPanel({value,onSaved=()=>{}}){
 const [draft,setDraft]=useState({...NETWORK_DEFAULTS,...value}),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState(null);
 useEffect(()=>{setDraft({...NETWORK_DEFAULTS,...value});},[value?.revision]);
 const config=next=>Object.fromEntries(Object.keys(NETWORK_DEFAULTS).map(key=>[key,next[key]]));
 async function save(next=draft,{test=false}={}){if(next.mode==='manual'&&!next.proxyUrl){setStatus(L('请填写代理地址'));return;}setBusy(true);setError(null);try{const result=await window.whale.network.save(config(next));setDraft(result);onSaved(result);if(test){setStatus(L('正在测试…'));await window.whale.network.test();setStatus(L('可以访问扩展目录'));}else setStatus(L('网络设置已保存'));}catch(cause){setError(cause);setStatus('');}finally{setBusy(false);}}
 const input=(key,label,placeholder)=>h('label',{className:'ws-fld'},h('span',null,L(label)),h('input',{'data-network-field':key,type:'url',value:draft[key],placeholder,disabled:busy,autoComplete:'off',spellCheck:false,onChange:event=>setDraft(current=>({...current,[key]:event.target.value})),onBlur:()=>void save()}));
 return h('section',{className:'ws-card ws-set network-settings','data-network-settings':true},h('h2',{className:'ws-sec'},L('网络')),
  h('div',{className:'ws-srow'},h('div',null,h('b',null,L('代理')),h('small',null,L('扩展中心、组件下载和模型聊天都按这里的设置联网。'))),h('select',{'data-network-mode':true,'aria-label':L('代理'),value:draft.mode,disabled:busy,onChange:event=>{const next={...draft,mode:event.target.value};setDraft(next);void save(next);}},...['system','manual','direct'].map((mode,index)=>h('option',{key:mode,value:mode},L(['跟随系统','手动','不使用'][index]))))),
  draft.mode==='manual'&&input('proxyUrl','代理','http://127.0.0.1:7890'),
  h('div',{className:'ws-srow'},h('div',null,h('b',null,L('下载镜像')),h('small',null,L('留空就从官方地址下载。用镜像下载的文件同样会核对大小和 SHA-256，对不上会拒绝。')))),
  h('div',{className:'ws-fgrid'},input('githubMirror','GitHub 镜像','https://…'),input('huggingFaceMirror','HuggingFace 镜像','https://…')),
  h('div',{className:'ws-srow'},h('span',{role:'status','aria-live':'polite'},status),h('button',{type:'button',className:'ui-btn sm',disabled:busy,'data-network-test':true,onClick:()=>void save(draft,{test:true})},L('测试'))),
  error&&h('div',{className:'settings-error ws-errtxt',role:'alert'},typeof error.code==='string'&&error.code.startsWith('NETWORK_')&&error.code!=='NETWORK_SETTINGS_INVALID'?networkErrorMessage(error.code,{host:error.host??error.details?.host,language:locale()}):L(error.message),h('details',null,h('summary',null,L('技术详情')),h('code',null,error.code??'NETWORK_ERROR'))));
}
