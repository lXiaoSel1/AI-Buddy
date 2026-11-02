import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

const driver=process.env.HOST_TEST_LAYOUT_DRIVER,runtime=process.env.HOST_TEST_LAYOUT_PLAYWRIGHT,out=process.env.HOST_TEST_LAYOUT_OUT;
const read=name=>readFile(new URL('../src/'+name,import.meta.url),'utf8');
const css=(await Promise.all(['dashboard.css','appearance.css','workspace.css'].map(read))).join('\n');
function html(theme,language){
 const zh=language==='zh-CN',groups=zh?[['工作',['工作概览','项目用量','历史统计','工作任务']],['陪伴',['Galgame','商店与背包','社交与心情','动作展示']],['插件',['B站陪伴','QQ连接']],['系统',['扩展中心','API 配置','Token 检测','通用设置']]]:[['Work',['Overview','Projects','History','Work tasks']],['Companion',['Galgame','Shop & backpack','Social & mood','Actions']],['Plugins',['Bilibili Companion','QQ Connect']],['System',['Extensions','API','Token check','Settings']]];
 const nav=groups.map(([title,labels])=>'<p class="nav-h">'+title+'</p>'+labels.map((label,i)=>'<button'+(i===0?' class="active"':'')+' title="'+label+'"><span aria-hidden="true">·</span><span class="nav-l">'+label+'</span></button>').join('')).join('');
 return '<!doctype html><html class="desktop-titlebar" data-theme="'+theme+'" lang="'+language+'"><head><meta charset="utf-8"><style>'+css+'</style></head><body><div class="layout"><aside><div class="brand"><span class="brand-mark">AI</span><div><strong>AI Buddy</strong><small>AI Buddy</small></div></div><nav class="nav-groups" aria-label="Main navigation">'+nav+'</nav><div class="side-status"><button class="sidebar-bottom"><b><i class="offline-dot"></i>Local monitor</b><small>Reads local logs, no model calls</small></button></div></aside><main><header>Private layout fixture</header></main></div></body></html>';
}

test('sidebar rows keep 34px in short windows and only navigation scrolls while the footer stays fixed',{skip:!driver||!runtime||!out,timeout:120000},async t=>{
 const {launchCaptureBrowser}=await import(pathToFileURL(resolve(driver))),{chromium}=await import(pathToFileURL(resolve(runtime)));
 await mkdir(out,{recursive:true});const {browser,finish,run}=await launchCaptureBrowser(chromium,{out,browser:process.env.HOST_TEST_CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe'},'host-sidebar-layout'),results=[];
 try{for(const theme of ['deepseek','claude'])for(const language of ['zh-CN','en'])for(const [width,height]of [[900,650],[1600,1000]])await t.test(theme+' '+language+' '+width+'x'+height,async()=>{
  const page=await browser.newPage({viewport:{width,height}});
  try{
   await page.route('**/*',route=>route.abort());await page.setContent(html(theme,language));await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const before=await page.evaluate(()=>{const nav=document.querySelector('.nav-groups'),footer=document.querySelector('.side-status'),rect=node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};};return {buttons:[...nav.querySelectorAll('button')].map(button=>({label:button.textContent,height:button.getBoundingClientRect().height,flexShrink:getComputedStyle(button).flexShrink})),nav:{...rect(nav),scrollHeight:nav.scrollHeight,clientHeight:nav.clientHeight,scrollTop:nav.scrollTop},footer:rect(footer),document:{scrollHeight:document.documentElement.scrollHeight,clientHeight:document.documentElement.clientHeight}};});
   const record={theme,language,width,height,before,passed:false};results.push(record);
   assert.equal(before.buttons.length,14,'the real shell has twelve base entries and two official plugin pages');
   for(const button of before.buttons)assert.ok(Math.abs(button.height-34)<.5,JSON.stringify({width,height,button}));
   assert.ok(before.document.scrollHeight<=before.document.clientHeight+1,'the document must not become the navigation scroll container');
   assert.ok(before.footer.bottom<=height+1&&before.footer.top>before.nav.top,'the status footer stays within the viewport');
   if(height===650){
    assert.ok(before.nav.scrollHeight>before.nav.clientHeight+1,'short navigation scrolls instead of compressing its rows');
    const after=await page.evaluate(()=>{const nav=document.querySelector('.nav-groups');nav.scrollTop=200;const footer=document.querySelector('.side-status').getBoundingClientRect();return {scrollTop:nav.scrollTop,footerTop:footer.top,footerBottom:footer.bottom};});record.after=after;
    assert.ok(after.scrollTop>0,'navigation can actually scroll');assert.ok(Math.abs(after.footerTop-before.footer.top)<.5&&Math.abs(after.footerBottom-before.footer.bottom)<.5,'scrolling navigation does not move the footer');
   }else assert.ok(before.nav.scrollHeight<=before.nav.clientHeight+1,'all entries fit at 1000px height');
   record.passed=true;
  }finally{await page.close();}
 });}finally{await finish();await writeFile(join(out,'RESULT.json'),JSON.stringify({run,scope:'actual browser layout; actual three host stylesheets with private shell markup; no product or platform login',results},null,2)+'\n');}
});
