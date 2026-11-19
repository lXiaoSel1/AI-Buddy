import { spawn } from 'node:child_process';
import {imageDataUrl} from './model-images.mjs';
import { createInterface } from 'node:readline';
import { join,resolve } from 'node:path';
import { mkdirSync,readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import {codexHome,codexRuntimeError} from './runtime-discovery.mjs';
import {t} from './i18n.mjs';
import {outputQueue} from './output-events.mjs';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {checkNativeSearch,normalizeSearchSource} from './native-search.mjs';
import {createModelSubmission} from './model-submission.mjs';
import {buildCodexThreadFields,codexMessageText} from './codex-thread-wire.mjs';
import {createCompanionNativeStore} from './companion-cache-store.mjs';
import {CodexPrivateThreads} from './codex-private-threads.mjs';
import {codexBounded,CodexOwnedProcesses} from './codex-owned-process.mjs';

const REASONING_EFFORTS=new Set(['none','minimal','low','medium','high','xhigh','max','ultra']);
const systemClock={setTimeout,clearTimeout};
const cancelled=()=>Object.assign(new Error('对话已取消'),{code:'ABORT_ERR'});
function catalogModel(row){
  if(!row||typeof row!=='object'||Array.isArray(row))return null;
  const id=typeof row.model==='string'&&row.model.trim()?row.model.trim():typeof row.id==='string'?row.id.trim():'';
  if(!id)return null;
  const supportedReasoningEfforts=Array.isArray(row.supportedReasoningEfforts)?row.supportedReasoningEfforts.filter(value=>value&&typeof value.reasoningEffort==='string').map(value=>({reasoningEffort:value.reasoningEffort,description:typeof value.description==='string'?value.description:''})):[];
  // Keep the app-server's model identity and capabilities; no guessed model IDs or effort levels.
  return {...row,id,name:typeof row.displayName==='string'?row.displayName:typeof row.name==='string'?row.name:id,supportedReasoningEfforts,defaultReasoningEffort:typeof row.defaultReasoningEffort==='string'?row.defaultReasoningEffort:null};
}

export class CodexProvider extends EventEmitter {
  get supportsSubmissionLifecycle(){return true;}
  constructor({binary,defaultModel,dataRoot,onUsage=()=>{},audit=()=>{},imageGeneration=false,clientInfo=null,spawnImpl=spawn,env=process.env,requestTimeoutMs=110000,handshakeTimeoutMs=15000,turnTimeoutMs=110000,poolIdleMs=60000,threadIdleMs=30*60*1000,deleteIdleMs=Math.min(poolIdleMs,5000),clock=systemClock,nativeStore,privateThreads,ownedProcesses,osProcesses,routedClient=false}) {
    super(); Object.assign(this,{binary,defaultModel,dataRoot,onUsage,audit,spawnImpl,env});
    this.imageGeneration=imageGeneration;this.clientInfo=clientInfo;this.enabled=false; this.pending=new Map(); this.nextId=1; this.child=null; this.chatTail=Promise.resolve(); this.notifications=new Set();this.models=[];this.catalogClient=null;this.catalogRequest=null;
    this.searchClient=null;
    this.maintenanceClients=new Set();
    this.exitCleanup=new WeakMap();
    this.exitingChildren=new Set();
    this.routedClient=routedClient;
    this.nativeStore=privateThreads?.store??nativeStore??createCompanionNativeStore(dataRoot,audit);
    this.privateThreads=privateThreads??new CodexPrivateThreads(this.nativeStore,audit);
    this.ownedProcesses=ownedProcesses??new CodexOwnedProcesses(this.nativeStore,audit,osProcesses);
    this.ownsNativeStore=!privateThreads&&!nativeStore;
    this.knownNativeStorage=!!nativeStore;
    Object.assign(this,{requestTimeoutMs,handshakeTimeoutMs,turnTimeoutMs,poolIdleMs,threadIdleMs,deleteIdleMs,clock});
    this.activeTurns=0;
  }
  setEnabled(value) {
    if(value){if(!this.closing)this.enabled=true;return;}
    this.enabled=false;
    if(this.disabling)return this.disabling;
    const search=this.searchClient;
    this.searchClient=null;
    this.disabling=Promise.allSettled([search?.close(),this.stop()]).finally(()=>{this.disabling=null;});
    return this.disabling;
  }
  stop(){
    this.clock.clearTimeout(this.idleTimer);
    this.clock.clearTimeout(this.deleteTimer);
    if(this.stopping)return this.stopping;
    const child=this.child;
    if(!child)return this.terminating;
    this.stopping=(async()=>{
      const deadline=Date.now()+5000;
      const archived=await codexBounded(this.privateThreads.archiveLoaded(this).then(()=>true),2000,false);
      if(!archived)this.audit({type:'codex-native-archive-pending',code:'CODEX_ARCHIVE_SHUTDOWN_TIMEOUT'});
      if(this.child===child&&this.retiredThreadReleased){
        this.retiredThreadReleased=false;
        const until=Math.min(deadline-2500,Date.now()+1000);
        if(until>Date.now())await codexBounded(this.runDeleteBatch(()=>
          this.child===child&&Date.now()<until
        ),until-Date.now());
      }
      if(this.child===child){
        this.retiredThreadReleased=false;
        const exited=await this.endStdin(child,Math.max(0,deadline-Date.now()-2500));
        if(!exited)await this.terminate(child,new Error('联网聊天已关闭'),deadline);
      }
      const cleanup=this.exitCleanup.get(child);
      if(cleanup)await codexBounded(cleanup,deadline-Date.now());
    })().finally(()=>{this.stopping=null;});
    return this.stopping;
  }
  onRetiredThreadReleased(child){
    if(this.child!==child)return;
    this.retiredThreadReleased=true;
    this.deleteAttempted=false;
  }
  refreshIdle(){
    this.clock.clearTimeout(this.idleTimer);
    this.clock.clearTimeout(this.deleteTimer);
    if(!this.isIdle()||this.idleMaintenance)return;
    if((!this.routedClient||this.retiredThreadReleased)&&!this.deleteAttempted&&this.privateThreads.hasRetiredWork){
      this.deleteTimer=this.clock.setTimeout(()=>void this.deleteIdle(),this.deleteIdleMs);
      this.deleteTimer?.unref?.();
    }
    if(!this.privateThreads.hasLoaded(this)){
      this.idleTimer=this.clock.setTimeout(()=>void this.stop(),this.poolIdleMs);
      this.idleTimer?.unref?.();
    }
  }
  isIdle(){
    return this.enabled&&this.child&&!this.starting&&!this.stopping&&!this.pending.size&&!this.activeTurns;
  }
  async deleteIdle(){
    if(!this.isIdle())return;
    const child=this.child;
    this.clock.clearTimeout(this.idleTimer);
    this.deleteAttempted=true;
    this.retiredThreadReleased=false;
    this.idleMaintenance=true;
    try{
      await this.runDeleteBatch(()=>this.child===child&&this.isIdle());
    }finally{
      this.idleMaintenance=false;
      this.refreshIdle();
    }
  }
  async runDeleteBatch(canContinue){
    try{await this.privateThreads.deleteBatch(this,this.ownedProcesses.protectedKeys,canContinue);}
    catch(error){this.audit({type:'codex-native-cleanup-pending',code:error.code??'CODEX_NATIVE_CLEANUP_FAILED'});}
  }
  endStdin(child,timeoutMs){
    return new Promise(resolve=>{
      let timer,done=false;
      const finish=exited=>{if(done)return;done=true;clearTimeout(timer);child.removeListener('exit',onExit);resolve(exited);};
      const onExit=()=>finish(true);
      child.once('exit',onExit);
      if(this.child!==child){finish(true);return;}
      try{child.stdin.end();}catch{finish(false);return;}
      if(done)return;
      if(Number.isSafeInteger(child.pid)&&timeoutMs>0)timer=setTimeout(()=>finish(false),timeoutMs);
      else queueMicrotask(()=>finish(this.child!==child));
    });
  }
  terminate(child,error,deadline=Date.now()+2400){
    if(this.terminating)return this.terminating;
    if(this.child===child){
      this.child=null;
      this.privateThreads.detach(this,child);
      this.fail(error);
    }
    this.terminating=(async()=>{
      const killed=Number.isSafeInteger(child.pid)&&await this.ownedProcesses.killTree(child,deadline-Date.now());
      if(!killed)child.kill();
      child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
    })().finally(()=>{this.terminating=null;});
    return this.terminating;
  }
  async request(method,params={},timeout=this.requestTimeoutMs,boundary=null) {
    if(!this.child) throw new Error('Codex 对话进程尚未启动');
    const id=boundary?.requestId??this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);this.refreshIdle();reject(Object.assign(new Error(method+' 超时'),{code:'CODEX_REQUEST_TIMEOUT',method}));},timeout);
      this.pending.set(id,{resolve,reject,timer});
      this.refreshIdle();
      try{const wire=JSON.stringify({id,method,params})+'\n';boundary?.onWrite?.();this.child.stdin.write(wire);}catch(error){clearTimeout(timer);this.pending.delete(id);this.refreshIdle();reject(error);}
    });
  }
  async start(requireSearchHost=false) {
    if(this.startupRecovery)await this.startupRecovery;
    if(this.disabling)await this.disabling;
    if(this.stopping)await this.stopping;
    if(this.terminating)await this.terminating;
    if(!this.enabled) throw new Error('离线模式：请手动开启 Codex 聊天');
    if(this.starting){
      await this.starting;
      if(requireSearchHost||this.routedClient)return;
    }
    if(this.child){
      if(!requireSearchHost&&!this.routedClient&&await this.hasNativeStorage())await this.recoverThreadsOnce(this);
      return;
    }
    this.starting=(async()=>{
      const recover=await this.hasNativeStorage();
      if(recover)await this.recoverProcesses();
      // The Codex executable manages existing login itself. This app never reads auth.json.
      const overrides=['notify=[]','project_doc_max_bytes=0','thread_unload_delay_secs=0','web_search="disabled"','features.shell_tool=false','features.js_repl=false','features.memories=false','memories.generate_memories=false','features.goals=false','features.apps=false','features.image_generation='+this.imageGeneration];
      const binary=typeof this.binary==='function'?await this.binary({requireSearchHost}):this.binary;
      if(!this.enabled)throw new Error(t('联网聊天已关闭'));
      if(!binary)throw codexRuntimeError({code:'CODEX_NOT_FOUND'});
      mkdirSync(this.dataRoot,{recursive:true});
      let config='';try{config=readFileSync(join(codexHome(this.env),'config.toml'),'utf8');}catch(error){if(error.code!=='ENOENT')throw new Error(t('Codex 配置无法读取，请检查文件权限。'));}
      for(const match of config.matchAll(/^\[(plugins\.(?:"[^"]+"|[^.\]\s]+)|mcp_servers\.[^.\]\s]+)\]\s*$/gm))overrides.push(match[1]+'.enabled=false');
      const child=this.spawnImpl(binary,['app-server',...overrides.flatMap(x=>['-c',x])],{env:this.env,windowsHide:true,cwd:this.dataRoot,stdio:['pipe','pipe','pipe']});this.child=child;this.launchBinary=binary;
      this.ownerProcessKey=null;
      this.retiredThreadReleased=false;
      const spawned=new Promise((resolve,reject)=>{
        child.once('spawn',()=>{
          const key=this.ownedProcesses.register(child,binary);
          if(this.child===child)this.ownerProcessKey=key??null;
          resolve();
        });
        child.once('error',error=>reject(codexRuntimeError(error)));
        child.once('exit',()=>reject(new Error(t('Codex 对话进程已结束'))));
      });
      this.audit({type:'codex-process-start',online:true});
      createInterface({input:this.child.stdout}).on('line',line=>{
        if(this.child!==child)return;
        let message; try{message=JSON.parse(line);}catch{return;}
        if(message.id!==undefined && !message.method && this.pending.has(message.id)) {
          const p=this.pending.get(message.id);this.pending.delete(message.id);clearTimeout(p.timer);this.refreshIdle();
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
      const failed=error=>{if(this.child===child)void this.terminate(child,error);};
      child.stdin.on('error',()=>failed(new Error(t('Codex 对话进程已结束'))));
      child.on('error',error=>failed(codexRuntimeError(error)));
      child.on('exit',()=>{
        if(this.child===child){
          this.child=null;
          this.privateThreads.detach(this,child);
          this.fail(new Error(t('Codex 对话进程已结束')));
        }
        child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
        const cleanup=this.ownedProcesses.forget(child).finally(()=>this.exitingChildren.delete(cleanup));
        this.exitCleanup.set(child,cleanup);
        this.exitingChildren.add(cleanup);
      });
      await spawned;
      if(this.child!==child||!this.enabled)throw new Error(t('联网聊天已关闭'));
      await this.request('initialize',{clientInfo:this.clientInfo??{name:'whale_companion',version:'1.0.0',title:'鲸鱼娘本地陪伴'},capabilities:{experimentalApi:true}},this.handshakeTimeoutMs);
      this.child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
      const account=await this.request('account/read',{refreshToken:false},this.handshakeTimeoutMs);
      if(!account.account && account.requiresOpenaiAuth) throw new Error('本机 Codex 尚未登录，请先使用 Codex 自身登录入口');
      this.readyChild=child;
      if(recover&&!requireSearchHost&&!this.routedClient)await this.recoverThreadsOnce(this);
    })();
    try {await this.starting;} catch(error){const child=this.child;if(child)await this.terminate(child,error);else this.fail(error);throw error;} finally {this.starting=null;this.refreshIdle();}
  }
  async hasNativeStorage(){
    if(this.knownNativeStorage)return true;
    try{await access(join(this.dataRoot,'companion-cache-r1.sqlite'));this.knownNativeStorage=true;return true;}
    catch{return false;}
  }
  recoverProcesses(){
    this.ownedProcesses.recovering??=this.ownedProcesses.recover().catch(()=>this.audit({type:'codex-process-recovery-failed'}));
    return this.ownedProcesses.recovering;
  }
  recoverThreadsOnce(active){
    this.privateThreads.startupRecovery??=this.recoverThreads(active);
    return this.privateThreads.startupRecovery;
  }
  async recoverThreads(active){
    await this.recoverProcesses();
    const protectedKeys=this.ownedProcesses.protectedKeys;
    if(await this.privateThreads.needsRecovery(protectedKeys)){
      if(active)await this.privateThreads.recover(active,protectedKeys);
      else await this.withMaintenanceClient(client=>this.privateThreads.recover(client,protectedKeys));
    }
    // The delete RPC can scan the rollout directory. Keep it off the chat
    // startup promise and on an independent connection.
    void this.deleteStartupBatch(protectedKeys).catch(error=>
      this.audit({type:'codex-native-cleanup-pending',code:error.code??'CODEX_NATIVE_CLEANUP_FAILED'}));
  }
  async withMaintenanceClient(work){
    if(this.closing)return;
    const client=this.createSessionClient();
    this.maintenanceClients.add(client);
    try{client.setEnabled(true);await client.start();return await work(client);}
    finally{await client.close();this.maintenanceClients.delete(client);}
  }
  async deleteStartupBatch(protectedKeys){
    if(await this.privateThreads.needsDelete(protectedKeys)){
      await this.withMaintenanceClient(client=>
        this.privateThreads.deleteBatch(client,protectedKeys,()=>!!client.child&&!this.closing));
    }
  }
  recoverOwnedState(){
    if(this.closing||this.routedClient)return Promise.resolve();
    this.startupRecovery??=(async()=>{
      if(!await this.hasNativeStorage())return;
      await this.recoverProcesses();
      if(!this.closing)await this.recoverThreadsOnce(this.readyChild===this.child?this:null);
    })().finally(()=>{this.startupRecovery=null;});
    return this.startupRecovery;
  }
  fail(error) {for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();for(const l of [...this.notifications])try{l({method:'provider/error',params:{message:error.message}});}catch{}}
  async complete(options) {
    const submission=createModelSubmission(options,'codex');
    const native=options.cacheContext?.native;
    this.activeTurns++;
    this.deleteAttempted=false;
    this.refreshIdle();
    try{
      await submission.prepare();
      const result=await this.completeRequest(options,submission);
      // The host commits the same trimmed text returned by streamText.
      // Keep streamed deltas and native history intact.
      const output=result.output.trim();
      await submission.complete();
      if(result.promptTokens!=null){
        try{await options.onPromptUsage?.(result.promptTokens);}
        catch{this.audit({type:'codex-native-prompt-usage-failed'});}
      }
      if(result.active&&await this.privateThreads.complete(result.active,options.messages,output)){
        await options.onNativeThread?.({threadId:result.active.thread.id,requestId:native.requestId});
      }
      return output;
    }catch(error){
      if(native)await this.discardPrivateThread(native.requestId).catch(()=>this.audit({type:'codex-native-discard-failed'}));
      throw await submission.failure(error);
    }finally{
      this.activeTurns--;
      this.refreshIdle();
    }
  }
  commitPrivateThread(requestId,metadata){return this.privateThreads.commit(requestId,metadata);}
  discardPrivateThread(requestId){return this.privateThreads.discard(requestId);}
  async markPrivateThreadsForDeletion(selector){
    const marked=await this.privateThreads.markDelete(await this.privateThreads.select(selector));
    if(marked)this.refreshIdle();
    return marked;
  }
  deletePrivateThreads(selector){return this.maintainPrivateThreads(selector,true);}
  releasePrivateThreads(selector){return this.maintainPrivateThreads(selector,false);}
  async maintainPrivateThreads(selector,deleting){
    const records=(await this.privateThreads.select(selector)).filter(record=>deleting||!record.archived);
    if(!records.length)return {matched:0,pending:0};
    if(deleting)await this.privateThreads.markDelete(records);
    const active=this.child?this:this.searchClient?.child?this.searchClient:null;
    const client=active??this.createSessionClient();
    if(!active)this.maintenanceClients.add(client);
    const cleanup=record=>deleting?
      this.privateThreads.deleteMarked(client,record.threadId):
      this.privateThreads.archive(this.privateThreads.loaded.get(record.threadId)?.client??client,record.threadId);
    try{
      if(!active){client.setEnabled(true);await client.start();}
      const settled=[];
      for(const record of records)settled.push(await cleanup(record));
      return {matched:records.length,pending:settled.filter(result=>!result).length};
    }catch(error){
      this.audit({type:'codex-native-cleanup-pending',code:error.code??'CODEX_NATIVE_CLEANUP_FAILED'});
      return {matched:records.length,pending:records.length};
    }finally{if(!active){await client.close();this.maintenanceClients.delete(client);}}
  }
  async completeRequest(options,submission) {
    if(options.signal?.aborted)throw cancelled();
    const model=options.model || this.defaultModel,native=options.cacheContext?.native;
    const selectedEffort=this.reasoningEffort(model,options.reasoningEffort);
    const autoEffort=!!native&&selectedEffort===null;
    const timings=new Set(),mark=name=>{if(timings.has(name))return;timings.add(name);options.onStreamActivity?.();try{options.onTiming?.({name});}catch{}};
    await this.start(options.nativeSearch?.allowed===true);mark('process-ready');if(options.signal?.aborted)throw cancelled();
    const cwd=join(tmpdir(),'ai-buddy-chat',createHash('sha256').update(this.dataRoot).digest('hex').slice(0,24));mkdirSync(cwd,{recursive:true});
    const searchAllowed=options.nativeSearch?.allowed===true;if(searchAllowed)await checkNativeSearch(options);
    // Persistent injection writes retained evidence before turn/start. Check
    // its current scope before storage, then check again at submission.
    if(native)await options.checkModelSubmit?.();
    const buildFields=effort=>{
      const fields=buildCodexThreadFields({model,cwd,effort,serviceTier:options.serviceTier,searchAllowed,developerInstructions:options.system||''});
      if(!native){
        if(options.serviceTier==null){delete fields.thread.serviceTier;delete fields.turn.serviceTier;}
        delete fields.thread.config.model_reasoning_summary;
      }
      return fields;
    };
    const effort=autoEffort?await this.privateThreads.frozenAutoEffort(native,options.codexConnectionId,model,buildFields)??
      await this.resolveAutoEffort(model):selectedEffort;
    const fields=buildFields(native?effort:null);
    const active=native?await this.privateThreads.prepare(this,native,fields,options.messages??[],options.codexConnectionId,autoEffort):null;
    const thread=active?{thread:active.thread}:await this.request('thread/start',{...fields.thread,ephemeral:true,...(options.gameBinding?{allowProviderModelFallback:false}:{})});
    const id=thread.thread.id,ownerChild=this.child;
    let releasePromise;
    const release=()=>{
      if(!active&&this.child===ownerChild)releasePromise??=this.request('thread/unsubscribe',{threadId:id},Math.min(this.handshakeTimeoutMs,2000))
        .catch(error=>this.audit({type:'codex-ephemeral-unsubscribe-failed',code:error.code??'CODEX_UNSUBSCRIBE_FAILED'}));
      return releasePromise;
    };
    try{return await this.runTurn(options,submission,{thread,ownerChild,id,active,fields,effort,searchAllowed,model,mark,release});}
    finally{await release();}
  }
  async runTurn(options,submission,{thread,ownerChild,id,active,fields,effort,searchAllowed,model,mark,release}){
    if(options.gameBinding){const actualModel=thread.model??thread.thread.model,actualProvider=thread.modelProvider??thread.thread.modelProvider;if(actualModel!==options.gameBinding.model||actualProvider!==(options.gameBinding.nativeProvider??'openai'))throw Object.assign(Error('游戏模型或提供商与冻结绑定不一致'),{code:'GAME_NATIVE_BINDING_MISMATCH'});}
    submission.details.threadId=id;mark('thread-ready');if(options.signal?.aborted)throw cancelled();
    // A local Codex process can use a custom model_provider. Do not grant it
    // first-party search merely because the connection is labelled "Codex".
    if(searchAllowed&&thread.thread.modelProvider!=='openai')throw Object.assign(new Error('当前 Codex 实际提供商未核实原生搜索能力，未提交本轮请求'),{code:'NATIVE_SEARCH_PROVIDER_UNVERIFIED'});
    if(searchAllowed)options.onDelta?.({type:'native-search-status',status:'available',provider:'codex',model,protocol:'codex'});
    const messages=options.messages??[];
    const current=active?messages.slice(-1):messages;
    const turnMessages=active?.sendFullWindow?messages:current;
    const images=current.flatMap(m=>Array.isArray(m.content)?m.content.filter(p=>p.type==='image'):[]);
    const text=turnMessages.map(message=>'['+(message.role||'user')+'] '+codexMessageText(message)).join('\n\n');
    return new Promise((resolve,reject)=>{
      let output='',finished=false,turnId=null,accepted=false,bufferBytes=0,evidenceBytes=0,evidenceOverflow=false,correlation='unverified',usageSignature=null,promptTokens=null,messageTail=Promise.resolve(),requestId=null;const items=new Map(),seen=new Set(),buffer=[],terminalEvents=[],searchSources=new Set(),citedSources=new Set(),searchTools=new Set();
      const eventTurn=message=>message.params?.turnId??message.params?.turn?.id??null;
      const evidence=(selectedTurn=turnId,verified=correlation)=>{
        const events=terminalEvents.filter(message=>!selectedTurn||eventTurn(message)===selectedTurn),completed=events.filter(message=>message.method==='turn/completed'),finalItems=events.filter(message=>message.method==='item/completed'&&message.params?.item?.type==='agentMessage'),texts=new Map();
        const consistent=finalItems.every(message=>{const item=message.params.item;if(typeof item.id!=='string'||!item.id||typeof item.text!=='string'||texts.has(item.id)&&texts.get(item.id)!==item.text)return false;texts.set(item.id,item.text);return true;});
        return {transport:'codex',requestId,threadId:id,turnId:selectedTurn,correlation:verified,complete:!evidenceOverflow&&!!selectedTurn&&completed.length>0&&completed.every(message=>message.params?.turn?.status==='completed')&&finalItems.length>0&&consistent,overflow:evidenceOverflow,events:structuredClone(events)};
      };
      const done=(error)=>{if(finished)return;finished=true;clearTimeout(timer);this.notifications.delete(listener);options.signal?.removeEventListener('abort',abort);const receipt=evidence();buffer.length=0;void(async()=>{try{if(receipt.events.length||receipt.overflow)await submission.evidence(receipt);error?reject(error):resolve({output,active,promptTokens});}catch(cause){reject(cause);}})();};
      const interrupt=()=>{if(turnId&&this.child===ownerChild)void this.request('turn/interrupt',{threadId:id,turnId},Math.min(3000,this.handshakeTimeoutMs)).catch(error=>stopUnknown(error));};
      const stopUnknown=error=>{if(this.child===ownerChild)void this.terminate(ownerChild,error);};
      const emit=(text,itemId)=>{if(!text)return;mark('first-delta');output+=text;options.onDelta?.({type:'text-delta',text,threadId:id,turnId,itemId});};
      const processMessage=async message=>{
        if(finished)return;const p=message.params||{},messageTurn=eventTurn(message);if(turnId&&(messageTurn&&messageTurn!==turnId||message.method!=='thread/tokenUsage/updated'&&messageTurn!==turnId))return;
        const eventId=p.eventId??p._meta?.eventId??message.eventId,sequence=p.sequence??p._meta?.sequence,key=eventId==null?(sequence==null?null:[message.method,messageTurn,p.itemId??p.item?.id,sequence].join(':')):'id:'+eventId;
        if(key&&seen.has(key))return;if(key)seen.add(key);
        if(message.method==='item/agentMessage/delta'){
          const itemId=p.itemId??'legacy-message',previous=items.get(itemId)??{text:'',completed:false};if(previous.completed)return;const text=p.delta||'';previous.text+=text;items.set(itemId,previous);emit(text,p.itemId);
        }
        if(message.method==='thread/tokenUsage/updated') {
          const lastInput=p.tokenUsage?.last?.inputTokens;
          if(active&&messageTurn===turnId&&Number.isFinite(lastInput)&&lastInput>0)promptTokens=lastInput;
          // The monitor differences cumulative samples for each native session.
          const total=p.tokenUsage?.total??p.tokenUsage?.totalTokenUsage;
          if(!total)return;
          const usage=Object.fromEntries(Object.entries({
            input_tokens:total.inputTokens,cached_input_tokens:total.cachedInputTokens,
            cache_write_input_tokens:total.cacheWriteInputTokens,output_tokens:total.outputTokens,
            reasoning_output_tokens:total.reasoningOutputTokens,total_tokens:total.totalTokens,
          }).filter(([,value])=>Number.isFinite(value)&&value>=0));
          if(!Object.keys(usage).length)return;
          const signature=JSON.stringify(usage);if(signature===usageSignature)return;usageSignature=signature;
          this.onUsage({purpose:options.purpose??'galgame',activityOriginId:options.activityOriginId,scope:options.scope,connectionIdentity:options.connectionIdentity,sessionId:id,model:options.model || this.defaultModel,timestamp:new Date().toISOString(),usage});
        }
        if(message.method==='item/completed'&&p.item?.type==='agentMessage'){
          const itemId=p.item.id??'legacy-message',previous=items.get(itemId)??{text:'',completed:false};if(!previous.completed){const text=p.item.text??previous.text;if(typeof text!=='string'||!text.startsWith(previous.text)){interrupt();done(Object.assign(new Error('Codex 最终正文与已显示的增量不一致，已保留原文'),{code:'CODEX_STREAM_MISMATCH'}));return;}emit(text.slice(previous.text.length),p.item.id);items.set(itemId,{text,completed:true});}
        }
        if(['item/started','item/completed'].includes(message.method)&&p.item?.type==='webSearch'&&searchAllowed){
          await checkNativeSearch(options);if(finished)return;
          const item=p.item,key=item.id+':'+message.method;if(!searchTools.has(key)){searchTools.add(key);options.onDelta?.({type:'native-search-tool',provider:'codex',model,id:item.id,name:'web_search',status:message.method==='item/completed'?'completed':'started',query:item.query??item.action?.query});}
          if(message.method==='item/completed'){const rows=[...(item.sources??[]),...(item.action?.sources??[]),...(item.results??[])];if(item.action?.url)rows.push({url:item.action.url});for(const row of rows){const source=normalizeSearchSource(row,{provider:'codex',model,retrievedAt:new Date().toISOString(),evidenceType:'codex-webSearch-item'});if(source&&!searchSources.has(source.url)){searchSources.add(source.url);options.onDelta?.({type:'native-search-sources',sources:[source]});}}}
        }
        // An annotation marks the source as cited; one already reported as a search result is reported again
        // with cited:true (merged by URL downstream), so cited sources can be listed first.
        if(message.method==='item/completed'&&p.item?.type==='agentMessage'&&searchAllowed){await checkNativeSearch(options);if(finished)return;for(const citation of p.item.annotations??p.item.citations??[]){const source=normalizeSearchSource(citation,{provider:'codex',model,retrievedAt:new Date().toISOString(),evidenceType:'codex-message-annotation',cited:true});if(!source)continue;if(!searchSources.has(source.url))searchSources.add(source.url);else if(citedSources.has(source.url))continue;citedSources.add(source.url);options.onDelta?.({type:'native-search-sources',sources:[source]});}}
        if(message.method==='turn/completed'){
          void release();
          const status=p.turn?.status;if(status==='completed'){mark('model-complete');if(searchAllowed)options.onDelta?.({type:'native-search-status',status:searchTools.size||searchSources.size?'completed':'not-used',sourceCount:searchSources.size});done();}else done(status==='interrupted'?cancelled():Object.assign(new Error(p.turn?.error?.message||'Codex 回复未正常完成'),{code:'CODEX_TURN_FAILED'}));
        }
        if(message.method==='error'&&p.willRetry!==true)done(Object.assign(new Error(p.error?.message??p.message??'Codex 回复失败'),{code:'CODEX_TURN_FAILED'}));
        if(message.method==='item/started'&&(searchAllowed?!['userMessage','agentMessage','reasoning','plan','webSearch','contextCompaction'].includes(p.item?.type):['commandExecution','fileChange','mcpToolCall','dynamicToolCall','webSearch'].includes(p.item?.type))) {
          interrupt();done(new Error('陪伴会话尝试调用工具，已停止'));
        }
      };
      const listener=message=>{
        if(finished)return;const p=message.params??{};if(message.method==='provider/error'){done(new Error(p.message));return;}if(p.threadId!==id)return;
        try{
          const messageTurn=eventTurn(message);if(!turnId||messageTurn===turnId||!messageTurn&&message.method==='thread/tokenUsage/updated')options.onStreamActivity?.();
          if(message.method==='turn/completed'||message.method==='item/completed'&&p.item?.type==='agentMessage'){
            const bytes=Buffer.byteLength(JSON.stringify(message));if(evidenceBytes+bytes>8*1024*1024||terminalEvents.length>=4096){evidenceOverflow=true;done(Object.assign(new Error('Codex 完整回执超过保留上限'),{code:'CODEX_STREAM_OVERFLOW'}));stopUnknown(new Error('Codex 回执超过保留上限'));return;}evidenceBytes+=bytes;terminalEvents.push(structuredClone(message));
          }
          if(!accepted){bufferBytes+=Buffer.byteLength(JSON.stringify(message));if(bufferBytes>8*1024*1024){evidenceOverflow=true;done(Object.assign(new Error('Codex 回复事件过多'),{code:'CODEX_STREAM_OVERFLOW'}));stopUnknown(new Error('Codex 回复事件过多'));return;}buffer.push(message);return;}messageTail=messageTail.then(()=>processMessage(message)).catch(error=>{interrupt();done(error);});
        }catch(error){interrupt();done(error);}
      };
      const abort=()=>{if(finished)return;const error=cancelled();if(turnId){interrupt();done(error);}else{done(error);stopUnknown(error);}};
      const timer=options.gameBinding?null:setTimeout(()=>{if(finished)return;const error=Object.assign(new Error('Codex 回复超时，已停止本次请求；已显示原文保留'),{code:'CODEX_TURN_TIMEOUT'});if(turnId){interrupt();done(error);}else{done(error);stopUnknown(error);}},this.turnTimeoutMs);
      this.notifications.add(listener);options.signal?.addEventListener('abort',abort,{once:true});
      if(options.signal?.aborted){abort();return;}
      const accept=async(value,verified)=>{
        turnId=value;correlation=verified;submission.details.turnId=turnId;
        if(finished||options.signal?.aborted){interrupt();return;}await submission.confirm({correlation});if(finished)return;mark('turn-submitted');
        accepted=true;for(const message of buffer.splice(0))messageTail=messageTail.then(()=>processMessage(message));await messageTail;
      };
      void Promise.resolve().then(async()=>{
        const params={...fields.turn,threadId:id,input:[{type:'text',text},...images.map(p=>({type:'image',url:imageDataUrl(p)}))],...(effort===null?{}:{effort})};
        // Reserve the RPC identity before awaiting the durable claim. Nothing
        // chargeable is written until the last private authorization check.
        requestId=this.nextId++;JSON.stringify({id:requestId,method:'turn/start',params});
        if(searchAllowed)await checkNativeSearch(options);await submission.beforeSend({requestId});if(finished||options.signal?.aborted)throw cancelled();
        return this.request('turn/start',params,this.handshakeTimeoutMs,{requestId,onWrite:()=>{if(finished||options.signal?.aborted||!this.enabled||this.stopping)throw cancelled();if(this.child!==ownerChild)throw Object.assign(new Error('Codex 准备请求所属进程已变化，未提交'),{code:'CODEX_PROCESS_CHANGED'});submission.attempt();}});
      }).then(async result=>{
        if(typeof result?.turn?.id!=='string'||!result.turn.id)throw Object.assign(new Error('Codex 请求确认缺少精确轮次，未接纳同线程事件'),{code:'CODEX_ACK_INVALID'});
        await accept(result.turn.id,'ack');
      },async error=>{
        if(finished)return;
        if(error.code==='CODEX_REQUEST_TIMEOUT'){
          const candidates=new Set(terminalEvents.filter(message=>(message.params?.requestId??message.params?._meta?.requestId)===requestId).map(eventTurn).filter(Boolean));
          if(candidates.size===1){const candidate=[...candidates][0],receipt=evidence(candidate,'request-id');if(receipt.complete){await accept(candidate,'request-id');return;}}
        }
        done(error);if(error.code==='CODEX_REQUEST_TIMEOUT')stopUnknown(error);
      }).catch(error=>{if(finished)return;done(error);stopUnknown(error);});
    });
  }
  async *stream(options) {
    const client=await this.selectClient(options.nativeSearch?.allowed===true);
    yield* client.streamLocal(options);
  }
  async selectClient(searchAllowed){
    if(!searchAllowed||this.routedClient||typeof this.binary!=='function'||!this.enabled)return this;
    if(this.searchClient)return this.searchClient;
    const [ordinary,search]=await Promise.all([
      this.child?this.launchBinary:this.binary({requireSearchHost:false}),
      this.binary({requireSearchHost:true}),
    ]);
    if(!this.enabled||!search)return this;
    const pathKey=path=>!path?null:process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
    if(pathKey(ordinary)===pathKey(search))return this;
    this.searchClient??=this.createSessionClient({binary:search});
    this.searchClient.models=this.models;
    this.searchClient.setEnabled(true);
    return this.searchClient;
  }
  createSessionClient(overrides={}){
    return new CodexProvider({
      binary:this.binary,defaultModel:this.defaultModel,dataRoot:this.dataRoot,env:this.env,
      spawnImpl:this.spawnImpl,audit:this.audit,onUsage:this.onUsage,clientInfo:this.clientInfo,
      requestTimeoutMs:this.requestTimeoutMs,handshakeTimeoutMs:this.handshakeTimeoutMs,
      turnTimeoutMs:this.turnTimeoutMs,poolIdleMs:this.poolIdleMs,threadIdleMs:this.threadIdleMs,deleteIdleMs:this.deleteIdleMs,clock:this.clock,
      privateThreads:this.privateThreads,nativeStore:this.knownNativeStorage?this.nativeStore:undefined,ownedProcesses:this.ownedProcesses,
      routedClient:true,...overrides,
    });
  }
  async *streamLocal(options) {
    if(!this.enabled) throw new Error('离线模式：请手动开启 Codex 聊天');
    const queue=outputQueue(),controller=new AbortController();const abort=()=>{controller.abort(options.signal?.reason);queue.fail(cancelled());};
    if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});
    let promptTokens,finished=false;
    const run=this.chatTail.then(()=>this.complete({
      ...options,signal:controller.signal,
      onDelta:part=>{if(!queue.push(part))controller.abort();},
      onPromptUsage:options.onPromptUsage?tokens=>{promptTokens=tokens;}:undefined,
    }));
    this.chatTail=run.catch(()=>{});
    void run.then(()=>{queue.push({type:'finish',reason:{kind:'stop'}});queue.close();},error=>queue.fail(error));
    try{
      for await(const part of queue){
        if(part.type==='finish')finished=true;
        yield part;
      }
    }finally{
      const calibrate=finished&&!controller.signal.aborted&&promptTokens!=null;
      controller.abort();
      options.signal?.removeEventListener('abort',abort);
      // The consumer can return immediately after finish. Only then can
      // calibration start writing to the shared cache used to close the turn.
      if(calibrate)void Promise.resolve().then(()=>options.onPromptUsage(promptTokens))
        .catch(()=>this.audit({type:'codex-native-prompt-usage-failed'}));
    }
  }
  async *streamForConnection(connectionId,options){
    if(!this.enabled)throw Error('联网聊天已关闭');
    if(typeof connectionId!=='string'||!connectionId||connectionId.length>300)throw Error('Codex 聊天连接身份无效');
    yield* this.stream({...options,codexConnectionId:connectionId});
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
  async resolveAutoEffort(model){
    let row=this.models.find(value=>value.id===model||value.model===model);
    if(!row){
      this.models=await this.readModelCatalog();
      row=this.models.find(value=>value.id===model||value.model===model);
    }
    if(REASONING_EFFORTS.has(row?.defaultReasoningEffort))return row.defaultReasoningEffort;
    if(row&&row.supportedReasoningEfforts?.length===0)return 'none';
    throw Object.assign(Error(t('无法确认 Codex 模型的默认推理强度，请刷新模型列表或手动选择推理强度。')),{code:'CODEX_NATIVE_AUTO_EFFORT_UNAVAILABLE'});
  }
  async readModelCatalog(){
    const models=new Map(),cursors=new Set();
    let cursor;
    for(let page=0;page<100;page++){
      const result=await this.request('model/list',{limit:100,...(cursor?{cursor}:{})},this.handshakeTimeoutMs);
      if(!result||!Array.isArray(result.data))throw Error('Codex 模型列表格式无效，请更新 Codex 后重试');
      for(const value of result.data){
        const model=catalogModel(value);
        if(model&&!model.hidden&&!models.has(model.id))models.set(model.id,model);
      }
      const next=result.nextCursor;
      if(next==null||next==='')return [...models.values()];
      if(typeof next!=='string'||cursors.has(next))throw Error('Codex 模型列表分页无效，请重试');
      cursors.add(next);cursor=next;
    }
    throw Error('Codex 模型列表分页过多，请更新 Codex 后重试');
  }
  async fetchModels(){
    if(this.catalogRequest)return this.catalogRequest;
    // A metadata-only process keeps model discovery independent of the chat switch
    // and never interrupts, enables, or sends a turn to the active chat process.
    const client=this.createSessionClient({audit:event=>this.audit({...event,purpose:'model-list'}),clientInfo:{name:'ai_buddy_models',version:'1.9.0',title:'AI Buddy model catalog'}});
    this.catalogClient=client;client.setEnabled(true);
    this.catalogRequest=(async()=>{
      await client.start();
      this.models=await client.readModelCatalog();
      return this.listModels();
    })();
    try{return await this.catalogRequest;}finally{await client.close();if(this.catalogClient===client)this.catalogClient=null;this.catalogRequest=null;}
  }
  close(){
    this.closing??=codexBounded(Promise.allSettled([
      this.catalogClient?.close(),this.setEnabled(false),...[...this.maintenanceClients].map(client=>client.close()),
    ]).then(()=>Promise.allSettled(this.exitingChildren)).then(()=>this.ownsNativeStore?this.nativeStore.close():undefined),5000);
    return this.closing;
  }
}
