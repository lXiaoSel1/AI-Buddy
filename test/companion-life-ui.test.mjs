import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CompanionManager,companionCardDraft} from '../src/companion-ui.mjs';
import {MemoryContent,MemoryCapacityInfo,MemoryJobStatus,GrowthPanel,ArchivePreview,companionGrowthLocked,companionLifeBytes,archiveDownloadPayload} from '../src/companion-life-ui.mjs';
import {setLocale} from '../src/i18n.mjs';

const state=mode=>({characters:[{id:'deepseek',name:'DeepSeek',builtin:true,life:{id:'life-1',mode,startedAt:1},growth:{mode,history:[]},fields:{personality:{mode:'custom',value:'认真的第一段\n第二段'},visual:{mode:'custom',value:'蓝发'},tone:{mode:'custom',value:'温和'}},effective:{name:'DeepSeek',personality:'认真的第一段\n第二段',visual:'蓝发'},examples:[{scene:'问候',speaker:'DeepSeek',text:'你好'}],modelBinding:{enabled:true,connectionId:'api-a'},talkativeness:.5}],activeCharacterId:'deepseek',activePersonaId:'default',personas:[{id:'default',name:'日常'}],groups:[],conversations:[],messages:[],settings:{},relationship:{level:1,affection:0}});
const render=(Component,props)=>renderToStaticMarkup(React.createElement(Component,props));
const manager=(panel,value)=>render(CompanionManager,{panel,state:value,request:async()=>({ok:true}),onClose(){}});

test('all three R30 panels are reachable inside existing manager tabs without changing original tabs',()=>{
 for(const panel of ['memory','growth','lives']){
  const html=manager(panel,state('normal'));
  for(const label of ['管理角色','我的身份','对话历史','群聊','长期记忆','人格自成长','人生存档'])assert.match(html,new RegExp('>'+label+'<'));
  assert.match(html,new RegExp('id="buddy-manager-'+panel+'"'));
  assert.match(html,/role="tab" aria-selected="true"/);
 }
});

test('growth card editor locks name, inherited mode controls and examples but keeps resource, model and talkativeness settings usable',()=>{
 const value=state('seed'),html=manager('characters',value);
 assert.equal(companionGrowthLocked(value.characters[0]),true);
 assert.match(html,/<input[^>]*disabled=""[^>]*value="DeepSeek"/);
 assert.match(html,/<textarea[^>]*id="buddy-card-personality"[^>]*disabled=""/);
 assert.match(html,/<select[^>]*aria-label="性格 · 内容方式"[^>]*disabled=""/);
 assert.match(html,/<button[^>]*disabled=""[^>]*>添加示例<\/button>/);
 assert.match(html,/<button[^>]*disabled=""[^>]*>恢复默认人设<\/button>/);
 assert.match(html,/<textarea[^>]*id="buddy-card-visual"(?:(?!disabled).)*>/);
 assert.match(html,/<input[^>]*id="buddy-card-talkativeness"(?:(?!disabled).)*>/);
 assert.match(html,/<select[^>]*aria-label="指定聊天连接"(?:(?!disabled).)*>/);
 assert.match(html,/<button[^>]*aria-label="头像 · 选择图片"(?:(?!disabled).)*>/);
 assert.deepEqual(companionCardDraft(value.characters[0]).modelBinding,{enabled:true,connectionId:'api-a'});
});

test('ordinary cards remain editable and migration does not opt them into growth from the UI',()=>{
 const html=manager('characters',state('normal'));
 assert.equal(companionGrowthLocked(state('normal').characters[0]),false);
 assert.doesNotMatch(html,/<textarea[^>]*id="buddy-card-personality"[^>]*disabled/);
 assert.doesNotMatch(html,/<input[^>]*disabled=""[^>]*value="DeepSeek"/);
 assert.match(manager('growth',state('normal')),/以当前设定启用自成长/);
 const grown=manager('growth',state('blank'));
 assert.doesNotMatch(grown,/data-growth-seed|data-growth-blank/);
 assert.match(grown,/重新填写人设请使用人生存档中的重置/);
});

test('memory text and original evidence are readonly, escaped and include source dates',()=>{
 const memory={core:[{id:'c1',day:'2026-10-20',kind:'agreement',text:'<script>bad()</script>\n约定尚未履行',eventIds:['m1']}],events:[{id:'m1',day:'2026-10-20',text:'原始内容 <img src=x onerror=bad()>',role:'user',sourceKind:'private',createdAt:1}]};
 const html=render(MemoryContent,{memory});
 assert.match(html,/2026-10-20/);assert.match(html,/查看原始来源/);assert.match(html,/原始内容 &lt;img/);assert.match(html,/&lt;script&gt;/);
 assert.doesNotMatch(html,/<script>|<textarea|contenteditable|>更正<\/button>/);
 assert.equal(memory.core[0].text,'<script>bad()</script>\n约定尚未履行');
 const missing=render(MemoryContent,{memory:{core:[{id:'c',text:'摘要',eventIds:['not-loaded']}],events:[]}});
 assert.match(missing,/来源未载入此页，原始记录仍保留/);
});

