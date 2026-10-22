import test from 'node:test';
import assert from 'node:assert/strict';
import {groupCgItems,groupCgLabel,activeGroupCg} from '../src/group-cg-ui.mjs';
import {setLocale} from '../src/i18n.mjs';
test('group CG catalogue excludes private, other-group and deleted media while retaining failed and retry items',()=>{
 const rows=[{id:'old',groupId:'g',kind:'group',at:1,status:'failed'},{id:'retry',groupId:'g',kind:'group',at:2,retryOf:'old',status:'ready'},{id:'other',groupId:'h',kind:'group',at:3},{id:'private',kind:'level',at:4},{id:'trash',groupId:'g',kind:'group',at:5,deletedAt:5}];
 assert.deepEqual(groupCgItems(rows,'g').map(r=>r.id),['retry','old']);assert.deepEqual(groupCgItems(rows,'missing'),[]);assert.equal(rows[0].id,'old');
});
test('CG status distinguishes local queue, theme, request preparation, submitted request and completion',()=>{
 setLocale('zh-CN');assert.equal(groupCgLabel({status:'queued'}),'排队中');assert.equal(groupCgLabel({status:'planning'}),'正在设计合影主题');assert.equal(groupCgLabel({status:'generating'}),'正在准备绘图请求');assert.equal(groupCgLabel({status:'generating',submittedAt:1}),'请求中 · 等待绘图服务返回');assert.equal(groupCgLabel({status:'ready'}),'生成成功');assert.equal(activeGroupCg({status:'failed'}),false);assert.equal(activeGroupCg({status:'ready'}),false);assert.equal(activeGroupCg({status:'planning'}),true);
});
