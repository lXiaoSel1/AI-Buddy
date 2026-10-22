import {t} from './i18n.mjs';
import {THEMES,resolvedTheme} from './appearance.mjs';
import {Icon} from './ui-icons.mjs';
import {Segmented,Switch} from './ui-controls.mjs';
import React,{useEffect,useState} from 'react';
import {ConnectionSelection} from './connection-selection.mjs';
import {TokenDetectionControl} from './token-settings.mjs';
import {PET_CHARACTERS,petCharacterName} from './pet-characters.mjs';
import {frameSequence} from './frame-sequence.mjs';
import {DataImportSetting,DataImportModal} from './data-import-ui.mjs';
const h=React.createElement;
const providerName=value=>value==='claude'?'Claude Code':value;
// B2: maxOutputTokens is 'auto' or a whole number from 256 to 65536 (default 8192).
export const OUTPUT_LIMIT={min:256,max:65536,fallback:8192};
export function parseOutputLimit(value){const text=String(value??'').trim();if(!/^\d+$/.test(text))return null;const n=Number(text);return Number.isSafeInteger(n)&&n>=OUTPUT_LIMIT.min&&n<=OUTPUT_LIMIT.max?n:null;}
export function OutputLimitSetting({value,disabled,onSave}){
  const auto=value==='auto',[draft,setDraft]=useState(auto?'':String(value??OUTPUT_LIMIT.fallback)),[invalid,setInvalid]=useState(false);
  useEffect(()=>{if(value!=='auto'){setDraft(String(value));setInvalid(false);}},[value]);
  const commit=()=>{const n=parseOutputLimit(draft);if(n===null){setInvalid(true);return;}setInvalid(false);if(n!==value)onSave({maxOutputTokens:n});};
  return h('div',{className:'setting-row output-limit','data-setting-row':'maxOutputTokens'},h('span',{className:'setting-label'},h('strong',null,t('模型最多输出（tokens）')),h('small',null,t('按实际输出计费；数值越大越不容易被截断；“自动”表示交给模型自己的默认值。')),invalid&&h('small',{id:'output-limit-error',className:'output-limit-error',role:'alert'},t('请输入 256 到 65536 之间的整数。'))),
    h('span',{className:'output-limit-controls'},h('select',{'data-setting':'maxOutputTokensMode','aria-label':t('模型最多输出（tokens）'),value:auto?'auto':'custom',disabled,onChange:e=>{if(e.target.value==='auto')onSave({maxOutputTokens:'auto'});else onSave({maxOutputTokens:parseOutputLimit(draft)??OUTPUT_LIMIT.fallback});}},h('option',{value:'auto'},t('自动')),h('option',{value:'custom'},t('自定义'))),
      !auto&&h('input',{'data-setting':'maxOutputTokens',type:'number',inputMode:'numeric',min:OUTPUT_LIMIT.min,max:OUTPUT_LIMIT.max,step:256,value:draft,disabled,'aria-label':t('最多输出的 token 数'),'aria-invalid':invalid||undefined,'aria-describedby':invalid?'output-limit-error':undefined,onChange:e=>{setDraft(e.target.value);setInvalid(false);},onBlur:commit,onKeyDown:e=>{if(e.key==='Enter'){e.preventDefault();commit();}}})));
}
// Copyright and license summary. The source address is plain text: the panel blocks external navigation.
export function AboutCard(){
  return h('section',{className:'ws-card ws-set settings-about','data-settings-about':true},h('h2',{className:'ws-sec'},t('关于')),
    h('dl',{className:'ws-dl settings-about-list'},
      h('dt',null,t('版权')),h('dd',null,'© 2026 lXiaoSel1'),
      h('dt',null,t('许可')),h('dd',null,t('Apache-2.0 + Commons Clause —— 可以免费使用、修改和转发，未经授权不得售卖')),
      h('dt',null,t('源码')),h('dd',null,h('code',null,'github.com/lXiaoSel1/AI-Buddy'))),
    h('p',{className:'settings-note'},t('许可全文和第三方声明见安装目录里的 LICENSE.md 和 THIRD_PARTY_NOTICES.md。')),
    h('p',{className:'settings-note'},t('本软件按“原样”提供，不提供任何担保。')));
}
export function GeneralSettings({view,onSaved,onPage,onManage}){
  const [busy,setBusy]=useState(false),[status,setStatus]=useState(t("修改会立即生效并自动保存")),[error,setError]=useState('');
  const [importOpen,setImportOpen]=useState(false);
  if(!view)return h('p',null,t("正在读取本地设置…"));
  const prefs=view.preferences,en=prefs.language==='en';
  const petId=view.effectivePetCharacter??view.petCharacterId??'deepseek',petPreview=frameSequence('idle',petId)?.staticFrames?.[0]?.src??'./assets/maid-left.webp';
  async function save(patch){
    setBusy(true);setError('');setStatus(t("正在保存…"));
    try{if(patch.petFixedCharacter&&view.resources?.characters.find(c=>c.id===patch.petFixedCharacter)?.installed===false){await window.whale.resources.manage(patch.petFixedCharacter);setStatus(t('角色资源待安装，保持当前角色'));return;}onSaved(await window.whale.setSettings(patch));setStatus(t("已保存 · 重启后保留"));}
    catch(e){setError(e.message);setStatus(t("保存失败，请重试"));}
    finally{setBusy(false);}
  }
  async function action(name){
    setBusy(true);setError('');
    try{onSaved(await window.whale.settingsAction(name));setStatus(name==='refresh'?t("已发起本地日志刷新"):name==='defaults'?t("已恢复默认设置"):t("已将桌宠放回主屏右下角"));}
    catch(e){setError(e.message);setStatus(t("操作失败，请重试"));}
    finally{setBusy(false);}
  }
  // one row per setting: name and note on the left, the control at the right edge
  const row=(key,title,note,control)=>h('div',{className:'ws-srow',key},h('div',null,h('b',null,title),note&&h('small',null,note)),control);
  function toggle(key,title,note){return row(key,title,note,h(Switch,{checked:!!prefs[key],disabled:busy,label:title,'data-setting':key,onChange:value=>{void save({[key]:value});}}));}
  function select(key,title,note,options){return row(key,title,note,h('select',{'data-setting':key,'aria-label':title,value:prefs[key],disabled:busy,onChange:e=>{void save({[key]:typeof prefs[key]==='number'?Number(e.target.value):e.target.value});}},...options.map(([value,label])=>h('option',{key:value,value},label))));}
  const current=resolvedTheme(prefs,view.themeCharacter),installed=view.resources?.characters.filter(c=>c.installed).length??11;
  return h('div',{className:'general-settings ws-page'},
    h('div',{className:'ws-page-head'},h('div',null,h('h1',{className:'ws-ptitle'},t("通用设置")),h('p',{className:'ws-meta'},t("让 AI 酱按你的习惯陪你工作。"))),h('div',{className:'ws-saved'+(error?' err':busy?' busy':''),role:'status','aria-live':'polite'},busy?h('span',{className:'ui-spinner','aria-hidden':true}):Icon(error?'alert':'check',{size:14}),busy?t("正在应用…"):status)),
    error&&h('p',{className:'settings-error ws-errtxt',role:'alert'},error),
    h('section',{className:'ws-card ws-set appearance-settings'},h('h2',{className:'ws-sec'},t("外观与语言")),
      select('language',t("语言 / Language"),t("界面和新对话使用所选语言，历史内容保留原文。"),[['zh-CN',t("简体中文")],['en','English']]),
      row('themeMode',t("主题"),t("跟随的是当前角色，与聊天 API 分开。"),h(Segmented,{value:prefs.themeMode,size:'sm',label:t("主题"),'data-setting':'themeMode',disabled:busy,options:[['fixed',t("固定主题")],['character',t("跟随角色")]],onChange:value=>{void save({themeMode:value});}})),
      // each chip shows the theme's ground, main and second colours
      h('div',{className:'ws-chips'},...Object.entries(THEMES).map(([id,v])=>h('button',{key:id,type:'button',className:'ws-chip','data-theme-choice':id,'aria-pressed':current===id,onClick:()=>save({theme:id,themeMode:'fixed'}),disabled:busy},h('i',{className:'ws-trio','aria-hidden':true},...[v.background,v.accent,v.secondary].map((color,i)=>h('b',{key:i,style:{background:color}}))),en?(v.nameEn||v.name):v.name))),
      toggle('hideSpriteOnCg',t("使用 CG 背景时自动隐藏立绘"),t("自动模式下避免背景人物与立绘重叠；也可在 Galgame 手动切换。"))),
    h('section',{className:'ws-card ws-set settings-pet'},h('div',{className:'ws-set-head'},h('div',null,h('h2',{className:'ws-sec'},t("桌宠")),h('small',null,t("当前桌宠")+' · '+t(petCharacterName(petId))+' · '+(en?'Click to pet; right-click to open your workspace.':'单击摸摸，右键打开工作空间'))),h('img',{src:petPreview,alt:''})),
      h('h3',{className:'ws-sub-h'},t("角色")),
      select('petCharacterMode',t('桌宠角色'),t('跟随 Galgame 最终选中的角色，与聊天 API 分开。'),[['follow',t('跟随 Galgame 角色')],['fixed',t('固定角色')]]),
      prefs.petCharacterMode==='fixed'&&select('petFixedCharacter',t('固定角色'),t('切换 Galgame 角色时保持此桌宠。'),PET_CHARACTERS.map(c=>[c.id,t(c.name)+(view.resources?.characters.find(r=>r.id===c.id)?.installed===false?' · '+t('待安装'):'')])),
      row('resources',t("角色资源"),t("已安装 ")+installed+' / 11'+(view.resources?.edition?' · '+view.resources.edition:''),h('button',{className:'ui-btn sm','data-manage-resources':true,onClick:()=>window.whale.resources.manage().catch(e=>setError(e.message))},t('管理角色资源'))),
      h('h3',{className:'ws-sub-h'},t("显示")),
      h('div',{className:'ws-two'},
        toggle('petVisible',t("显示桌宠"),t("隐藏后可从托盘重新显示。")),
        toggle('alwaysOnTop',t("保持置顶"),t("显示在其他窗口上方。")),
        select('petScale',t("桌宠大小"),t("角色、状态条和提示气泡一起缩放。"),[[0.75,t("75% · 小")],[1,t("100% · 默认")],[1.25,t("125% · 大")],[1.5,t("150% · 更大")]]),
        select('animationSpeed',t("动作播放速度"),t("放慢动作循环；鼠标跟随和拖动仍及时响应。"),[[0.25,t("25% · 很慢")],[0.5,t("50% · 慢")],[0.75,t("75% · 默认")],[1,t("100% · 原速")]]),
        toggle('showStatusBadge',t("显示状态条"),t("显示工作会话数；可点击状态条右侧关闭，在这里重新开启。")),
        toggle('completionBubbles',t("任务提示气泡"),t("日志明确记录完成或错误时显示提示。"))),
      h('h3',{className:'ws-sub-h'},t("互动")),
      h('div',{className:'ws-two'},
        toggle('clickThrough',t("透明区域点击穿透"),t("开启后可点击角色周围的桌面内容。")),
        toggle('followCursor',t("跟随鼠标方向"),t("待机时看向鼠标所在的位置。")),
        toggle('autoSleep',en?'Automatic sleep':'自动睡眠',en?'Sleep after five quiet minutes. Real chat/image requests keep the pet awake.':'五分钟无活动后入睡；真实聊天和绘图执行期间保持清醒。'),
        toggle('petPhysics',en?'Physical interactions':'物理互动',en?'Left-drag to walk. Right-drag and release quickly to fly. While right-dragging, hold left to charge; release left to launch. Releasing right while charging does not launch; Esc cancels.':'左键拖动左右走；右键拖动快松飞行。右键拖动时按住左键蓄力，松左键发射；蓄力时松右键不发射，Esc 取消。')),
      select('throwStrength',en?'Throw strength':'抛掷力度',en?'Changes physical speed without changing animation assets.':'只调整物理力度，不复制动画。',[['gentle',en?'Gentle':'轻柔'],['standard',en?'Standard':'标准'],['strong',en?'Strong':'强力'],['exaggerated',en?'Exaggerated':'夸张']]),
      h('div',{className:'ui-note hint'},Icon('info',{size:16}),h('div',null,en?'Left-click to pet and play an expression. +1 affection at most once per 60 seconds, up to 30 per character daily. Right-click without dragging opens the workspace menu.':'左键单击触发表情并摸摸：同一角色每 60 秒最多 +1 好感，每天最多 30 点。右键单击打开工作空间菜单。',view.interactionMedia?.[petId]===false&&h('div',{className:'ws-muted',role:'status'},en?'The six new motion samples are awaiting review. Sleep and throwing remain inactive for characters without these assets.':'六段新动作尚待审核；缺少该组资源的角色暂不启用睡眠和抛掷。'))),
      h('div',{className:'ws-srow ws-end'},h('span',null),h('button',{className:'ui-btn sm','data-action':'reset-position',disabled:busy,onClick:()=>{void action('reset-position');}},t("重置桌宠位置")))),
    h('div',{className:'ws-set2'},
      h(ConnectionSelection,{type:'model',initial:view.modelConnections,onManage:()=>onManage('model')}),
      h(ConnectionSelection,{type:'cg',initial:view.cgConnections,onManage:()=>onManage('cg')}),
      h('section',{className:'ws-card ws-set'},h('h2',{className:'ws-sec'},t("检测与时间")),
        select('monitorRefreshMs',t("备用检查间隔"),t("文件变化会即时触发读取；此项控制轮询。"),[[1000,t("1 秒 · 默认")],[2000,t("2 秒")],[5000,t("5 秒")]]),
        select('displayTimeZone',t("活动时间显示"),t("用于最近工作的活动时间。"),[['America/New_York',t("纽约时间")],['local',t("系统本地时间")],['UTC','UTC']]),
        select('statisticsTimeZone',t("统计时区"),t("按此时区划分日、周、月；修改后重新聚合。"),[['local',t("系统本地时间")],['America/New_York',t("纽约时间")],['Asia/Shanghai',t("北京时间")],['UTC','UTC'],...(prefs.statisticsTimeZone&&!['local','America/New_York','Asia/Shanghai','UTC'].includes(prefs.statisticsTimeZone)?[[prefs.statisticsTimeZone,prefs.statisticsTimeZone]]:[])]),
        toggle('autoPriceUpdates',t("每日更新价格目录"),t("默认关闭；启用后仅下载公开价格，不发送日志。")),
        h('div',{className:'ws-srow'},h('small',{className:'ws-muted'},t("本地监控不调用模型，在线额度在 API 配置中单独启用。")),h('button',{className:'ui-btn sm','data-action':'refresh',disabled:busy,onClick:()=>{void action('refresh');}},Icon('refresh'),t("立即刷新日志")))),
      h('div',{className:'ws-stack'},
        h('section',{className:'ws-card ws-set settings-output'},h('h2',{className:'ws-sec'},t('模型输出')),h(OutputLimitSetting,{value:prefs.maxOutputTokens??OUTPUT_LIMIT.fallback,disabled:busy,onSave:patch=>void save(patch)}),h('p',{className:'settings-note ws-muted'},t('回复被截断时，可以在这里调高上限后重试。'))),
        h(TokenDetectionControl,{onManage:()=>onPage('tokens')}),
        h('section',{className:'ws-card ws-set settings-character'},h('h2',{className:'ws-sec'},t("角色与对话")),h('p',{className:'ws-meta'},t("角色、好感度、记忆、立绘和背景在 Galgame 中设置。联网聊天需手动开启，重启后默认关闭。")),h('div',{className:'ws-srow ws-end'},h('span',null),h('button',{className:'ui-btn sm',onClick:()=>onPage('galgame')},t("打开 Galgame →")))))),
    h(DataImportSetting,{onOpen:()=>setImportOpen(true)}),
    h('details',{className:'ws-details settings-install'},h('summary',null,Icon('chevron',{size:16}),t("本地安装"),h('span',{className:'ws-muted'},' · '+t("AI 酱 ")+view.version)),h('dl',{className:'ws-dl settings-info'},h('dt',null,t("版本")),h('dd',null,view.version+' · '+view.build),h('dt',null,t("数据目录")),h('dd',null,view.dataRoot),h('dt',null,t("日志来源")),h('dd',null,...view.logRoots.map((r,i)=>h('div',{key:i},h('span',null,providerName(r.provider)+' '),h('code',null,r.path))))),h('p',{className:'settings-note ws-muted'},t("设置保存为版本快照；旧版本、用量与陪伴历史继续保留。"))),
    h(AboutCard),
    h('div',{className:'ws-reset-row settings-footer'},h('div',null,h('b',null,t("恢复默认设置")),h('small',null,t("恢复默认仅调整这些选项，保留位置、用量和 Galgame 存档。"))),h('button',{className:'ui-btn danger','data-action':'defaults',disabled:busy,onClick:()=>{void action('defaults');}},t("恢复默认设置"))),importOpen&&h(DataImportModal,{onClose:()=>setImportOpen(false),onComplete:()=>location.reload()}));
}
