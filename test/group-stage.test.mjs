import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGalgame} from '../src/galgame-host.mjs';
import {stageCapacity,stageWindow,stableMembers,replyEmotion,groupDialogueText} from '../src/group-stage.mjs';
import {ModelRouter} from '../src/model-router.mjs';
import {CgService} from '../src/cg-service.mjs';
const state=async g=>(await g.action('companion-state')).companion;
const until=async fn=>{for(let n=0;n<300;n++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,5));}throw Error('fixture timeout');};
async function fixture({cg:providedCg,root:providedRoot}={}){const calls=[],events=[],photos=[];let fail=false;
 const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'fixture'}),listProviders:()=>[{id:'fixture'}],listModels:()=>[{id:'fixture'}],runTurn:async fn=>fn(),runProfile:async(id,fn)=>{calls.push({route:id});return fn();},async *stream(o){calls.push(o);if(fail)throw Error('fixture network failure');yield{type:'text-delta',text:o.purpose==='group-chat'?'{"text":"我很开心！","emotion":"cheerful","affection":1}':/选项生成器/.test(o.system)?'{"positive":"好","neutral":"继续","negative":"暂停"}':'我很开心！'};}};
 const cg=providedCg??{available:()=>true,enabled:false,subscribe:()=>()=>{},validateReferences:async()=>[],enqueue:async job=>{photos.push(job);return job;},themePlanner:{capture:b=>({enabled:false,binding:b})}};
 const root=providedRoot??mkdtempSync(join(tmpdir(),'buddy-stage-')),game=await createGalgame({dataRoot:root,provider,model:'fixture',cg,onChatCommitted:e=>events.push(e)});
 const group=(await game.action('companion-group-save',{name:'roundtable',memberIds:['deepseek','claude','qwen','kimi','grok'],mode:'list'})).group;
 await game.action('companion-group-select',{id:group.id});return{game,group,calls,events,photos,provider,root,cg,setFail:v=>fail=v};
}
test('Camera capacity depends on viewport, preserves overlapping sectors and never loses a speaker among twelve',()=>{
 const ids=Array.from({length:12},(_,i)=>'c'+i);for(const [w,c]of[[900,4],[899,3],[660,3],[659,2]]){assert.equal(stageCapacity(w),c);let prev=[];for(const target of ids){const visible=stageWindow(ids,c,target,prev);assert.equal(visible.length,c);assert.ok(visible.includes(target));if(prev.includes(target))assert.deepEqual(visible,prev);prev=visible;}}
 assert.deepEqual(stableMembers({stageOrder:['a','b','c'],memberIds:['c','b','d']}),['b','c','d']);
});
test('Reply emotion prefers valid tag; guards code, quotes, negation and ambiguous keywords without calls',()=>{
 assert.deepEqual(replyEmotion('生气','shy'),{emotion:'shy',emotionSource:'structured'});
 for(const text of ['不要生气','我不生气','"angry"','```angry```','I am not angry.','开心又生气'])assert.equal(replyEmotion(text).emotion,'normal',text);
 assert.equal(replyEmotion('我很开心！').emotion,'cheerful');assert.equal(replyEmotion('I feel embarrassed.').emotion,'shy');assert.equal(replyEmotion('不要生气。我会认真考虑。').emotion,'serious');
});
test('A captured speaker can use a whole-line quotation without suppressing their own emotion',()=>{
 const options={speakerName:'DeepSeek'};
 for(const [text,emotion]of [['开心','cheerful'],['害羞','shy'],['认真','serious'],['困惑','confused'],['生气','angry'],['受惊','frightened'],['无奈','exasperated'],['星星眼','starry']]){
  assert.deepEqual(replyEmotion(`DeepSeek：DeepSeek：「我现在${text}。」`,undefined,options),{emotion,emotionSource:'keyword'});
 }
 for(const text of ['Claude：「我很生气。」','「我很生气。」','DeepSeek：「不要生气。」','DeepSeek：「她说“我很生气”。」','DeepSeek：```angry```'])assert.equal(replyEmotion(text,undefined,options).emotion,'normal',text);
 assert.equal(replyEmotion('DeepSeek：「我很生气。」','shy',options).emotion,'shy');
 assert.equal(replyEmotion('DeepSeek：「我很生气。」').emotion,'normal');
});

