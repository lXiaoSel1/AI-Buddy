import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CgService} from '../src/cg-service.mjs';
import {CgThemePlanner} from '../src/cg-theme.mjs';
import {prepareDailyCgTheme,localDailyCgTheme} from '../src/daily-cg-theme.mjs';
import {sanitizeDailyCgBrief,dailyCgRestricted} from '../src/daily-cg-policy.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=','base64');
const scope={characterId:'deepseek',personaId:'p1',lifeId:'life-1',operationId:'op-1'};
const daily={logicalDay:'2026-11-01',slot:'10:00',timeZone:'UTC',triggeredAt:Date.parse('2026-11-01T10:00:00Z'),sourceEventId:'daily:2026-11-01:1000',materialEventIds:['safe-source'],materialSourceHashes:[],fictional:true};
const brief=()=>({kind:'daily',charId:'deepseek',language:'zh-CN',daily,profile:{displayName:'鲸鱼娘',visual:'蓝白女仆装',personality:'UNFILTERED_PROFILE_MARKER 喜欢星空',likes:'星空摄影'},visual:'蓝白女仆装',materials:[{id:'safe-source',text:'她觉得温热茶杯让人放松。',sourceKind:'personal-activity'},{id:'blocked-source',text:'她喜欢星空观测。',sourceKind:'personal-activity'}],preferences:['温热红茶','星空观测'],mood:{overall:{label:'平静',summary:'星空让她心动',eventIds:['private']}},scene:{kind:'uploaded',name:'星空房间',description:'星空穹顶下的休息室',dataUrl:'data:image/png;base64,'+png.toString('base64')},materialRestrictions:{topics:['星空']}});
const until=async predicate=>{for(let i=0;i<500;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('CG boundary fixture timeout');};
async function fixture(t,{referenceResolver,router={enabled:false,selected:()=>null}}={}){
 const root=mkdtempSync(join(tmpdir(),'daily-boundary-')),calls=[],references=[];
 const cg=new CgService({dataRoot:root,codex:{defaultModel:'fixture',close(){}},crypto:{encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()},captureRewardScope:()=>scope,imageCodec:bytes=>({png:bytes,thumbnail:bytes,width:1,height:1}),themePlanner:new CgThemePlanner(router),referenceResolver:async(characters,scene)=>{references.push({characters:structuredClone(characters),scene:structuredClone(scene)});return referenceResolver?referenceResolver(characters,scene):[];},fetchImpl:async(_url,request)=>{calls.push(JSON.parse(request.body));return Response.json({data:[{b64_json:png.toString('base64')}]});}});
 await cg.ready;const profile=await cg.save({kind:'custom',name:'fixture',baseUrl:'http://127.0.0.1:3',protocol:'openai-images',model:'image',options:{references:true}});await cg.activate(profile.id);await cg.setEnabled(true);
 t.after(async()=>{await cg.close();rmSync(root,{recursive:true,force:true});});return {cg,calls,references};
}
const enqueue=(cg,b)=>cg.enqueue({id:'boundary',sourceEventId:daily.sourceEventId,kind:'daily',daily,themeBrief:b,characters:[{id:'deepseek',name:'鲸鱼娘',identity:'蓝白女仆装',profile:b.profile}],scene:b.scene,rewardScope:scope,automatic:true});
test('daily boundary keeps only identity fields and never recovers preferences or mood reasons from a raw card',()=>{
 const clean=sanitizeDailyCgBrief(brief());assert.deepEqual(Object.keys(clean.profile).sort(),['displayName','visual']);assert.deepEqual(clean.preferences,['温热红茶']);assert.deepEqual(clean.mood,{overall:{label:'平静'}});assert.equal(clean.scene.kind,'imagined');assert.equal(clean.scene.dataUrl,undefined);assert.equal(clean.materials.length,1);assert.equal(dailyCgRestricted('山间星空布景',{topics:['星空观测']}),true);
});
test('daily online request omits restriction topics, raw profile, blocked history and generated blocked theme',async()=>{
 const b=brief(),requests=[],router={enabled:true,async *stream(request){requests.push(request);yield {type:'text-delta',text:JSON.stringify({...localDailyCgTheme(b),title:'星空的夜晚',scene:'星空穹顶'})};}};
 const result=await prepareDailyCgTheme(router,b,[{title:'星空旧主题',scene:'星空',action:'旧动作',composition:'旧构图'}],{enabled:true,language:'zh-CN',profile:{id:'chat',model:'chosen'}});
 assert.equal(requests.length,1);assert.doesNotMatch(JSON.stringify(requests[0]),/星空|UNFILTERED_PROFILE_MARKER|materialRestrictions|private/);assert.equal(result.theme.source,'local');assert.doesNotMatch(result.prompt,/星空|UNFILTERED_PROFILE_MARKER/);
});
test('the actual daily drawing request cannot mention banned topics from scene, card or preferences',async t=>{
 const {cg,calls,references}=await fixture(t),b=brief();await enqueue(cg,b);cg.start();await until(()=>['ready','failed'].includes(cg.job('boundary').status));assert.equal(cg.job('boundary').status,'ready',cg.job('boundary').error);assert.equal(calls.length,1);assert.doesNotMatch(calls[0].prompt,/星空|UNFILTERED_PROFILE_MARKER|materialRestrictions/);assert.equal(references[0].scene.kind,'imagined');assert.equal(references[0].scene.dataUrl,undefined);assert.deepEqual(Object.keys(references[0].characters[0].profile).sort(),['displayName','visual']);
});
test('no-material fallback sends only filtered preferences and never raw profile likes to drawing',async t=>{
 const {cg,calls}=await fixture(t),b=brief();b.materials=[];await enqueue(cg,b);cg.start();await until(()=>['ready','failed'].includes(cg.job('boundary').status));assert.equal(cg.job('boundary').status,'ready',cg.job('boundary').error);assert.equal(cg.job('boundary').theme.inspiration,'known-preferences-and-mood');assert.match(calls[0].prompt,/温热红茶/);assert.doesNotMatch(calls[0].prompt,/星空|UNFILTERED_PROFILE_MARKER/);
});
test('a banned visual identity refuses the slot before references or either model, preserving the original appearance',async t=>{
 const {cg,calls,references}=await fixture(t),b=brief();b.visual='星空花纹的蓝白女仆装';const original=structuredClone(b);await assert.rejects(enqueue(cg,b),{code:'DAILY_CG_IDENTITY_RESTRICTED'});assert.deepEqual(b,original);assert.equal(references.length,0);assert.equal(calls.length,0);assert.equal(cg.jobs.length,0);
});
test('a blocked reference label is caught before persisting or sending the final drawing prompt',async t=>{
 const {cg,calls}=await fixture(t,{referenceResolver:async()=>[{buffer:png,role:'character',characterId:'deepseek',name:'星空女仆'}]}),b=brief();await enqueue(cg,b);cg.start();await until(()=>cg.job('boundary').status==='failed');assert.equal(calls.length,0);assert.doesNotMatch(cg.job('boundary').prompt,/星空/);assert.match(cg.job('boundary').error,/素材限制/);
});
