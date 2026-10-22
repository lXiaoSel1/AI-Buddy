import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,mkdirSync,writeFileSync,readFileSync,existsSync,renameSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {CgService} from '../src/cg-service.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=','base64');
const hash=b=>createHash('sha256').update(b).digest('hex');
const temp=()=>mkdtempSync(join(tmpdir(),'buddy-portable-job-'));
const until=async fn=>{for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('CG fixture timeout');};
async function service(root=temp(),options={}){
 const calls=[];
 const cg=new CgService({dataRoot:root,crypto:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},codex:{defaultModel:'fixture',close(){}},imageCodec:b=>({png:b,thumbnail:b,width:1,height:1}),referenceResolver:async()=>[{buffer:png,role:'character'}],fetchImpl:async(url,opts)=>{calls.push({url:String(url),method:opts.method});return Response.json({data:[{b64_json:png.toString('base64')}]});},...options});
 await cg.ready;if(!cg.selected())await cg.activate((await cg.save({kind:'custom',name:'mock',protocol:'openai-images',baseUrl:'http://127.0.0.1:3',model:'fixture',options:{references:true}})).id);
 return {cg,calls};
}
async function queued(root=temp(),options={}){const f=await service(root,options);await f.cg.enqueue({id:'portable',sourceEventId:'portable',prompt:'已保存的提示词'});return f;}
async function copiedSource({keepOld=true,legacy=false}={}){
 const root=temp(),source=join(root,'source'),target=join(root,'target'),f=await queued(source);
 if(legacy){delete f.cg.job('portable').directoryRef;delete f.cg.job('portable').references[0].assetRef;await f.cg.persistJobs();}
 await f.cg.close();cpSync(source,target,{recursive:true});if(!keepOld)renameSync(source,join(root,'source-unavailable'));
 return {source,target};
}

