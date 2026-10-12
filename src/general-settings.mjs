import {t} from './i18n.mjs';
import {THEMES} from './appearance.mjs';
import React,{useState} from 'react';
import {ConnectionSelection} from './connection-selection.mjs';
import {TokenDetectionControl} from './token-settings.mjs';
const h=React.createElement;
const providerName=value=>value==='claude'?'Claude Code':value;
export function GeneralSettings({view,onSaved,onPage,onManage}){
  const [busy,setBusy]=useState(false),[status,setStatus]=useState(t("修改会立即生效并自动保存")),[error,setError]=useState('');
  if(!view)return h('p',null,t("正在读取本地设置…"));
  const prefs=view.preferences;
  async function save(patch){
    setBusy(true);setError('');setStatus(t("正在保存…"));
    try{onSaved(await window.whale.setSettings(patch));setStatus(t("已保存 · 重启后保留"));}
    catch(e){setError(e.message);setStatus(t("保存失败，请重试"));}
    finally{setBusy(false);}
  }
  async function action(name){
    setBusy(true);setError('');
    try{onSaved(await window.whale.settingsAction(name));setStatus(name==='refresh'?t("已发起本地日志刷新"):name==='defaults'?t("已恢复默认设置"):t("已将桌宠放回主屏右下角"));}
    catch(e){setError(e.message);setStatus(t("操作失败，请重试"));}
    finally{setBusy(false);}
  }
  function toggle(key,title,note){return h('label',{className:'setting-row',key},h('span',{className:'setting-label'},h('strong',null,title),h('small',null,note)),h('input',{'data-setting':key,type:'checkbox',checked:prefs[key],disabled:busy,onChange:e=>{void save({[key]:e.target.checked});}}));}
  function select(key,title,note,options){return h('label',{className:'setting-row',key},h('span',{className:'setting-label'},h('strong',null,title),h('small',null,note)),h('select',{'data-setting':key,value:prefs[key],disabled:busy,onChange:e=>{void save({[key]:typeof prefs[key]==='number'?Number(e.target.value):e.target.value});}},...options.map(([value,label])=>h('option',{key:value,value},label))));}
  return h('div',{className:'general-settings'},
    h('div',{className:'settings-heading'},h('div',null,h('h1',null,t("通用设置")),h('p',null,t("让 AI 酱按你的习惯陪你工作。"))),h('div',{className:'settings-saved',role:'status','aria-live':'polite'},busy?t("正在应用…"):t(status))),
    error&&h('p',{className:'settings-error',role:'alert'},error),
    h('section',{className:'card appearance-settings'},h('h2',null,t("外观与语言")),select('language',t("语言 / Language"),t("界面和新对话使用所选语言，历史内容保留原文。"),[['zh-CN',t("简体中文")],['en','English']]),select('themeMode',t("主题模式"),t("跟随的是当前角色，与聊天 API 分开。"),[['fixed',t("固定主题")],['character',t("跟随角色")]]),h('div',{className:'theme-picker'},...Object.entries(THEMES).map(([id,v])=>h('button',{key:id,'data-theme-choice':id,'aria-pressed':prefs.theme===id&&prefs.themeMode==='fixed',onClick:()=>save({theme:id,themeMode:'fixed'}),disabled:busy,style:{'--swatch':v.accent,'--swatch-alt':v.secondary}},h('span',{className:'theme-swatch','aria-hidden':true}),prefs.language==='en'?(v.nameEn||v.name):v.name))),toggle('hideSpriteOnCg',t("使用 CG 背景时自动隐藏立绘"),t("自动模式下避免背景人物与立绘重叠；也可在 Galgame 手动切换。"))),
    h('div',{className:'settings-grid'},
      h('div',{className:'settings-column'},
      h('section',{className:'card settings-pet'},h('div',{className:'settings-section-heading'},h('div',null,h('h2',null,t("桌宠")),h('p',null,t("按住角色或状态条拖动，点击打开工作面板。"))),h('div',{className:'settings-pet-preview','aria-hidden':true},h('img',{src:'./assets/maid-left.webp',alt:''}))),
        toggle('petVisible',t("显示桌宠"),t("隐藏后可从托盘重新显示。")),
        select('petScale',t("桌宠大小"),t("角色、状态条和提示气泡一起缩放。"),[[0.75,t("75% · 小")],[1,t("100% · 默认")],[1.25,t("125% · 大")],[1.5,t("150% · 更大")]]),
        select('animationSpeed',t("动作播放速度"),t("放慢动作循环；鼠标跟随和拖动仍及时响应。"),[[0.25,t("25% · 很慢")],[0.5,t("50% · 慢")],[0.75,t("75% · 默认")],[1,t("100% · 原速")]]),
        toggle('alwaysOnTop',t("保持置顶"),t("显示在其他窗口上方。")),
        toggle('clickThrough',t("透明区域点击穿透"),t("开启后可点击角色周围的桌面内容。")),
        toggle('followCursor',t("跟随鼠标方向"),t("待机时看向鼠标所在的位置。")),
        toggle('showStatusBadge',t("显示状态条"),t("在桌宠下方显示运行中的会话数。")),
        toggle('completionBubbles',t("任务提示气泡"),t("日志明确记录完成或错误时显示提示。")),
        h('div',{className:'settings-actions'},h('button',{'data-action':'reset-position',disabled:busy,onClick:()=>{void action('reset-position');}},t("重置桌宠位置")))),
        h(TokenDetectionControl,{onManage:()=>onPage('tokens')}),
        h('section',{className:'card settings-character'},h('div',null,h('h2',null,t("角色与对话")),h('p',{className:'settings-note'},t("角色、好感度、记忆、立绘和背景在 Galgame 中设置。联网聊天需手动开启，重启后默认关闭。"))),h('div',{className:'settings-actions'},h('button',{onClick:()=>onPage('galgame')},t("打开 Galgame →"))))),
      h('div',{className:'settings-column'},
        h(ConnectionSelection,{type:'model',initial:view.modelConnections,onManage:()=>onManage('model')}),
        h(ConnectionSelection,{type:'cg',initial:view.cgConnections,onManage:()=>onManage('cg')}),
        h('section',{className:'card'},h('h2',null,t("检测与时间")),
          select('monitorRefreshMs',t("备用检查间隔"),t("文件变化会即时触发读取；此项控制轮询。"),[[1000,t("1 秒 · 默认")],[2000,t("2 秒")],[5000,t("5 秒")]]),
          select('displayTimeZone',t("活动时间显示"),t("用于最近工作的活动时间。"),[['America/New_York',t("纽约时间")],['local',t("系统本地时间")],['UTC','UTC']]),
          select('statisticsTimeZone',t("统计时区"),t("按此时区划分日、周、月；修改后重新聚合。"),[['local',t("系统本地时间")],['America/New_York',t("纽约时间")],['Asia/Shanghai',t("北京时间")],['UTC','UTC'],...(prefs.statisticsTimeZone&&!['local','America/New_York','Asia/Shanghai','UTC'].includes(prefs.statisticsTimeZone)?[[prefs.statisticsTimeZone,prefs.statisticsTimeZone]]:[])]),
          toggle('autoPriceUpdates',t("每日更新价格目录"),t("默认关闭；启用后仅下载公开价格，不发送日志。")),
          h('p',{className:'settings-note'},t("本地监控不调用模型，在线额度在 API 配置中单独启用。")),
          h('div',{className:'settings-actions'},h('button',{'data-action':'refresh',disabled:busy,onClick:()=>{void action('refresh');}},t("立即刷新日志")))))),
    h('details',{className:'card settings-install'},h('summary',null,t("本地安装"),h('span',null,t("AI 酱 ")+view.version)),h('dl',{className:'settings-info'},h('dt',null,t("版本")),h('dd',null,view.version+' · '+view.build),h('dt',null,t("数据目录")),h('dd',null,view.dataRoot),h('dt',null,t("日志来源")),h('dd',null,...view.logRoots.map((r,i)=>h('div',{key:i},h('span',null,providerName(r.provider)),h('code',null,r.path))))),h('p',{className:'settings-note'},t("设置保存为版本快照；旧版本、用量与陪伴历史继续保留。"))),
    h('div',{className:'settings-footer'},h('span',null,t("恢复默认仅调整这些选项，保留位置、用量和 Galgame 存档。")),h('button',{'data-action':'defaults',disabled:busy,onClick:()=>{void action('defaults');}},t("恢复默认设置"))));
}
