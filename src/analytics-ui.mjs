import {t} from './i18n.mjs';
import React,{useEffect,useState,useRef} from 'react';
import {TOOL_NAMES,providerLabel} from './token-types.mjs';
import {platformLabel,BILLING_ROUTES} from './service-identity.mjs';
import {defaultViews,defaultView,SORT_OPTIONS,compactNumber} from './statistics-views.mjs';
import {StatisticsModal} from './statistics-modal.mjs';
import {QuotaCards} from './quota-ui.mjs';
import {PriceEditor,priceStamp as stamp} from './price-editor.mjs';
import {themeAsset} from './appearance.mjs';
import {frameSequence} from './frame-sequence.mjs';
import {Icon} from './ui-icons.mjs';
import {Menu,StatusPill} from './ui-controls.mjs';
const h=React.createElement,fmt=n=>n==null?t("未提供"):Number(n).toLocaleString('zh-CN',{maximumFractionDigits:6});
export function amount(u,k,compact=false){if(!u)return '—';const missing=u.fieldMissing?.[k]||0;return missing>=Math.max(1,u.requests)?t("未提供"):(compact?compactNumber(u[k]):fmt(u[k]))+(missing?t(" · 部分"):'');}
const shortPath=p=>p?.split(/[\\/]/).filter(Boolean).at(-1)||t("未记录项目");
const table=(heads,rows)=>h('div',{className:'table-wrap'},h('table',null,h('thead',null,h('tr',null,...heads.map(s=>h('th',{key:s},s)))),h('tbody',null,...rows)));
const rangeName={get today(){return t("今日")},get '7d'(){return t("近七天")},get '30d'(){return t("近三十天")},get all(){return t("全部历史")},get custom(){return t("自定义范围")}};
// "574.62K" keeps a smaller unit after the digits, as in the approved cards.
const figure=text=>{const m=/^([\d.,]+)([A-Za-z%]+)$/.exec(String(text));return m?h(React.Fragment,null,m[1],h('span',{className:'ws-unit'},m[2])):text;};
const tag=text=>h('span',{className:'ws-tag'},text);
const STATUS={running:['ok',"运行中"],waiting:['warn',"等待回应"],completed:['info',"已完成"],failed:['err',"日志错误"],paused:['idle',"已中断"]};
// Splits the slogan after its first comma so each half stays on one line.
const phrases=text=>{const i=text.search(/[，,]/);return i<0?[text]:[text.slice(0,i+1),text.slice(i+1).trim()];};

