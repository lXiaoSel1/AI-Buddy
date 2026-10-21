import {t} from './i18n.mjs';
import React,{useEffect,useRef,useState} from 'react';
import {Icon} from './ui-icons.mjs';
import {Switch} from './ui-controls.mjs';
const h=React.createElement;
export function ConnectionSelection({type,initial,onManage}){
 const cg=type==='cg',api=cg?window.whale.cg:window.whale.models;
 const [view,setView]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),running=useRef(false);
 useEffect(()=>{if(initial)setView(initial);},[initial]);
 useEffect(()=>{let active=true;api.get().then(value=>{if(active)setView(value);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
 async function run(fn){if(running.current)return;running.current=true;setBusy(true);setError('');setMessage('');try{await fn();setView(await api.get());setMessage(t("已保存"));}catch(e){setError(e.message);setView(await api.get());}finally{running.current=false;setBusy(false);}}
 if(!view)return h('p',null,t("正在读取配置…"));
 const selected=view.profiles.find(profile=>profile.id===view.activeId),empty=view.profiles.length===0;
 return h('section',{className:'ws-card ws-set api-selection','data-connection-selection':type},h('h2',{className:'ws-sec'},cg?t("CG 绘图"):t("聊天模型")),
  h('label',{className:'ws-srow ws-col model-field'},h('b',null,t("当前使用配置")),h('select',{['data-'+type+'-select']:true,value:view.activeId??'',disabled:busy||view.busy||empty,onChange:e=>{if(e.target.value)void run(()=>api.activate(e.target.value));}},h('option',{value:'',disabled:true},empty?t("尚未配置"):t("请选择已保存的配置")),...view.profiles.map(profile=>h('option',{key:profile.id,value:profile.id},profile.name+' · '+(profile.model||t("未填写模型")))))),
  h('p',{className:'api-current ws-sr-only',['data-current-'+type]:true},selected?t("当前使用：")+t(selected.name)+' · '+selected.model:t("尚未配置")),
  h('div',{className:'ws-srow'},h('div',null,h('b',null,cg?t("自动生成 CG"):t("联网聊天")),h('small',null,cg?t("新升级纪念图与剧场合影；重启记住选择。联网聊天开启时，每张新升级 CG 会额外调用一次聊天模型设计主题。"):t("需要时开启；重启默认关闭。"))),h(Switch,{['data-'+type+'-enabled']:true,checked:!!(cg?view.autoEnabled:view.enabled),disabled:busy||!selected,label:cg?t("自动生成 CG"):t("联网聊天"),onChange:enabled=>{void run(()=>cg?api.enabled(enabled):window.whale.chat(enabled));}})),
  view.busy&&h('p',{className:'ui-note'},Icon('info',{size:16}),h('span',null,cg?t("CG 正在绘制，完成后可切换配置。"):t("正在生成对话，完成后可切换配置。"))),
  h('div',{className:'ws-srow'},h('small',{className:'ws-muted'},empty?t("还没有配置"):t("共 ")+view.profiles.length+t(" 个配置")),h('button',{className:'ui-btn sm'+(empty?' primary':''),'data-manage-connections':type,onClick:onManage},empty&&Icon('plus'),empty?t("添加配置"):t("管理配置"))),
  message&&h('p',{role:'status',className:'ws-ok-text'},message),error&&h('p',{className:'settings-error ws-errtxt',role:'alert'},error));
}
