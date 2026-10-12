import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createGalgame} from '../src/galgame-host.mjs';
let calls=0;
const provider={enabled:false,listProviders:()=>[{id:'codex',name:'Codex'}],listModels:()=>[{id:'gpt-6.1-sol'}],async *stream(){calls++;throw new Error('offline');}};
test('Galgame runs offline with model names and eleven roles, persistence and no model calls',async()=>{
 const root=join(import.meta.dirname,'../local/test-runs','galgame-'+Date.now());
 let game=await createGalgame({dataRoot:root,provider,model:'gpt-6.1-sol'});
 const options=await game.action('model-options');assert.ok(JSON.stringify(options).includes('deepseek'));assert.ok(JSON.stringify(options).includes('kimi'));
 const settings=await game.action('settings-get');assert.equal(settings.characterId,'deepseek');assert.equal(settings.characterMode,'manual');assert.equal(settings.sideStorySeedSource,'activity');
 await assert.rejects(()=>game.action('chat',{text:'你好'}),/离线/);
 const view=await game.action('view');assert.equal(view.name,'DeepSeek');assert.equal(calls,0);
 const edited=await game.action('profile-set',{characterId:'deepseek',overrides:{displayName:'测试鲸鱼娘'}});assert.equal(edited.ok,true);
 game.workTokens(5100);await new Promise(r=>setTimeout(r,250));await game.action('view');game.close();
 game=await createGalgame({dataRoot:root,provider,model:'gpt-6.1-sol'});const profile=await game.action('profile-get',{characterId:'deepseek'});assert.ok(JSON.stringify(profile).includes('测试鲸鱼娘'));game.close();
});

test('Private companion workspace routes chat, remembers replies and disables level-up CG',async()=>{
 const root=join(import.meta.dirname,'../local/test-runs','chat-'+Date.now());let modelCalls=0,petVisible=true;
 const online={...provider,enabled:true,async *stream(options){modelCalls++;const response=/情绪分类器/.test(options.system)?'cheerful':/选项生成器/.test(options.system)?'{"positive":"一起休息吧","neutral":"说说今天","negative":"先安静一下"}':'主人，鲸鱼娘在这里陪你呀。';yield {type:'text-delta',text:response};yield {type:'finish',reason:{kind:'stop'}};}};
 let game=await createGalgame({dataRoot:root,provider:online,model:'gpt-6.1-sol',onPetVisibility:v=>petVisible=v});
 const chat=await game.action('chat',{text:'你好'});assert.ok(JSON.stringify(chat).includes('鲸鱼娘在这里陪你'));assert.equal(modelCalls,3);
 assert.ok(JSON.stringify(chat).includes('一起休息吧'));
 await game.action('pet-set',{enabled:false});assert.equal(petVisible,false);await game.action('pet-set',{enabled:true});
 game.workTokens(180000);
 for(let i=0;i<12;i++){await game.action('view');await new Promise(r=>setTimeout(r,15));}
 const view=await game.action('view');assert.ok(!JSON.stringify(view).includes('"status":"generating"'));assert.equal(modelCalls,3);
 assert.equal((await game.action('skit-cg',{skitId:'x'})).ok,false);game.close();
 game=await createGalgame({dataRoot:root,provider:online,model:'gpt-6.1-sol'});assert.ok(JSON.stringify(await game.action('view')).includes('鲸鱼娘在这里陪你'));game.close();
});
