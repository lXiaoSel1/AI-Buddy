import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CgTransport} from '../src/cg-transport.mjs';
import {CgService} from '../src/cg-service.mjs';
import {codexImageBytes} from '../src/codex-image-provider.mjs';
import {createSnapshotStorage,readJson} from '../src/storage.mjs';
import {createGalgame} from '../src/galgame-host.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=','base64');
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const codec=bytes=>({png:bytes,thumbnail:bytes,width:1,height:1,extension:'png'});
const crypto={isEncryptionAvailable:()=>true,encryptString:key=>Buffer.from([...key].reverse().join('')),decryptString:bytes=>[...bytes.toString()].reverse().join('')};
const codex={defaultModel:'gpt-6.1-sol',enabled:false,close(){},setEnabled(){}};
const temp=()=>mkdtempSync(join(tmpdir(),'whale-cg-'));
const wait=async predicate=>{const end=Date.now()+6000;while(!predicate()){if(Date.now()>end)throw Error('Wait timed out');await new Promise(resolve=>setTimeout(resolve,15));}};
async function service({fetchImpl=async()=>json({data:[{b64_json:png.toString('base64')}]}),dataRoot=temp(),...options}={}){
 const cg=new CgService({dataRoot,codex,crypto,imageCodec:codec,referenceResolver:async()=>[{buffer:png}],fetchImpl,pollInterval:1,...options});await cg.ready;return cg;
}
async function configure(cg,protocol='openai-images'){const profile=await cg.save({kind:'custom',name:'CG 测试连接',baseUrl:'http://127.0.0.1:31415/v1',model:'image-model',protocol,options:{references:!protocol.startsWith('wan-t2i')}});await cg.activate(profile.id);return profile;}