test('Group dialogue removes only leading captured-speaker labels, retaining body mentions and quotations',()=>{
 for(const prefix of ['DeepSeek：','DeepSeek: DeepSeek: ',' deepseek ： DEEPSEEK: '])assert.equal(groupDialogueText(prefix+'「我很害羞。GPT，你呢？」','DeepSeek'),'「我很害羞。GPT，你呢？」');
 for(const body of ['我叫 DeepSeek。','GPT：我很开心。','她说“DeepSeek：你好”。','「DeepSeek：你好。」','```\nDeepSeek: code\n```','DeepSeek：',' DeepSeek Model：正文 '])assert.equal(groupDialogueText(body,'DeepSeek'),body);
 assert.equal(groupDialogueText('小鱼：小鱼：你好。','小鱼'),'你好。');
 assert.equal(groupDialogueText('A+[B]：你好。','A+[B]'),'你好。');
 assert.equal(groupDialogueText('DeepSeek：旧名字。','新名字'),'DeepSeek：旧名字。');
 assert.equal(groupDialogueText('DeepSeek：你好。',undefined),'DeepSeek：你好。');
});

test('Group labels are normalized for display, bubbles and context while exported originals and speaker snapshots survive',async()=>{
 const f=await fixture(),raw='DeepSeek：DeepSeek：「我很害羞。GPT，你呢？」';
 try{
  let output=raw;
  f.provider.stream=async function*(o){f.calls.push(o);yield{type:'text-delta',text:output};};
  await f.game.action('companion-group-send',{text:'DeepSeek：这是用户原文',forceCharacterId:'deepseek'});
  const pending=await until(async()=>(await state(f.game)).groupRuntime.pendingMessage);
  assert.equal(pending.text,'「我很害羞。GPT，你呢？」');assert.equal(pending.emotion,'shy');
  await f.game.action('companion-group-present',{requestId:pending.id});
  assert.equal(f.events[0].text,pending.text);
  let view=await state(f.game);assert.equal(view.groupRuntime.currentMessage.text,pending.text);assert.equal(view.groupMessages.at(-1).text,pending.text);
  const exported=(await f.game.action('companion-group-export',{id:f.group.id})).data;
  assert.equal(exported.groups[0].messages.at(-1).text,raw);
  await f.game.action('companion-character-save',{id:'deepseek',name:'小鱼'});
  view=await state(f.game);assert.equal(view.groupRuntime.currentMessage.text,pending.text);assert.equal(view.groupRuntime.currentMessage.characterName,'DeepSeek');
  output=JSON.stringify({text:'Claude：我很开心！',emotion:'cheerful',affection:0});
  await f.game.action('companion-group-send',{text:'请继续',forceCharacterId:'claude'});
  const next=await until(async()=>(await state(f.game)).groupRuntime.pendingMessage);
  assert.equal(next.text,'我很开心！');assert.equal(next.emotion,'cheerful');
  const call=f.calls.at(-1),contents=call.messages.map(m=>m.content[0].text);
  assert.ok(contents.includes('DeepSeek：「我很害羞。GPT，你呢？」'));assert.ok(contents.includes('用户：DeepSeek：这是用户原文'));
  assert.ok(!contents.some(s=>s.includes('DeepSeek：DeepSeek：')));assert.match(call.system,/不要添加.*姓名/);
  await f.game.action('companion-group-present',{requestId:next.id});
  assert.equal(f.calls.length,2);assert.equal(f.events.length,2);
 }finally{await f.game.close();}
});
test('Group parser passes the captured speaker to quoted-line fallback without another model call',async()=>{
 const f=await fixture();try{
  f.provider.stream=async function*(){f.calls.push({purpose:'quoted-group'});yield {type:'text-delta',text:'DeepSeek：DeepSeek：「我很害羞。」'};};
  await f.game.action('companion-group-send',{text:'hello',forceCharacterId:'deepseek'});
  const pending=await until(async()=>(await state(f.game)).groupRuntime.pendingMessage);
  assert.equal(pending.emotion,'shy');assert.equal(pending.emotionSource,'keyword');assert.equal(pending.characterId,'deepseek');
  await f.game.action('companion-group-present',{requestId:pending.id});
  assert.equal(f.calls.filter(x=>x.purpose==='quoted-group').length,1);assert.equal(f.events[0].emotion,'shy');
 }finally{await f.game.close();}
});
test('Unpresented generated response makes no history/reward; ack commits exactly once and only Continue generates next',async()=>{
 const f=await fixture();try{await f.game.action('companion-group-send',{text:'hello'});const pending=await until(async()=>(await state(f.game)).groupRuntime.pendingMessage);assert.equal(f.events.length,0);assert.equal((await state(f.game)).groupMessages.filter(m=>m.role==='assistant').length,0);assert.equal((await state(f.game)).relationship.affection,0);
 await Promise.all([1,2,3].map(()=>f.game.action('companion-group-present',{requestId:pending.id})));assert.equal(f.events.length,1);assert.equal((await state(f.game)).relationship.affection,1);assert.equal(f.calls.filter(c=>c.purpose==='group-chat').length,1);
 await f.game.action('companion-group-continue');const second=await until(async()=>(await state(f.game)).groupRuntime.pendingMessage);assert.notEqual(second.id,pending.id);await f.game.action('companion-group-stop');await assert.rejects(()=>f.game.action('companion-group-present',{requestId:second.id}),/失效/);assert.equal(f.events.length,1);
 }finally{f.game.close();}
});
test('Failed group pauses with retained queue, explicit retry and no automatic model resubmit',async()=>{const f=await fixture();try{f.setFail(true);await f.game.action('companion-group-send',{text:'hi'});await until(async()=>(await state(f.game)).groupRuntime.status==='failed');assert.equal((await state(f.game)).groupRuntime.queue.length,5);assert.equal(f.calls.filter(c=>c.purpose==='group-chat').length,1);f.setFail(false);await f.game.action('companion-group-retry');await until(async()=>(await state(f.game)).groupRuntime.pendingMessage);assert.equal(f.calls.filter(c=>c.purpose==='group-chat').length,2);}finally{f.game.close();}});
test('Group exit restores follow mode and original Persona/conversation instead of forcing manual',async()=>{const f=await fixture();try{await f.game.action('companion-group-close');await f.game.action('settings-set',{characterMode:'follow'});const before=await state(f.game);await f.game.action('companion-group-select',{id:f.group.id});await f.game.action('companion-group-close');const after=await state(f.game);assert.equal((await f.game.action('view')).characterMode,'follow');assert.equal(after.activeConversationId,before.activeConversationId);assert.equal(after.activePersonaId,before.activePersonaId);}finally{f.game.close();}});
test('Group photo includes all presented participants beyond four, deduplicates, shares gallery record, and never settles again',async()=>{
 const f=await fixture();try{await f.game.action('companion-group-send',{text:'一起在图书室讨论星空'});for(let n=0;n<5;n++){const pending=await until(async()=>(await state(f.game)).groupRuntime.pendingMessage);await f.game.action('companion-group-present',{requestId:pending.id});if(n<4)await f.game.action('companion-group-continue');}
 const preview=(await f.game.action('companion-group-photo-preview')).photo;assert.equal(preview.characterIds.length,5);const before=f.events.length,photo=(await f.game.action('companion-group-photo')).photo;await f.game.action('companion-group-photo');assert.equal(f.photos.length,1);assert.equal(f.photos[0].characters.length,5);assert.equal(f.events.length,before);assert.equal(f.photos[0].themeBrief.kind,'group');for(const id of preview.characterIds)assert.ok((await f.game.action('cg-gallery',{characterId:id})).items.some(i=>i.id===photo.cgId));await f.game.action('companion-group-end');await assert.rejects(()=>f.game.action('companion-group-photo-preview'),/没有新对话/);
 }finally{f.game.close();}
});

