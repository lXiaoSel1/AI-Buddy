import test from 'node:test';
import {constrainCgPrompt,constrainDailyCgPrompt} from '../src/cg-composition.mjs';
import {localTheme,themePrompt} from '../src/cg-theme.mjs';
import {runGalgameDom} from './support/galgame-r14-dom.mjs';

test('private Galgame entry points apply the approved paper dialog frames',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-paper-frame-fixture.mjs',{scenario:'idle',entry:'privateFrames'});
});
test('group Galgame dialogs use the appropriate paper frame and workplace dialogs keep theirs',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-paper-frame-fixture.mjs',{scenario:'idle',entry:'groupFrames'});
});

test('Galgame group photo uses the 640px paper frame at content height',{timeout:24000},async t=>{
 await runGalgameDom(t,'./galgame-paper-frame-fixture.mjs',{scenario:'idle',entry:'mediumFrame'});
});

for(const paperWidth of [1280,680]){
 test('all seven manager sidebars can reach their last row independently at '+paperWidth+'px',{timeout:24000},async t=>{
  await runGalgameDom(t,'./galgame-paper-frame-fixture.mjs',{scenario:'idle',entry:'managerSidebars',paperWidth});
 });
}

const reasonRows=['主题服务暂不可用','日常主题服务暂不可用','模型主题格式不完整、视角不合规或与近期重复',
 '日常主题格式或来源引用无效','联网聊天未开启','联网聊天未开启'];
const groupBrief={kind:'group',groupName:'Fixture reunion',scene:{description:'Synthetic lantern-lit reading room'},
 characters:[{id:'deepseek',name:'DeepSeek'}],recentContext:[{text:'The sign reads 主题服务暂不可用. '+('A wide river with quiet lamps. '.repeat(100))}]};
const groupTheme={...localTheme(groupBrief),fallbackReason:reasonRows[0]};
const innerLegacyPrompt=constrainCgPrompt('Original legacy scene.').replace(' v2】',' v1】')
 .replace('【再次确认】男性','【再次确认】内层历史说明，男性');
const nestedLegacyPrompt=constrainCgPrompt('LEGACY_INNER_SCENE')
 .replace('【再次确认】男性','【再次确认】外层历史说明，男性').replace('LEGACY_INNER_SCENE',innerLegacyPrompt);
const paperGallery=Array.from({length:8},(_,i)=>({
 id:'paper-cg-'+i,name:'DeepSeek',at:1700000000000,level:i+1,status:'ready',
 dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAABB0lEQVR4nA3LMcdGIRiA4e/nvERExCEiIh7iqK2xsbHhHhob+9Hfufbr7ycoQQtGsIITHsELQYhCErIgQhFeoQl/v4qq6Iqp2IqrPBVfCZVYSZVckUqpvJVWv9BRHd0xHdtxnafjO6ETO6mTO9IpnbfT+hcGaqAHZmAHbvAM/CAM4iAN8kAGZfAO2vjCRE30xEzsxE2eiZ+ESZykSZ7IpEzeSZtfWKiFXpiFXbjFs/CLsIiLtMgLWZTFu2jrCxu10RuzsRu3eTZ+EzZxkzZ5I5uyeTdtf+GgDvpgDvbgDs/BH8IhHtIhH+RQDu+hnS9c1EVfzMVe3OW5+Eu4xEu65ItcyuW9tMs/frujad2ZK7QAAAAASUVORK5CYII=',
 theme:i===0?groupTheme:{title:'River '+i,source:'local',fallbackReason:reasonRows[i]},
 referenceNotice:i===0?'未使用人物参考':i===1?'已保留全部人物参考；环境仅使用文字线索':null,
 prompt:i===0?themePrompt(groupBrief,groupTheme):i===1?constrainCgPrompt('Fog over the river.\n【再次确认】This line belongs to the scene.\nThe fog lifts.').replace(' v2】',' v17】').replaceAll('\n','\r\n'):
  i===2?nestedLegacyPrompt:i===6?'  Untouched archive.\n【CG 固定构图要求 v2】 in prose.\n\n  Last line.  ':i===7?constrainDailyCgPrompt('Daily scene.'):'Other scene.',
}));
for(const paperWidth of [1131,900]){
 test('gallery detail stays centered, keeps its header controls apart, and localizes notices at '+paperWidth+'px',{timeout:24000},async t=>{
  await runGalgameDom(t,'./galgame-paper-frame-fixture.mjs',{scenario:'paper-gallery',entry:'galleryDetails',galleryCount:8,paperGallery,paperWidth,reducedMotion:true});
 });
}