test('Image adapters send one image, reference inputs, correct endpoints, and ignore Gemini thought images',async()=>{
 const directory=temp(),path=join(directory,'reference.png');writeFileSync(path,png);const calls=[];
 const transport=new CgTransport({pollInterval:1,fetchImpl:async(url,options)=>{calls.push({url:String(url),...options});if(String(url).includes('/interactions'))return json({steps:[{type:'thought',data:'not-an-image'}],output_image:{mime_type:'image/png',data:png.toString('base64')}});if(String(url).includes('multimodal-generation'))return json({output:{choices:[{message:{content:[{image:'data:image/png;base64,'+png.toString('base64')} ]}}]}});return json({data:[{b64_json:png.toString('base64')}]});}});
 const base={kind:'custom',baseUrl:'http://127.0.0.1:3/v1',model:'image-model',key:'fixture-secret',options:{references:true}};
 for(const protocol of ['openai-images','gemini-images','wan-image'])assert.deepEqual((await transport.generate({...base,protocol},{prompt:'人物 CG',references:[{path}]})).buffer,png);
 assert.ok(calls[0].url.endsWith('/images/edits'));assert.equal(calls[0].body.get('n'),'1');assert.equal(calls[0].body.getAll('image[]').length,1);
 const gemini=JSON.parse(calls[1].body);assert.equal(gemini.input[1].type,'image');assert.equal(gemini.response_format.aspect_ratio,'16:9');
 const wan=JSON.parse(calls[2].body);assert.equal(wan.parameters.n,1);assert.equal(wan.parameters.enable_interleave,false);assert.equal(wan.input.messages[0].content.length,2);
 await transport.generate({...base,protocol:'openai-images',options:{references:false}},{prompt:'人物 CG',references:[{path}]});assert.ok(calls.at(-1).url.endsWith('/images/generations'));assert.equal(JSON.parse(calls.at(-1).body).n,1);
});
test('Wan async persists its task before polling; resumed work makes no second submission',async()=>{
 let posts=0,polls=0,saved=false;const transport=new CgTransport({pollInterval:1,fetchImpl:async(url,options)=>{if(options.method==='POST'){posts++;return json({output:{task_id:'task-123'}});}assert.equal(saved,true);polls++;return json({output:{task_status:polls===1?'RUNNING':'SUCCEEDED',results:[{url:'data:image/png;base64,'+png.toString('base64')}]}});}});
 const profile={kind:'wan',protocol:'wan-t2i',baseUrl:'http://127.0.0.1:3',key:'key',model:'wan2.6-t2i',options:{}};
 await transport.generate(profile,{prompt:'CG',onRemoteTask:async task=>{assert.equal(task.id,'task-123');saved=true;}});assert.equal(posts,1);
 await transport.generate(profile,{prompt:'CG',remoteTask:{id:'task-123'}});assert.equal(posts,1);
});
test('Bad responses, HTTP errors and unsafe image addresses fail without exposing credentials',async()=>{
 const profile={kind:'custom',protocol:'openai-images',baseUrl:'http://127.0.0.1:3',key:'SECRET',model:'image'};
 for(const response of [new Response('SECRET',{status:500}),json({data:[]}),new Response('invalid')]){const transport=new CgTransport({fetchImpl:async()=>response});await assert.rejects(()=>transport.generate(profile,{prompt:'CG'}),error=>!error.message.includes('SECRET'));}
 await assert.rejects(()=>new CgTransport().image('http://example.com/image.png'),/HTTPS/);
 let called=0;const transport=new CgTransport({fetchImpl:async()=>{called++;throw Error('network');}});await assert.rejects(()=>transport.generate(profile,{prompt:'CG'}),/连接失败/);assert.equal(called,1);
});
test('CG settings are encrypted, default off, persistent and independent from chat; reads do not generate',async()=>{
 let draws=0;const root=temp(),cg=await service({dataRoot:root,fetchImpl:async(url)=>{if(String(url).endsWith('/models'))return json({data:[{id:'image-model'}]});draws++;return json({data:[{b64_json:png.toString('base64')}]});}});
 const saved=await cg.save({kind:'openai',name:'CG',baseUrl:'https://api.example.test/v1',key:'secret-CG-key',model:'image-model'});await cg.activate(saved.id);assert.equal(cg.enabled,false);assert.ok(!JSON.stringify(cg.view()).includes('secret-CG-key'));assert.ok(!JSON.stringify(cg.state).includes('secret-CG-key'));
 await cg.test({...saved,key:''});await cg.fetchModels({...saved,key:''});assert.equal(draws,0);await cg.setEnabled(true);await cg.close();
 const next=await service({dataRoot:root});assert.equal(next.enabled,true);assert.equal(next.state.activeId,saved.id);assert.equal(next.jobs.length,0);await next.close();
});
test('Serial queue deduplicates events, locks connections, cancels unsubmitted auto jobs and finishes submitted jobs',async()=>{
 let submitted=0,release;const cg=await service({fetchImpl:async()=>{submitted++;await new Promise(resolve=>release=resolve);return json({data:[{b64_json:png.toString('base64')}]});}});const profile=await configure(cg);cg.start();
 assert.equal((await cg.enqueue({sourceEventId:'off',automatic:true,prompt:'CG'})).skipped,true);
 await cg.setEnabled(true);await cg.enqueue({id:'first',sourceEventId:'event-first',automatic:true,prompt:'CG'});await wait(()=>submitted===1);
 await cg.enqueue({id:'second',sourceEventId:'event-second',automatic:true,prompt:'CG'});await cg.enqueue({id:'different-id',sourceEventId:'event-first',automatic:true,prompt:'CG'});assert.equal(cg.jobs.length,2);
 await assert.rejects(()=>cg.activate(profile.id),/CG 队列/);await assert.rejects(()=>cg.remove(profile.id),/CG 队列/);
 await cg.setEnabled(false);assert.equal(cg.job('second').status,'cancelled');release();await wait(()=>cg.job('first').status==='ready');assert.equal(submitted,1);assert.equal(cg.enabled,false);assert.ok(cg.job('first').assetRef);assert.ok(cg.readAsset(cg.job('first').assetRef).startsWith('data:image/png'));
 await assert.rejects(async()=>cg.readAsset('cg-assets/../../../package.json'));
 await cg.close();
});
test('Failed submissions are retained and explicit retry submits once; no automatic resubmission',async()=>{
 let submissions=0;const cg=await service({fetchImpl:async()=>{submissions++;return submissions===1?new Response('err',{status:500}):json({data:[{b64_json:png.toString('base64')}]});}});await configure(cg);cg.start();
 await cg.enqueue({id:'bad',sourceEventId:'bad',prompt:'CG'});await wait(()=>cg.job('bad').status==='failed');assert.equal(submissions,1);
 await cg.enqueue({id:'retry',sourceEventId:'retry',retryOf:'bad',prompt:'CG'});await wait(()=>cg.job('retry').status==='ready');assert.equal(cg.job('bad').status,'failed');assert.equal(submissions,2);await cg.close();
});
test('Native image results require actual completed images and validated output paths',()=>{
 assert.deepEqual(codexImageBytes({type:'imageGeneration',status:'completed',result:png.toString('base64')},temp()),png);
 assert.throws(()=>codexImageBytes({type:'agentMessage',status:'completed',result:'已完成'},temp()));assert.throws(()=>codexImageBytes({type:'imageGeneration',status:'failed',failure:{type:'usageLimitExceeded'},result:''},temp()));
 const inside=temp(),outside=temp(),path=join(outside,'image.png');writeFileSync(path,png);assert.throws(()=>codexImageBytes({type:'imageGeneration',status:'completed',result:'',savedPath:path},inside),/本次任务目录/);
});
test('Manual CG works with chat off; gallery, background, restart, and old inline images remain compatible',async()=>{
 const root=temp(),cg=await service({dataRoot:root});await configure(cg);const provider={enabled:false,listProviders:()=>[],listModels:()=>[],async *stream(){throw Error('chat must stay off');}};
 let game=await createGalgame({dataRoot:root,provider,model:'offline',cg});cg.start();const before=await game.action('view');
 const request=await game.action('cg-generate',{characterId:'deepseek'});assert.equal(request.ok,true);await wait(()=>cg.job(request.cgId)?.status==='ready');await wait(()=>JSON.stringify(cg.view()).includes('ready'));await new Promise(resolve=>setTimeout(resolve,60));
 const gallery=await game.action('cg-gallery');assert.equal(gallery.items[0].status,'ready');assert.ok(!JSON.stringify(gallery).includes('base64'));assert.equal((await game.action('cg-data',{id:request.cgId})).dataUrl,'data:image/png;base64,'+png.toString('base64'));
 await game.action('cg-save-bg',{id:request.cgId});assert.equal((await game.action('bg-data')).dataUrl,'data:image/png;base64,'+png.toString('base64'));
 assert.equal((await game.action('view')).level,before.level);assert.equal((await game.action('cg-generate')).cgId,request.cgId);game.close();await cg.close();
 const reopened=await service({dataRoot:root});game=await createGalgame({dataRoot:root,provider,model:'offline',cg:reopened});reopened.start();assert.equal((await game.action('cg-gallery')).items[0].status,'ready');assert.ok((await game.action('bg-data')).dataUrl);assert.equal(reopened.jobs.length,1);game.close();await reopened.close();
});

