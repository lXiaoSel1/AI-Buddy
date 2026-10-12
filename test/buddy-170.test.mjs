import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createGalgame} from '../src/galgame-host.mjs';
import {migrateCharacterDisplay,isSpriteVisible} from '../src/character-display.mjs';
import {THEMES,themeVariables,chromeColor,resolvedTheme} from '../src/appearance.mjs';
import {normalizePreferences} from '../src/preferences.mjs';
import {createSnapshotStorage,readJson} from '../src/storage.mjs';
import {PriceService} from '../src/pricing.mjs';
const provider={enabled:false,listProviders:()=>[],listModels:()=>[],async *stream(){throw Error('No network in tests')}};
const temp=()=>mkdtempSync(join(tmpdir(),'buddy170-')),url='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=';
test('Legacy global CG belongs only to its owner, manual visibility wins over automatic hiding',()=>{
 const s={current:'claude',bg:'cg:old',preferences:{customBgName:'old'},characters:{deepseek:{cgs:[{id:'old'}]},claude:{cgs:[]}}};
 assert.equal(migrateCharacterDisplay(s),true);assert.equal(s.characters.deepseek.backgroundOverride,'cg:old');assert.equal(s.characters.claude.backgroundOverride,null);assert.equal(migrateCharacterDisplay(s),false);
 for(const bg of ['cg','custom','builtin']){assert.equal(isSpriteVisible('hide',bg,true),false);assert.equal(isSpriteVisible('show',bg,true),true);assert.equal(isSpriteVisible('auto',bg,false),true);assert.equal(isSpriteVisible('auto',bg,true),bg!=='cg');}
});
test('Role backgrounds, gallery, trash and sprite preference persist independently',async()=>{
 const dataRoot=temp();let game=await createGalgame({dataRoot,provider,model:'fixture'});
 await game.action('bg-upload',{dataUrl:url,fileName:'DeepSeek-room.png'});await game.action('sprite-visibility',{mode:'hide'});
 await game.action('settings-set',{characterMode:'manual',characterId:'claude'});assert.notEqual((await game.action('view')).bg,'custom');assert.equal((await game.action('view')).spriteVisibility,'auto');
 await game.action('bg-upload',{dataUrl:url,fileName:'Claude-room.png'});game.close();
 const store=createSnapshotStorage(join(dataRoot,'galgame/storages/dsh-whale-galgame/global.json')),s=await readJson(store);
 for(const id of ['deepseek','claude'])s.characters[id].cgs=[{id:id+'-cg',status:'ready',at:1,level:3,dataUrl:url}];await store.writeText(JSON.stringify(s));
 game=await createGalgame({dataRoot,provider,model:'fixture'});assert.equal((await game.action('cg-gallery')).items[0].id,'claude-cg');
 await game.action('cg-save-bg',{id:'claude-cg'});assert.equal((await game.action('view')).bg,'cg');await game.action('cg-trash',{id:'claude-cg'});assert.notEqual((await game.action('view')).bg,'cg');
 await game.action('settings-set',{characterMode:'manual',characterId:'deepseek'});const v=await game.action('view');assert.equal(v.bg,'custom');assert.equal(v.spriteVisibility,'hide');assert.equal((await game.action('cg-gallery')).items[0].id,'deepseek-cg');assert.equal((await game.action('bg-data')).fileName,'DeepSeek-room.png');game.close();
});
test('English defaults apply to new conversations without rewriting existing dialogue',async()=>{
 const dataRoot=temp();let lang='en';const game=await createGalgame({dataRoot,provider,model:'fixture',getLanguage:()=>lang});
 let p=await game.action('profile-get');assert.match(p.effective.greeting,/Welcome/);const before=(await game.action('view')).history;assert.ok(before.length);assert.match(before.at(-1).text,/Welcome/);
 lang='zh-CN';p=await game.action('profile-get');assert.match(p.effective.greeting,/[\u3400-\u9fff]/);assert.deepEqual((await game.action('view')).history,before);
 await game.action('profile-set',{characterId:'deepseek',overrides:{greeting:'用户自己写的'}});lang='en';assert.equal((await game.action('profile-get')).effective.greeting,'用户自己写的');game.close();
});
test('Eleven validated palettes resolve fixed and character-following themes',()=>{
 assert.equal(Object.keys(THEMES).length,11);for(const id of Object.keys(THEMES)){assert.match(chromeColor(id),/^#[a-f0-9]{6}$/i);assert.ok(Object.keys(themeVariables(id)).length>5);assert.equal(resolvedTheme({themeMode:'character',theme:'deepseek'},id),id);assert.equal(resolvedTheme({themeMode:'fixed',theme:'deepseek'},id),'deepseek');}
 assert.equal(normalizePreferences({language:'en',theme:'claude',hideSpriteOnCg:false}).language,'en');
});
test('Price browser exposes the same effective override and context tiers as estimation',async()=>{
 const p=new PriceService({dataRoot:temp(),bundle:{version:'fixture',rows:{'openai/gpt-fixture':{provider:'openai',model:'gpt-fixture',currency:'USD',input:2,output:8,cacheRead:1,cacheWrite:2,tiers:[{threshold:200000,input:4,output:12}]}}}});await p.ready;
 const record={serviceProvider:'openai',model:'gpt-fixture',billingRoute:'api',usage:{input:300000,output:10000,cacheRead:0,cacheWrite:0,total:310000}};
 assert.equal(p.catalog({provider:'openai'}).rows[0].tiers[0].input,4);assert.ok(Math.abs(p.estimate(record).amount-1.32)<1e-10);
 await p.save({overrides:[{provider:'openai',model:'gpt-fixture',currency:'CNY',input:1,output:2,cacheRead:0,cacheWrite:0}]});
 const row=p.catalog({scope:'used'},[record]).rows[0];assert.equal(row.input,1);assert.equal(row.origin,'custom');assert.equal(p.estimate(record).currency,'CNY');assert.equal(p.estimate(record).amount,.32);assert.equal(p.catalog({search:'absent'}).total,0);
});
test('A chat captures its language before asynchronous model work',async()=>{
 let language='en',release;const waiting=new Promise(r=>release=r),calls=[];
 const online={...provider,enabled:true,currentSelection:()=>({provider:'test',model:'fixture'}),async *stream(o){calls.push(o);if(o.maxTokens===1200){await waiting;yield{type:'text-delta',text:'I am glad you are here.'}}else yield{type:'text-delta',text:o.purpose==='emotion'?'normal':'{"positive":"Stay a little longer","neutral":"Tell me more","negative":"I need a break"}'};yield{type:'finish',reason:{kind:'stop'}};}};
 const game=await createGalgame({dataRoot:temp(),provider:online,model:'fixture',getLanguage:()=>language});const task=game.action('chat',{text:'Hi'});while(!calls.some(c=>c.maxTokens===1200))await new Promise(r=>setTimeout(r,10));language='zh-CN';release();await task;
 for(const call of calls.filter(c=>c.purpose!=='emotion'))assert.match(call.system,/Respond in natural English/);game.close();
});

