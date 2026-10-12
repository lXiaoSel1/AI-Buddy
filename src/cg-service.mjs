import {randomUUID,createHash} from 'node:crypto';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {mkdirSync,readFileSync,writeFileSync,existsSync,realpathSync} from 'node:fs';
import {ModelRouter} from './model-router.mjs';
import {CG_PRESETS,CG_PROTOCOLS,cgOptions} from './cg-presets.mjs';
import {localTheme,themePrompt} from './cg-theme.mjs';
import {CG_COMPOSITION_VERSION,constrainCgPrompt} from './cg-composition.mjs';
import {CgTransport} from './cg-transport.mjs';
import {fitReferences,referenceInstructions} from './cg-reference-registry.mjs';
import {createSnapshotStorage,readJson} from './storage.mjs';
const pending=job=>['queued','planning','generating'].includes(job.status),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export class CgService extends ModelRouter{
 constructor({codex,dataRoot,crypto,onChange=()=>{},onUsage=()=>{},audit=()=>{},fetchImpl,imageCodec,themePlanner=null,referenceResolver=async()=>[],pollInterval=10000,timeoutMs=600000}){
  super({codex,dataRoot,crypto,onChange,onUsage,audit,fetchImpl,legacy:false,storeName:'cg-connections.json',presets:CG_PRESETS,protocols:CG_PROTOCOLS,timeoutMs});
  Object.assign(this,{imageCodec,referenceResolver,themePlanner});this.jobs=[];this.tombstones={};this.listeners=new Set();this.sentJobs=new Map();this.jobTail=Promise.resolve();this.jobStore=createSnapshotStorage(join(dataRoot,'cg-jobs.json'));this.imageTransport=new CgTransport({fetchImpl,onUsage,pollInterval});this.started=false;this.closed=false;
  const configurationReady=this.ready;
  this.ready=Promise.all([configurationReady,readJson(this.jobStore,{version:1,jobs:[]})]).then(async([,state])=>{
   this.enabled=this.state.autoEnabled===true;this.jobs=state.jobs;this.tombstones=state.tombstones??{};
   for(const job of this.jobs)if(['generating','planning'].includes(job.status)){job.status=job.remoteTask?'queued':'failed';job.error=job.remoteTask?null:'上次生成被中断，请手动重试';}
   await this.persistJobs();return this;
  });
 }
 publicProfile(profile){return {...super.publicProfile(profile),options:profile.options??cgOptions(),references:profile.options?.references!==false&&!profile.protocol.startsWith('wan-t2i')};}
 validateDraft(draft,previous){const profile=super.validateDraft(draft,previous),preset=this.presets.find(row=>row.kind===profile.kind);profile.options=cgOptions({...previous?.options,references:preset.references,...draft.options});if(profile.protocol.startsWith('wan-t2i'))profile.options.references=false;return profile;}
 status(){return {...super.status(),busy:!!this.jobs?.some(pending)||this.activeTurns>0,autoEnabled:this.enabled};}
 publicJob(job){return {id:job.id,status:job.status,kind:job.kind,sourceEventId:job.sourceEventId,label:job.label,at:job.at,provider:job.profile.kind,model:job.profile.model,connectionName:job.profile.name,error:job.error??null,assetRef:job.assetRef??null,thumbnailRef:job.thumbnailRef??null,width:job.width,height:job.height,sha256:job.sha256,retryOf:job.retryOf??null,prompt:job.prompt??null,theme:job.theme??null,referenceMode:job.referenceMode??null,referenceNotice:job.referenceMode==='text-only'?'未使用人物参考':job.environmentReferenceOmitted?'已保留全部人物参考；环境仅使用文字线索':null,characters:job.characters??null,scene:job.scene??null,deletedAt:job.deletedAt??null};}
 view(){return {...super.view(),jobs:(this.jobs??[]).slice(-30).reverse().map(job=>this.publicJob(job))};}
 available(){try{this.materialize(this.selected());return true;}catch{return false;}}
 unlocked(id){if(this.activeTurns||(this.jobs??[]).some(job=>pending(job)&&(id===undefined||job.profile.id===id)))throw Error('请等待当前 CG 队列完成后再修改或切换连接');}
 async remove(id){return this.mutate(state=>{this.unlocked(id);if(!state.profiles.some(profile=>profile.id===id))throw Error('连接不存在');state.profiles=state.profiles.filter(profile=>profile.id!==id);if(state.activeId===id){state.activeId=null;state.autoEnabled=false;this.enabled=false;}});}
 async setEnabled(value){await this.ready;if(value)this.materialize(this.selected());await this.mutate(state=>{state.autoEnabled=!!value;this.enabled=!!value;});if(!value)await this.jobsMutate(()=>{for(const job of this.jobs)if(job.automatic&&pending(job)&&!job.remoteTask&&!job.submittedAt){job.status='cancelled';job.error='自动生成已关闭';}});if(!value&&this.currentJob?.automatic&&!this.currentJob.submittedAt)this.currentController?.abort();return this.view();}
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
 async enqueue({id=randomUUID(),sourceEventId,kind='level',label='',prompt,characters=[],scene=null,automatic=false,retryOf=null,draft=null,themeBrief=null,theme=null}){
  await this.ready;if(automatic&&!this.enabled)return {skipped:true};
  const prior=this.jobs.find(job=>job.sourceEventId===sourceEventId);if(prior)return this.publicJob(prior);
  const profile=draft?this.draftProfile(draft):structuredClone(this.selected());this.materialize(profile);
  const directory=join(this.dataRoot,'cg-assets',id);if(!/^[a-zA-Z0-9_-]{1,180}$/.test(id))throw Error('CG 标识无效');mkdirSync(directory,{recursive:true});
  const old=retryOf?this.job(retryOf):null;
  const requestedRefs=old?.references??(profile.options?.references===false?[]:await this.referenceResolver(characters,scene));
  const references=fitReferences(profile,requestedRefs);
  const storedRefs=[];for(let index=0;index<references.length;index++){
   const ref=references[index],bytes=ref.buffer??readFileSync(ref.path);const normalized=this.imageCodec(bytes,{reference:true});const path=join(directory,'reference-'+index+'.png');writeFileSync(path,normalized.png,{flag:'wx'});storedRefs.push({path,mime:'image/png',sha256:sha(normalized.png),sourceSha256:ref.sourceSha256||sha(bytes),role:ref.role||'character',characterId:ref.characterId||characters[index]?.id||null,name:ref.name||characters[index]?.name||null,resourceVersion:ref.resourceVersion||null,ignoreCharacters:ref.role==='environment'});
  }
  const job={id,sourceEventId,kind,label,prompt:old?.prompt||prompt,theme:old?.theme||theme,themeBrief:old?.themeBrief||themeBrief,themeConnection:this.themePlanner?.capture()??null,automatic,retryOf,profile,references:storedRefs,directory,at:Date.now(),status:'queued',...(old?.remoteTask&&old.profile.id===profile.id?{remoteTask:old.remoteTask,profile:structuredClone(old.profile)}:{})};
  job.characters=old?.characters??characters.map(({dataUrl,...character})=>structuredClone(character));
  job.basePrompt=old?.basePrompt??old?.prompt??prompt;job.prompt=job.basePrompt;
  job.scene=old?.scene??(scene?structuredClone(Object.fromEntries(Object.entries(scene).filter(([key])=>key!=='dataUrl'))):null);
  job.referenceMode=storedRefs.some(r=>r.role==='character')?'character-reference':'text-only';
  job.environmentReferenceOmitted=requestedRefs.some(r=>r.role==='environment')&&!storedRefs.some(r=>r.role==='environment');
  const result=await this.jobsMutate(()=>{const existing=this.jobs.find(value=>value.sourceEventId===sourceEventId);if(existing)return this.publicJob(existing);if(automatic&&!this.enabled){job.status='cancelled';job.error='自动生成已关闭';}if(this.tombstones[id]){job.deletedAt=this.tombstones[id];job.status='cancelled';job.error='已移入回收站';}this.jobs.push(job);return this.publicJob(job);});this.pump();return result;
 }
 pump(){if(!this.started||this.closed||this.pumping||this.activeTurns)return;this.pumping=this.runQueue().finally(()=>{this.pumping=null;if(!this.closed&&this.jobs.some(job=>job.status==='queued'))this.pump();});}
 async runQueue(){
  while(!this.closed){const job=this.jobs.find(value=>value.status==='queued');if(!job)break;
   if(!await this.jobsMutate(()=>{if(job.status!=='queued'||job.deletedAt)return false;job.status=job.themeBrief&&!job.prompt?'planning':'generating';job.error=null;return true;}))continue;const controller=new AbortController();this.currentController=controller;this.currentJob=job;const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
   try{
    if(job.themeBrief&&!job.prompt){
     const history=[...this.jobs.filter(x=>x.id!==job.id&&x.themeBrief?.charId===job.themeBrief.charId&&x.theme).sort((a,b)=>b.at-a.at).map(x=>x.theme),...(job.themeBrief.history??[])].slice(0,6);
     const prepared=this.themePlanner?await this.themePlanner.prepare(job.themeBrief,history,job.themeConnection,controller.signal):(()=>{const theme=localTheme(job.themeBrief,history);return {theme,prompt:themePrompt(job.themeBrief,theme)};})();
     if(controller.signal.aborted)throw Error('主题准备已中断');
     await this.jobsMutate(()=>{job.theme=prepared.theme;job.prompt=prepared.prompt;job.basePrompt=prepared.prompt;});
    }
    if(job.status==='cancelled'||job.deletedAt||(job.automatic&&!this.enabled&&!job.submittedAt))continue;
    await this.jobsMutate(()=>{job.status='generating';if(!job.remoteTask){if(!job.referencePolicyVersion){job.originalPrompt??=job.prompt;job.prompt=[job.prompt,referenceInstructions(job.references)].join('\n');job.referencePolicyVersion=1;}const prompt=constrainCgPrompt(job.prompt);if(prompt!==job.prompt){job.originalPrompt??=job.prompt;job.prompt=prompt;}job.compositionPolicyVersion=CG_COMPOSITION_VERSION;}});
    const profile=this.materialize(job.profile);
    const options={prompt:job.prompt,references:job.references,directory:job.directory,remoteTask:job.remoteTask,signal:controller.signal,onRemoteTask:task=>this.jobsMutate(()=>{job.remoteTask=task;}),onSubmit:()=>this.jobsMutate(()=>{if(job.status==='cancelled'||(job.automatic&&!this.enabled))throw Error('自动生成已关闭');job.submittedAt=Date.now();})};
    const result=profile.kind==='codex'?await this.codex.generate(profile,options):await this.imageTransport.generate(profile,options);
    const decoded=this.imageCodec(result.buffer),path=join(job.directory,'image.png'),thumb=join(job.directory,'thumbnail.png'),raw=join(job.directory,'original.'+(decoded.extension??'png'));
    writeFileSync(raw,result.buffer,{flag:'wx'});writeFileSync(path,decoded.png,{flag:'wx'});writeFileSync(thumb,decoded.thumbnail,{flag:'wx'});
    await this.jobsMutate(()=>Object.assign(job,{status:'ready',error:null,assetRef:relative(this.dataRoot,path).replaceAll('\\','/'),thumbnailRef:relative(this.dataRoot,thumb).replaceAll('\\','/'),originalRef:relative(this.dataRoot,raw).replaceAll('\\','/'),width:decoded.width,height:decoded.height,sha256:sha(decoded.png),revisedPrompt:result.revisedPrompt??null,completedAt:Date.now()}));
   }catch(error){await this.jobsMutate(()=>{job.status=job.status==='cancelled'?'cancelled':this.closed&&job.remoteTask?'queued':'failed';job.error=error.message?.slice(0,160)??'CG 生成失败，请重试';});}
   finally{clearTimeout(timer);this.currentController=null;this.currentJob=null;this.codex.close();}
  }
 }
 readAsset(ref){if(typeof ref!=='string'||!ref.startsWith('cg-assets/'))throw Error('CG 文件引用无效');const root=realpathSync(join(this.dataRoot,'cg-assets')),path=realpathSync(resolve(this.dataRoot,ref)),rel=relative(root,path);if(rel.startsWith('..')||isAbsolute(rel))throw Error('CG 文件引用无效');return 'data:image/png;base64,'+readFileSync(path).toString('base64');}
 async fetchModels(draft){await this.ready;if(this.status().busy)throw Error('请等待 CG 队列完成');const profile=this.materialize({...this.draftProfile(draft),model:draft.model||'model-list'});this.activeTurns++;this.onChange(this.view());const request=this.requestController(null,15000);try{return profile.kind==='codex'?await this.codex.models():await this.imageTransport.listModels(profile,request.controller.signal);}finally{request.dispose();this.activeTurns--;this.codex.close();this.onChange(this.view());this.pump();}}
 async test(draft){await this.ready;if(this.status().busy)throw Error('请等待 CG 队列完成');const profile=this.materialize({...this.draftProfile(draft),model:draft.model||'connection-check'});this.activeTurns++;this.onChange(this.view());const request=this.requestController(null,15000);try{return profile.kind==='codex'?await this.codex.check():await this.imageTransport.check(profile,request.controller.signal);}finally{request.dispose();this.activeTurns--;this.codex.close();this.onChange(this.view());this.pump();}}
 async testImage(draft){if(this.status().busy)throw Error('请等待 CG 队列完成');return this.enqueue({draft,kind:'test',sourceEventId:'test:'+randomUUID(),label:'连接测试图',prompt:'精美 Galgame CG 插画。参考图片中的鲸鱼娘保持人物外观，在温暖的海底女仆工坊中微笑挥手，横向16:9，允许文字，保留原有服饰标识。',characters:[{id:'deepseek'}]});}
 async close(){this.closed=true;this.currentController?.abort();this.codex.close();await this.pumping;await this.jobTail;}
}