test('Fresh level-up creates one CG; opening history and restarting never repeats it; legacy inline CG remains readable',async()=>{
 const root=temp(),cg=await service({dataRoot:root});await configure(cg);await cg.setEnabled(true);
 const provider={enabled:false,listProviders:()=>[],listModels:()=>[],async *stream(){throw Error('No chat');}};
 let game=await createGalgame({dataRoot:root,provider,model:'offline',cg});await game.action('view');game.close();
 const storage=createSnapshotStorage(join(root,'galgame/storages/dsh-whale-galgame/global.json')),state=await readJson(storage,null);
 state.characters.deepseek.affection=30;state.characters.deepseek.level=1;state.characters.deepseek.cgs.push({id:'legacy',status:'ready',dataUrl:'data:image/png;base64,'+png.toString('base64'),level:1,at:1,seen:true});await storage.writeText(JSON.stringify(state));
 game=await createGalgame({dataRoot:root,provider,model:'offline',cg});cg.start();await game.action('view');await new Promise(r=>setTimeout(r,30));assert.equal(cg.jobs.length,0,'Reading historical affection must not generate a gift');game.workTokens(5000);await new Promise(r=>setTimeout(r,30));await game.action('view');await wait(()=>cg.jobs.some(job=>job.status==='ready'));assert.equal((await game.action('view')).level,2);
 for(let i=0;i<8;i++){await game.action('view');await game.action('cg-gallery');}assert.equal(cg.jobs.length,1);assert.equal(cg.jobs[0].automatic,true);assert.ok((await game.action('cg-data',{id:'legacy'})).dataUrl);
 game.close();await cg.close();const restarted=await service({dataRoot:root});game=await createGalgame({dataRoot:root,provider,model:'offline',cg:restarted});restarted.start();await game.action('view');assert.equal(restarted.jobs.length,1);assert.ok((await game.action('cg-data',{id:'legacy'})).dataUrl);game.close();await restarted.close();
});

