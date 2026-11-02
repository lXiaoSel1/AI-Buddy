import {randomUUID,createHash} from 'node:crypto';
import {join,relative} from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import {ModelRouter} from './model-router.mjs';
import {CG_PRESETS,CG_PROTOCOLS,cgOptions,cgProtocol} from './cg-presets.mjs';
import {localTheme,themePrompt} from './cg-theme.mjs';
import {CG_COMPOSITION_VERSION,constrainCgPrompt,DAILY_CG_COMPOSITION_POLICY,DAILY_CG_COMPOSITION_VERSION,constrainDailyCgPrompt} from './cg-composition.mjs';
import {CgTransport} from './cg-transport.mjs';
import {fitReferences,referenceInstructions} from './cg-reference-registry.mjs';
import {createSnapshotStorage,readJson} from './storage.mjs';
import {cgJobPaths,cgAssetPath,assertCgRemoteResume} from './cg-job-paths.mjs';
import {createCgRewardFacts} from './cg-reward-facts.mjs';
import {sanitizeDailyCgBrief,dailyCgCharacters,dailyCgScene,assertDailyCgPromptAllowed} from './daily-cg-policy.mjs';
const pending=job=>['queued','planning','generating'].includes(job.status),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const rewardJob=job=>({...job,id:job.rewardJobId??job.id});
const closedError=()=>Object.assign(Error('CG 服务正在关闭或已关闭'),{code:'CG_SERVICE_CLOSED'});
function dailyMetadata(value){
 if(!value||!/^\d{4}-\d{2}-\d{2}$/.test(value.logicalDay)||!['10:00','22:00'].includes(value.slot)||typeof value.timeZone!=='string'||value.timeZone==='local'||!Number.isFinite(value.triggeredAt)||value.fictional!==true)throw Error('每日 CG 时点资料无效');
 new Intl.DateTimeFormat('en',{timeZone:value.timeZone});
 const materialEventIds=value.materialEventIds??[],materialSourceHashes=value.materialSourceHashes??[];
 if(!Array.isArray(materialEventIds)||materialEventIds.some(id=>typeof id!=='string'||!id||id.length>512)||!Array.isArray(materialSourceHashes))throw Error('每日 CG 素材资料无效');
 return {logicalDay:value.logicalDay,slot:value.slot,timeZone:value.timeZone,triggeredAt:value.triggeredAt,sourceEventId:value.sourceEventId??'daily:'+value.logicalDay+':'+value.slot.replace(':',''),materialEventIds:[...new Set(materialEventIds)],materialSourceHashes:structuredClone(materialSourceHashes),fictional:true,...(typeof value.coverageHash==='string'?{coverageHash:value.coverageHash}:{})};
}
export class CgService extends ModelRouter{
 constructor({codex,dataRoot,crypto,onChange=()=>{},onUsage=()=>{},onRewardFact=null,captureRewardScope=()=>null,validateDailyScope=()=>true,canViewDailyScope=()=>true,onActivity=()=>{},audit=()=>{},fetchImpl,imageCodec,themePlanner=null,resourceCheck=()=>{},referenceResolver=async()=>[],automaticWorkAllowed=()=>true,pollInterval=10000,timeoutMs=600000}){
  super({codex,dataRoot,crypto,onChange,onUsage,onActivity,audit,fetchImpl,legacy:false,storeName:'cg-connections.json',presets:CG_PRESETS,protocols:CG_PROTOCOLS,timeoutMs});
  Object.assign(this,{imageCodec,referenceResolver,themePlanner,resourceCheck,automaticWorkAllowed,validateDailyScope,canViewDailyScope});this.jobs=[];this.tombstones={};this.listeners=new Set();this.sentJobs=new Map();this.enqueuing=new Set();this.jobTail=Promise.resolve();this.jobStore=createSnapshotStorage(join(dataRoot,'cg-jobs.json'));this.imageTransport=new CgTransport({fetchImpl,onUsage,pollInterval});this.started=false;this.closed=false;this.automaticGeneration=randomUUID();this.automaticAdmission=false;this.automaticControlVersion=0;
  this.captureRewardScope=captureRewardScope;this.rewardFacts=createCgRewardFacts({dataRoot,onRewardFact});
  const configurationReady=this.ready;
  this.ready=Promise.all([configurationReady,readJson(this.jobStore,{version:1,jobs:[]})]).then(async([,state])=>{
   this.enabled=this.state.autoEnabled===true;if(this.automaticControlVersion===0)this.automaticAdmission=this.enabled;this.jobs=state.jobs;this.tombstones=state.tombstones??{};
   for(const job of this.jobs){
    if(job.automatic&&!job.submittedAt&&!job.remoteTask)job.automaticGeneration=this.automaticGeneration;
    // Compatibility fields are rebased to the current root, without probing any
    // old absolute directory. Bad individual jobs fail safely when run.
    try{const paths=cgJobPaths(this.dataRoot,job,{validate:false});Object.assign(job,paths);}catch{}
    if(['generating','planning'].includes(job.status)){job.status=job.remoteTask?'queued':'failed';job.error=job.remoteTask?null:'上次生成被中断，请手动重试';}
   }
   await this.persistJobs();await this.rewardFacts.initialize(this.jobs.map(rewardJob));return this;
  });
 }
 pauseAutomaticJob(job){if(!job.automatic||this.automaticWorkAllowed())return false;job.pausedFrom=job.submittedAt?'generating':job.themeBrief&&!job.prompt?'planning':'queued';job.status='paused';job.pauseReason='import';job.pausedAt=Date.now();job.error=null;return true;}
 publicProfile(profile){return {...super.publicProfile(profile),options:profile.options??cgOptions(),references:profile.options?.references!==false&&!profile.protocol.startsWith('wan-t2i')};}
 validateDraft(draft,previous){const profile=super.validateDraft(draft,previous);profile.protocol=cgProtocol(profile);const preset=this.presets.find(row=>row.kind===profile.kind);profile.options=cgOptions({...previous?.options,references:preset.references,...draft.options});if(profile.protocol.startsWith('wan-t2i'))profile.options.references=false;return profile;}
 status(){return {...super.status(),busy:!!this.jobs?.some(pending)||this.activeTurns>0,autoEnabled:this.enabled};}
 publicJob(job){return {id:job.id,status:job.status,pausedFrom:job.pausedFrom??null,pauseReason:job.pauseReason??null,pausedAt:job.pausedAt??null,resumeAllowed:job.status==='paused'&&!this.resumeError(job),resumeError:this.resumeError(job),submittedAt:job.submittedAt??null,completedAt:job.completedAt??null,kind:job.kind,sourceEventId:job.sourceEventId,label:job.label,at:job.at,provider:job.profile.kind,model:job.profile.model,connectionName:job.profile.name,error:job.error??null,errorDetails:job.errorDetails??null,assetRef:job.assetRef??null,thumbnailRef:job.thumbnailRef??null,width:job.width,height:job.height,sha256:job.sha256,retryOf:job.retryOf??null,prompt:job.prompt??null,theme:job.theme??null,referenceMode:job.referenceMode??null,referenceNotice:job.referenceMode==='text-only'?'未使用人物参考':job.environmentReferenceOmitted?'已保留全部人物参考；环境仅使用文字线索':null,characters:job.characters??null,scene:job.scene??null,deletedAt:job.deletedAt??null,...(job.kind==='daily'?{daily:structuredClone(job.daily),compositionPolicy:job.compositionPolicy}:{} )};}
 resumeError(job){if(job.status!=='paused')return null;try{assertCgRemoteResume(job);if(!job.remoteTask&&(job.submittedAt||job.pausedFrom==='generating'))return '此前提交结果不明，请确认后使用重试；不会自动重新提交';return null;}catch(error){return error.message;}}
 async resume(id){await this.ready;const result=await this.jobsMutate(()=>{const job=this.assertReadableJob(id);if(job.deletedAt)throw Error('CG 任务不存在');if(job.status!=='paused')throw Error('此 CG 任务未暂停，请勿重复继续');const error=this.resumeError(job);if(error)throw Error(error);assertCgRemoteResume(job);cgJobPaths(this.dataRoot,job,{references:!job.remoteTask,validate:!job.remoteTask});job.status='queued';job.resumedAt=Date.now();job.resumedManually=true;job.originallyAutomatic??=job.automatic;job.automatic=false;job.error=null;return this.publicJob(job);});this.pump();return result;}
 canReadJob(job){if(job?.kind!=='daily')return true;try{this.assertDailyScope(job.rewardScope);return this.canViewDailyScope(job.rewardScope)===true;}catch{return false;}}
 assertReadableJob(id){const job=this.job(id);if(!job)throw Error('CG 任务不存在');if(!this.canReadJob(job))throw Object.assign(Error('日常 CG 不属于当前身份或人生'),{code:'DAILY_CG_SCOPE_DENIED'});return job;}
 view(){return {...super.view(),jobs:(this.jobs??[]).filter(job=>this.canReadJob(job)).slice(-30).reverse().map(job=>this.publicJob(job))};}
 available(){try{this.materialize(this.selected());return true;}catch{return false;}}
 unlocked(id){if(this.activeTurns||(this.jobs??[]).some(job=>pending(job)&&(id===undefined||job.profile.id===id)))throw Error('请等待当前 CG 队列完成后再修改或切换连接');}
 async remove(id){return this.mutate(state=>{this.unlocked(id);if(!state.profiles.some(profile=>profile.id===id))throw Error('连接不存在');state.profiles=state.profiles.filter(profile=>profile.id!==id);if(state.activeId===id){state.activeId=null;state.autoEnabled=false;this.enabled=false;}});}
 automaticRevoked(job){return job.automatic&&!job.submittedAt&&!job.remoteTask&&(!this.enabled||!this.automaticAdmission||job.automaticGeneration!==undefined&&job.automaticGeneration!==this.automaticGeneration);}
 async setEnabled(value){const controlVersion=++this.automaticControlVersion;if(!value){this.automaticAdmission=false;this.automaticGeneration=randomUUID();}await this.ready;if(value)this.materialize(this.selected());await this.mutate(state=>{state.autoEnabled=!!value;});this.enabled=this.state.autoEnabled===true;if(controlVersion===this.automaticControlVersion)this.automaticAdmission=!!value;if(!value)await this.jobsMutate(()=>{for(const job of this.jobs)if(pending(job)&&this.automaticRevoked(job)){job.status='cancelled';job.error='自动生成已关闭';}});if(!value&&this.currentJob&&this.automaticRevoked(this.currentJob))this.currentController?.abort();return this.view();}
 subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 changed(){this.onChange(this.state?this.view():null);for(const job of this.jobs){const value=this.publicJob(job),serialized=JSON.stringify(value);if(this.sentJobs.get(job.id)===serialized)continue;this.sentJobs.set(job.id,serialized);for(const listener of this.listeners)listener(value);}}
 persistJobs(){return this.jobStore.writeText(JSON.stringify({version:1,jobs:this.jobs,tombstones:this.tombstones}));}
 jobsMutate(fn){const run=this.jobTail.then(async()=>{const result=await fn();await this.persistJobs();this.changed();return result;});this.jobTail=run.catch(()=>{});return run;}
 start(){this.started=true;this.changed();this.pump();}
 async trashJob(id){await this.ready;return this.jobsMutate(()=>{const job=this.job(id);if(!job){this.tombstones[id]=Date.now();return;}
  if(job.status==='planning'||job.status==='generating')throw Error('请等待当前 CG 生成完成');
  if(job.status==='queued'){if(job.submittedAt||job.remoteTask)throw Error('请等待已提交的 CG 生成完成');job.status='cancelled';job.error='已移入回收站';}
  job.deletedAt=Date.now();this.tombstones[id]=job.deletedAt;return this.publicJob(job);
 });}
 async restoreJob(id){await this.ready;return this.jobsMutate(()=>{delete this.tombstones[id];const job=this.job(id);if(job){job.deletedAt=null;return this.publicJob(job);}});}
 job(id){return this.jobs.find(job=>job.id===id);}
 async validateReferences(characters,scene){await this.ready;this.resourceCheck(characters.map(c=>c.id));const profile=structuredClone(this.selected());this.materialize(profile);const refs=profile.options?.references===false?[]:await this.referenceResolver(characters,scene);return fitReferences(profile,refs);}
 assertDailyScope(scope){if(!scope||['characterId','personaId','lifeId','operationId'].some(key=>typeof scope[key]!=='string'||!scope[key])||this.validateDailyScope(scope)===false)throw Object.assign(Error('每日 CG 角色人生或活动范围已变化'),{code:'DAILY_CG_SCOPE_STALE'});}
 enqueue(options){if(this.closed)return Promise.reject(closedError());const task=this.enqueueJob(options,this.automaticGeneration);this.enqueuing.add(task);task.then(()=>this.enqueuing.delete(task),()=>this.enqueuing.delete(task));return task;}
 async enqueueJob({id=randomUUID(),sourceEventId,kind='level',label='',prompt,characters=[],scene=null,automatic=false,retryOf=null,draft=null,profile:capturedProfile=null,themeBrief=null,theme=null,themeConnection=undefined,resolvedRefs=null,rewardScope=undefined,daily=null,compositionPolicy=null},automaticGeneration=this.automaticGeneration){
  await this.ready;if(this.closed)throw closedError();if(automatic&&(!this.enabled||!this.automaticAdmission||automaticGeneration!==this.automaticGeneration))return {skipped:true};
  const prior=this.jobs.find(job=>job.sourceEventId===sourceEventId);if(prior)return this.publicJob(prior);
  const old=retryOf?this.job(retryOf):null;
  if(old?.kind==='daily')kind='daily';
  if(kind==='daily'){
   daily=dailyMetadata(old?.daily??daily??themeBrief?.daily);compositionPolicy=DAILY_CG_COMPOSITION_POLICY;
   themeBrief=sanitizeDailyCgBrief({...structuredClone(old?.themeBrief??themeBrief),kind:'daily',daily});
   rewardScope=structuredClone(old?.rewardScope??rewardScope);this.assertDailyScope(rewardScope);
   themeConnection=structuredClone(old?.themeConnection??themeConnection??this.themePlanner?.capture(themeBrief?.modelBinding)??null);
   characters=dailyCgCharacters(old?.characters??characters,themeBrief.materialRestrictions);scene=dailyCgScene(old?.scene??scene,themeBrief.materialRestrictions,themeBrief.language);themeBrief.scene=scene;
  }
  // Freeze provenance before any asynchronous reference/connection work. A
  // missing host scope stays unknown, never reassigned to a later active life.
  rewardScope=structuredClone(rewardScope===undefined?this.captureRewardScope({id,sourceEventId,kind,characters}):rewardScope);
  this.resourceCheck(characters.map(c=>c.id));
  const profile=kind==='daily'&&old?structuredClone(old.profile):capturedProfile?structuredClone(capturedProfile):draft?this.draftProfile(draft):structuredClone(this.selected());this.materialize(profile);
  const {directory,directoryRef}=cgJobPaths(this.dataRoot,{id,references:[]},{createDirectory:true});
  const continuingRemote=!!(old?.remoteTask&&old.profile.id===profile.id);
  // Group photos validate references first; reuse them instead of resolving every image twice.
  const rawRefs=old?cgJobPaths(this.dataRoot,old).references:(profile.options?.references===false?[]:resolvedRefs??await this.referenceResolver(characters,scene));
  const requestedRefs=kind==='daily'&&scene?.kind==='imagined'?rawRefs.filter(ref=>ref.role!=='environment'):rawRefs;
  if(this.closed)throw closedError();if(automatic&&(!this.enabled||!this.automaticAdmission||automaticGeneration!==this.automaticGeneration))return {skipped:true,reason:'automatic-revoked'};if(kind==='daily')this.assertDailyScope(rewardScope);
  const references=fitReferences(profile,requestedRefs);
  const storedRefs=[];for(let index=0;index<references.length;index++){
   const ref=references[index],bytes=ref.buffer??readFileSync(ref.path);const normalized=this.imageCodec(bytes,{reference:true});const path=join(directory,'reference-'+index+'.png');writeFileSync(path,normalized.png,{flag:'wx'});storedRefs.push({path,assetRef:directoryRef+'/reference-'+index+'.png',mime:'image/png',sha256:sha(normalized.png),sourceSha256:ref.sourceSha256||sha(bytes),role:ref.role||'character',characterId:ref.characterId||characters[index]?.id||null,name:ref.name||characters[index]?.name||null,resourceVersion:ref.resourceVersion||null,ignoreCharacters:ref.role==='environment'});
  }
  const job={id,sourceEventId,kind,label,prompt:old?.prompt||prompt,theme:old?.theme||theme,themeBrief:old?.themeBrief||themeBrief,themeConnection:old?.themeConnection??themeConnection??this.themePlanner?.capture()??null,automatic,...(automatic?{automaticGeneration}:{}),retryOf,profile,references:storedRefs,directory,directoryRef,at:Date.now(),status:'queued',rewardJobId:continuingRemote?old.rewardJobId??old.id:id,rewardScope:continuingRemote?old.rewardScope??null:rewardScope,...(continuingRemote?{remoteTask:old.remoteTask,profile:structuredClone(old.profile)}:{})};
  if(kind==='daily'){job.daily=daily;job.compositionPolicy=compositionPolicy;job.themeBrief=themeBrief;}
  job.characters=kind==='daily'?characters.map(({dataUrl,...character})=>structuredClone(character)):old?.characters??characters.map(({dataUrl,...character})=>structuredClone(character));
  job.basePrompt=old?.basePrompt??old?.prompt??prompt;job.prompt=job.basePrompt;
  job.scene=kind==='daily'?(scene?structuredClone(Object.fromEntries(Object.entries(scene).filter(([key])=>key!=='dataUrl'))):null):old?.scene??(scene?structuredClone(Object.fromEntries(Object.entries(scene).filter(([key])=>key!=='dataUrl'))):null);
  job.referenceMode=storedRefs.some(r=>r.role==='character')?'character-reference':'text-only';
  job.environmentReferenceOmitted=requestedRefs.some(r=>r.role==='environment')&&!storedRefs.some(r=>r.role==='environment');
  const result=await this.jobsMutate(()=>{if(this.closed)throw closedError();if(kind==='daily')this.assertDailyScope(rewardScope);const existing=this.jobs.find(value=>value.sourceEventId===sourceEventId);if(existing)return this.publicJob(existing);if(this.automaticRevoked(job)){job.status='cancelled';job.error='自动生成已关闭';}if(this.tombstones[id]){job.deletedAt=this.tombstones[id];job.status='cancelled';job.error='已移入回收站';}if(job.status==='queued')this.pauseAutomaticJob(job);this.rewardFacts.registerJob(rewardJob(job));this.jobs.push(job);return this.publicJob(job);});this.pump();return result;
 }
 pump(){if(!this.started||this.closed||this.pumping||this.activeTurns)return;this.pumping=this.runQueue().finally(()=>{this.pumping=null;if(!this.closed&&this.jobs.some(job=>job.status==='queued'))this.pump();});}
 async runQueue(){
  while(!this.closed){const job=this.jobs.find(value=>value.status==='queued');if(!job)break;
   if(!await this.jobsMutate(()=>{if(job.status!=='queued'||job.deletedAt)return false;if(this.automaticRevoked(job)||job.automatic&&!job.submittedAt&&(!this.enabled||!this.automaticAdmission)){job.status='cancelled';job.error='自动生成已关闭';return false;}if(this.pauseAutomaticJob(job))return false;job.status=job.themeBrief&&!job.prompt?'planning':'generating';job.error=null;return true;}))continue;const controller=new AbortController();this.currentController=controller;this.currentJob=job;const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
   try{
    if(this.closed)throw closedError();
    this.onActivity({id:'cg:'+job.id,active:true,kind:'cg'});
    if(job.status==='cancelled'||job.deletedAt||this.automaticRevoked(job)||job.automatic&&!job.submittedAt&&(!this.enabled||!this.automaticAdmission)){if(pending(job))await this.jobsMutate(()=>{job.status='cancelled';job.error??=job.deletedAt?'已移入回收站':'自动生成已关闭';});continue;}
    assertCgRemoteResume(job);
    if(job.kind==='daily'){dailyMetadata(job.daily);this.assertDailyScope(job.rewardScope);}
    if(job.submittedAt&&!job.remoteTask)throw Error('此前 CG 提交结果不明，请确认后手动重试；不会自动重新提交');
    const paths=cgJobPaths(this.dataRoot,job,{references:!job.remoteTask,createDirectory:true});job.directory=paths.directory;job.directoryRef=paths.directoryRef;if(!job.remoteTask)job.references=paths.references;
    if(!job.remoteTask&&job.themeBrief&&!job.prompt){
     const history=job.kind==='daily'?this.jobs.filter(x=>x.id!==job.id&&x.kind==='daily'&&x.theme&&['characterId','personaId','lifeId','operationId'].every(key=>x.rewardScope?.[key]===job.rewardScope?.[key])).sort((a,b)=>b.at-a.at).slice(0,6).map(x=>x.theme):[...this.jobs.filter(x=>x.kind!=='daily'&&x.id!==job.id&&x.themeBrief?.charId===job.themeBrief.charId&&x.theme).sort((a,b)=>b.at-a.at).map(x=>x.theme),...(job.themeBrief.history??[]).filter(value=>value?.compositionPolicy!==DAILY_CG_COMPOSITION_POLICY)].slice(0,6);
     const prepared=this.themePlanner?await this.themePlanner.prepare(job.themeBrief,history,job.themeConnection,controller.signal):(()=>{const theme=localTheme(job.themeBrief,history);return {theme,prompt:themePrompt(job.themeBrief,theme)};})();
     if(controller.signal.aborted)throw Error('主题准备已中断');
     await this.jobsMutate(()=>{job.theme=prepared.theme;job.prompt=prepared.prompt;job.basePrompt=prepared.prompt;});
    }
    if(await this.jobsMutate(()=>this.pauseAutomaticJob(job)))continue;
    // A job that will not run must not stay 'planning'/'generating', or the queue looks busy forever.
    if(job.status==='cancelled'||job.deletedAt||this.automaticRevoked(job)){if(pending(job))await this.jobsMutate(()=>{job.status='cancelled';job.error??=job.deletedAt?'已移入回收站':'自动生成已关闭';});continue;}
    if(!await this.jobsMutate(()=>{
     if(job.status==='cancelled'||this.automaticRevoked(job)){job.status='cancelled';return false;}job.status='generating';if(job.remoteTask)return true;
     const referenced=job.referencePolicyVersion?job.prompt:[job.prompt,referenceInstructions(job.references)].join('\n');
     const prompt=job.kind==='daily'?constrainDailyCgPrompt(referenced):constrainCgPrompt(referenced);
     if(job.kind==='daily')assertDailyCgPromptAllowed(prompt,job.themeBrief?.materialRestrictions);
     if(prompt!==job.prompt)job.originalPrompt??=job.prompt;job.prompt=prompt;job.referencePolicyVersion=1;
     job.compositionPolicyVersion=job.kind==='daily'?DAILY_CG_COMPOSITION_VERSION:CG_COMPOSITION_VERSION;if(job.kind==='daily')job.compositionPolicy=DAILY_CG_COMPOSITION_POLICY;return true;
    }))continue;
    const profile=this.materialize(job.profile);
    const current=cgJobPaths(this.dataRoot,job,{references:!job.remoteTask,createDirectory:true});
    const options={prompt:job.prompt,references:current.references,directory:current.directory,remoteTask:job.remoteTask,jobId:job.rewardJobId??job.id,scope:job.rewardScope??null,onRewardUsage:usage=>this.recordRewardUsage(usage),signal:controller.signal,onRemoteTask:task=>this.jobsMutate(()=>{job.remoteTask=task;}),onSubmit:()=>this.jobsMutate(()=>{if(this.closed||controller.signal.aborted)throw closedError();if(job.kind==='daily')this.assertDailyScope(job.rewardScope);if(job.status==='cancelled'||this.automaticRevoked(job))throw Error('自动生成已关闭');if(this.pauseAutomaticJob(job))throw Error('导入保护期间自动 CG 已暂停，请手动继续');cgJobPaths(this.dataRoot,job,{createDirectory:true});job.submittedAt=Date.now();})};
    const result=profile.kind==='codex'?await this.codex.generate(profile,options):await this.imageTransport.generate(profile,options);
    const output=cgJobPaths(this.dataRoot,job,{references:false,createDirectory:true}),decoded=this.imageCodec(result.buffer),path=join(output.directory,'image.png'),thumb=join(output.directory,'thumbnail.png'),raw=join(output.directory,'original.'+(decoded.extension??'png'));
    writeFileSync(raw,result.buffer,{flag:'wx'});writeFileSync(path,decoded.png,{flag:'wx'});writeFileSync(thumb,decoded.thumbnail,{flag:'wx'});
    await this.jobsMutate(()=>Object.assign(job,{status:'ready',error:null,assetRef:relative(this.dataRoot,path).replaceAll('\\','/'),thumbnailRef:relative(this.dataRoot,thumb).replaceAll('\\','/'),originalRef:relative(this.dataRoot,raw).replaceAll('\\','/'),width:decoded.width,height:decoded.height,sha256:sha(decoded.png),revisedPrompt:result.revisedPrompt??null,completedAt:Date.now()}));
   }catch(error){await this.jobsMutate(()=>{job.status=['cancelled','paused'].includes(job.status)?job.status:this.closed&&job.remoteTask?'queued':'failed';job.error=error.message?.slice(0,1800)??'CG 生成失败，请重试';job.errorDetails=error.details??null;});}
   finally{try{await this.rewardFacts.observeJob(rewardJob(job));}catch(error){this.audit({type:'cg-reward-pending',jobId:job.id,reason:String(error.message).slice(0,300)});}clearTimeout(timer);this.currentController=null;this.currentJob=null;this.codex.close();try{this.onActivity({id:'cg:'+job.id,active:false,kind:'cg'});}catch{}}
  }
 }
 readAsset(ref){const bytes=readFileSync(cgAssetPath(this.dataRoot,ref)),mime=bytes[0]===255&&bytes[1]===216?'jpeg':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'webp':'png';return 'data:image/'+mime+';base64,'+bytes.toString('base64');}
 async fetchModels(draft){await this.ready;if(this.status().busy)throw Error('请等待 CG 队列完成');const profile=this.materialize({...this.draftProfile(draft),model:draft.model||'model-list'});this.activeTurns++;this.onChange(this.view());const request=this.requestController(null,15000);try{return profile.kind==='codex'?await this.codex.models():await this.imageTransport.listModels(profile,request.controller.signal);}finally{request.dispose();this.activeTurns--;this.codex.close();this.onChange(this.view());this.pump();}}
 async test(draft){await this.ready;if(this.status().busy)throw Error('请等待 CG 队列完成');const profile=this.materialize({...this.draftProfile(draft),model:draft.model||'connection-check'});this.activeTurns++;this.onChange(this.view());const request=this.requestController(null,15000);try{return profile.kind==='codex'?await this.codex.check():await this.imageTransport.check(profile,request.controller.signal);}finally{request.dispose();this.activeTurns--;this.codex.close();this.onChange(this.view());this.pump();}}
 async testImage(draft){if(this.status().busy)throw Error('请等待 CG 队列完成');return this.enqueue({draft,kind:'test',sourceEventId:'test:'+randomUUID(),label:'连接测试图',prompt:'精美 Galgame CG 插画。参考图片中的鲸鱼娘保持人物外观，在温暖的海底女仆工坊中微笑挥手，横向16:9，允许文字，保留原有服饰标识。',characters:[{id:'deepseek'}]});}
 // These are Core-only accounting hooks, deliberately absent from UI actions.
 recordRewardUsage(usage){return this.rewardFacts.recordUsage(usage);}
 drainRewardFacts(){return this.rewardFacts.drain();}
 close(){if(this.closePromise)return this.closePromise;this.closed=true;this.currentController?.abort();this.codex.close();this.closePromise=(async()=>{await this.ready.catch(()=>{});while(this.enqueuing.size)await Promise.allSettled([...this.enqueuing]);await this.pumping;await this.jobTail;await this.rewardFacts.close();})();return this.closePromise;}
}