test('Same group photo participants in a different checkbox order cannot enqueue a second drawing',async()=>{
 const f=await fixture();try{
  await f.game.action('companion-group-send',{text:'讨论星空'});
  for(let i=0;i<5;i++){const p=await until(async()=>(await state(f.game)).groupRuntime.pendingMessage);await f.game.action('companion-group-present',{requestId:p.id});if(i<4)await f.game.action('companion-group-continue');}
  const ids=(await f.game.action('companion-group-photo-preview')).photo.characterIds;
  const first=(await f.game.action('companion-group-photo',{characterIds:ids})).photo;
  const second=(await f.game.action('companion-group-photo',{characterIds:[...ids].reverse()})).photo;
  assert.equal(second.cgId,first.cgId);assert.equal(f.photos.length,1);
 }finally{f.game.close();}
});

test('A group model timeout pauses with retry and retains unexecuted members instead of silently stopping',async t=>{
 const f=await fixture(),originalTimer=globalThis.setTimeout;
 t.mock.method(globalThis,'setTimeout',(fn,delay,...args)=>originalTimer(fn,delay===110000?20:delay,...args));
 try{
  f.provider.stream=async function*(options){await new Promise((_,reject)=>{if(options.signal.aborted)reject(options.signal.reason);else options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});};
  await f.game.action('companion-group-send',{text:'timeout fixture'});
  await until(async()=>['failed','idle'].includes((await state(f.game)).groupRuntime.status));
  const s=await state(f.game);assert.equal(s.groupRuntime.status,'failed');assert.equal(s.groupRuntime.canRetry,true);assert.equal(s.groupRuntime.queue.length,5);assert.match(s.groupRuntime.error,/超时/);assert.equal(s.groupMessages.filter(m=>m.role==='assistant').length,0);assert.equal(f.events.length,0);
 }finally{t.mock.restoreAll();f.game.close();}
});
test('Restart discards pending presentation without a reward or automatic model call',async()=>{const f=await fixture();await f.game.action('companion-group-send',{text:'hi'});await until(async()=>(await state(f.game)).groupRuntime.pendingMessage);f.game.close();const before=f.calls.length,g=await createGalgame({dataRoot:f.root,provider:f.provider,model:'fixture',cg:f.cg});try{assert.equal(f.calls.length,before);assert.equal((await state(g)).groupMessages.filter(m=>m.role==='assistant').length,0);assert.equal((await state(g)).relationship.affection,0);}finally{g.close();}});

