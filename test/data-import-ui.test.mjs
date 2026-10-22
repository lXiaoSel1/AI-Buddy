import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {DataImportPanel,DataImportSetting,dataImportBytes,dataImportProgress,dataImportPhase} from '../src/data-import-ui.mjs';
import {CgPausedNotice,cgPauseInfo} from '../src/cg-paused-ui.mjs';
import {groupCgLabel,activeGroupCg,GroupCgGallery} from '../src/group-cg-ui.mjs';
import {setLocale} from '../src/i18n.mjs';
const render=(Component,props={})=>renderToStaticMarkup(React.createElement(Component,props));
const plan={planId:'p1',sourceDataRoot:'E:\\旧版 空格\\local\\data-v003',targetDataRoot:'E:\\AI Buddy\\local\\data-profiles\\import-1',files:13,bytes:4*1024**2,summary:{characters:12,personas:3,conversations:8,messages:19,groups:2,memoryEvents:31,lifeArchives:4,cgs:6,connections:2},exclusions:['Chromium cache'],warnings:['来源应保持关闭']};

test('first launch defaults to explicit create without issuing a data request during render',()=>{
 let calls=0;const api=new Proxy({},{get:()=>{calls++;throw Error('unexpected API');}}),html=render(DataImportPanel,{onboarding:true,api});
 assert.equal(calls,0);assert.match(html,/欢迎使用 AI 酱/);assert.match(html,/<input[^>]*checked=""[^>]*value="create"/);assert.match(html,/data-import-create="true"/);assert.doesNotMatch(html,/data-import-start=/);assert.match(html,/确认前不创建业务存档/);
});
test('import preview names actual roots and all independent record counts with escaped paths',()=>{
 const html=render(DataImportPanel,{initialState:{onboarding:false,phase:'idle',plan,canCancel:true}});
 for(const text of ['旧版 空格','data-profiles','4.0 MiB','用户身份','人生存档','记忆记录','模型连接','Chromium cache','来源应保持关闭'])assert.ok(html.includes(text),text);
 assert.match(html,/data-import-source[^>]*value=/);assert.match(html,/readOnly=""/i);assert.match(html,/data-import-start="true"[^>]*>导入副本并切换/);
 assert.match(html,/<button[^>]*disabled=""[^>]*data-import-start="true"/,'unchecked source confirmation cannot start');
 assert.match(html,/不会合并聊天、好感或用量/);
});
test('busy non-cancellable commit prevents source selection and exit',()=>{
 const html=render(DataImportPanel,{initialState:{phase:'switching',plan,canCancel:false}});
 assert.match(html,/正在切换存档并重启/);assert.match(html,/<button[^>]*disabled=""[^>]*data-import-choose="true"/);assert.match(html,/<button[^>]*disabled=""[^>]*data-import-cancel="true"/);assert.doesNotMatch(html,/data-import-start=/);
});
test('progress is bounded, unknown totals remain indeterminate, and errors are plain text',()=>{
 assert.equal(dataImportProgress({bytesCopied:25,totalBytes:100}),.25);assert.equal(dataImportProgress({doneBytes:110,expectedBytes:100}),1);assert.equal(dataImportProgress({bytesCopied:-3,totalBytes:10}),0);assert.equal(dataImportProgress({bytesCopied:12,totalBytes:0}),null);
 for(const n of [-1,NaN,Infinity])assert.equal(dataImportBytes(n),'—');assert.equal(dataImportBytes(0),'0 B');assert.equal(dataImportBytes(1024**3),'1.00 GiB');
 const html=render(DataImportPanel,{initialState:{phase:'failed',error:'<script>bad</script>'}});assert.match(html,/&lt;script&gt;bad&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>bad/);
 assert.equal(dataImportPhase('waiting'),'正在等待聊天和绘图收尾…');
});
test('settings has separate opt-in automatic memory resume and no bulk CG start',()=>{
 const html=render(DataImportSetting,{initialPaused:true,onOpen(){}});assert.match(html,/旧存档已导入，自动整理暂已暂停/);assert.match(html,/data-import-resume-work="true"/);assert.match(html,/未完成 CG 仍需逐项手动继续/);
 assert.doesNotMatch(render(DataImportSetting,{onOpen(){}}),/data-import-resume-work/);
});
test('paused CG renders only an explicit individual resume; uncertain submission cannot resume',()=>{
 assert.equal(render(CgPausedNotice,{item:{id:'a',status:'ready'}}),'');assert.equal(cgPauseInfo({status:'ready'}),null);
 let calls=0;const item={id:'cg-paused',status:'paused',pauseReason:'旧资料导入',resumeAllowed:true},html=render(CgPausedNotice,{item,onResume(){calls++;}});
 assert.equal(calls,0);assert.match(html,/CG 已暂停/);assert.match(html,/旧资料导入/);assert.match(html,/data-cg-resume="cg-paused"/);assert.doesNotMatch(html,/<button[^>]*disabled/);
 const unknown=render(CgPausedNotice,{item:{...item,resumeAllowed:false}});assert.match(unknown,/无法确认旧请求是否已提交/);assert.match(unknown,/避免重复收费/);assert.match(unknown,/<button[^>]*disabled=""[^>]*data-cg-resume/);
 assert.equal(groupCgLabel(item),'已暂停 · 手动继续');assert.equal(activeGroupCg(item),false);
});
test('group gallery exposes paused individual tasks without requesting a new image',()=>{
 let calls=0;const item={id:'cg-p',kind:'group',groupId:'g1',status:'paused',at:1,resumeAllowed:true};
 const html=render(GroupCgGallery,{catalog:{items:[item],loading:false,refresh(){}},selectedId:item.id,request(){calls++;},loadImage(){calls++;},onClose(){},Dialog:({children})=>React.createElement('div',null,children)});
 assert.equal(calls,0);assert.match(html,/data-cg-paused="cg-p"/);assert.match(html,/已暂停 · 手动继续/);assert.doesNotMatch(html,/重试此合影/);
});
test('import and paused CG strings use English without touching old locale entries',()=>{
 setLocale('en');try{const html=render(DataImportPanel,{onboarding:true});assert.match(html,/Welcome to AI Buddy/);assert.match(html,/Create a new save and start/);assert.match(render(CgPausedNotice,{item:{id:'p',status:'paused',resumeAllowed:false}}),/avoid duplicate charges/);assert.equal(groupCgLabel({status:'paused'}),'Paused · resume manually');}finally{setLocale('zh-CN');}
});
test('onboarding entry bypasses dashboard business hooks, and source confirmation is required by both operations',()=>{
 const dashboard=readFileSync(new URL('../src/dashboard.mjs',import.meta.url),'utf8'),ui=readFileSync(new URL('../src/data-import-ui.mjs',import.meta.url),'utf8');
 assert.match(dashboard,/render\(h\(location\.hash\.slice\(1\)==='data-import'\?DataImportWelcome:App\)\)/);assert.match(ui,/api\.preview\(\{source,sourceClosed:true\}\)/);assert.match(ui,/api\.start\(\{planId:plan\.planId,sourceClosed:true\}\)/);assert.doesNotMatch(ui,/api\.(?:write|merge|delete|remove)\(/);
});