test('growth history renders public summaries and ignores raw private reasoning accidentally present in a response',()=>{
 const current=state('seed');current.characters[0].growth.history=[{id:'g',summary:'逐步使用更简洁的表达',reason:'不得展示私人原因',eventIds:['private-evidence'],version:2,evidenceCount:4}];
 const html=render(GrowthPanel,{state:current,request:async()=>{},setFeedback(){}});
 assert.match(html,/逐步使用更简洁的表达/);assert.match(html,/独立经历/);assert.doesNotMatch(html,/不得展示私人原因|private-evidence/);
});

test('archive preview reports each Persona relation independently and does not inject old private raw chats',()=>{
 const preview={id:'a',name:'最初的人生',mode:'seed',createdAt:1,bytes:2048,personas:[{id:'a',name:'工作'},{id:'b',name:'日常'}],relationships:{byPersona:{a:{level:3,experience:100,affection:8},b:{level:1,experience:2,affection:1}}},card:{name:'DeepSeek',fields:{personality:{value:'认真'}}},conversations:[{messages:[{text:'不在预览打开的私聊秘密'}]}],dependencies:[{version:'1.8.0',id:'deepseek',required:true}]};
 const html=render(ArchivePreview,{preview});
 assert.match(html,/工作/);assert.match(html,/日常/);assert.match(html,/>100<\/td>/);assert.match(html,/>8<\/td>/);assert.match(html,/>1<\/td>/);
 assert.match(html,/预览不激活此人生/);assert.match(html,/必需资源/);assert.doesNotMatch(html,/不在预览打开的私聊秘密/);
});

test('archive download validates payload boundaries before exposing a local ZIP download',()=>{
 const bytes=Buffer.from([80,75,3,4,20,0,0,0]),result=archiveDownloadPayload({base64:bytes.toString('base64'),fileName:'../人物:人生.zip',bytes:bytes.length});
 assert.deepEqual(Buffer.from(result.bytes),bytes);assert.equal(result.fileName,'.._人物_人生.zip');
 assert.throws(()=>archiveDownloadPayload({base64:'@@@='}),/数据无效/);
 assert.throws(()=>archiveDownloadPayload({base64:Buffer.from('notzip').toString('base64')}),/ZIP/);
 assert.throws(()=>archiveDownloadPayload({base64:bytes.toString('base64'),bytes:200}),/长度/);
 assert.equal(companionLifeBytes(1024),'1.0 KiB');assert.equal(companionLifeBytes(-1),'体积待核验');
});

test('new management panels are localized in English without translating a character name',()=>{
 try{setLocale('en');for(const panel of ['memory','growth','lives']){
  const html=manager(panel,state('normal'));assert.match(html,/Long-term memory/);assert.match(html,/Personality growth/);assert.match(html,/Life archives/);assert.match(html,/DeepSeek/);
 }
 const html=manager('growth',state('seed'));assert.match(html,/Growth cards are read-only/);assert.doesNotMatch(html,/成长人设只读/);
 }finally{setLocale('zh-CN');}
});

test('context capacity distinguishes user settings from unknown fallback and avoids claiming maximum capacity was tested',()=>{
 const fallback=render(MemoryCapacityInfo,{capacity:{tokens:8192,source:'conservative-fallback-unknown-capacity',verified:false}});
 assert.match(fallback,/未知容量，使用保守上限/);assert.match(fallback,/8,192/);assert.match(fallback,/不代表此接口已通过极限实测/);
 const manual=render(MemoryCapacityInfo,{capacity:{tokens:16384,source:'connection-setting',verified:false}});
 assert.match(manual,/用户填写的接口容量/);assert.doesNotMatch(manual,/未知容量，使用保守上限/);
 const appDefault=render(MemoryCapacityInfo,{capacity:{tokens:272000,source:'application-default',verified:false}});
 assert.match(appDefault,/272,000/);assert.match(appDefault,/应用默认容量（模型未声明）/);assert.doesNotMatch(appDefault,/模型目录声明/);assert.match(appDefault,/不代表此接口已通过极限实测/);
});

test('failed daily consolidation offers explicit retry but running and committed days do not expose a duplicate action',()=>{
 const jobs=[{id:'bad',day:'2026-10-20',scope:'persona:default',status:'failed',error:'接口暂不可用'},{id:'running',day:'2026-10-19',status:'running'},{id:'done',day:'2026-10-18',status:'committed'}];
 const html=render(MemoryJobStatus,{jobs,onRetry(){}});
 assert.match(html,/接口暂不可用/);assert.equal((html.match(/data-memory-retry=/g)||[]).length,1);assert.match(html,/data-memory-retry="bad"/);assert.doesNotMatch(html,/2026-10-18/);
});

test('archive preview resolves saved inherited defaults, custom values and explicit empty without consulting a live card',()=>{
 const preview={id:'resolved',name:'历史卡片',card:{name:'旧名字',defaults:{personality:'归档时继承的性格',tone:'已被覆盖的默认语气',background:'应清空的旧经历',sprite:'builtin-image-ref'},fields:{personality:{mode:'inherit',value:'不应采用的缓存'},tone:{mode:'custom',value:'归档时的自定义语气'},background:{mode:'empty'}}}};
 const html=render(ArchivePreview,{preview});
 assert.match(html,/归档时继承的性格/);assert.match(html,/归档时的自定义语气/);assert.match(html,/背景经历：主动清空/);
 assert.doesNotMatch(html,/不应采用的缓存|已被覆盖的默认语气|应清空的旧经历|builtin-image-ref/);
});
