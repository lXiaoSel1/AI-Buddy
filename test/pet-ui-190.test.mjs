import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {badgeText,bubbleView} from '../src/pet-badge.mjs';
import {trayMenuTemplate,petContextTemplate} from '../src/pet-menu.mjs';
import {PetActivityClock} from '../src/pet-interactions.mjs';
import {THEME_PALETTES} from '../src/theme-palettes.mjs';

test('status bar: a short label with a state dot, sleep and hold hints, hidden in flight',()=>{
 assert.deepEqual(badgeText(),{tone:'idle',label:'AI 酱',detail:'陪着你'});
 assert.deepEqual(badgeText({snapshot:{sessions:[{displayStatus:'running'},{displayStatus:'running'},{displayStatus:'waiting',provider:'codex'}]}}),{tone:'ok',label:'工作中',detail:'2 个会话'});
 assert.deepEqual(badgeText({snapshot:{sessions:[{displayStatus:'waiting',provider:'codex'}]}}),{tone:'warn',label:'等你回应',detail:'Codex'});
 assert.equal(badgeText({snapshot:{indexing:true}}).tone,'busy');
 assert.deepEqual(badgeText({interaction:{phase:'asleep',motion:{mode:'rest'}}}),{icon:'moon',label:'睡着了',detail:'点一下叫醒'});
 assert.equal(badgeText({interaction:{phase:'awake',motion:{mode:'dragging',button:0}}}).label,'拖着走');
 assert.equal(badgeText({interaction:{phase:'awake',motion:{mode:'pressed',button:0}}}).label,'AI 酱');
 assert.equal(badgeText({interaction:{phase:'awake',motion:{mode:'dragging',button:2}}}).label,'按住左键蓄力');
 assert.equal(badgeText({interaction:{phase:'awake',motion:{mode:'charging',button:2}}}).detail,'Esc 取消');
 for(const mode of ['flying','landing'])assert.equal(badgeText({interaction:{phase:'awake',motion:{mode}}}),null);
 assert.deepEqual(badgeText({demo:'睡眠'}),{tone:'ok',label:'演示',detail:'睡眠'});
 const en=badgeText({snapshot:{sessions:[{displayStatus:'running'}]},language:'en'});
 assert.doesNotMatch(en.label+en.detail,/[一-鿿]/);
});

test('bubbles split into who/what and a second line; the log error opens Token detection',()=>{
 assert.deepEqual(bubbleView({source:'completed',text:'DeepSeek Harness完成任务啦，辛苦了～'}),{kind:'ok',icon:'check',title:'DeepSeek Harness 完成任务啦',detail:'辛苦了～'});
 const error=bubbleView({source:'failed',text:'Codex日志记录了错误，点我查看。'});
 assert.equal(error.kind,'err');assert.equal(error.open,'tokens');assert.equal(error.title,'Codex 的日志记录了错误');
 assert.equal(bubbleView({source:'chat-error',text:'聊天暂时失败，请重试。'}).title,'聊天暂时失败');
 assert.deepEqual(bubbleView({source:'dialog',characterId:'claude',text:'早点休息哦'}),{kind:'say',name:'Claude',title:'早点休息哦'});
 const hidden=bubbleView({kind:'badge-hidden'});assert.equal(hidden.undo,'撤销');assert.match(hidden.detail,/右键桌宠/);
 assert.deepEqual(bubbleView({text:'本地验证：任务完成'}),{kind:'plain',title:'本地验证：任务完成'});
 for(const value of [{source:'completed',text:'Codex完成任务啦，辛苦了～'},{source:'failed',text:'Codex日志记录了错误，点我查看。'},{source:'chat-error',text:'x'},{kind:'badge-hidden'}]){const view=bubbleView(value,{language:'en'});assert.doesNotMatch([view.title,view.detail,view.link,view.undo].join(' '),/[一-鿿]/,JSON.stringify(value));}
});

