import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { mkdirSync,readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import {codexHome,codexRuntimeError} from './runtime-discovery.mjs';
import {t} from './i18n.mjs';

const REASONING_EFFORTS=new Set(['none','minimal','low','medium','high','xhigh','max','ultra']);
function catalogModel(row){
  if(!row||typeof row!=='object'||Array.isArray(row))return null;
  const id=typeof row.model==='string'&&row.model.trim()?row.model.trim():typeof row.id==='string'?row.id.trim():'';
  if(!id)return null;
  const supportedReasoningEfforts=Array.isArray(row.supportedReasoningEfforts)?row.supportedReasoningEfforts.filter(value=>value&&typeof value.reasoningEffort==='string').map(value=>({reasoningEffort:value.reasoningEffort,description:typeof value.description==='string'?value.description:''})):[];
  // Keep the app-server's model identity and capabilities; no guessed model IDs or effort levels.
  return {...row,id,name:typeof row.displayName==='string'?row.displayName:typeof row.name==='string'?row.name:id,supportedReasoningEfforts,defaultReasoningEffort:typeof row.defaultReasoningEffort==='string'?row.defaultReasoningEffort:null};
}

export class CodexProvider extends EventEmitter {
  constructor({binary,defaultModel,dataRoot,onUsage=()=>{},audit=()=>{},imageGeneration=false,clientInfo=null,spawnImpl=spawn,env=process.env}) {
    super(); Object.assign(this,{binary,defaultModel,dataRoot,onUsage,audit,spawnImpl,env});
    this.imageGeneration=imageGeneration;this.clientInfo=clientInfo;this.enabled=false; this.pending=new Map(); this.nextId=1; this.child=null; this.chatTail=Promise.resolve(); this.notifications=new Set();this.models=[];this.catalogClient=null;this.catalogRequest=null;
  }
  setEnabled(value) {
    this.enabled=!!value;
    if(!this.enabled && this.child) {const child=this.child;this.child=null;this.fail(new Error('联网聊天已关闭'));child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.kill();}
  }
  async request(method,params={},timeout=110000) {
    if(!this.child) throw new Error('Codex 对话进程尚未启动');
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(method+' 超时'));},timeout);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({id,method,params})+'\n');
    });
  }
  async start() {
    if(!this.enabled) throw new Error('离线模式：请手动开启 Codex 聊天');
    if(this.starting) return this.starting;
    if(this.child) return;
    this.starting=(async()=>{
      // The Codex executable manages existing login itself. This app never reads auth.json.
      const overrides=['notify=[]','web_search="disabled"','features.shell_tool=false','features.js_repl=false','features.memories=false','features.goals=false','features.apps=false','features.image_generation='+this.imageGeneration];
      const binary=typeof this.binary==='function'?await this.binary():this.binary;
      if(!this.enabled)throw new Error(t('联网聊天已关闭'));
      if(!binary)throw codexRuntimeError({code:'CODEX_NOT_FOUND'});
      mkdirSync(this.dataRoot,{recursive:true});
      let config='';try{config=readFileSync(join(codexHome(this.env),'config.toml'),'utf8');}catch(error){if(error.code!=='ENOENT')throw new Error(t('Codex 配置无法读取，请检查文件权限。'));}
      for(const match of config.matchAll(/^\[(plugins\.(?:"[^"]+"|[^.\]\s]+)|mcp_servers\.[^.\]\s]+)\]\s*$/gm))overrides.push(match[1]+'.enabled=false');
      const child=this.spawnImpl(binary,['app-server',...overrides.flatMap(x=>['-c',x])],{env:this.env,windowsHide:true,cwd:this.dataRoot,stdio:['pipe','pipe','pipe']});this.child=child;
      const spawned=new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',error=>reject(codexRuntimeError(error)));});
      this.audit({type:'codex-process-start',online:true});
      createInterface({input:this.child.stdout}).on('line',line=>{
        if(this.child!==child)return;
        let message; try{message=JSON.parse(line);}catch{return;}
        if(message.id!==undefined && this.pending.has(message.id)) {
          const p=this.pending.get(message.id);this.pending.delete(message.id);clearTimeout(p.timer);
          message.error?p.reject(new Error(message.error.message || JSON.stringify(message.error))):p.resolve(message.result);return;
        }
        if(message.id!==undefined && message.method) {
          // Never approve privilege changes, edits, command execution or tool requests.
          this.child?.stdin.write(JSON.stringify({id:message.id,result:{decision:'decline'}})+'\n');
          this.audit({type:'codex-request-denied',method:message.method});return;
        }
        for(const listener of this.notifications) listener(message);
      });
      this.child.stderr.on('data',data=>{this.lastError=String(data).slice(-2000);});
      const failed=error=>{if(this.child!==child)return;this.child=null;this.fail(error);child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.kill();};
      child.stdin.on('error',()=>failed(new Error(t('Codex 对话进程已结束'))));
      child.on('error',error=>failed(codexRuntimeError(error)));
      child.on('exit',()=>failed(new Error(t('Codex 对话进程已结束'))));
      await spawned;
      await this.request('initialize',{clientInfo:this.clientInfo??{name:'whale_companion',version:'1.0.0',title:'鲸鱼娘本地陪伴'},capabilities:{experimentalApi:true}},15000);
      this.child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
      const account=await this.request('account/read',{refreshToken:false},15000);
      if(!account.account && account.requiresOpenaiAuth) throw new Error('本机 Codex 尚未登录，请先使用 Codex 自身登录入口');
    })();
    try {await this.starting;} catch(error){const child=this.child;this.child=null;if(child){child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.kill();}this.fail(error);throw error;} finally {this.starting=null;}
  }
  fail(error) {for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();for(const l of this.notifications)l({method:'provider/error',params:{message:error.message}});}
  async complete(options) {
    const model=options.model || this.defaultModel,effort=this.reasoningEffort(model,options.reasoningEffort);
    await this.start();
    const cwd=join(this.dataRoot,'chat-sandbox');mkdirSync(cwd,{recursive:true});
    const thread=await this.request('thread/start',{model:options.model || this.defaultModel,cwd,ephemeral:true,approvalPolicy:'never',sandbox:'read-only',config:{web_search:'disabled','features.shell_tool':false,'features.js_repl':false,'features.memories':false,'features.goals':false,'features.apply_patch_freeform':false,'mcp_servers':{},'apps':{_default:{enabled:false}}},baseInstructions:'你只生成聊天文本。不调用任何工具，不读取本机文件，不执行命令，不修改文件。',developerInstructions:options.system || ''});
    const id=thread.thread.id;
    const text=(options.messages || []).map(m=>{
      const content=typeof m.content==='string'?m.content:(m.content || []).map(x=>x.text || '').join('\n');
      return '['+(m.role || 'user')+'] '+content;
    }).join('\n\n');
    const timeout=110000;
    return new Promise(async(resolve,reject)=>{
      let output='',finished=false;
      const done=(error)=>{if(finished)return;finished=true;clearTimeout(timer);this.notifications.delete(listener);options.signal?.removeEventListener('abort',abort);error?reject(error):resolve(output.trim());};
      const listener=message=>{
        const p=message.params || {};if(p.threadId && p.threadId!==id)return;
        if(message.method==='item/agentMessage/delta')output+=p.delta || '';
        if(message.method==='thread/tokenUsage/updated') {
          const usage=p.tokenUsage?.total || p.tokenUsage?.totalTokenUsage || {};
          this.onUsage({purpose:options.purpose??'galgame',connectionIdentity:options.connectionIdentity,sessionId:id,model:options.model || this.defaultModel,timestamp:new Date().toISOString(),usage:{input_tokens:usage.inputTokens || 0,cached_input_tokens:usage.cachedInputTokens || 0,cache_write_input_tokens:usage.cacheWriteInputTokens || 0,output_tokens:usage.outputTokens || 0,reasoning_output_tokens:usage.reasoningOutputTokens || 0,total_tokens:usage.totalTokens || 0}});
        }
        if(message.method==='item/completed' && p.item?.type==='agentMessage' && !output)output=p.item.text || '';
        if(message.method==='turn/completed')done(p.turn?.status==='failed'?new Error(p.turn.error?.message || 'Codex 回复失败'):null);
        if(message.method==='provider/error')done(new Error(p.message));
        if(message.method==='item/started' && ['commandExecution','fileChange','mcpToolCall','webSearch','dynamicToolCall'].includes(p.item?.type)) {
          void this.request('turn/interrupt',{threadId:id,turnId:p.turnId},3000).catch(()=>{});done(new Error('陪伴会话尝试调用工具，已停止'));
        }
      };
      const abort=()=>{void this.request('turn/interrupt',{threadId:id},3000).catch(()=>{});done(new Error('对话已取消'));};
      const timer=setTimeout(()=>{abort();},timeout);
      this.notifications.add(listener);options.signal?.addEventListener('abort',abort,{once:true});
      if(options.signal?.aborted){abort();return;}
      try {await this.request('turn/start',{threadId:id,input:[{type:'text',text}],cwd,model,...(effort===null?{}:{effort}),approvalPolicy:'never',sandboxPolicy:{type:'readOnly'},summary:'concise'},15000);}catch(error){done(error);}
    });
  }
  async *stream(options) {
    if(!this.enabled) throw new Error('离线模式：请手动开启 Codex 聊天');
    const run=this.chatTail.then(()=>this.complete(options));this.chatTail=run.catch(()=>{});
    const text=await run;yield {type:'text-delta',text};yield {type:'finish',reason:{kind:'stop'}};
  }
  listProviders(){return [{id:'codex',name:'本机 Codex 登录'}];}
  listModels(){return structuredClone(this.models);}
  resolveModelInfo(model=this.defaultModel){const row=this.models.find(value=>value.id===model||value.model===model),supportedReasoningEfforts=structuredClone(row?.supportedReasoningEfforts??[]);return {reasoningEfforts:supportedReasoningEfforts.map(value=>value.reasoningEffort),supportedReasoningEfforts,defaultReasoningEffort:row?.defaultReasoningEffort??null};}
  reasoningEffort(model,value){
    if(value===null||value==='auto')return null;
    const effort=value===undefined?'low':value;
    if(typeof effort!=='string'||!REASONING_EFFORTS.has(effort))throw Error('Codex 推理强度无效，请重新选择');
    const known=this.models.find(row=>row.id===model||row.model===model),supported=this.resolveModelInfo(model).reasoningEfforts;
    if(Array.isArray(known?.supportedReasoningEfforts)&&!supported.includes(effort))throw Error('所选 Codex 模型不支持推理强度 '+effort+'，请重新选择');
    return effort;
  }
  async fetchModels(){
    if(this.catalogRequest)return this.catalogRequest;
    // A metadata-only process keeps model discovery independent of the chat switch
    // and never interrupts, enables, or sends a turn to the active chat process.
    const client=new CodexProvider({binary:this.binary,defaultModel:this.defaultModel,dataRoot:this.dataRoot,env:this.env,spawnImpl:this.spawnImpl,audit:event=>this.audit({...event,purpose:'model-list'}),clientInfo:{name:'ai_buddy_models',version:'1.9.0',title:'AI Buddy model catalog'}});
    this.catalogClient=client;client.setEnabled(true);
    this.catalogRequest=(async()=>{
      await client.start();const models=new Map(),cursors=new Set();let cursor;
      for(let page=0;page<100;page++){
        const result=await client.request('model/list',{limit:100,...(cursor?{cursor}:{})},15000);
        if(!result||!Array.isArray(result.data))throw Error('Codex 模型列表格式无效，请更新 Codex 后重试');
        for(const value of result.data){const model=catalogModel(value);if(model&&!model.hidden&&!models.has(model.id))models.set(model.id,model);}
        const next=result.nextCursor;
        if(next==null||next===''){this.models=[...models.values()];return this.listModels();}
        if(typeof next!=='string'||cursors.has(next))throw Error('Codex 模型列表分页无效，请重试');
        cursors.add(next);cursor=next;
      }
      throw Error('Codex 模型列表分页过多，请更新 Codex 后重试');
    })();
    try{return await this.catalogRequest;}finally{client.close();if(this.catalogClient===client)this.catalogClient=null;this.catalogRequest=null;}
  }
  close(){this.catalogClient?.close();this.setEnabled(false);}
}
