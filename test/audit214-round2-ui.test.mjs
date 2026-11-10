import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import {EmbedArea,prepareEmbedRuntime} from '../src/plugin-embed-page.mjs';
import {CommunityComponentPreparation,communityInstalledCount} from '../src/community-center.mjs';
import {setLocale,t} from '../src/i18n.mjs';
const markup=(component,props)=>renderToStaticMarkup(React.createElement(component,props));

test('missing plugin runtime offers preparation instead of a misleading unresponsive backend',()=>{
 setLocale('zh-CN');
 const html=markup(EmbedArea,{target:'qq',record:{enabled:true,exactVersion:'2.0.10'},view:'err',state:{target:'qq',state:'err',code:'DSH_RUNTIME_NOT_READY'}});
 assert.match(html,/运行组件还没准备好/);assert.match(html,/>准备运行组件</);assert.doesNotMatch(html,/DSH 后台没有响应/);
});
test('runtime preparation presents actual bytes and a bounded determinate progress bar',()=>{
 setLocale('zh-CN');
 const html=markup(CommunityComponentPreparation,{working:{bytes:200000000},progress:{receivedBytes:40000000,totalBytes:200000000}});
 assert.match(html,/aria-valuenow="40000000"/);assert.match(html,/aria-valuemax="200000000"/);
 assert.match(html,/40\.0 MB \/ 200\.0 MB/);
});
test('English voice-disabled and unknown image input labels are translated',()=>{
 try{setLocale('en');assert.equal(t('语音尚未启用'),'Voice is not enabled');assert.equal(t('图片输入：未知（目录未收录；不会自动试读）'),'Image input: unknown (not in the catalog; no automatic probe)');}
 finally{setLocale('zh-CN');}
});

test('Discover installed tab counts a voice engine before visiting Installed',{timeout:20000},async()=>{
 const base=process.env.AUDIT214_DOM_OUTPUT??tmpdir();await mkdir(base,{recursive:true});
 const directory=await mkdtemp(join(base,'round2-community-count-')),host=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(import.meta.url);
 const renderer=`import React from 'react';import {createRoot} from 'react-dom/client';import {CommunityCenter} from './src/community-center.mjs';const {ipcRenderer}=window.require('electron');
 window.fetch=()=>{throw Error('External I/O forbidden')};const calls=[],state={sources:[],community:{sources:[]},dsh:{installed:[{packageKey:'dsh:official:a'},{packageKey:'dsh:official:b'},{packageKey:'dsh:official:c'}],state:{ready:true}},voicePackages:[{id:'ai-buddy.voice-breeze',installed:true,sourceId:'official',version:'1.0.3'}]};
 const api={onUpdate(){return()=>{}},async action(request){calls.push(request);if(request.action==='community-status')return state;if(request.action==='community-open')return{snapshot:state,results:[]};if(request.action==='community-search')return{items:[],total:0};throw Error('Unexpected API '+request.action)}};
 const root=createRoot(document.getElementById('root'));root.render(React.createElement(CommunityCenter,{api}));
 (async()=>{try{for(let n=0;n<100&&!calls.some(r=>r.action==='community-search');n++)await new Promise(r=>setTimeout(r,20));await new Promise(r=>setTimeout(r,60));const installed=[...document.querySelectorAll('[role=tab]')].find(el=>el.id==='ext-tab-installed-tab'||el.textContent.includes('已安装'));if(!installed||installed.textContent.replaceAll(' ','')!=='已安装4')throw Error('Discover Installed count must be 4, got '+installed?.textContent);if(calls.some(r=>r.action==='search'))throw Error('Test unexpectedly opened Installed/Sources');root.unmount();ipcRenderer.send('result',{ok:true,calls});}catch(e){ipcRenderer.send('result',{error:e.stack,calls,body:document.body.textContent})}})();`;
 await build({stdin:{contents:renderer,resolveDir:host,sourcefile:'round2-count.mjs'},bundle:true,format:'iife',platform:'browser',outfile:join(directory,'renderer.js'),logLevel:'silent'});
 await writeFile(join(directory,'index.html'),'<!doctype html><div id="root"></div><script src="renderer.js"></script>');
 await writeFile(join(directory,'main.cjs'),`const {app,BrowserWindow,ipcMain,session}=require('electron'),fs=require('node:fs'),path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();ipcMain.once('result',(_,v)=>{fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(v));app.quit()});app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest((d,done)=>done({cancel:!d.url.startsWith('file:')&&!d.url.startsWith('data:')}));new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false}}).loadFile(path.join(__dirname,'index.html'))});setTimeout(()=>app.exit(2),15000);`);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const exit=await new Promise((yes,no)=>{const child=spawn(require('electron'),[join(directory,'main.cjs')],{env,stdio:'ignore',windowsHide:true});child.once('error',no);child.once('exit',yes)});
 assert.equal(exit,0);const result=JSON.parse(await readFile(join(directory,'result.json'),'utf8'));assert.equal(result.error,undefined,result.error);assert.equal(result.ok,true);
});

test('missing runtime preparation uses the pinned plan and reloads only the still-current page',async()=>{
 const calls=[],api={async action(request){calls.push(request);return request.action==='dsh-component-plan'?{planId:'pinned-plan'}:{state:'ready'};}};
 await prepareEmbedRuntime(api,{onReady:()=>calls.push('reload')});
 assert.deepEqual(calls,[{action:'dsh-component-plan'},{action:'dsh-component-install',planId:'pinned-plan'},'reload']);
 let current=true;calls.length=0;
 await prepareEmbedRuntime({async action(request){calls.push(request);if(request.action==='dsh-component-install')current=false;return request.action==='dsh-component-plan'?{planId:'next'}:{state:'ready'};}},{isCurrent:()=>current,onReady:()=>calls.push('stale-reload')});
 assert.equal(calls.length,2);assert.ok(!calls.includes('stale-reload'));
});
test('failed runtime preparation preserves the error and never reloads',async()=>{
 let reloads=0;
 await assert.rejects(prepareEmbedRuntime({async action(request){return request.action==='dsh-component-plan'?{planId:'plan'}:{error:{code:'NETWORK_CONNECT_FAILED',message:'unreachable'}};}},{onReady:()=>reloads++}),{code:'NETWORK_CONNECT_FAILED'});
 assert.equal(reloads,0);
});

test('cancelled runtime preparation does not reopen the plugin',async()=>{
 let reloads=0;
 await assert.rejects(prepareEmbedRuntime({async action(request){return request.action==='dsh-component-plan'?{planId:'plan'}:{state:'cancelled'};}},{onReady:()=>reloads++}),{code:'DSH_RUNTIME_NOT_READY'});
 assert.equal(reloads,0);
});

test('installed count deduplicates voice registry entries and hides shared dependencies',()=>{
 const state={dsh:{installed:[{packageKey:'dsh'}]},voicePackages:[{id:'ai-buddy.voice-breeze',sourceId:'official',installed:true},{id:'ai-buddy.voice-gpt-sovits',sourceId:'official',installed:false}]};
 assert.equal(communityInstalledCount(state,[{sourceId:'official',manifest:{id:'ai-buddy.voice-breeze'}},{sourceId:'official',manifest:{id:'ai-buddy.voice-shared-runtime'}}]),2);
});
