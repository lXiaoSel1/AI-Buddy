import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {t} from '../src/i18n.mjs';

test('Galgame r14 user-facing source strings have an English entry',()=>{
 const cases={
  'src/adapted/galgame-client.ts':[
   '正在使用 · 角色背景','内置背景 · {name} 专属','PNG、JPG、WebP、AVIF，12 MB 以内。上传和 CG 背景按角色保存。',
   '应用到背景','支持 PNG、JPG、WebP、AVIF。用了自己上传的立绘后，表情差分和小动作仍然生效，但图只有一张。',
  ],
  'src/galgame-redesign.mjs':['{name} · 只对当前角色生效','{name} · 只对这个群聊生效'],
  'src/group-header.mjs':['搜索成员','没有找到这个成员','加载更早的消息'],
  'src/companion-history-page-client.mjs':['读取中断，请重试。'],
  'src/companion-memory.mjs':['记忆来源在读取过程中已变化，请重试'],
  'src/companion-service.mjs':['会话不存在','无效关系结算','关系投影与保存结果不一致'],
  'src/companion-storage-worker.mjs':['导出会话不存在','清理计划已经变化，请重新预演后再确认'],
 };
 for(const [path,phrases] of Object.entries(cases)){
  const source=readFileSync(new URL('../'+path,import.meta.url),'utf8');
  for(const phrase of phrases){
   assert.ok(source.includes(phrase),path+' should use '+phrase);
   assert.notEqual(t(phrase,'en'),phrase,phrase+' needs an English translation');
  }
 }
});
