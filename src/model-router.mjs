import {connectionIdentity} from './service-identity.mjs';
import {defaultContextCapacity} from './context-capacity.mjs';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {join} from 'node:path';
import {createSnapshotStorage,readJson} from './storage.mjs';
import {MODEL_PRESETS,API_PROTOCOLS,presetFor,apiBaseUrl,localEndpoint} from './model-presets.mjs';
import {ApiTransport} from './api-transport.mjs';
import {profileEffort,validateProfileEffort,cleanModelCatalog} from './reasoning-settings.mjs';
export class ModelRouter{
  constructor({codex,dataRoot,crypto,legacy=false,onChange=()=>{},onUsage=()=>{},onActivity=()=>{},audit=()=>{},fetchImpl,timeoutMs=110000,storeName='model-connections.json',presets=MODEL_PRESETS,protocols=API_PROTOCOLS,outputLimit=()=>8192}){
    Object.assign(this,{codex,dataRoot,crypto,onChange,onActivity,audit,timeoutMs,presets,protocols,outputLimit});this.store=createSnapshotStorage(join(dataRoot,storeName));this.enabled=false;this.activeTurns=0;this.controllers=new Set();this.context=new AsyncLocalStorage();this.tail=Promise.resolve();this.transport=new ApiTransport({fetchImpl,onUsage,audit});
    this.ready=readJson(this.store,null).then(async value=>{this.state=value??{version:1,activeId:legacy?'codex':null,profiles:legacy?[{id:'codex',kind:'codex',name:'本机 Codex 登录',protocol:'codex',baseUrl:'',model:codex.defaultModel,models:[]}]:[]};if(!value)await this.store.writeText(JSON.stringify(this.state));return this;});
  }
  selected(){return this.context.getStore()?.profile??this.state?.profiles.find(profile=>profile.id===this.state.activeId)??null;}
  currentSelection(){const profile=this.selected();return profile&&profile.model?{provider:profile.id,model:profile.model}:null;}
  get defaultModel(){return this.selected()?.model??'';}
  get currentName(){return this.selected()?.name??'尚未选择模型';}
  get currentKind(){return this.selected()?.kind??null;}
  status(){return {enabled:this.enabled,model:this.defaultModel,provider:this.currentKind,name:this.currentName,busy:this.activeTurns>0};}
  publicProfile(profile){return {id:profile.id,kind:profile.kind,name:profile.name,protocol:profile.protocol,baseUrl:profile.baseUrl,model:profile.model,models:profile.models??[],...(this.protocols===API_PROTOCOLS?{reasoningEffort:profileEffort(profile),contextTokens:profile.contextTokens??null}:{}),keyConfigured:!!profile.keyCiphertext};}
  view(){return {...this.status(),codexModel:this.codex.defaultModel,activeId:this.state.activeId,presets:this.presets,profiles:this.state.profiles.map(profile=>this.publicProfile(profile))};}
  async mutate(fn){const result=this.tail.then(async()=>{await this.ready;const previous=this.state,next=structuredClone(previous);const value=await fn(next);await this.store.writeText(JSON.stringify(next));this.state=next;this.onChange(this.view());return value??this.view();});this.tail=result.catch(()=>{});return result;}
  validateDraft(draft,previous=null){
    if(!draft||typeof draft!=='object'||Array.isArray(draft))throw Error('连接配置格式无效');const preset=this.presets.find(value=>value.kind===draft.kind);if(!preset)throw Error('请选择受支持的厂商');
    const model=String(draft.model??'').trim(),name=String(draft.name??preset.name).trim();if(!name||name.length>80||model.length>200)throw Error('连接名称或模型 ID 无效');
    if(typeof draft.key!=='undefined'&&typeof draft.key!=='string')throw Error('API Key 格式无效');if((draft.key??'').length>8192)throw Error('API Key 过长');
    const protocol=preset.kind==='codex'?'codex':draft.protocol??preset.protocol;if(protocol!=='codex'&&!this.protocols.includes(protocol))throw Error('接口协议无效');if(preset.kind!=='codex'&&protocol==='codex')throw Error('接口协议无效');
    const baseUrl=protocol==='codex'?'':apiBaseUrl(draft.baseUrl??preset.baseUrl);
    let keyCiphertext=previous?.baseUrl===baseUrl?previous.keyCiphertext:undefined;
    if(draft.clearKey)keyCiphertext=undefined;
    if(draft.key?.trim()){if(!this.crypto.isEncryptionAvailable())throw Error('系统密钥加密不可用，请修复 Windows 密钥存储');keyCiphertext=this.crypto.encryptString(draft.key.trim()).toString('base64');}
    const models=cleanModelCatalog(Array.isArray(draft.models)?draft.models:previous?.baseUrl===baseUrl&&previous?.protocol===protocol?previous.models??[]:[]);
    const profile={id:previous?.id??randomUUID(),kind:preset.kind,name,protocol,baseUrl,model,keyCiphertext,models};
    if(this.protocols===API_PROTOCOLS){
      const capacity=Object.hasOwn(draft,'contextTokens')?draft.contextTokens:previous?.model===model?previous.contextTokens:null;
      if(capacity!=null&&capacity!==''&&(!Number.isSafeInteger(Number(capacity))||Number(capacity)<2048||Number(capacity)>2000000))throw Error('上下文容量应为 2048–2000000 tokens，未知请留空');
      profile.contextTokens=capacity==null||capacity===''?null:Number(capacity);
      profile.reasoningEffort=profileEffort({...profile,...(Object.hasOwn(draft,'reasoningEffort')?{reasoningEffort:draft.reasoningEffort}:previous&&Object.hasOwn(previous,'reasoningEffort')?{reasoningEffort:previous.reasoningEffort}:{})});
      validateProfileEffort(profile);
    }
    return profile;
  }
  unlocked(id){if(this.activeTurns&&(id===undefined||[...(this.lanes?.values()??[])].some(lane=>lane.executing===id||lane.queue.some(turn=>turn.profile.id===id))||id===this.state.activeId))throw Error('请等待当前对话完成后再修改或切换连接');}
  async save(draft){return this.mutate(state=>{const previous=draft.id?state.profiles.find(profile=>profile.id===draft.id):null;if(draft.id&&!previous)throw Error('连接不存在');this.unlocked(previous?.id??'new');const profile=this.validateDraft(draft,previous);const index=state.profiles.findIndex(value=>value.id===profile.id);if(index<0)state.profiles.push(profile);else state.profiles[index]=profile;return this.publicProfile(profile);});}
  async remove(id){return this.mutate(state=>{this.unlocked(id);if(!state.profiles.some(profile=>profile.id===id))throw Error('连接不存在');state.profiles=state.profiles.filter(profile=>profile.id!==id);if(state.activeId===id){state.activeId=null;this.setEnabled(false);}});}
  materialize(profile){if(!profile||!profile.model)throw Error('请先选择连接并填写模型 ID');if(profile.kind==='codex')return {...profile};let key='';if(profile.keyCiphertext){try{key=this.crypto.decryptString(Buffer.from(profile.keyCiphertext,'base64'));}catch{throw Error('API Key 无法解密，请重新填写');}}if(!key&&!(profile.kind==='custom'&&localEndpoint(profile.baseUrl)))throw Error('请先填写 API Key');return {...profile,key};}
  async activate(id){return this.mutate(state=>{this.unlocked();const profile=state.profiles.find(value=>value.id===id);this.materialize(profile);state.activeId=id;if(this.codex.enabled)this.codex.setEnabled(false);});}
  setEnabled(value){if(value)this.materialize(this.selected());this.enabled=!!value;if(!this.enabled){for(const controller of this.controllers)controller.abort();this.codex.setEnabled(false);}this.onChange(this.state?this.view():null);}
  listProviders(){return this.state.profiles.map(profile=>({id:profile.id,name:profile.name}));}
  listModels(id){const profile=this.state.profiles.find(value=>value.id===id);if(!profile)return [];return [...(profile.models??[]),...(profile.model&&!(profile.models??[]).some(value=>value.id===profile.model)?[{id:profile.model,name:profile.model}]:[])];}
  resolveModelInfo(providerId,modelId){const profile=this.selected()?.id===providerId?this.selected():this.state.profiles.find(p=>p.id===providerId),effort=profileEffort(profile);return {reasoning:{efforts:effort?[{id:effort}]:[]}};}
  async runTurn(fn,signal,{background=false}={}){await this.ready;return this.scheduleTurn(this.selected(),fn,background?1:0,signal);}
  resolveConnection(binding){const dedicated=binding?.enabled===true,profile=dedicated?this.state?.profiles.find(p=>p.id===binding.connectionId):this.selected();const error=!profile?(dedicated?'角色关联的聊天连接已删除，请重新选择':'尚未选择全局聊天连接'):profile.enabled===false?'角色关联的聊天连接已停用':profile.capabilities?.chat===false?'该连接不支持聊天':!profile.model?'聊天连接未设置模型':null;return {mode:dedicated?'character':'global',connectionId:profile?.id??binding?.connectionId??null,name:profile?.name??'',model:profile?.model??'',error};}
  resolveContextCapacity(binding){
    const profile=binding?.enabled?this.state?.profiles.find(p=>p.id===binding.connectionId):this.selected(),model=profile?.models?.find(m=>m.id===profile.model||m.model===profile.model);
    if(profile?.contextTokens)return {tokens:profile.contextTokens,source:'connection-setting',verified:false};
    const declared=model?.contextWindow??model?.context_window??model?.contextLength??model?.inputTokenLimit??model?.max_input_tokens;
    if(Number.isSafeInteger(declared)&&declared>=2048&&declared<=2000000)return {tokens:declared,source:'model-catalog',verified:true};
    return defaultContextCapacity();
  }
  async runProfile(id,fn,signal,{background=false}={}){await this.ready;const profile=this.state.profiles.find(p=>p.id===id);if(!profile)throw Error('角色关联的聊天连接不存在');const route=this.resolveConnection({enabled:true,connectionId:id});if(route.error)throw Error(route.error);return this.scheduleTurn(profile,fn,background?1:0,signal);}
  async runBackground(profile,fn,signal){await this.ready;return this.scheduleTurn(profile,fn,1,signal);}
  // One serial lane per connection: a background job on one provider never
  // delays chat on another, and chat (priority 0) runs before queued
  // background work (priority 1) on the same connection.
  scheduleTurn(profile,fn,priority,signal){
    const captured=structuredClone(profile);this.materialize(captured);
    this.lanes??=new Map();const key=captured.id??captured.kind??'default';let lane=this.lanes.get(key);if(!lane)this.lanes.set(key,lane={queue:[],running:false,executing:null});
    this.activeTurns++;this.onChange(this.view());
    return new Promise((resolve,reject)=>{lane.queue.push({profile:captured,fn,priority,signal,resolve,reject});queueMicrotask(()=>this.pumpTurns(lane));});
  }
  async pumpTurns(lane){
    if(lane.running)return;lane.running=true;
    try{while(lane.queue.length){lane.queue.sort((a,b)=>a.priority-b.priority);const turn=lane.queue.shift();lane.executing=turn.profile.id;
      try{if(turn.signal?.aborted)throw Error('主题准备已取消');turn.resolve(await this.context.run({profile:this.materialize(turn.profile)},turn.fn));}catch(error){turn.reject(error);}finally{lane.executing=null;this.activeTurns--;this.onChange(this.view());}
    }}finally{lane.running=false;}
  }
  requestController(signal,timeout=this.timeoutMs){const controller=new AbortController(),abort=()=>controller.abort();if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,timeout);this.controllers.add(controller);return {controller,dispose:()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.controllers.delete(controller);}};}
  async *stream(options){
    await this.ready;if(!this.enabled)throw Error('联网聊天已关闭');const profile=this.materialize(this.selected());const request=this.requestController(options.signal);
    const activityId='chat:'+randomUUID();this.onActivity({id:activityId,active:true,kind:options.purpose==='cg-theme'?'cg-theme':'chat'});
    try{if(profile.kind==='codex'){this.codex.setEnabled(true);yield* this.codex.stream({...options,connectionIdentity:connectionIdentity(profile),model:profile.model,reasoningEffort:profileEffort(profile),signal:request.controller.signal});}else yield* this.streamWithRetry(profile,options,request.controller.signal);}finally{request.controller.abort();request.dispose();this.onActivity({id:activityId,active:false,kind:'chat'});}
  }
  // Output limit for one request: the user's setting ('auto' or 256-65536) for
  // callers that follow it, never below the caller's own floor, and never above
  // the model's declared output limit, 65536 or what the context window leaves.
  outputCeiling(profile,options){
    const model=profile.models?.find(m=>m.id===profile.model||m.model===profile.model),declared=Number(model?.maxOutputTokens??model?.max_output_tokens??model?.outputTokenLimit)||65536;
    const capacity=this.resolveContextCapacity({enabled:true,connectionId:profile.id}).tokens,input=Buffer.byteLength(JSON.stringify([options.system??'',options.messages??[]]),'utf8')+12;
    return Math.min(declared,65536,Math.max(256,capacity-input-64));
  }
  outputBudget(profile,options){
    if(!options.userLimit)return options.maxTokens;
    const ceiling=this.outputCeiling(profile,options);
    const setting=this.outputLimit();
    if(setting==='auto')return 'auto';
    return Math.max(1,Math.min(Math.max(Number(setting)||8192,Number(options.maxTokens)||0),ceiling));
  }
  // A response cut off by the output limit is retried once with twice the
  // limit (16384 under 'auto'); a second cut-off is an error, never a reply.
  async *streamWithRetry(profile,options,signal){
    let maxTokens=this.outputBudget(profile,options);const started=Date.now();
    for(let attempt=0;;attempt++){
      const parts=[];let finish=null;
      for await(const part of this.transport.stream(profile,{...options,maxTokens,signal}))if(part.type==='finish')finish=part;else parts.push(part);
      if(finish?.reason?.kind!=='length'){yield* parts;if(finish)yield finish;return;}
      this.audit({type:'model-output-truncated',profileId:profile.id,model:profile.model,purpose:options.purpose??'galgame',maxTokens,attempt});
      // A retry needs time: past half the request timeout it would only be cut off.
      if(attempt>=1||Date.now()-started>this.timeoutMs/2)throw Object.assign(Error('回复被截断：模型输出达到上限，可以调高通用设置里的“模型最多输出”后重试'),{code:'MODEL_OUTPUT_TRUNCATED'});
      const ceiling=this.outputCeiling(profile,options);
      maxTokens=maxTokens==='auto'?Math.min(16384,ceiling):Math.min(ceiling,Math.max(256,(Number(maxTokens)||2048)*2));
    }
  }
  draftProfile(draft){const previous=draft.id?this.state.profiles.find(profile=>profile.id===draft.id):null;return this.validateDraft(draft,previous);}
  async fetchModels(draft){await this.ready;const profile=this.draftProfile({...draft,reasoningEffort:null});if(profile.kind==='codex')return cleanModelCatalog(await this.codex.fetchModels());const request=this.requestController(null,15000);try{return await this.transport.listModels({...this.materialize({...profile,model:profile.model||'model-list'})},request.controller.signal);}finally{request.dispose();}}
  async test(draft){await this.ready;const profile=this.materialize(this.draftProfile(draft));if(profile.kind==='codex')throw Error('本机 Codex 请在 Galgame 手动开启聊天验证');const request=this.requestController();try{let output='';for await(const part of this.transport.stream(profile,{messages:[{role:'user',content:'请只回复：连接成功'}],maxTokens:2048,purpose:'connection-test',signal:request.controller.signal}))if(part.type==='text-delta')output+=part.text;return {ok:true,message:'连接成功',model:profile.model};}finally{request.dispose();}}
  async saveModels(id,models){return this.mutate(state=>{const profile=state.profiles.find(value=>value.id===id);if(profile)profile.models=cleanModelCatalog(models);});}
  close(){this.setEnabled(false);}
}