function Adjust({page,tab,current,result,settings,onApply,onClose}){
 const [draft,setDraft]=useState(structuredClone(current)),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const platforms=result?.platformCatalog||[],[platformText,setPlatformText]=useState(platforms.find(p=>p.id===current.provider)?.name||'');
 const set=(k,v)=>setDraft(s=>({...s,[k]:v})),select=(key,label,options)=>h('label',{key,className:'ws-fld'},h('span',null,label),h('select',{value:draft[key]||'all',onChange:e=>set(key,e.target.value)},...options.map(([id,n])=>h('option',{key:id,value:id},t(n)))));
 return h(StatisticsModal,{title:t("调整显示"),subtitle:t("只影响这一页看到的数据"),onClose,footer:h(React.Fragment,null,h('button',{className:'ui-btn ghost',onClick:()=>{setDraft(defaultView(page));setPlatformText('');},disabled:busy},t("恢复默认")),h('span',{className:'spacer'}),h('button',{className:'ui-btn',onClick:onClose,disabled:busy},t("取消")),h('button',{className:'ui-btn primary',disabled:busy,onClick:async()=>{setBusy(true);try{await onApply(draft);}catch(e){setError(e.message);}finally{setBusy(false);}}},busy?t("保存中…"):t("应用")))},
  error&&h('p',{role:'alert',className:'ws-errtxt'},error),h('div',{className:'ws-fgrid'},select('preset',t("时间范围"),Object.entries(rangeName)),draft.preset==='custom'&&['from','to'].map(k=>h('label',{key:k,className:'ws-fld'},h('span',null,k==='from'?t("开始日期"):t("结束日期")),h('input',{type:'date',value:draft[k]||'',onChange:e=>set(k,e.target.value)}))),page==='history'&&select('group',t("聚合粒度"),[['day',t("日")],['week',t("周 · 周一开始")],['month',t("月")]]),
  ...Object.entries({tool:t("工具"),modelVendor:t("模型厂商"),model:t("模型"),workspace:t("项目"),sourceId:t("来源"),purpose:t("用途")}).map(([key,title])=>select(key,title,[['all',t("全部")],...(result?.facets[key]||[]).map(id=>[id,key==='tool'?TOOL_NAMES[id]||id:key==='modelVendor'?providerLabel(id):key==='workspace'?shortPath(id):key==='sourceId'?settings?.tokenSources?.sources.find(s=>s.id===id)?.name||id:id])])),
  // one searchable field instead of a search box beside a long list
  h('label',{className:'ws-fld'},h('span',null,t("服务平台")),h('input',{list:'stats-platforms','aria-label':t("服务平台"),placeholder:t("全部"),value:platformText,onChange:e=>{const text=e.target.value,hit=platforms.find(p=>p.name===text||p.id===text);setPlatformText(text);if(!text.trim())set('provider','all');else if(hit)set('provider',hit.id);},onBlur:()=>setPlatformText(platforms.find(p=>p.id===draft.provider)?.name||'')}),h('datalist',{id:'stats-platforms'},...platforms.map(p=>h('option',{key:p.id,value:p.name},p.observed?'':t(" · 本机暂无记录")))),h('small',null,t("选项太多时可在下拉框里直接输入搜索"))),
  h('label',{className:'ws-fld ws-span2'},h('span',null,t("搜索")),h('span',{className:'ws-inp'},Icon('search'),h('input',{value:draft.search||'',onChange:e=>set('search',e.target.value),placeholder:t("项目、模型或会话")})))),
  page==='overview'&&tab==='usage'&&h('fieldset',{className:'ws-fset'},h('legend',null,t("显示工具卡片")),h('label',{className:'ws-chk'},h('input',{type:'checkbox',checked:draft.visibleTools===null,onChange:e=>set('visibleTools',e.target.checked?null:(result?.tools||[]).map(t=>t.name))}),h('span',null,h('b',null,t("自动显示有请求的工具")),h('small',null,t("卡片显隐不改变统计总量。")))),draft.visibleTools!==null&&h('div',{className:'ws-chk-grid'},...Object.entries(TOOL_NAMES).filter(([id])=>id!=='custom').map(([id,name])=>h('label',{key:id,className:'ws-chk'},h('input',{type:'checkbox',checked:draft.visibleTools.includes(id),onChange:e=>set('visibleTools',e.target.checked?[...draft.visibleTools,id]:draft.visibleTools.filter(t=>t!==id))}),name)))));
}
function UsageDetails({detail,onAttribution,settings}){
 const r=detail.result;if(!r)return h('p',{className:detail.error?'ws-errtxt':'ws-muted'},detail.error||t("读取详情…"));
 const source=id=>settings?.tokenSources?.sources.find(s=>s.id===id)?.name||id;
 return h(React.Fragment,null,detail.path&&h('p',{className:'full-path ws-path'},detail.path),
  h('div',{className:'ws-mini-stats'},...[['total',t("总 Token")],['input',t("未缓存输入")],['output',t("输出")],['requests',t("请求")]].map(([k,name])=>h('div',{key:k,className:'ws-mini'},h('small',null,name),h('b',{title:amount(r.totals,k)},figure(amount(r.totals,k,true)))))),
  h('dl',{className:'ws-dl stats-breakdown'},...Object.entries({cacheRead:t("缓存读取"),cacheWrite:t("缓存写入"),reasoning:t("推理（输出细分）")}).map(([k,name])=>h(React.Fragment,{key:k},h('dt',null,name),h('dd',null,amount(r.totals,k))))),
  (r.identities||[]).length>0&&h('h3',{className:'ws-sec'},t("服务归属")),
  ...(r.identities||[]).map((i,n)=>{const unknown=i.serviceProvider==='unknown';return h('section',{className:'ws-identity stats-identity'+(unknown?' unknown':''),key:n},
   h('div',{className:'ws-identity-head'},h('b',null,platformLabel(i.serviceProvider)),tag(unknown?t("待补充"):t(BILLING_ROUTES[i.billingRoute]||i.billingRoute)),h('span',{className:'spacer'}),unknown?h('button',{className:'ui-btn sm primary',onClick:()=>onAttribution(i.sourceId)},t("补充归属")):h('span',{className:'ws-muted ws-tabular'},fmt(i.usage.requests)+t(" 次请求"))),
   h('span',null,(TOOL_NAMES[i.tool]||i.tool)+' / '+providerLabel(i.modelVendor)+' / '+(i.model||t("模型未提供"))),
   h('small',null,t("通道：")+i.channel+' · '+i.identityBasis+' · '+t("来源：")+source(i.sourceId)));}));
}
function BigCard({title,usage,onClick,primary=false,icon=null,label=null,children}){
 return h('button',{className:'stats-big-card ws-stat'+(primary?' stats-total':''),onClick,'data-stat-card':title},
  h('span',{className:'ws-stat-top'},h('span',{className:'ws-stat-title'},icon&&Icon(icon),title),label&&tag(label)),
  h('strong',{className:'ws-num',title:amount(usage,'total')},figure(amount(usage,'total',true))),h('small',null,'Token · '+fmt(usage?.requests||0)+t(" 次请求")),children);
}
// The last seven days of the same filters, today last; days without records stay as empty bars.
function Spark({spark}){
 if(!spark?.to)return null;
 const byDate=new Map(spark.periods.map(p=>[p.date,p.usage.total||0])),end=new Date(spark.to+'T12:00:00Z'),days=[];
 for(let i=6;i>=0;i--){const d=new Date(end);d.setUTCDate(d.getUTCDate()-i);days.push(byDate.get(d.toISOString().slice(0,10))||0);}
 const max=Math.max(1,...days);
 return h(React.Fragment,null,h('span',{className:'ws-spark','aria-hidden':true},...days.map((v,i)=>h('i',{key:i,style:{height:Math.max(4,Math.round(v/max*100))+'%'}}))),h('span',{className:'ws-cap'},h('span',null,t("近 7 天")),h('span',null,t("今天"))));
}
function UsageOverview({result,visibleTools,showUsage,spark,label,monitor,onProjects}){
 const tools=result.tools.filter(t=>visibleTools==null?t.usage.requests>0:visibleTools.includes(t.name)),total=result.totals.total||0,cols=tools.length+1===2||tools.length+1===4?2:3;
 const status=s=>{const live=(monitor?.sessions||[]).find(m=>m.tool===s.tool&&m.id===s.sessionId);return STATUS[live?.displayStatus];};
 const share=label===t("今日")?t("占今日用量"):t("占范围内用量");
 return h(React.Fragment,null,h('div',{className:'stats-large-grid ws-stats',style:{'--cols':cols}},
   h(BigCard,{title:t("总用量"),usage:result.totals,primary:true,label,onClick:()=>showUsage(t("总用量"))},h(Spark,{spark})),
   ...tools.map(tool=>{const name=TOOL_NAMES[tool.name]||tool.name,model=result.sessions.find(s=>s.tool===tool.name)?.model,pct=total?Math.round(tool.usage.total/total*100):0;
    return h(BigCard,{key:tool.name,title:name,usage:tool.usage,icon:'terminal',label:model,onClick:()=>showUsage(name,{tool:tool.name})},h('span',{className:'ws-meter','aria-hidden':true},h('b',{style:{width:pct+'%'}})),h('span',{className:'ws-cap'},h('span',null,share),h('span',null,pct+'%')));})),
  h('section',{className:'ws-card ws-recent stats-recent'},h('div',{className:'ws-section-title'},h('h2',{className:'ws-sec'},t("最近的工作")),onProjects&&h('button',{className:'ui-btn ghost sm',onClick:onProjects},t("查看项目用量"))),
   !result.sessions.length&&h('p',{className:'note ws-muted'},t("当前范围还没有工作记录")),
   ...result.sessions.slice(0,5).map(s=>{const st=status(s);return h('button',{key:s.key,className:'ws-rrow',onClick:()=>showUsage(t("工作详情"),{tool:s.tool,sessionId:s.sessionId},s.workspace)},h('span',{className:'ws-who'},h('span',{className:'ws-tool-ico'},Icon('terminal')),h('span',null,h('strong',null,shortPath(s.workspace)),h('small',null,(TOOL_NAMES[s.tool]||s.tool)+' · '+(s.model||t("模型未提供"))))),st?h(StatusPill,{tone:st[0]},t(st[1])):h('span',null),h('span',{className:'ws-tok',title:amount(s.usage,'total')},figure(amount(s.usage,'total',true))));})));
}
function CostOverview({result,setModal,label}){
 const c=result.cost,coverage=c.tokenCoverage,missing=[...new Set((c.unpriced||[]).map(r=>r.model).filter(Boolean))];
 return h('div',{className:'stats-large-grid ws-cov'},...Object.entries(c.amounts).map(([currency,n])=>h('button',{key:currency,className:'stats-big-card ws-stat',onClick:()=>setModal('cost')},h('span',{className:'ws-stat-top'},h('span',{className:'ws-stat-title'},t("预估费用 · ")+currency),tag(label)),h('strong',{className:'ws-num',title:fmt(n)+' '+currency},figure(compactNumber(n))),h('small',null,t("按模型单价估算 · 非实际账单")))),
  h('button',{className:'stats-big-card ws-stat',onClick:()=>setModal('cost')},h('span',{className:'ws-stat-top'},h('span',{className:'ws-stat-title'},t("Token 估算覆盖率")),tag(label)),h('strong',{className:'ws-num'},coverage==null?'—':figure((coverage*100).toFixed(1)+'%')),h('small',{title:fmt(c.pricedTokens)+' / '+fmt(c.allTokens)+' Token'},t("已覆盖 ")+compactNumber(c.pricedTokens)+t(" / 已记录 ")+compactNumber(c.allTokens)+' Token'+(c.missingTokenRequests?' · '+c.missingTokenRequests+t(" 次请求未提供总量"):'')),h('span',{className:'ws-meter','aria-hidden':true},h('b',{style:{width:Math.max(coverage?1:0,Math.round((coverage||0)*100))+'%'}}))),
  h('div',{className:'ws-card ws-cov-side'},!Object.keys(c.amounts).length&&h('div',{className:'ui-alert warn',role:'status'},Icon('alert',{size:16}),h('div',null,h('b',null,t("当前记录暂不能估算费用")),missing.length>0&&h('div',{className:'ws-text'},missing.slice(0,3).join('、')+t(" 还没有参考价格。补上价格后会自动重新计算。")))),
   h('div',{className:'ws-row-btns'},h('button',{className:'ui-btn primary',onClick:()=>setModal('prices')},Icon('coin'),t("价格设置")),h('button',{className:'ui-btn',onClick:()=>setModal('cost')},t("查看详情")))));
}
function Projects({result,filters,save,showUsage}){return h(React.Fragment,null,h('label',{className:'stats-sort'},t("排序"),h('select',{'data-project-sort':true,value:filters.sortField+':'+filters.sortDirection,onChange:e=>{const[sortField,sortDirection]=e.target.value.split(':');void save({...filters,sortField,sortDirection});}},...Object.entries(SORT_OPTIONS).map(([id,n])=>h('option',{key:id,value:id},t(n))))),table([t("项目"),t("总 Token"),t("输入"),t("输出")],result.projects.map(p=>h('tr',{key:p.name},h('td',null,h('button',{className:'stats-project-link',title:p.name,onClick:()=>showUsage(t("项目详情"),{workspace:p.name},p.name)},shortPath(p.name))),...['total','input','output'].map(k=>h('td',{key:k,title:amount(p.usage,k)},amount(p.usage,k,true)))))),!result.projects.length&&h('p',null,t("当前范围没有项目记录")));}
function History({result,setDetail}){const max=Math.max(1,...result.periods.map(r=>r.usage.total));return h(React.Fragment,null,h('section',{className:'card stats-trend'},h('h2',null,t("用量趋势")),h('div',{className:'usage-chart'},...result.periods.map(r=>h('button',{key:r.date,title:r.date+' · '+amount(r.usage,'total'),onClick:()=>setDetail({title:r.date,result:{totals:r.usage,identities:[]}})},h('i',{style:{height:Math.max(2,140*r.usage.total/max)+'px'}}),h('small',null,r.date.slice(-5)))))),table([t("日期"),t("总 Token"),t("输入"),t("输出"),t("缓存读取")],[...result.periods].reverse().map(r=>h('tr',{key:r.date},h('td',null,r.date),...['total','input','output','cacheRead'].map(k=>h('td',{key:k,title:amount(r.usage,k)},amount(r.usage,k,true)))))));}
function Skeleton(){return h('div',{className:'stats-status ws-stats',role:'status','aria-label':t("读取中…"),style:{'--cols':2}},...[0,1].map(i=>h('div',{key:i,className:'ws-card ws-skel-card'},h('span',{className:'ui-skel',style:{height:14,width:'30%'}}),h('span',{className:'ui-skel',style:{height:34,width:'55%'}}),h('span',{className:'ui-skel',style:{height:12,width:'40%'}}),h('span',{className:'ui-skel',style:{height:30,width:'100%',marginTop:6}}))));}
function IndexBanner({monitor}){
 const scanned=monitor.progress?.scanned||0,total=monitor.progress?.total||0,checking=monitor.indexPhase==='checking';
 return h('div',{className:'ws-banner stats-status',role:'status'},h('div',{className:'ws-banner-row'},h('span',{className:'ui-spinner','aria-hidden':true}),h('b',null,checking?t("正在核对新增记录"):t("正在建立本地历史索引")),h('span',{className:'spacer'}),h('span',{className:'ws-muted ws-tabular'},t("已读取 ")+scanned+' / '+(total||'—')+t(" 个文件"))),h('span',{className:'ws-meter'},h('b',{style:{width:(total?Math.round(scanned/total*100):0)+'%'}})),h('span',{className:'ws-muted'},t("完成前用量为部分结果。")));
}
function EmptyUsage({pet,onAdjust}){
 const still=frameSequence('idle',pet)?.staticFrames?.[0]?.src;
 return h('div',{className:'ws-card ws-empty'},still&&h('img',{src:still,alt:''}),h('b',null,t("当前范围还没有工作记录")),h('p',null,t("用 Codex、Claude Code 等工具工作后，这里会自动出现用量。也可以放宽时间范围看看。")),h('button',{className:'ui-btn',onClick:onAdjust},Icon('sliders'),t("调整范围")));
}
export function AnalyticsPage({page='overview',settings,revision,onManage,onSaved,onAttribution,onPage,monitor}){
 const [tab,setTab]=useState('usage'),[result,setResult]=useState(null),[spark,setSpark]=useState(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[loading,setLoading]=useState(true),[modal,setModal]=useState(null),[detail,setDetail]=useState(null),[more,setMore]=useState(null),[priceSearch,setPriceSearch]=useState(''),[priceVersion,setPriceVersion]=useState(''),detailId=useRef(0),refreshQuery=useRef(null),moreRef=useRef(null),errorsRef=useRef(null);
 const views=settings?.preferences.statisticsViews||defaultViews(),filters=views[page]||defaultView(page),zone=settings?.preferences.statisticsTimeZone||'America/New_York',isQuota=page==='overview'&&tab==='quota';
 const {visibleTools,...query}=filters,queryKey=JSON.stringify(query),pet=settings?.effectivePetCharacter||settings?.petCharacterId||'deepseek';
 useEffect(()=>{
  if(isQuota){refreshQuery.current=null;return;}
  let live=true,running=false,pending=false,timer;setLoading(true);
  const enqueue=()=>{pending=true;if(running||timer)return;timer=setTimeout(run,100);};
  async function run(){timer=null;if(!live)return;running=true;pending=false;
   try{const r=await window.whale.tokens.action('statistics',{...query,timeZone:zone,page:1,pageSize:5});if(live){setResult(r);setError('');}
    // the overview's seven-day bars: same filters, one query after the main one
    if(live&&page==='overview'){const s=await window.whale.tokens.action('statistics',{...query,preset:'7d',from:undefined,to:undefined,group:'day',timeZone:zone,page:1,pageSize:1});if(live)setSpark({periods:s.periods,to:s.to});}}
   catch(e){if(live)setError(e.message);}
   finally{running=false;if(live){setLoading(false);if(pending)enqueue();}}
  }
  refreshQuery.current=enqueue;enqueue();
  return()=>{live=false;clearTimeout(timer);if(refreshQuery.current===enqueue)refreshQuery.current=null;};
 },[page,queryKey,zone,isQuota]);
 useEffect(()=>{refreshQuery.current?.();},[revision,refresh]);
 useEffect(()=>{setModal(null);setDetail(null);setMore(null);setResult(null);setSpark(null);detailId.current++;},[page]);
 // the "More" menu closes on Escape or a click anywhere else
 useEffect(()=>{if(!more)return;const close=()=>setMore(null),away=e=>{if(!moreRef.current?.contains(e.target))close();},key=e=>{if(e.key==='Escape'){close();moreRef.current?.querySelector('button')?.focus();}},scroller=document.querySelector('.content');document.addEventListener('pointerdown',away,true);document.addEventListener('keydown',key);scroller?.addEventListener('scroll',close,{passive:true});window.addEventListener('resize',close);return()=>{document.removeEventListener('pointerdown',away,true);document.removeEventListener('keydown',key);scroller?.removeEventListener('scroll',close);window.removeEventListener('resize',close);};},[more]);
 async function save(value){const updated=await window.whale.setSettings({statisticsViews:{...views,[page]:value}});onSaved?.(updated);setModal(null);}
 async function showUsage(title,extra={},path){const id=++detailId.current;setDetail({title,path});try{const r=await window.whale.tokens.action('statistics',{...query,...extra,timeZone:zone,page:1,pageSize:5});if(id===detailId.current)setDetail({title,path,result:r});}catch(e){if(id===detailId.current)setDetail({title,path,error:e.message});}}
 async function exportReport(format){setMore(null);try{await window.whale.statisticsExport({...query,timeZone:zone,format,view:page});}catch(e){setError(e.message);}}
 const summary=filters.preset==='custom'?(filters.from||t("开始"))+' — '+(filters.to||t("至今")):rangeName[filters.preset],title={overview:t("工作概览"),projects:t("项目用量"),history:t("历史统计")}[page];
 const refreshNow=()=>{setMore(null);if(isQuota)window.whale.quotas.action('get').then(v=>Promise.all(v.profiles.filter(p=>p.enabled).map(p=>window.whale.quotas.action('refresh',{id:p.id})))).catch(e=>setError(e.message));else setRefresh(v=>v+1);};
 const menu=[{label:t("刷新"),icon:'refresh',onSelect:refreshNow},...(isQuota?[]:['separator',{label:t("导出 ")+'CSV',icon:'download',onSelect:()=>exportReport('csv')},{label:t("导出 ")+'JSON',icon:'download',onSelect:()=>exportReport('json')},'separator',{label:t("数据说明"),icon:'info',onSelect:()=>setModal('data')}])];
 const operations=h('div',{className:'stats-operations ws-btns'},!isQuota&&h('button',{className:'ui-btn','data-stats-adjust':true,onClick:()=>setModal('adjust')},Icon('sliders'),t("调整")),h('div',{className:'stats-more',ref:moreRef},h('button',{className:'ui-btn','aria-expanded':!!more,'aria-haspopup':'menu',onClick:e=>{const r=e.currentTarget.getBoundingClientRect();setMore(v=>v?null:{top:r.bottom+6,left:r.left});}},Icon('more'),t("更多")),more&&h(Menu,{className:'stats-menu',label:t("更多"),items:menu,style:more,onClose:()=>setMore(null)})));
 const scope=t("范围：")+summary+' · '+(filters.tool&&filters.tool!=='all'?TOOL_NAMES[filters.tool]||filters.tool:t("全部工具"));
 const empty=page==='overview'&&tab==='usage'&&result&&!result.totals.requests&&!result.sessions.length;
 let report=null;if(isQuota)report=h(QuotaCards,{onManage:()=>onManage('quota'),compact:true});else if(result){if(page==='overview')report=tab==='cost'?h(CostOverview,{result,setModal,label:summary}):empty?h(EmptyUsage,{pet,onAdjust:()=>setModal('adjust')}):h(UsageOverview,{result,visibleTools,showUsage,spark,label:summary,monitor,onProjects:onPage&&(()=>onPage('projects'))});else if(page==='projects')report=h(Projects,{result,filters,save:v=>save(v).catch(e=>setError(e.message)),showUsage});else report=h(History,{result,setDetail});}
 const errors=monitor?.errors||[];
 const [first,...rest]=phrases(t("每一份努力，都有记录。"));
 return h('div',{className:'analytics-page stats-'+page},
  page==='overview'?h('section',{className:'ws-card ws-hero'},h('i',{className:'ws-acc','aria-hidden':true}),
    h('div',{className:'ws-hero-txt'},h('h1',{className:'ws-eyebrow'},title),h('p',{className:'ws-slogan'},h('span',null,first),...rest.map((x,i)=>h('span',{key:i},x))),h('p',{className:'ws-meta'},isQuota?t("服务端额度"):summary+' · '+(result?.timeZone||zone)),operations),
    h('div',{className:'ws-hero-art'},h('img',{src:'./'+themeAsset(pet,'portrait.webp'),alt:''})))
   :h('div',{className:'stats-heading'},h('div',null,h('h1',null,title),h('small',null,summary+' · '+(result?.timeZone||zone))),operations),
  page==='overview'&&h('div',{className:'ws-tabs-bar'},h('div',{className:'ui-seg ws-seg',role:'tablist','aria-label':title},...Object.entries({usage:t("用量"),cost:t("费用"),quota:t("额度")}).map(([id,n])=>h('button',{'data-analytics-tab':id,key:id,type:'button',role:'tab','aria-selected':tab===id,className:tab===id?'active':'',onClick:()=>{setTab(id);setMore(null);}},n))),!isQuota&&h('span',{className:'ws-range'},scope)),
  error&&h('div',{className:'ui-alert settings-error',role:'alert'},Icon('alert',{size:16}),h('div',null,h('b',null,t("读取失败：")+error),h('div',{className:'ws-text'},t("已显示的数据可能不完整。")),h('div',{className:'ws-row-btns'},h('button',{className:'ui-btn sm',onClick:()=>setRefresh(v=>v+1)},Icon('retry'),t("重试")),errors.length>0&&h('button',{className:'ui-btn sm ghost',onClick:()=>{if(errorsRef.current){errorsRef.current.open=true;errorsRef.current.scrollIntoView({block:'nearest'});}}},t("查看日志读取问题"))))),
  !isQuota&&monitor?.indexing&&h(IndexBanner,{monitor}),
  !isQuota&&monitor?.missingRequests>0&&h('div',{className:'ui-alert warn',role:'status'},Icon('alert',{size:16}),h('div',null,monitor.missingRequests+t(" 条请求缺少完整用量，合计为已记录部分。"))),
  !isQuota&&loading&&!result&&h(Skeleton),report,
  !isQuota&&errors.length>0&&h('details',{className:'ws-details read-errors',ref:errorsRef},h('summary',null,Icon('alert',{size:16}),errors.length+t(" 个日志读取问题")),...errors.slice(0,10).map(e=>h('p',{key:e.path},e.path+' · '+e.message))),
  modal==='adjust'&&h(Adjust,{page,tab,current:filters,result,settings,onApply:save,onClose:()=>setModal(null)}),
  modal==='prices'&&h(StatisticsModal,{title:t("价格设置"),subtitle:t("每百万 Token 的参考单价，跟随实际 Token 计算"),wide:true,onClose:()=>{setModal(null);setPriceSearch('');setRefresh(n=>n+1);},footer:h(React.Fragment,null,h('span',{className:'ws-foot-note'},priceVersion&&t("价格版本 ")+stamp(priceVersion)),h('span',{className:'spacer'}),h('button',{className:'ui-btn primary',onClick:()=>{setModal(null);setPriceSearch('');setRefresh(n=>n+1);}},t("完成")))},h(PriceEditor,{initialSearch:priceSearch,onVersion:setPriceVersion})),
  modal==='cost'&&result&&h(StatisticsModal,{title:t("费用明细"),subtitle:result.cost.basis,wide:true,onClose:()=>setModal(null),footer:h(React.Fragment,null,h('span',{className:'ws-foot-note'},t("价格版本 ")+stamp(result.cost.catalog?.version)),h('span',{className:'spacer'}),h('button',{className:'ui-btn',onClick:()=>setModal(null)},t("关闭")))},
   h('div',{className:'ui-note'},Icon('info',{size:16}),h('div',null,t("优先使用已配置价格；服务平台或计费路线未记录时，按该模型的 API 参考价格估算。"))),
   h('h3',{className:'ws-sec'},t("已估算"),tag((result.cost.estimates||[]).length)),(result.cost.estimates||[]).length?table([t("参考价格 / 模型"),t("金额"),t("来源"),t("请求")],result.cost.estimates.map((r,i)=>h('tr',{key:i},h('td',null,h('b',null,r.model),h('small',null,platformLabel(r.provider))),h('td',{className:'r'},fmt(r.amount)+' '+r.currency),h('td',null,r.source),h('td',{className:'r'},fmt(r.requests))))):h('p',{className:'ws-muted'},t("当前范围还没有能估算的请求。")),
   h('h3',{className:'ws-sec'},t("暂未覆盖"),tag(result.cost.unpriced.length)),result.cost.unpriced.length>0&&table([t("服务平台 / 模型"),t("原因"),t("请求"),''],result.cost.unpriced.map((r,i)=>h('tr',{key:i},h('td',null,h('b',null,r.model),h('small',null,platformLabel(r.provider))),h('td',null,r.reason),h('td',{className:'r'},fmt(r.requests)),h('td',{className:'r'},h('button',{className:'ui-btn ghost sm',onClick:()=>{setPriceSearch(r.model||'');setModal('prices');}},t("去补价格"))))))),
  modal==='data'&&h(StatisticsModal,{title:t("数据说明"),onClose:()=>setModal(null)},
   h('dl',{className:'ws-dl'},h('dt',null,t("输入")),h('dd',null,t("未缓存输入；缓存读取、写入单独列出")),h('dt',null,t("推理")),h('dd',null,t("输出的一部分，不重复计入")),h('dt',null,t("缺失字段")),h('dd',null,t("保留为未知，部分记录已标记"))),
   table([t("总量来源"),''],[[t("服务报告"),result?.totalOrigins.reported||0],[t("计算值"),result?.totalOrigins.calculated||0],[t("部分记录"),result?.totalOrigins.partial||0]].map(([k,v])=>h('tr',{key:k},h('td',null,k),h('td',{className:'r'},v+t(" 条")))).concat(h('tr',{key:'zone'},h('td',null,t("统计时区")),h('td',{className:'r'},zone==='local'?t("本机")+'（'+(result?.timeZone||'')+'）':result?.timeZone||zone)))),
   ...errors.map((e,i)=>h('p',{key:i,className:'full-path ws-path'},e.message))),
  detail&&h(StatisticsModal,{title:detail.title+' · '+summary,wide:true,onClose:()=>{detailId.current++;setDetail(null);}},h(UsageDetails,{detail,settings,onAttribution:id=>{detailId.current++;setDetail(null);onAttribution(id);}})));
}