test('Multi-role skit upgrades queue three gifts; only reaching the final beat queues one photo; early close makes no photo',async()=>{
 const root=temp(),cg=await service({dataRoot:root});await configure(cg);await cg.setEnabled(true);
 const provider={enabled:true,listProviders:()=>[{id:'codex'}],listModels:()=>[{id:'fixture'}],async *stream(options){
  const cast=[...options.system.matchAll(/^- ([a-z]+)（/gm)].map(match=>match[1]).slice(0,3);assert.equal(cast.length,3);
  const beats=[{speaker:'narrator',text:'一起喝茶。'},...cast.map(speaker=>({speaker,text:'今天好开心。',emotion:'cheerful'}))];
  const choices=[0,1,2].map(index=>({text:['一起喝茶','看看海','继续聊聊'][index],effects:Object.fromEntries(cast.map(id=>[id,1])),reply:[{speaker:cast[0],text:'一起吧。',emotion:'cheerful'}]}));
  yield {type:'text-delta',text:JSON.stringify({acts:[{beats,choices},{beats,choices},{beats}]})};yield {type:'finish',reason:{kind:'stop'}};
 }};
 let game=await createGalgame({dataRoot:root,provider,model:'fixture',cg});await game.action('view');game.close();
 const storage=createSnapshotStorage(join(root,'galgame/storages/dsh-whale-galgame/global.json')),state=await readJson(storage,null);for(const character of Object.values(state.characters)){character.affection=29;character.level=1;}await storage.writeText(JSON.stringify(state));
 game=await createGalgame({dataRoot:root,provider,model:'fixture',cg});cg.start();let view=await game.action('side-story',{op:'start',force:true,topic:'大家一起喝茶'});assert.ok(view.sideStory.scene,JSON.stringify(view));
 while(!view.sideStory.scene.choices.length)view=await game.action('side-story',{op:'advance'});
 view=await game.action('side-story',{op:'choose',choiceId:view.sideStory.scene.choices[0].id});await wait(()=>cg.jobs.length===3);assert.equal(cg.jobs.filter(job=>job.kind==='skit').length,0);
 while(!view.sideStory.scene.choices.length)view=await game.action('side-story',{op:'advance'});
 view=await game.action('side-story',{op:'choose',choiceId:view.sideStory.scene.choices[0].id});assert.equal(view.sideStory.scene.settled,true);assert.equal(cg.jobs.filter(job=>job.kind==='skit').length,0);
 while(view.sideStory.scene.cursor<view.sideStory.scene.beats.length-1)view=await game.action('side-story',{op:'advance'});
 await wait(()=>cg.jobs.filter(job=>job.kind==='skit').length===1);await game.action('side-story',{op:'advance'});await game.action('side-story-log');assert.equal(cg.jobs.length,4);
 await game.action('side-story',{op:'close'});await game.action('side-story',{op:'start',force:true,topic:'新的茶会'});await game.action('side-story',{op:'close'});assert.equal(cg.jobs.length,4);await wait(()=>cg.jobs.every(job=>job.status==='ready'));game.close();await cg.close();
});

test('Restart resumes a known async task by querying only and never repeats an uncertain submission',async()=>{
 const root=temp(),cg=await service({dataRoot:root});await configure(cg,'wan-t2i');await cg.enqueue({id:'resume-me',sourceEventId:'resume-event',prompt:'CG'});
 const job=cg.job('resume-me');job.status='generating';job.remoteTask={id:'remote-task'};await cg.persistJobs();await cg.close();
 let posts=0,gets=0;const restored=await service({dataRoot:root,fetchImpl:async(url,options)=>{if(options.method==='POST')posts++;else gets++;return json({output:{task_status:'SUCCEEDED',results:[{url:'data:image/png;base64,'+png.toString('base64')}]}});}});restored.start();await wait(()=>restored.job('resume-me').status==='ready');assert.equal(posts,0);assert.equal(gets,1);await restored.close();
 const uncertain=await service();await configure(uncertain);await uncertain.enqueue({id:'uncertain',sourceEventId:'uncertain-event',prompt:'CG'});uncertain.job('uncertain').status='generating';await uncertain.persistJobs();await uncertain.close();const after=await service({dataRoot:uncertain.dataRoot,fetchImpl:async()=>{throw Error('Must not submit');}});after.start();assert.equal(after.job('uncertain').status,'failed');await after.close();
});