test('new CG jobs persist portable directory and reference identities with sha256',async()=>{
 const {cg}=await queued();try{const j=cg.job('portable');assert.equal(j.directoryRef,'cg-assets/portable');assert.equal(j.references[0].assetRef,'cg-assets/portable/reference-0.png');assert.equal(j.references[0].sha256,hash(png));}finally{await cg.close();}
});
test('a copied job reads the current root, ignoring an existing poisoned source root',async()=>{
 const {source,target}=await copiedSource();writeFileSync(join(source,'cg-assets/portable/reference-0.png'),'OLD-ROOT-POISON');
 const {cg,calls}=await service(target);try{cg.start();await until(()=>['ready','failed'].includes(cg.job('portable').status));assert.equal(cg.job('portable').status,'ready',cg.job('portable').error);assert.equal(calls.length,1);assert.equal(cg.job('portable').directory,join(target,'cg-assets/portable'));assert.equal(cg.job('portable').references[0].path,join(target,'cg-assets/portable/reference-0.png'));assert.deepEqual(readFileSync(join(target,'cg-assets/portable/image.png')),png);assert.equal(existsSync(join(source,'cg-assets/portable/image.png')),false);}finally{await cg.close();}
});
test('legacy absolute paths migrate by job and reference identity with the old root unavailable',async()=>{
 const {target}=await copiedSource({keepOld:false,legacy:true});const {cg}=await service(target);try{cg.start();await until(()=>['ready','failed'].includes(cg.job('portable').status));assert.equal(cg.job('portable').status,'ready',cg.job('portable').error);assert.equal(cg.job('portable').directoryRef,'cg-assets/portable');assert.equal(cg.job('portable').references[0].assetRef,'cg-assets/portable/reference-0.png');}finally{await cg.close();}
});
for(const defect of ['missing','hash','reference-escape','directory-escape','directory-link','reference-link'])test('CG '+defect+' fails before theme planning and any network submission',async()=>{
 let plans=0;const {cg,calls}=await service(temp(),{themePlanner:{capture:()=>null,prepare:async()=>{plans++;return {theme:{},prompt:'planned'};}}});try{
  await cg.enqueue({id:'portable',sourceEventId:'portable',themeBrief:{charId:'deepseek'}});const j=cg.job('portable'),path=j.references[0].path;
  if(defect==='missing')renameSync(path,path+'.unavailable');
  if(defect==='hash')writeFileSync(path,'corrupted');
  if(defect==='reference-escape')j.references[0].assetRef='../outside.png';
  if(defect==='directory-escape')j.directoryRef='../outside';
  if(defect==='directory-link'){const outside=temp();cpSync(j.directory,outside,{recursive:true});renameSync(j.directory,j.directory+'.original');symlinkSync(outside,j.directory,'junction');}
  if(defect==='reference-link'){const outside=temp();writeFileSync(join(outside,'reference.png'),png);renameSync(path,path+'.original');symlinkSync(outside,path,'junction');}
  cg.start();await until(()=>['ready','failed'].includes(j.status));assert.equal(j.status,'failed');assert.equal(plans,0);assert.equal(calls.length,0);assert.equal(j.submittedAt,undefined);
 }finally{await cg.close();}
});
test('references changed while preparing a theme fail revalidation before onSubmit',async()=>{
 let cg,plans=0;const f=await service(temp(),{themePlanner:{capture:()=>null,prepare:async()=>{plans++;writeFileSync(cg.job('portable').references[0].path,'changed during planner');return {theme:{},prompt:'prepared'};}}});cg=f.cg;
 try{await cg.enqueue({id:'portable',sourceEventId:'portable',themeBrief:{charId:'deepseek'}});cg.start();await until(()=>['ready','failed'].includes(cg.job('portable').status));assert.equal(cg.job('portable').status,'failed');assert.equal(plans,1);assert.equal(f.calls.length,0);assert.equal(cg.job('portable').submittedAt,undefined);}finally{await cg.close();}
});
test('imported unsubmitted jobs remain paused after restart until explicit resume',async()=>{
 const root=temp(),f=await queued(root);Object.assign(f.cg.job('portable'),{status:'paused',pausedFrom:'queued',pauseReason:'import',pausedAt:Date.now()});await f.cg.persistJobs();await f.cg.close();const {cg,calls}=await service(root);
 try{cg.start();await new Promise(r=>setTimeout(r,40));assert.equal(calls.length,0);assert.equal(cg.publicJob(cg.job('portable')).pausedFrom,'queued');await cg.resume('portable');await until(()=>cg.job('portable').status==='ready');assert.equal(calls.length,1);}finally{await cg.close();}
});
test('manual resume of an imported automatic gift does not enable the automatic queue',async()=>{
 const {cg,calls}=await queued();try{const j=cg.job('portable');Object.assign(j,{status:'paused',pausedFrom:'queued',pauseReason:'import',automatic:true});assert.equal(cg.enabled,false);cg.start();await cg.resume(j.id);await until(()=>j.status==='ready');assert.equal(calls.length,1);assert.equal(cg.enabled,false);assert.equal(j.originallyAutomatic,true);assert.equal(j.resumedManually,true);}finally{await cg.close();}
});
test('queued work with an uncertain recorded submission cannot silently resubmit',async()=>{
 const {cg,calls}=await queued();try{cg.job('portable').submittedAt=1;cg.start();await until(()=>cg.job('portable').status==='failed');assert.equal(calls.length,0);assert.match(cg.job('portable').error,/提交结果不明/);}finally{await cg.close();}
});
test('an unsupported remote protocol in a queued job fails without submission',async()=>{
 const {cg,calls}=await queued();try{cg.job('portable').remoteTask={id:'existing'};cg.start();await until(()=>cg.job('portable').status==='failed');assert.equal(calls.length,0);assert.match(cg.job('portable').error,/不支持/);}finally{await cg.close();}
});
test('known imported Wan task polls only without references or theme replanning',async()=>{
 let plans=0;const {cg,calls}=await queued(temp(),{themePlanner:{capture:()=>null,prepare:async()=>{plans++;throw Error('must not replan');}},fetchImpl:async(url,opts)=>{calls.push({url:String(url),method:opts.method});return Response.json({output:{task_status:'SUCCEEDED',results:[{url:'data:image/png;base64,'+png.toString('base64')}]}});}});
 try{const j=cg.job('portable');Object.assign(j,{status:'paused',pausedFrom:'generating',pauseReason:'import',submittedAt:1,remoteTask:{id:'already-submitted'},themeBrief:{charId:'deepseek'},prompt:null});j.profile.protocol='wan-t2i';j.profile.options.references=false;renameSync(j.references[0].path,j.references[0].path+'.unavailable');cg.start();await cg.resume(j.id);await until(()=>['ready','failed'].includes(j.status));assert.equal(j.status,'ready',j.error);assert.equal(plans,0);assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.ok(calls[0].url.endsWith('/tasks/already-submitted'));}finally{await cg.close();}
});
for(const remote of [false,true])test((remote?'unsupported remote task':'uncertain submitted task')+' cannot resume or silently issue a POST',async()=>{
 const {cg,calls}=await queued();try{const j=cg.job('portable');Object.assign(j,{status:'paused',pausedFrom:'generating',pauseReason:'import',submittedAt:1,...(remote?{remoteTask:{id:'unknown'}}:{})});cg.start();await assert.rejects(()=>cg.resume(j.id),/无法|不支持|确认|重试/);assert.equal(j.status,'paused');assert.equal(calls.length,0);}finally{await cg.close();}
});
test('the import guard preserves newly earned automatic CG gifts as paused without submitting',async()=>{
 const {cg,calls}=await service(temp(),{automaticWorkAllowed:()=>false});try{await cg.setEnabled(true);cg.start();const created=await cg.enqueue({id:'protected-gift',sourceEventId:'protected-gift',automatic:true,prompt:'earned gift'});assert.equal(created.status,'paused');assert.equal(created.pausedFrom,'queued');assert.equal(created.pauseReason,'import');assert.equal(cg.jobs.length,1);assert.equal(calls.length,0);await cg.resume(created.id);await until(()=>cg.job(created.id).status==='ready');assert.equal(calls.length,1);}finally{await cg.close();}
});
test('the import guard pauses an existing automatic queue before theme planning or submission',async()=>{
 let allowed=true,plans=0;const {cg,calls}=await service(temp(),{automaticWorkAllowed:()=>allowed,themePlanner:{capture:()=>null,prepare:async()=>{plans++;throw Error('must not plan');}}});try{await cg.setEnabled(true);await cg.enqueue({id:'queued-gift',sourceEventId:'queued-gift',automatic:true,themeBrief:{charId:'deepseek'}});allowed=false;cg.start();await until(()=>cg.job('queued-gift').status==='paused');assert.equal(plans,0);assert.equal(calls.length,0);assert.equal(cg.status().busy,false);}finally{await cg.close();}
});
test('a guard activated while theme planning finishes preserves the prepared theme and pauses before drawing',async()=>{
 let allowed=true;const {cg,calls}=await service(temp(),{automaticWorkAllowed:()=>allowed,themePlanner:{capture:()=>null,prepare:async()=>{allowed=false;return {theme:{name:'already prepared'},prompt:'keep prepared prompt'};}}});try{await cg.setEnabled(true);await cg.enqueue({id:'planning-gift',sourceEventId:'planning-gift',automatic:true,themeBrief:{charId:'deepseek'}});cg.start();await until(()=>cg.job('planning-gift').status==='paused');assert.equal(calls.length,0);assert.equal(cg.job('planning-gift').prompt,'keep prepared prompt');assert.equal(cg.job('planning-gift').theme.name,'already prepared');assert.equal(cg.job('planning-gift').submittedAt,undefined);assert.equal(cg.publicJob(cg.job('planning-gift')).resumeAllowed,true);}finally{await cg.close();}
});
