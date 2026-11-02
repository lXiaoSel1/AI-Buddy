import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CgService} from '../src/cg-service.mjs';
import {CgThemePlanner} from '../src/cg-theme.mjs';
import {CG_POV_RULES,DAILY_CG_COMPOSITION_POLICY} from '../src/cg-composition.mjs';
import {createSnapshotStorage,readJson} from '../src/storage.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=','base64');
const scope={characterId:'deepseek',personaId:'p1',lifeId:'life-1',operationId:'op-1'};
const daily={logicalDay:'2026-11-01',slot:'10:00',timeZone:'UTC',triggeredAt:Date.parse('2026-11-01T10:00:00Z'),sourceEventId:'daily:2026-11-01:1000',materialEventIds:['material-1'],materialSourceHashes:[{eventId:'material-1',sha256:'a'.repeat(64)}],fictional:true};
const brief=()=>({kind:'daily',charId:'deepseek',profile:{displayName:'DeepSeek'},visual:'已确认的鲸鱼娘',daily,materials:[{id:'material-1',text:'她看过一段宁静花园视频。',sourceHash:'a'.repeat(64),sourceKind:'personal-activity'}],preferences:['看书']});
const until=async predicate=>{for(let i=0;i<500;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('CG fixture timeout');};
async function fixture(t,options={}){
 const root=mkdtempSync(join(tmpdir(),'daily-cg-service-')),calls=[],facts=[];
 const cg=new CgService({dataRoot:root,codex:{defaultModel:'fixture',close(){}},crypto:{encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()},captureRewardScope:()=>({characterId:'claude',personaId:'other',lifeId:'other-life',operationId:'other-op'}),onRewardFact:fact=>{facts.push(fact);return {accepted:true};},imageCodec:bytes=>({png:bytes,thumbnail:bytes,width:1,height:1}),themePlanner:new CgThemePlanner({enabled:false,selected:()=>null}),fetchImpl:async(_url,request)=>{calls.push(JSON.parse(request.body));return Response.json({data:[{b64_json:png.toString('base64')}]});},...options});
 await cg.ready;const saved=await cg.save({kind:'custom',name:'CG selected',baseUrl:'http://127.0.0.1:3',protocol:'openai-images',model:'image-chosen',options:{references:false}});await cg.activate(saved.id);await cg.setEnabled(true);
 t.after(async()=>{await cg.close();rmSync(root,{recursive:true,force:true});});return {cg,calls,facts,root};
}
const enqueue=cg=>cg.enqueue({id:'daily-fixture',sourceEventId:daily.sourceEventId,kind:'daily',automatic:true,themeBrief:brief(),daily,compositionPolicy:DAILY_CG_COMPOSITION_POLICY,characters:[{id:'deepseek'}],rewardScope:scope});
test('daily CG uses chosen image profile, independent composition, frozen reward scope and durable metadata',async t=>{
 const {cg,calls,facts,root}=await fixture(t);await enqueue(cg);cg.start();await until(()=>cg.job('daily-fixture').status==='ready');
 assert.equal(calls.length,1);assert.equal(calls[0].model,'image-chosen');assert.doesNotMatch(calls[0].prompt,/摄像机就是画外男生的双眼/);assert.match(calls[0].prompt,/日常 CG 构图要求/);
 const job=cg.job('daily-fixture');assert.deepEqual(job.rewardScope,scope);assert.deepEqual(cg.publicJob(job).daily,daily);assert.equal(job.theme.fictional,true);assert.equal(job.compositionPolicy,DAILY_CG_COMPOSITION_POLICY);assert.ok(facts.length);assert.deepEqual(facts[0].scope,scope);
 const stored=await readJson(createSnapshotStorage(join(root,'cg-jobs.json')));assert.deepEqual(stored.jobs[0].daily,daily);assert.equal(cg.jobs.length,1);
});
test('a frozen trigger profile survives a later global selection before enqueue',async t=>{
 const {cg,calls}=await fixture(t),profile=structuredClone(cg.selected());const second=await cg.save({kind:'custom',name:'later',baseUrl:'http://127.0.0.1:3',protocol:'openai-images',model:'later-image',options:{references:false}});await cg.activate(second.id);
 await cg.enqueue({id:'captured',sourceEventId:'captured',kind:'daily',daily,themeBrief:brief(),profile,characters:[{id:'deepseek'}],rewardScope:scope});cg.start();await until(()=>cg.job('captured').status==='ready');assert.equal(calls[0].model,'image-chosen');
});
test('daily retry keeps original metadata, policy, material and reward scope while old image is unchanged',async t=>{
 const {cg,calls}=await fixture(t);await enqueue(cg);cg.start();await until(()=>cg.job('daily-fixture').status==='ready');const original=structuredClone(cg.job('daily-fixture'));
 await cg.enqueue({id:'manual-daily-retry',sourceEventId:'manual-daily-retry',kind:'daily',retryOf:original.id,daily:{...daily,logicalDay:'2026-11-02'},rewardScope:{...scope,personaId:'other'}});await until(()=>cg.job('manual-daily-retry').status==='ready');const retry=cg.job('manual-daily-retry');assert.deepEqual(retry.daily,original.daily);assert.deepEqual(retry.rewardScope,original.rewardScope);assert.equal(retry.compositionPolicy,DAILY_CG_COMPOSITION_POLICY);assert.equal(retry.prompt,original.prompt);assert.deepEqual(cg.job(original.id),original);assert.equal(calls.length,2);
});
test('daily history never passes other Persona, life or legacy level themes to the planner',async t=>{
 let history;const planner={capture:()=>null,prepare:async(_brief,old)=>{history=old;return {theme:{title:'daily',fictional:true},prompt:'solo character'};}};const {cg}=await fixture(t,{themePlanner:planner});
 for(const [id,kind,rewardScope]of [['own','daily',scope],['other-persona','daily',{...scope,personaId:'p2'}],['other-life','daily',{...scope,lifeId:'life-2'}],['level','level',scope]])cg.jobs.push({id,sourceEventId:id,kind,rewardScope,daily,profile:cg.selected(),status:'failed',references:[],at:1,themeBrief:{charId:'deepseek'},theme:{title:id}});
 await enqueue(cg);cg.start();await until(()=>cg.job('daily-fixture').status==='ready');assert.deepEqual(history.map(row=>row.title),['own']);
});
test('old upgrade and theater auto CG remain alongside daily tasks and retain original POV',async t=>{
 const {cg,calls}=await fixture(t);await enqueue(cg);for(const kind of ['level','skit'])await cg.enqueue({id:kind,sourceEventId:kind,kind,automatic:true,prompt:'existing gift',rewardScope:scope});cg.start();await until(()=>cg.jobs.every(job=>job.status==='ready'));assert.equal(calls.length,3);assert.ok(cg.job('level').prompt.includes(CG_POV_RULES));assert.ok(cg.job('skit').prompt.includes(CG_POV_RULES));assert.equal(cg.job('daily-fixture').theme.fictional,true);
});
test('disabled auto CG does no daily preparation and duplicate source event does not charge twice',async t=>{
 const {cg,calls}=await fixture(t);await cg.setEnabled(false);assert.equal((await enqueue(cg)).skipped,true);assert.equal(cg.jobs.length,0);await cg.setEnabled(true);await enqueue(cg);await enqueue(cg);cg.start();await until(()=>cg.job('daily-fixture').status==='ready');assert.equal(cg.jobs.length,1);assert.equal(calls.length,1);
});
test('a stale daily life is rejected before reference preparation, and queued life changes cannot submit',async t=>{
 let valid=true,references=0;const {cg,calls}=await fixture(t,{validateDailyScope:()=>valid,referenceResolver:async()=>{references++;return [];}});valid=false;await assert.rejects(enqueue(cg),{code:'DAILY_CG_SCOPE_STALE'});assert.equal(references,0);assert.equal(cg.jobs.length,0);
 valid=true;await enqueue(cg);valid=false;cg.start();await until(()=>cg.job('daily-fixture').status==='failed');assert.equal(calls.length,0);assert.match(cg.job('daily-fixture').error,/人生|范围/);
});
test('daily connection views and direct image admission cannot expose another Persona while internal jobs remain intact',async t=>{
 let visible=true;const {cg}=await fixture(t,{canViewDailyScope:()=>visible});await enqueue(cg);assert.equal(cg.view().jobs.length,1);assert.equal(cg.assertReadableJob('daily-fixture').kind,'daily');visible=false;assert.equal(cg.view().jobs.length,0);assert.throws(()=>cg.assertReadableJob('daily-fixture'),{code:'DAILY_CG_SCOPE_DENIED'});await assert.rejects(cg.resume('daily-fixture'),{code:'DAILY_CG_SCOPE_DENIED'});assert.equal(cg.job('daily-fixture').kind,'daily');
});
test('legacy planner history excludes daily private inspiration while keeping legacy themes',async t=>{
 let seen;const {cg}=await fixture(t,{themePlanner:{capture:()=>null,prepare:async(_brief,history)=>{seen=history;return {theme:{title:'level'},prompt:'legacy level'};}}});
 for(const [id,kind]of [['private-daily','daily'],['old-level','level']])cg.jobs.push({id,sourceEventId:id,kind,rewardScope:scope,daily,profile:cg.selected(),status:'failed',references:[],at:1,themeBrief:{charId:'deepseek'},theme:{title:id,compositionPolicy:kind==='daily'?'daily-v1':undefined}});
 await cg.enqueue({id:'new-level',sourceEventId:'new-level',kind:'level',themeBrief:{charId:'deepseek',history:[{title:'brief-private',compositionPolicy:'daily-v1'}]},rewardScope:scope});cg.start();await until(()=>cg.job('new-level').status==='ready');assert.deepEqual(seen.map(row=>row.title),['old-level']);
});
