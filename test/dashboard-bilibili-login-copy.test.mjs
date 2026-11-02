import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/dashboard.mjs',import.meta.url),'utf8'),en=JSON.parse(readFileSync(new URL('../src/locales/en.json',import.meta.url),'utf8'));
const start=source.indexOf('const SOCIAL_STATUS='),end=source.indexOf('const EMBED_FOOT=',start);
assert.ok(start>=0&&end>start);
// Run only the pure status formatter, without booting the dashboard document.
const formatter=t=>new Function('t',source.slice(start,end)+'\nreturn pluginStatusRow;')(t);
for(const language of ['zh-CN','en'])test('Bilibili sidebar requires a connected account in '+language,()=>{
 const t=text=>language==='en'?en[text]??text:text,row=formatter(t),record={packageName:'@ai-buddy/bilibili-companion',enabled:true};
 for(const runtimeVerified of [false,true])for(const accounts of [[],[{pluginId:record.packageName,enabled:false}]]){const value=row({...record,runtimeVerified},{accounts});assert.equal(value[1],(runtimeVerified?'':t('加载中')+' · ')+t('还没连接账号'));assert.doesNotMatch(value[1],/不用账号|只看不评论|No account · watches|watches, no comments/i);}
 const account={pluginId:record.packageName,enabled:true};assert.equal(row({...record,runtimeVerified:true},{accounts:[account]})[1],t('已连接 · 可以发评论'));assert.equal(row({...record,runtimeVerified:true},{accounts:[{...account,activityApprovalRequired:true}]})[1],t('已连接 · 还没完成设置'));
 assert.equal(row({packageName:'@ai-buddy/qq-connect',enabled:true,runtimeVerified:true},{accounts:[]})[1],t('还没连接账号'));
});