test('Legacy custom sprites remain discoverable for off-screen members; stage preferences survive export/restore',async()=>{
 const f=await fixture();try{await f.game.action('sprite-upload',{characterId:'claude',dataUrl:'data:image/png;base64,aGVsbG8='});assert.equal((await state(f.game)).characters.find(c=>c.id==='claude').hasCustomSprite,true);
 await f.game.action('companion-group-camera',{cameraMode:'wide'});const data=(await f.game.action('companion-group-export')).data;assert.equal(data.groups[0].cameraMode,'wide');await f.game.action('companion-group-save',{id:f.group.id,name:'changed after export'});await f.game.action('companion-conversation-import',{data});const group=(await state(f.game)).groups.find(g=>g.importedFrom===f.group.id);assert.equal(group.cameraMode,'wide');assert.deepEqual(group.stageOrder,data.groups[0].stageOrder);assert.equal(group.sceneTemplate,'library');assert.equal(group.autoPhoto,false);
 }finally{f.game.close();}
});
test('Dedicated deleted, disabled and non-chat profiles report failure instead of using the global model',()=>{
 const router=Object.create(ModelRouter.prototype);router.state={activeId:'global',profiles:[{id:'global',model:'G'},{id:'disabled',model:'D',enabled:false},{id:'image',model:'I',capabilities:{chat:false}},{id:'glm',name:'GLM API',model:'glm-fixture'}]};router.context={getStore:()=>null};
 assert.equal(router.resolveConnection().model,'G');assert.equal(router.resolveConnection({enabled:true,connectionId:'glm'}).model,'glm-fixture');for(const id of ['missing','disabled','image']){const route=router.resolveConnection({enabled:true,connectionId:id});assert.ok(route.error);assert.notEqual(route.model,'G');}
});
test('Photo reference-capacity failure submits no job; selecting fewer actual participants retries safely',async()=>{
 const f=await fixture();try{await f.game.action('companion-group-send',{text:'hi'});for(let i=0;i<5;i++){const p=await until(async()=>(await state(f.game)).groupRuntime.pendingMessage);await f.game.action('companion-group-present',{requestId:p.id});if(i<4)await f.game.action('companion-group-continue');}
 f.cg.validateReferences=async chars=>{if(chars.length>2)throw Error('参考图上限 2；请选择成员');return[];};await assert.rejects(()=>f.game.action('companion-group-photo'),/参考图上限/);assert.equal(f.photos.length,0);await f.game.action('companion-group-photo',{characterIds:['deepseek','claude']});assert.equal(f.photos.length,1);assert.deepEqual(f.photos[0].characters.map(c=>c.id),['deepseek','claude']);
 }finally{f.game.close();}
});

