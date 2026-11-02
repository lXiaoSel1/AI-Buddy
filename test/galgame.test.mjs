import test from 'node:test';
import {recordMoodRequest} from './support/mood-request.mjs';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createGalgame} from '../src/galgame-host.mjs';
import {createSnapshotStorage,readJson} from '../src/storage.mjs';
let calls=0;
const provider={enabled:false,listProviders:()=>[{id:'codex',name:'Codex'}],listModels:()=>[{id:'gpt-6.1-sol'}],async *stream(){calls++;throw new Error('offline');}};
test('A saved cast scene advances and closes offline without acquiring a chat turn',async()=>{
 const root=join(import.meta.dirname,'../local/test-runs','offline-cast-'+Date.now());let turns=0;
 const offline={...provider,runTurn:async fn=>{turns++;return fn()}};
 let game=await createGalgame({dataRoot:root,provider:offline,model:'fixture'});await game.action('settings-set',{characterMode:'manual',characterId:'claude'});await game.close();
 await new Promise(r=>setTimeout(r,100));const storage=createSnapshotStorage(join(root,'galgame/storages/dsh-whale-galgame/global.json')),saved=await readJson(storage);
 saved.sideStory={scene:{id:'saved-cast',cast:['claude','qwen'],cursor:0,settled:true,beats:[{speaker:'claude',text:'甲',emotion:'angry'},{speaker:'qwen',text:'乙',emotion:'shy'}],interludes:[{at:1,consumed:true,choices:[]}]},history:[],transcripts:[]};await storage.writeText(JSON.stringify(saved));
 game=await createGalgame({dataRoot:root,provider:offline,model:'fixture'});
 try{assert.equal((await game.action('view')).sideStory.scene.cursor,0);const next=await game.action('side-story',{op:'advance'});assert.equal(next.sideStory.scene.cursor,1);assert.equal(next.sideStory.scene.beats[1].emotion,'shy');await assert.rejects(()=>game.action('side-story',{op:'start'}),/离线/);await assert.rejects(()=>game.action('side-story',{op:'speak',text:'hello'}),/离线/);assert.equal((await game.action('side-story',{op:'close'})).sideStory.scene,null);assert.equal(turns,0);}finally{await game.close();}
});
test('Galgame runs offline with model names and eleven roles, persistence and no model calls',async()=>{
 const root=join(import.meta.dirname,'../local/test-runs','galgame-'+Date.now());
 let game=await createGalgame({dataRoot:root,provider,model:'gpt-6.1-sol'});
 const options=await game.action('model-options');assert.ok(JSON.stringify(options).includes('deepseek'));assert.ok(JSON.stringify(options).includes('kimi'));
 const settings=await game.action('settings-get');assert.equal(settings.characterId,'deepseek');assert.equal(settings.characterMode,'manual');assert.equal(settings.sideStorySeedSource,'activity');
 await assert.rejects(()=>game.action('chat',{text:'你好'}),/离线/);
 const view=await game.action('view');assert.equal(view.name,'DeepSeek');assert.equal(calls,0);
 const edited=await game.action('profile-set',{characterId:'deepseek',overrides:{displayName:'测试鲸鱼娘'}});assert.equal(edited.ok,true);
 game.workTokens(5100);await new Promise(r=>setTimeout(r,250));await game.action('view');await game.close();
 game=await createGalgame({dataRoot:root,provider,model:'gpt-6.1-sol'});const profile=await game.action('profile-get',{characterId:'deepseek'});assert.ok(JSON.stringify(profile).includes('测试鲸鱼娘'));await game.close();
});

test('Private companion workspace routes chat, remembers replies and disables level-up CG',async()=>{
 const root=join(import.meta.dirname,'../local/test-runs','chat-'+Date.now());let modelCalls=0,petVisible=true;const moodCalls=[];
 const online={...provider,enabled:true,currentSelection:()=>({provider:'codex',model:'gpt-6.1-sol'}),async *stream(options){if(recordMoodRequest(options,moodCalls,{characterIds:['deepseek']})){yield{type:'text-delta',text:'{"changed":false}'};return;}modelCalls++;const response=/情绪分类器/.test(options.system)?'cheerful':/选项生成器/.test(options.system)?'{"positive":"一起休息吧","neutral":"说说今天","negative":"先安静一下"}':'主人，鲸鱼娘在这里陪你呀。';yield {type:'text-delta',text:response};yield {type:'finish',reason:{kind:'stop'}};}};
 let game=await createGalgame({dataRoot:root,provider:online,model:'gpt-6.1-sol',onPetVisibility:v=>petVisible=v});
 const chat=await game.action('chat',{text:'你好'});assert.ok(JSON.stringify(chat).includes('鲸鱼娘在这里陪你'));assert.equal(modelCalls,1,'body returns before background choices');
 for(let n=0;n<100&&modelCalls<2;n++)await new Promise(r=>setTimeout(r,5));
 assert.equal(modelCalls,2);assert.ok(moodCalls.length>0);assert.ok(JSON.stringify(await game.action('view')).includes('一起休息吧'));
 await game.action('pet-set',{enabled:false});assert.equal(petVisible,false);await game.action('pet-set',{enabled:true});
 game.workTokens(180000);
 for(let i=0;i<12;i++){await game.action('view');await new Promise(r=>setTimeout(r,15));}
 const view=await game.action('view');assert.ok(!JSON.stringify(view).includes('"status":"generating"'));assert.equal(modelCalls,2);
 assert.equal((await game.action('skit-cg',{skitId:'x'})).ok,false);await game.close();
 game=await createGalgame({dataRoot:root,provider:online,model:'gpt-6.1-sol'});assert.ok(JSON.stringify(await game.action('view')).includes('鲸鱼娘在这里陪你'));await game.close();
});