test('tray menu gains a separator; the pet menu has five items and swaps nap/wake while asleep',()=>{
 const noop=()=>{},tray=trayMenuTemplate({open:noop,setPetVisible:noop,setGestureMode:noop,quit:noop});
 assert.deepEqual(tray.map(item=>item.type==='separator'?'—':item.label),['工作概览','通用设置','动作展示','打开 Galgame','—','显示桌宠','拖动模式（整个窗口可拖动）','—','退出']);
 const opened=[];const pet=petContextTemplate({open:page=>opened.push(page),sleep:noop,wake:noop,setStatusBadge:noop,hidePet:noop});
 assert.deepEqual(pet.filter(item=>item.type!=='separator').map(item=>item.label),['打开工作空间','打开 Galgame','让她睡一会儿','显示状态条','隐藏桌宠']);
 pet[0].click();pet[1].click();assert.deepEqual(opened,['overview','galgame']);
 assert.equal(pet.find(item=>item.label==='显示状态条').type,'checkbox');
 assert.equal(petContextTemplate({asleep:true,open:noop,sleep:noop,wake:noop,setStatusBadge:noop,hidePet:noop})[3].label,'叫醒她');
 for(const item of [...trayMenuTemplate({language:'en',open:noop,setPetVisible:noop,setGestureMode:noop,quit:noop}),...petContextTemplate({language:'en',asleep:true,open:noop,sleep:noop,wake:noop,setStatusBadge:noop,hidePet:noop})])if(item.label)assert.doesNotMatch(item.label,/[一-鿿]/,item.label);
});

test('sleepNow only works while she is awake and idle',()=>{
 let now=0;const clock=new PetActivityClock({now:()=>now});
 clock.request('chat',true);assert.equal(clock.sleepNow(),false);assert.equal(clock.phase,'awake');
 clock.request('chat',false);assert.equal(clock.sleepNow(),true);assert.equal(clock.phase,'sleep-enter');
 assert.equal(clock.sleepNow(),false);now=5000;clock.tick();assert.equal(clock.phase,'asleep');
 assert.equal(clock.wake('menu'),true);assert.equal(clock.phase,'waking');
});

test('every theme has a full set of tinted glove frames; the v2 originals are untouched',()=>{
 const originals=readdirSync(new URL('../assets/pet-glove-v2/',import.meta.url)).filter(name=>name.endsWith('.png')).sort();
 assert.equal(originals.length,26);
 for(const {id} of THEME_PALETTES){
  const dir=new URL(`../assets/pet-glove-tint/${id}/`,import.meta.url);assert.ok(existsSync(dir),id);
  assert.deepEqual(readdirSync(dir).sort(),originals,id);
  assert.notDeepEqual(readFileSync(new URL('open@2x.png',dir)),readFileSync(new URL('../assets/pet-glove-v2/open@2x.png',import.meta.url)),id);
 }
});

test('the landing ring comes from the same flight run until it settles on the floor',async()=>{
 const {PetMotion}=await import('../src/pet-interactions.mjs');
 let time=0;const at=t=>time=t,m=new PetMotion({now:()=>time,bounds:{x:200,y:200,width:270,height:280},displays:()=>[{x:0,y:0,width:1920,height:1080}]});
 m.begin({x:250,y:250});at(50);m.move({x:300,y:250});m.right({x:300,y:250});m.move({x:450,y:350});
 const land=m.landing(),origin={...m.bounds},pull={...m.pull};assert.ok(land);assert.equal(m.preview().length,13);
 assert.ok(Math.abs(origin.y+land.y+pull.y+280-1080)<2,'rests on the floor');
 m.release();for(let i=1;i<=400&&m.mode==='flying';i++){at(50+i*25);m.tick();}
 assert.ok(Math.abs(m.bounds.x-(origin.x+land.x+pull.x))<.001);assert.ok(Math.abs(m.bounds.y-(origin.y+land.y+pull.y))<.001);
 m.begin({x:250,y:250});assert.equal(m.landing(),null);
});
