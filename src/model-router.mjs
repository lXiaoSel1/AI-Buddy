import {connectionIdentity} from './service-identity.mjs';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {join} from 'node:path';
import {createSnapshotStorage,readJson} from './storage.mjs';
import {MODEL_PRESETS,API_PROTOCOLS,presetFor,apiBaseUrl,localEndpoint} from './model-presets.mjs';
import {ApiTransport} from './api-transport.mjs';
export class ModelRouter{
  constructor({codex,dataRoot,crypto,legacy=false,onChange=()=>{},onUsage=()=>{},audit=()=>{},fetchImpl,timeoutMs=110000,storeName='model-connections.json',presets=MODEL_PRESETS,protocols=API_PROTOCOLS}){
    Object.assign(this,{codex,dataRoot,crypto,onChange,audit,timeoutMs,presets,protocols});this.store=createSnapshotStorage(join(dataRoot,storeName));this.enabled=false;this.activeTurns=0;this.controllers=new Set();this.context=new AsyncLocalStorage();this.tail=Promise.resolve();this.transport=new ApiTransport({fetchImpl,onUsage,audit});
    this.ready=readJson(this.store,null).then(async value=>{this.state=value??{version:1,activeId:legacy?'codex':null,profiles:legacy?[{id:'codex',kind:'codex',name:'本机 Codex 登录',protocol:'codex',baseUrl:'',model:codex.defaultModel,models:[]}]:[]};if(!value)await this.store.writeText(JSON.stringify(this.state));return this;});
  }
  selected(){return this.context.getStore()?.profile??this.state?.profiles.find(profile=>profile.id===this.state.activeId)??null;}
  currentSelection(){const profile=this.selected();return profile&&profile.model?{provider:profile.id,model:profile.model}:null;}
  get defaultModel(){return this.selected()?.model??'';}
  get currentName(){return this.selected()?.name??'尚未选择模型';}
  get currentKind(){return this.selected()?.kind??null;}
  status(){return {enabled:this.enabled,model:this.defaultModel,provider:this.currentKind,name:this.currentName,busy:this.activeTurns>0};}
  publicProfile(profile){return {id:profile.id,kind:profile.kind,name:profile.name,protocol:profile.protocol,baseUrl:profile.baseUrl,model:profile.model,models:profile.models??[],keyConfigured:!!profile.keyCiphertext};}
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
    const models=Array.isArray(draft.models)?draft.models.filter(row=>typeof row?.id==='string'&&row.id.length<=200).slice(0,1000).map(row=>({id:row.id,name:String(row.name??row.id).slice(0,300)})):previous?.baseUrl===baseUrl&&previous?.protocol===protocol?previous.models??[]:[];
    return {id:previous?.id??randomUUID(),kind:preset.kind,name,protocol,baseUrl,model,keyCiphertext,models};
  }
  unlocked(id){if(this.activeTurns&&(id===undefined||id===this.executingProfile||this.turnQueue?.some(turn=>turn.profile.id===id)||id===this.state.activeId))throw Error('请等待当前对话完成后再修改或切换连接');}
  async save(draft){return this.mutate(state=>{const previous=draft.id?state.profiles.find(profile=>profile.id===draft.id):null;if(draft.id&&!previous)throw Error('连接不存在');this.unlocked(previous?.id??'new');const profile=this.validateDraft(draft,previous);const index=state.profiles.findIndex(value=>value.id===profile.id);if(index<0)state.profiles.push(profile);else state.profiles[index]=profile;return this.publicProfile(profile);});}
  async remove(id){return this.mutate(state=>{this.unlocked(id);if(!state.profiles.some(profile=>profile.id===id))throw Error('连接不存在');state.profiles=state.profiles.filter(profile=>profile.id!==id);if(state.activeId===id){state.activeId=null;this.setEnabled(false);}});}
  materialize(profile){if(!profile||!profile.model)throw Error('请先选择连接并填写模型 ID');if(profile.kind==='codex')return {...profile};let key='';if(profile.keyCiphertext){try{key=this.crypto.decryptString(Buffer.from(profile.keyCiphertext,'base64'));}catch{throw Error('API Key 无法解密，请重新填写');}}if(!key&&!(profile.kind==='custom'&&localEndpoint(profile.baseUrl)))throw Error('请先填写 API Key');return {...profile,key};}
  async activate(id){return this.mutate(state=>{this.unlocked();const profile=state.profiles.find(value=>value.id===id);this.materialize(profile);state.activeId=id;if(this.codex.enabled)this.codex.setEnabled(false);});}
  setEnabled(value){if(value)this.materialize(this.selected());this.enabled=!!value;if(!this.enabled){for(const controller of this.controllers)controller.abort();this.codex.setEnabled(false);}this.onChange(this.state?this.view():null);}
  listProviders(){return this.state.profiles.map(profile=>({id:profile.id,name:profile.name}));}
  listModels(id){const profile=this.state.profiles.find(value=>value.id===id);if(!profile)return [];return [...(profile.models??[]),...(profile.model&&!(profile.models??[]).some(value=>value.id===profile.model)?[{id:profile.model,name:profile.model}]:[])];}
  resolveModelInfo(){return {reasoning:{efforts:[]}};}
  async runTurn(fn){await this.ready;return this.scheduleTurn(this.selected(),fn,0);}
  async runBackground(profile,fn,signal){await this.ready;return this.scheduleTurn(profile,fn,1,signal);}
  scheduleTurn(profile,fn,priority,signal){
    const captured=structuredClone(profile);this.materialize(captured);
    this.turnQueue??=[];this.activeTurns++;this.onChange(this.view());
    return new Promise((resolve,reject)=>{this.turnQueue.push({profile:captured,fn,priority,signal,resolve,reject});queueMicrotask(()=>this.pumpTurns());});
  }
  async pumpTurns(){
    if(this.runningTurn)return;this.runningTurn=true;
    try{while(this.turnQueue?.length){this.turnQueue.sort((a,b)=>a.priority-b.priority);const turn=this.turnQueue.shift();this.executingProfile=turn.profile.id;
      try{if(turn.signal?.aborted)throw Error('主题准备已取消');turn.resolve(await this.context.run({profile:this.materialize(turn.profile)},turn.fn));}catch(error){turn.reject(error);}finally{this.executingProfile=null;this.activeTurns--;this.onChange(this.view());}
    }}finally{this.runningTurn=false;}
  }
  requestController(signal,timeout=this.timeoutMs){const controller=new AbortController(),abort=()=>controller.abort();if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,timeout);this.controllers.add(controller);return {controller,dispose:()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.controllers.delete(controller);}};}
  async *stream(options){
    await this.ready;if(!this.enabled)throw Error('联网聊天已关闭');const profile=this.materialize(this.selected());const request=this.requestController(options.signal);
    try{if(profile.kind==='codex'){this.codex.setEnabled(true);yield* this.codex.stream({...options,connectionIdentity:connectionIdentity(profile),model:profile.model,signal:request.controller.signal});}else yield* this.transport.stream(profile,{...options,signal:request.controller.signal});}finally{request.controller.abort();request.dispose();}
  }
  draftProfile(draft){const previous=draft.id?this.state.profiles.find(profile=>profile.id===draft.id):null;return this.validateDraft(draft,previous);}
  async fetchModels(draft){await this.ready;const profile=this.draftProfile(draft);if(profile.kind==='codex')return [{id:profile.model||this.codex.defaultModel,name:profile.model||this.codex.defaultModel}];const request=this.requestController(null,15000);try{return await this.transport.listModels({...this.materialize({...profile,model:profile.model||'model-list'})},request.controller.signal);}finally{request.dispose();}}
  async test(draft){await this.ready;const profile=this.materialize(this.draftProfile(draft));if(profile.kind==='codex')throw Error('本机 Codex 请在 Galgame 手动开启聊天验证');const request=this.requestController();try{let output='';for await(const part of this.transport.stream(profile,{messages:[{role:'user',content:'请只回复：连接成功'}],maxTokens:2048,purpose:'connection-test',signal:request.controller.signal}))if(part.type==='text-delta')output+=part.text;return {ok:true,message:'连接成功',model:profile.model};}finally{request.dispose();}}
  async saveModels(id,models){return this.mutate(state=>{const profile=state.profiles.find(value=>value.id===id);if(profile)profile.models=models;});}
  close(){this.setEnabled(false);}
}