test('Real CG queue saves a group image across five galleries; failed draw retry reuses theme and trash remains shared',async()=>{
 const root=mkdtempSync(join(tmpdir(),'buddy-group-cg-'));
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=','base64');
 let themes=0,draws=0;
 const cg=new CgService({dataRoot:root,crypto:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},codex:{defaultModel:'fixture',close(){}},
  imageCodec:b=>({png:b,thumbnail:b,width:1,height:1}),
  referenceResolver:async chars=>chars.map(c=>({buffer:png,role:'character',characterId:c.id,name:c.name})),
  themePlanner:{capture:binding=>({enabled:true,binding}),prepare:async brief=>{themes++;assert.equal(brief.kind,'group');return{theme:{name:'图书室的星空',source:'fixture'},prompt:'五位伙伴在图书室讨论星空。'};}},
  fetchImpl:async()=>{draws++;return draws===1?new Response('fixture failed draw',{status:500}):Response.json({data:[{b64_json:png.toString('base64')}]});}});
 await cg.ready;
 const profile=await cg.save({kind:'custom',name:'local mock only',protocol:'openai-images',baseUrl:'http://127.0.0.1:3',model:'fixture',options:{references:true}});
 await cg.activate(profile.id);cg.start();
 const f=await fixture({cg,root});
 try{
  await f.game.action('companion-group-send',{text:'一起在图书室讨论星空'});
  for(let i=0;i<5;i++){const p=await until(async()=>(await state(f.game)).groupRuntime.pendingMessage);await f.game.action('companion-group-present',{requestId:p.id});if(i<4)await f.game.action('companion-group-continue');}
  const initial=(await f.game.action('companion-group-photo')).photo;
  await until(()=>cg.job(initial.cgId)?.status==='failed');
  assert.equal(themes,1);assert.equal(draws,1);
  const retried=await f.game.action('cg-retry',{id:initial.cgId});assert.notEqual(retried.ok,false,retried.error);
  await until(()=>cg.job(retried.cgId)?.status==='ready');
  assert.equal(themes,1);assert.equal(draws,2);assert.equal(f.events.length,5);
  const job=cg.job(retried.cgId);assert.equal(job.references.length,5);assert.equal(job.kind,'group');
  for(const id of ['deepseek','claude','qwen','kimi','grok']){
   const entry=await until(async()=>(await f.game.action('cg-gallery',{characterId:id})).items.find(i=>i.id===retried.cgId&&i.status==='ready'));
   assert.equal(entry.thumbnailRef,job.thumbnailRef);
   assert.equal((await f.game.action('cg-data',{id:entry.id})).dataUrl,cg.readAsset(job.assetRef));
  }
  await f.game.action('cg-trash',{id:retried.cgId});
  for(const id of ['deepseek','claude','qwen','kimi','grok'])assert.ok(!(await f.game.action('cg-gallery',{characterId:id})).items.some(i=>i.id===retried.cgId));
  await f.game.action('cg-restore',{id:retried.cgId});
  assert.ok((await f.game.action('cg-gallery',{characterId:'grok'})).items.some(i=>i.id===retried.cgId));assert.equal(draws,2);assert.equal(themes,1);
 }finally{f.game.close();await cg.close();}
});


test('Group photo reuse is visible, explicit regeneration is idempotent and group gallery survives participants leaving',async()=>{
 const f=await fixture();try{
  await f.game.action('companion-group-send',{text:'合影范围'});
  for(let i=0;i<5;i++){const pending=await until(async()=>(await state(f.game)).groupRuntime.pendingMessage);await f.game.action('companion-group-present',{requestId:pending.id});if(i<4)await f.game.action('companion-group-continue');}
  const first=(await f.game.action('companion-group-photo')).photo;
  const reused=(await f.game.action('companion-group-photo')).photo;
  assert.equal(reused.cgId,first.cgId);assert.equal(reused.reused,true);assert.equal(f.photos.length,1);
  const args={regenerate:true,clientRequestId:'one-explicit-click'};
  const [a,b]=await Promise.all([f.game.action('companion-group-photo',args),f.game.action('companion-group-photo',args)]);
  assert.notEqual(a.photo.cgId,first.cgId);assert.equal(a.photo.cgId,b.photo.cgId);assert.equal(f.photos.length,2);
  await f.game.action('companion-group-member',{characterId:'deepseek',op:'leave'});
  const gallery=(await f.game.action('cg-gallery',{groupId:f.group.id})).items;
  assert.deepEqual(new Set(gallery.map(r=>r.id)),new Set([first.cgId,a.photo.cgId]));
  assert.ok(gallery.every(r=>r.groupId===f.group.id&&r.kind==='group'));
  assert.equal((await f.game.action('cg-gallery',{groupId:'another-group'})).items.length,0);
 }finally{f.game.close();}
});
