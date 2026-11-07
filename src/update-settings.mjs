import React,{useEffect,useState} from 'react';
import {t} from './i18n.mjs';
import {Switch} from './ui-controls.mjs';

const h=React.createElement;
const labels={idle:'尚未检查更新',initializing:'正在读取更新状态…',checking:'正在核对发布签名…',current:'当前已是最新版本',available:'发现新版本',downloading:'正在下载更新…',
  preparing:'正在校验并准备安装…',ready:'更新已准备就绪', 'waiting-safe-point':'正在等待当前活动收尾…',applying:'正在安装更新…',
  verifying:'正在核对新版启动…',completed:'更新已完成',error:'更新操作失败','recovery-required':'更新需要恢复',bootstrap:'请先通过安装器升级'};
const reasons={chat:'聊天',cg:'CG 生成',work:'工作任务',plugin:'插件活动',data:'资料导入',storage:'正在保存',voice:'语音活动'};
const errors={APP_UPDATE_RATE_LIMITED:'发布服务暂时限流，请稍后再试。',APP_UPDATE_NETWORK_FAILED:'连接发布服务失败，请检查网络后重试。',
  APP_UPDATE_BUSY:'已有更新操作正在进行。',APP_UPDATE_RESERVED:'正在等待安装，暂时无法开始新活动。',APP_UPDATE_DISK_SPACE:'剩余空间不足，当前版本仍可使用。',
  APP_UPDATE_IDENTITY_CHANGED:'安装或存档登记已变化，请重启后重新检查。',APP_UPDATE_MANAGER_UNTRUSTED:'更新维护器未通过校验，请使用官方安装器修复。'};
const size=value=>Number.isFinite(value)?new Intl.NumberFormat(undefined,{maximumFractionDigits:1,style:'unit',unit:'megabyte'}).format(value/1_000_000):null;

export function UpdateSettings({version,onPlugins}){
  const [state,setState]=useState(null),[plugins,setPlugins]=useState(null),[error,setError]=useState(null),[checkingPlugins,setCheckingPlugins]=useState(false);
  const api=window.whale.updates,pluginApi=window.whale.plugins;
  const accept=next=>{if(next)setState(old=>!old||next.revision>=old.revision?next:old);};
  const acceptPlugins=next=>{if(next&&Array.isArray(next.updates))setPlugins(old=>!old||(next.checkedAt??0)>=(old.checkedAt??0)?next:old);};
  useEffect(()=>{
    if(!api)return;
    let active=true;
    const off=api.onUpdate(accept),offPlugins=pluginApi.onUpdate(snapshot=>acceptPlugins(snapshot?.community?.pluginUpdates));
    api.action('status').then(value=>{if(active)accept(value);},()=>{});
    pluginApi.action({action:'community-update-summary'}).then(value=>{if(active)acceptPlugins(value);},()=>{});
    return ()=>{active=false;off();offPlugins();};
  },[api,pluginApi]);
  async function act(command,value){
    setError(null);
    try{accept(await api.action(command,value));}catch(cause){setError(cause.code??'APP_UPDATE_FAILED');}
  }
  async function checkPlugins(){
    setCheckingPlugins(true);setError(null);
    try{const result=await pluginApi.action({action:'community-check-updates',refresh:true});if(result?.error)throw Error('Plugin check failed');acceptPlugins(result);}
    catch{setError('PLUGIN_UPDATE_CHECK_FAILED');}finally{setCheckingPlugins(false);}
  }
  const phase=state?.phase??'initializing',active=['initializing','checking','downloading','preparing','waiting-safe-point','applying','verifying'].includes(phase);
  const button=(action,label,callback,disabled=false)=>h('button',{type:'button',className:'ui-btn sm','data-update-action':action,onClick:callback,disabled},t(label));
  const problem=error??state?.error;
  const rows=plugins?.updates??[];
  const pluginBlocks=rows.filter(row=>!['available','queued'].includes(row.state)).length;
  const downloaded=state?.progress?.bytes,total=state?.progress?.total,speed=size(state?.progress?.bytesPerSecond);
  return h('section',{className:'ws-stack','aria-label':t('版本与更新'),'data-update-phase':phase},
    h('h3',{className:'ws-sub-h'},t('版本与更新')),
    h('div',{className:'ws-srow'},h('div',null,h('b',null,'AI Buddy '+version),h('small',{role:'status'},t(labels[phase]??labels.idle),state?.target?.version?' · '+state.target.version:'')),
      phase==='bootstrap'||phase==='recovery-required'?button('bootstrap','打开官方安装器下载页',()=>act('bootstrap')):
        button('check','检查更新',()=>act('check'),!api||active)),
    state?.checkedAt!=null&&h('p',{className:'settings-note'},t('上次检查')+' · '+new Date(state.checkedAt).toLocaleString()),
    state&&phase!=='bootstrap'&&h('div',{className:'ws-srow'},h('span',null,t('自动检查本体更新')),h(Switch,{checked:state.automatic,label:t('自动检查本体更新'),onChange:value=>act('automatic',value)})),
    state?.target&&h('div',null,
      h('p',{className:'settings-note'},phase==='completed'?null:[size(state.target.downloadBytes??state.target.installerBytes)&&t('下载')+' '+size(state.target.downloadBytes??state.target.installerBytes),size(state.target.installBytes)&&t('暂存空间')+' '+size(state.target.installBytes),t('安装需要重启')].filter(Boolean).join(' · ')),
      state.target.notes&&h('details',null,h('summary',null,t('更新说明')),h('p',{style:{whiteSpace:'pre-line'}},state.target.notes))),
    state?.progress&&active&&h('div',null,h('progress',{max:total>0?total:undefined,value:total>0&&downloaded!=null?Math.min(downloaded,total):undefined,'aria-label':t('更新进度')}),
      downloaded!=null&&h('small',null,' '+size(downloaded)+(total>0?' / '+size(total):'')+(speed?' · '+speed+'/s':''))),
    !!state?.reasons?.length&&h('p',{role:'status'},state.reasons.map(row=>t(reasons[row.capability]??'后台活动')).join('、')),
    problem&&h('div',{className:'settings-error',role:'alert'},t(errors[problem]??'操作未完成，请检查更新状态后重试。'),h('details',null,h('summary',null,t('技术详情')),h('code',null,problem))),
    h('div',{className:'ws-srow'},
      state?.target?.requiresBootstrap&&button('bootstrap','打开官方安装器下载页',()=>act('bootstrap')),
      !state?.target?.requiresBootstrap&&(phase==='available'||state?.retryAction==='download')&&button('download','下载更新',()=>act('download')),
      (phase==='ready'||state?.retryAction==='apply')&&button('apply','安装并重启',()=>act('apply')),
      state?.canCancel&&button('cancel',phase==='waiting-safe-point'?'稍后':'取消',()=>act('cancel'))),
    h('div',{className:'ws-srow'},h('div',null,h('b',null,t('插件更新')),h('small',null,plugins?`${rows.length} ${t('个插件有更新')}${pluginBlocks?' · '+pluginBlocks+' '+t('项需处理'):''}`:t('尚未检查插件更新')),
      !!plugins?.errors?.length&&h('small',null,t('部分插件来源暂时无法检查。'))),
      h('div',null,button('plugins-check','检查插件更新',checkPlugins,checkingPlugins),button('plugins','查看已安装插件',onPlugins))));
}
