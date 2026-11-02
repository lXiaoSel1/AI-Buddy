import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {apply} from '../src/adapted/game-core.ts';
import {restrictedFileService,createSnapshotStorage,readJson} from '../src/storage.mjs';
import {writePortableImages} from '../src/companion-media.mjs';
const daily={logicalDay:'2026-11-01',slot:'10:00',timeZone:'UTC',triggeredAt:Date.parse('2026-11-01T10:00:00Z'),sourceEventId:'daily:2026-11-01:1000',materialEventIds:['source-1'],materialSourceHashes:[{eventId:'source-1',sha256:'a'.repeat(64)}],fictional:true};
const scope={characterId:'deepseek',personaId:'p1',lifeId:'life-1',operationId:'op-1'};
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=';
const until=async fn=>{for(let i=0;i<300;i++){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Engine fixture timeout');};
async function fixture(t,{root=mkdtempSync(join(tmpdir(),'daily-cg-engine-')),fail=false}={}){
 const workspace=join(root,'workspace');mkdirSync(workspace,{recursive:true});const jobs=[],effects=[],listeners=new Set(),globalPath=join(root,'galgame','storages','dsh-whale-galgame','global.json');let referenceChecks=0,currentPersona='p1',currentLife={lifeId:'life-1',operationId:'op-1'};
 const profile={id:'cg-trigger',name:'CG trigger',kind:'custom',model:'image-trigger',keyCiphertext:'PRIVATE-CIPHER'},cg={enabled:true,available:()=>true,selected:()=>profile,job:id=>jobs.find(row=>row.id===id),readAsset:()=>image,trashJob:async()=>{},restoreJob:async()=>{},themePlanner:{capture:()=>({enabled:false,profile:null,language:'zh-CN'})},subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
  async enqueue(job){
   const persisted=await readJson(createSnapshotStorage(globalPath)),found=Object.values(persisted.characters).flatMap(row=>row.cgs??[]).find(row=>row.id===job.id);
   assert.ok(found,'gallery must exist on disk before enqueue');jobs.push(structuredClone(job));return {id:job.id,status:'queued'};
  },
 };
 const header={id:'fixture',cwd:workspace,events:[]},services={fs:restrictedFileService(workspace),sandboxPolicy:{resolve:()=>({workspaceRoot:workspace})},sessions:{list:()=>[header]},workspaceRegistry:{list:()=>[{path:workspace}]},agentDefaultModel:{currentSelection:()=>({provider:'fixture',model:'fixture'})},sessionQuery:{listSessions:async()=>[header],listEvents:async()=>[]}};
 const ctx={cg,llm:{enabled:false,currentSelection:()=>({provider:'fixture',model:'fixture'})},language:()=> 'zh-CN',companionPersonaId:()=>currentPersona,writePortableImages:files=>writePortableImages(root,bytes=>({png:bytes,thumbnail:bytes}),files),dshHomePath:(...parts)=>join(root,'galgame',...parts),inject:(_keys,fn)=>fn(services),on(){},emit(){},effect(fn){const cleanup=fn();if(typeof cleanup==='function')effects.push(cleanup);},assertCompanionLife(id,token){assert.equal(id,'deepseek');assert.equal(token.lifeId,currentLife.lifeId);assert.equal(token.operationId,currentLife.operationId);referenceChecks++;},companionLifeIds:ids=>Object.fromEntries(ids.map(id=>[id,currentLife.lifeId])),companionCgVisible:()=>true};
 const engine=apply(ctx,{singleChatSelection:true,chatModel:'fixture'});await engine.handleAction('settings-get',{});
 t.after(async()=>{await engine.flushWorkLedger();for(const cleanup of effects)cleanup();});
 const notify=(id,status,extra={})=>{for(const listener of listeners)listener({id,status,error:status==='failed'?'fixture failure':null,...(status==='ready'?{dataUrl:image,thumbnailRef:'cg-assets/fixture/thumbnail.png'}:{}),...extra});};
 const persisted=()=>readJson(createSnapshotStorage(globalPath));
 const publish=async(id,status,extra={})=>{notify(id,status,extra);await until(async()=>Object.values((await persisted()).characters).flatMap(row=>row.cgs??[]).find(row=>row.id===id)?.status===status);};
 const payload=()=>({scope:structuredClone(scope),sourceEventId:daily.sourceEventId,daily:structuredClone(daily),profile:structuredClone(profile),materials:{events:[{id:'source-1',text:'当日视频里的一座宁静花园。',sourceHash:'a'.repeat(64),sourceKind:'personal-activity'}]},mood:{overall:{label:'平静'}},preferences:['读书'],language:'zh-CN'});
 return {root,engine,jobs,cg,payload,publish,notify,persisted,referenceChecks:()=>referenceChecks,persona:value=>{currentPersona=value;},life:value=>{currentLife=value;}};
}
test('daily engine creates gallery first, captures identity/scope/profile and does not alter the old level slot',async t=>{
 const f=await fixture(t),payload=f.payload();const result=await f.engine.handleAction('cg-daily',payload);assert.equal(result.ok,true,result.error);assert.equal(f.jobs.length,1);const job=f.jobs[0];assert.equal(job.kind,'daily');assert.equal(job.automatic,true);assert.deepEqual(job.rewardScope,scope);assert.equal(job.profile.model,'image-trigger');assert.equal(job.characters.length,1);assert.equal(job.characters[0].id,'deepseek');assert.equal(job.themeBrief.materials[0].id,'source-1');
 const duplicate=await f.engine.handleAction('cg-daily',f.payload());assert.equal(duplicate.cgId,result.cgId);assert.equal(f.jobs.length,1);
 const gallery=(await f.engine.handleAction('cg-gallery',{characterId:'deepseek'})).items;assert.equal(gallery[0].kind,'daily');assert.deepEqual(gallery[0].daily,daily);assert.doesNotMatch(JSON.stringify(gallery),/PRIVATE-CIPHER/);
 const level=await f.engine.handleAction('cg-generate',{characterId:'deepseek',personaId:'p1'});assert.notEqual(level.cgId,result.cgId);await until(()=>f.jobs.length===2);assert.equal(f.jobs[1].kind,'level');
});
test('daily retry preserves its original source, policy, materials and owner while producing a manual job',async t=>{
 const f=await fixture(t),result=await f.engine.handleAction('cg-daily',f.payload());await f.publish(result.cgId,'failed');const retry=await f.engine.handleAction('cg-retry',{id:result.cgId});assert.equal(retry.ok,true);assert.notEqual(retry.cgId,result.cgId);assert.equal(f.jobs.length,2);
 const job=f.jobs[1];assert.equal(job.kind,'daily');assert.equal(job.automatic,false);assert.deepEqual(job.daily,daily);assert.deepEqual(job.rewardScope,scope);assert.equal(job.retryOf,result.cgId);assert.equal(job.themeBrief.materials[0].id,'source-1');assert.equal(job.compositionPolicy,'daily-v1');
});
test('daily metadata survives restart and portable export/import without credentials or auto requests',async t=>{
 const f=await fixture(t),result=await f.engine.handleAction('cg-daily',f.payload());await f.publish(result.cgId,'failed');
 const exported=(await f.engine.handleAction('companion-media-export',{all:true})).media;assert.deepEqual(exported.cgs[0].daily,daily);assert.deepEqual(exported.cgs[0].rewardScope,scope);assert.deepEqual(exported.cgs[0].lifeIds,{deepseek:scope.lifeId});assert.equal(exported.cgs[0].personaId,scope.personaId);assert.equal(exported.cgs[0].compositionPolicy,'daily-v1');assert.equal(exported.cgs[0].themeBrief.materials[0].id,'source-1');assert.doesNotMatch(JSON.stringify(exported),/PRIVATE-CIPHER/);
 const reopened=await fixture(t,{root:f.root});const row=(await reopened.engine.handleAction('cg-gallery',{characterId:'deepseek'})).items.find(row=>row.id===result.cgId);assert.deepEqual(row.daily,daily);assert.equal(reopened.jobs.length,0);
 const target=await fixture(t);const imported=await target.engine.handleAction('companion-media-import',{media:exported,characterIds:['deepseek']});assert.equal(imported.ok,true);const item=(await target.engine.handleAction('cg-gallery',{characterId:'deepseek'})).items[0];assert.deepEqual(item.daily,daily);assert.equal(item.kind,'daily');assert.equal(target.jobs.length,0);
 const persisted=Object.values((await target.persisted()).characters).flatMap(character=>character.cgs??[]).find(cg=>cg.id===item.id);assert.deepEqual(persisted.rewardScope,scope);assert.deepEqual(persisted.lifeIds,{deepseek:scope.lifeId});assert.equal(persisted.personaId,scope.personaId);assert.equal(persisted.compositionPolicy,'daily-v1');assert.deepEqual(persisted.themeBrief,exported.cgs[0].themeBrief);
});
test('disabled daily entry performs no queue work while original manual CG generation remains available',async t=>{
 const f=await fixture(t);f.cg.enabled=false;assert.equal((await f.engine.handleAction('cg-daily',f.payload())).skipped,true);assert.equal(f.jobs.length,0);assert.equal((await f.engine.handleAction('cg-gallery',{characterId:'deepseek'})).items.length,0);
 await f.engine.handleAction('cg-generate',{characterId:'deepseek',personaId:'p1'});await until(()=>f.jobs.length===1);assert.equal(f.jobs[0].kind,'level');
});
test('daily gallery, images, retry and mutations deny another Persona before exposing content or queueing',async t=>{
 const f=await fixture(t),created=await f.engine.handleAction('cg-daily',f.payload());await f.publish(created.cgId,'ready');assert.equal((await f.engine.handleAction('cg-data',{id:created.cgId})).ok,true);await f.engine.handleAction('cg-save-bg',{id:created.cgId});assert.equal((await f.engine.handleAction('bg-data',{characterId:'deepseek'})).dataUrl,image);
 f.persona('p2');assert.equal((await f.engine.handleAction('cg-gallery',{characterId:'deepseek'})).items.length,0);assert.equal((await f.engine.handleAction('view',{})).galleryCount,0);
 for(const action of ['cg-data','cg-thumbnail','cg-retry','cg-trash','cg-restore','cg-ack','cg-save-bg'])assert.equal((await f.engine.handleAction(action,{id:created.cgId})).code,'DAILY_CG_SCOPE_DENIED',action);
 assert.equal((await f.engine.handleAction('bg-data',{characterId:'deepseek'})).dataUrl,null);assert.equal(f.jobs.length,1);f.persona('p1');assert.equal((await f.engine.handleAction('cg-thumbnail',{id:created.cgId})).ok,true);
});
test('daily access checks both life identity and operation, including portable import before any record is written',async t=>{
 const f=await fixture(t),created=await f.engine.handleAction('cg-daily',f.payload());await f.publish(created.cgId,'failed');const bundle=(await f.engine.handleAction('companion-media-export',{all:true})).media;
 for(const value of [{lifeId:'life-2',operationId:'op-1'},{lifeId:'life-1',operationId:'op-2'}]){f.life(value);assert.equal((await f.engine.handleAction('cg-gallery',{characterId:'deepseek'})).items.length,0);assert.equal((await f.engine.handleAction('cg-retry',{id:created.cgId})).code,'DAILY_CG_SCOPE_DENIED');}
 const target=await fixture(t);target.persona('p2');await assert.rejects(target.engine.handleAction('companion-media-import',{media:bundle,characterIds:['deepseek']}),{code:'DAILY_CG_SCOPE_DENIED'});target.persona('p1');assert.equal((await target.engine.handleAction('cg-gallery',{characterId:'deepseek'})).items.length,0);assert.equal(target.jobs.length,0);
});
test('legacy CG subscribe persists a terminal update outside any active workspace context',async t=>{
 const f=await fixture(t),created=await f.engine.handleAction('cg-generate',{characterId:'deepseek',personaId:'p1'});await until(()=>f.jobs.length===1);f.notify(created.cgId,'failed');
 await until(async()=>(await f.engine.handleAction('cg-gallery',{characterId:'deepseek'})).items.find(row=>row.id===created.cgId)?.status==='failed');await new Promise(resolve=>setImmediate(resolve));
 const row=Object.values((await f.persisted()).characters).flatMap(character=>character.cgs??[]).find(row=>row.id===created.cgId);assert.equal(row.status,'failed','a rendered terminal update must be committed before a later flush or shutdown');
});
test('legacy level inspiration cannot import private daily themes from another Persona',async t=>{
 const f=await fixture(t),created=await f.engine.handleAction('cg-daily',f.payload());await f.publish(created.cgId,'failed',{prompt:'PRIVATE-DAILY-MATERIAL',theme:{title:'PRIVATE-DAILY-MATERIAL',scene:'PRIVATE-SCENE',compositionPolicy:'daily-v1'}});f.persona('p2');await f.engine.handleAction('cg-generate',{characterId:'deepseek',personaId:'p2'});await until(()=>f.jobs.length===2);assert.doesNotMatch(JSON.stringify(f.jobs[1].themeBrief.history),/PRIVATE-DAILY-MATERIAL|PRIVATE-SCENE/);
});
test('daily engine uses an identity whitelist and drops restricted scene inspiration before enqueue',async t=>{
 const f=await fixture(t),payload=f.payload();payload.characterProfile={displayName:'鲸鱼娘',visual:'蓝白女仆装',persona:'UNFILTERED_CARD 星空观测',likes:'星空'};payload.characters=[{id:'deepseek',name:'鲸鱼娘',identity:'蓝白女仆装',profile:payload.characterProfile}];payload.scene={kind:'uploaded',description:'星空穹顶',name:'星空',dataUrl:image};payload.preferences=['热茶','星空'];payload.materialRestrictions={topics:['星空']};
 assert.equal((await f.engine.handleAction('cg-daily',payload)).ok,true);const job=f.jobs[0];assert.deepEqual(Object.keys(job.themeBrief.profile).sort(),['displayName','visual']);assert.deepEqual(Object.keys(job.characters[0].profile).sort(),['displayName','visual']);assert.equal(job.scene.kind,'imagined');assert.equal(job.scene.dataUrl,undefined);assert.deepEqual(job.themeBrief.preferences,['热茶']);assert.doesNotMatch(JSON.stringify(job.characters),/星空|UNFILTERED_CARD/);
});
test('daily engine refuses a restricted identity without changing its appearance or creating a gallery job',async t=>{
 const f=await fixture(t),payload=f.payload();payload.visual='星空花纹外衣';payload.materialRestrictions={topics:['星空']};await assert.rejects(f.engine.handleAction('cg-daily',payload),{code:'DAILY_CG_IDENTITY_RESTRICTED'});assert.equal(f.jobs.length,0);assert.equal((await f.engine.handleAction('cg-gallery',{characterId:'deepseek'})).items.length,0);assert.equal(payload.visual,'星空花纹外衣');
});

test('daily theme profile frozen at admission survives a queued engine action and later connection edit',async t=>{
 const f=await fixture(t);let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r),original=f.cg.enqueue;f.cg.enqueue=async job=>{const result=await original(job);if(f.jobs.length===1){entered();await gate;}return result;};
 const first=f.engine.handleAction('cg-daily',f.payload());await started;const second=f.payload();second.daily={...second.daily,slot:'22:00',sourceEventId:'daily:2026-11-01:2200'};second.sourceEventId=second.daily.sourceEventId;second.themeConnection={enabled:true,profile:{id:'theme',model:'theme-at-trigger'},language:'zh-CN'};const pending=f.engine.handleAction('cg-daily',second);f.cg.themePlanner.capture=()=>({enabled:true,profile:{id:'theme',model:'later-theme'},language:'zh-CN'});release();await first;await pending;assert.equal(f.jobs[1].themeConnection.profile.model,'theme-at-trigger');
});
