import {EventEmitter} from 'node:events';
import {readdir,realpath,stat,lstat,open} from 'node:fs/promises';
import {join,relative,isAbsolute,resolve,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {redactAgentValue} from './agent-task-store.mjs';
import {buildCharacterWorkContext,workExperienceSource} from './character-context-bridge.mjs';
import {workEvidenceHash,validateWorkEvidence} from './companion-life-archive.mjs';
import {lastAgentUsageBaseline} from './agent-usage.mjs';

const failure=(message,code,details)=>Object.assign(Error(message),{code,...(details?{details}:{})});
const clone=value=>structuredClone(value);
const LIVE=new Set(['running','waiting-for-user','cancelling']);
const IGNORED=new Set(['.git','node_modules','.cache','.venv','venv','target','dist']);
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export function agentBinding(value={}){
  const binding={connectionId:value.connectionId??value.id,provider:value.provider,model:value.model,effort:value.effort??null,harness:value.harness??value.kind??'codex'};
  if(value.connectionFingerprint!=null){if(!/^[a-f0-9]{64}$/.test(value.connectionFingerprint))throw failure('工作连接来源校验值无效','AGENT_CONNECTION_INVALID');binding.connectionFingerprint=value.connectionFingerprint;}
  if(value.workTransport!=null)binding.workTransport=clone(value.workTransport);
  if(!binding.connectionId||!binding.model||!binding.provider)throw failure('工作连接缺少身份、厂商或模型','AGENT_CONNECTION_INVALID');
  for(const key of ['connectionId','provider','model','harness'])if(typeof binding[key]!=='string'||binding[key].length>300)throw failure('工作连接参数无效','AGENT_CONNECTION_INVALID');
  return binding;
}
export async function canonicalAgentWorkspace(path){
  if(typeof path!=='string'||!isAbsolute(path))throw failure('请选择绝对路径的项目目录','WORKSPACE_REQUIRED');
  const canonical=await realpath(resolve(path));if(!(await stat(canonical)).isDirectory())throw failure('工作目录不是文件夹','WORKSPACE_REQUIRED');
  const identity=process.platform==='win32'?canonical.toLowerCase():canonical;
  return {id:'workspace-'+digest(identity),path:canonical};
}
async function fileDigest(path){const handle=await open(path,'r');try{const hash=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);return hash.digest('hex');}finally{await handle.close();}}
/** Every included file is hashed. Exclusions are explicit and recorded in the checkpoint. */
export async function inspectAgentWorkspace(workspace,{maxFiles=20000,maxBytes=256*1024*1024}={}){
  const current=await canonicalAgentWorkspace(workspace.path);if(current.id!==workspace.id)throw failure('项目目录的实际身份已变化','WORKSPACE_IDENTITY_CHANGED');
  const entries=[];let bytes=0;
  async function walk(directory){
    for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      if(IGNORED.has(entry.name))continue;const path=join(directory,entry.name),name=relative(workspace.path,path).split(sep).join('/');
      if(entry.isSymbolicLink())throw failure('项目中含有无法核对授权边界的链接：'+name,'WORKSPACE_LINK_UNSUPPORTED');
      if(entry.isDirectory()){await walk(path);continue;}if(!entry.isFile())continue;
      const before=await lstat(path);bytes+=before.size;if(entries.length>=maxFiles||bytes>maxBytes)throw failure('项目核对超过本次容量，请选择更具体的项目目录','WORKSPACE_TOO_LARGE',{maxFiles,maxBytes});
      const sha256=await fileDigest(path),after=await lstat(path);
      if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw failure('核对期间项目文件发生变化，请稍后重试','WORKSPACE_CHANGING');
      entries.push({path:name,size:after.size,sha256});
    }
  }
  await walk(workspace.path);return {workspaceId:workspace.id,digest:digest(JSON.stringify(entries)),fileCount:entries.length,bytes,entries,excluded:[...IGNORED]};
}
function changes(before,after){const old=new Map((before?.entries??[]).map(row=>[row.path,row])),next=new Map(after.entries.map(row=>[row.path,row]));return {added:[...next.keys()].filter(key=>!old.has(key)),removed:[...old.keys()].filter(key=>!next.has(key)),changed:[...next.keys()].filter(key=>old.has(key)&&next.get(key).sha256!==old.get(key).sha256)};}
function scopeOf(spec){const value={characterId:spec.characterId??spec.scope?.characterId,personaId:spec.personaId??spec.scope?.personaId,lifeId:spec.lifeId??spec.scope?.lifeId,operationId:spec.operationId??spec.scope?.operationId};for(const [key,id]of Object.entries(value))if(typeof id!=='string'||!id||id.length>300)throw failure('工作任务缺少明确归属：'+key,'AGENT_SCOPE_INVALID');return value;}
function collectSecrets(value,result=[],depth=0){if(depth>8||!value||typeof value!=='object')return result;for(const [key,item]of Object.entries(value)){if((/api.?key|password|secret|authorization|access.?token|refresh.?token/i.test(key)||key==='key'||key==='keyCiphertext')&&typeof item==='string')result.push(item);else if(typeof item==='object')collectSecrets(item,result,depth+1);}return result;}
function eventKey(event){const id=event.eventId??event.id??event.payload?.eventId;if(id!=null)return `${event.sessionId??''}:${id}`;if(event.sequence!=null)return `${event.sessionId??''}:${event.turnId??''}:${event.sequence}`;return null;}
function eventText(events){return events.filter(event=>event.type==='text'&&!event.replay).map(event=>event.payload?.text??'').join('');}

export class AgentTaskService extends EventEmitter {
  constructor({store,adapterFactory,connectionResolver,contextProvider,scopeResolver,requestPolicy,onEvent=()=>{},onUsage=()=>{},onExperience=()=>{},now=Date.now,cancelTimeoutMs=10000,workspaceOptions,workspaceInspector=inspectAgentWorkspace,confirmationTtlMs=300000}={}){
    super();if(!store||typeof adapterFactory!=='function'||typeof connectionResolver!=='function')throw Error('工作任务服务缺少存储或执行器');
    Object.assign(this,{store,adapterFactory,connectionResolver,contextProvider,scopeResolver,requestPolicy,onEvent,onUsage,onExperience,now,cancelTimeoutMs,workspaceOptions,workspaceInspector,confirmationTtlMs});
    this.runs=new Map();this.writerLocks=new Map();this.queue=[];this.closed=false;this.initializing=null;this.starting=new Map();this.scheduling=new Set();this.presenting=new Map();
    this.confirmations=new Map();this.generations=new Map();this.preparations=new Map();
  }
  async init(){if(!this.initializing)this.initializing=(async()=>{await this.store.init();await this.store.recoverInterrupted();return this;})();return this.initializing;}
  async guard(task){
    if(this.closed)throw failure('工作任务服务已关闭','AGENT_SERVICE_CLOSED');if(!this.scopeResolver)return;
    const actual=await this.scopeResolver(clone(task));
    if(!actual||['characterId','personaId','lifeId','operationId'].some(key=>actual[key]!=null&&actual[key]!==task.scope[key]))throw failure('该任务属于已结束的人生或不可访问的身份','AGENT_STALE_SCOPE');
    if(actual.lifeId==null||actual.operationId==null)throw failure('无法确认工作任务当前人生','AGENT_STALE_SCOPE');
  }
  async create(spec={},trusted={}){
    await this.init();const scope=scopeOf(spec),instruction=String(spec.instruction??spec.goal??'').trim();if(!instruction||instruction.length>512*1024)throw failure('请填写有效的工作目标','AGENT_INSTRUCTION_REQUIRED');
    const workspace=await canonicalAgentWorkspace(spec.workspace??spec.workspacePath),connection=await this.connectionResolver({...spec,scope,workspace}),binding=agentBinding(connection);
    if(trusted.expectedBinding&&JSON.stringify(binding)!==JSON.stringify(trusted.expectedBinding))throw failure('续建期间连接已经变化，请重新核对','AGENT_BINDING_CHANGED');
    // This first work profile has write tools. A renderer cannot bypass the
    // workspace writer lock by claiming that its task is read-only.
    if(spec.writing===false)throw failure('当前工作引擎不提供只读任务模式','AGENT_READ_ONLY_UNSUPPORTED');
    const task={id:'task-'+randomUUID(),scope,workspace,binding,title:String(spec.title??instruction.slice(0,80)).slice(0,200),instruction,writing:true,status:'queued',pendingRequests:[],outcomeUnknown:false,...trusted.metadata};
    await this.guard(task);task.checkpoint=await this.workspaceInspector(workspace,this.workspaceOptions);
    const raw=await this.contextProvider?.(clone(task));const context=raw?.developerInstructions?raw:buildCharacterWorkContext({task,...raw});
    task.context={hash:context.hash??digest(context.developerInstructions),cardRevision:context.cardRevision??null,sources:context.sources??[]};
    await this.guard(task);trusted.check?.();
    const created=await this.store.create(task);this.publish(created,'created');return created;
  }
  publish(task,type,event){const value={taskId:task.id,scope:clone(task.scope),status:task.status,type,revision:task.revision,...(event?{event}:{} )};this.emit('event',value);try{this.onEvent(value);}catch{}return value;}
  read(value){const {taskId,scope={}}=typeof value==='string'?{taskId:value}:value??{},task=this.store.read(taskId);for(const [key,id]of Object.entries(scope))if(id!=null&&task.scope?.[key]!==id)throw failure('无法读取该身份的工作记录','AGENT_SCOPE_DENIED');return task;}
  list(scope={}){return this.store.list(scope);}
  generation(taskId){return this.generations.get(taskId)??0;}
  checkGeneration(taskId,generation){if(this.closed||generation!==this.generation(taskId))throw failure('工作任务已取消','ABORT_ERR');}
  invalidateChecks(taskId){for(const [id,value]of this.confirmations)if(value.taskId===taskId||value.expiresAt<=this.now())this.confirmations.delete(id);}
  confirmationIdentity(task){return digest({taskId:task.id,scope:task.scope,workspace:task.workspace,binding:task.binding,previous:task.checkpoint?.digest??null,attempt:task.pendingAttempt,generation:this.generation(task.id)});}
  workspaceCheck(task,current){
    this.invalidateChecks(task.id);const requestId=task.pendingAttempt?.submitted===false?task.pendingAttempt.requestId:null;
    const check={taskId:task.id,requestId,unchanged:current.digest===task.checkpoint?.digest,previous:task.checkpoint?.digest??null,digest:current.digest,current,changes:changes(task.checkpoint,current)};
    if(requestId){check.checkId='workspace-check-'+randomUUID();check.expiresAt=this.now()+this.confirmationTtlMs;this.confirmations.set(check.checkId,{taskId:task.id,requestId,digest:current.digest,identity:this.confirmationIdentity(task),expiresAt:check.expiresAt});}
    return check;
  }
  async restorePendingAttempt(task){
    if(task.pendingAttempt||task.outcomeUnknown||!task.queuedRequestId||task.queuedRequestId===task.completedRequestId)return task;
    const original=task.events.find(event=>event.type==='user'&&event.requestId===task.queuedRequestId);
    if(!original||typeof original.payload?.text!=='string')return task;
    // Legacy queued records are safe to recover only when no model submission
    // is known. A result-unknown request always requires a fresh user decision.
    if(task.errorCode!=='WORKSPACE_CHANGED'&&task.recoveryReason!=='application-restarted')return task;
    return this.store.patch(task.id,{pendingAttempt:{requestId:task.queuedRequestId,kind:task.turnCount?'continue':'initial',text:original.payload.text,newSession:task.restoredSessionPending===true,submitted:false,createdAt:original.at??task.updatedAt,legacy:true}});
  }
  async inspectWorkspace({taskId,requestId}={}){
    await this.init();let task=this.store.read(taskId);await this.guard(task);const generation=this.generation(taskId);task=await this.restorePendingAttempt(task);
    if(requestId!=null&&requestId!==task.pendingAttempt?.requestId)throw failure('核对请求已过期，请重新核对项目','WORKSPACE_CONFIRMATION_EXPIRED');
    const inspectedIdentity=this.confirmationIdentity(task),current=await this.workspaceInspector(task.workspace,this.workspaceOptions);this.checkGeneration(taskId,generation);await this.guard(task);this.checkGeneration(taskId,generation);const latest=this.store.read(taskId);
    if(inspectedIdentity!==this.confirmationIdentity(latest)||requestId!=null&&requestId!==latest.pendingAttempt?.requestId)throw failure('核对请求已过期，请重新核对项目','WORKSPACE_CONFIRMATION_EXPIRED');return this.workspaceCheck(latest,current);
  }
  validateSchedule(options,action){
    if(Object.hasOwn(options,'acceptWorkspaceDigest'))throw failure('仅文件摘要不足以确认本轮请求，请重新核对项目','WORKSPACE_CONFIRMATION_REQUIRED');
    const allowed=action==='start'?['taskId','workspaceConfirmation']:['taskId','text','newSession','workspaceConfirmation'];
    if(Object.keys(options).some(key=>!allowed.includes(key))||options.newSession!=null&&typeof options.newSession!=='boolean')throw failure('工作操作参数无效','AGENT_ACTION_INVALID');
  }
  async start(options={}){return this.schedule(options,'start');}
  async continue(options={}){return this.schedule(options,'continue');}
  async continueScheduled(options={}){return this.schedule(options,'continue');}
  async schedule(options,action){
    this.validateSchedule(options,action);await this.init();const {taskId}=options;
    if(this.scheduling.has(taskId)){if(action==='start')return this.store.read(taskId);throw failure('该工作任务仍在排队','AGENT_BUSY');}
    this.scheduling.add(taskId);const generation=this.generation(taskId),promise=this.prepareAndEnqueue(options,action,generation);this.preparations.set(taskId,promise);
    try{return await promise;}catch(error){if(error.code==='ABORT_ERR'&&!this.runs.has(taskId)){const paused=await this.store.patch(taskId,{status:'paused-recoverable',error:'工作任务已取消',errorCode:'ABORT_ERR',errorDetails:null,pendingRequests:[],outcomeUnknown:false});this.publish(paused,'cancelled');}throw error;}finally{this.scheduling.delete(taskId);if(this.preparations.get(taskId)===promise)this.preparations.delete(taskId);}
  }
  async verifyBinding(task){
    const connection=await this.connectionResolver(clone(task)),binding=agentBinding(connection);
    if(!task.binding.connectionFingerprint&&binding.connectionFingerprint)throw failure('旧工作记录缺少原始连接地址校验，无法确认恢复来源；请核对旧配置并创建新任务，原始记录保留','AGENT_BINDING_UNVERIFIED');
    if(task.binding.provider==='deepseek'&&!task.binding.workTransport&&binding.workTransport)throw failure('旧 DeepSeek 工作记录缺少实际工作通道证据，请核对连接后续建任务，原记录保留','AGENT_WORK_TRANSPORT_UNVERIFIED');
    if(JSON.stringify(binding)!==JSON.stringify(task.binding))throw failure('角色工作连接或模型已经改变；此任务保持原绑定，需先恢复原配置','AGENT_BINDING_CHANGED');
    return {connection,binding};
  }
  async prepareAndEnqueue(options,action,generation){
    const {taskId,text,workspaceConfirmation}=options;let task=this.store.read(taskId);await this.guard(task);this.checkGeneration(taskId,generation);
    if(this.runs.has(taskId)||this.queue.some(row=>row.taskId===taskId)||this.starting.has(taskId)){if(action==='start')return task;throw failure('该工作任务仍在执行','AGENT_BUSY');}
    task=await this.restorePendingAttempt(task);this.checkGeneration(taskId,generation);
    if(task.outcomeUnknown&&!(typeof text==='string'&&text.trim()))throw failure('上次操作结果尚未确认，请填写继续说明并先核对实际结果','AGENT_CONTINUE_INSTRUCTION_REQUIRED');
    let attempt=task.pendingAttempt?.submitted===false?task.pendingAttempt:null;
    const newSession=options.newSession===true||task.restoredSessionPending===true||attempt?.newSession===true;
    if(!attempt||text!=null&&text!==attempt.text||newSession!==attempt.newSession){
      const initial=!task.turnCount&&!task.sessionId&&!task.restoredSessionPending;
      const prompt=text??(initial?task.instruction:'继续本任务。先核对当前项目、最后的执行结果和未完成步骤；结果未知的命令不要盲目重复执行。');
      if(typeof prompt!=='string'||!prompt.trim()||prompt.length>512*1024)throw failure('继续任务的内容无效','AGENT_INSTRUCTION_REQUIRED');
      this.invalidateChecks(taskId);attempt={requestId:'work-turn-'+randomUUID(),kind:initial?'initial':'continue',text:prompt,newSession,submitted:false,createdAt:this.now()};
      task=await this.store.patch(taskId,{pendingAttempt:attempt,queuedRequestId:attempt.requestId});this.checkGeneration(taskId,generation);
      task=await this.store.append(taskId,{type:'user',requestId:attempt.requestId,payload:{text:attempt.text}});this.checkGeneration(taskId,generation);
    }
    const current=await this.workspaceInspector(task.workspace,this.workspaceOptions);this.checkGeneration(taskId,generation);await this.guard(task);this.checkGeneration(taskId,generation);
    try{
      if(workspaceConfirmation){
        const saved=this.confirmations.get(workspaceConfirmation.checkId);
        if(!saved||saved.expiresAt<=this.now()||saved.identity!==this.confirmationIdentity(task)||saved.taskId!==taskId||saved.requestId!==workspaceConfirmation.requestId||saved.digest!==workspaceConfirmation.digest)throw failure('核对请求已过期，请重新核对项目','WORKSPACE_CONFIRMATION_EXPIRED');
        await this.verifyBinding(task);this.checkGeneration(taskId,generation);
        if(saved.digest!==current.digest)throw failure('核对后项目又有变化，请重新核对','WORKSPACE_CHANGED',this.workspaceCheck(task,current));
        this.invalidateChecks(taskId);await this.store.append(taskId,{type:'workspace-confirmed',requestId:attempt.requestId,payload:{digest:current.digest,previous:task.checkpoint?.digest??null}});this.checkGeneration(taskId,generation);
      }else if(current.digest!==task.checkpoint?.digest)throw failure('项目文件已变化，请先核对变更后继续','WORKSPACE_CHANGED',this.workspaceCheck(task,current));
      task=await this.store.patch(taskId,{checkpoint:current});this.checkGeneration(taskId,generation);
      return await this.enqueue(task,{requestId:attempt.requestId,text:attempt.text,resume:!!task.sessionId&&!attempt.newSession,newSession:attempt.newSession,generation});
    }catch(error){
      if(error.code==='WORKSPACE_CHANGED'){const paused=await this.store.patch(taskId,{status:'paused-recoverable',error:error.message,errorCode:error.code,errorDetails:error.details,pendingRequests:[],outcomeUnknown:false});this.publish(paused,'stopped');}
      throw error;
    }
  }
  async enqueue(task,options){
    this.checkGeneration(task.id,options.generation);
    const queued=await this.store.patch(task.id,{status:'queued',error:null,errorCode:null,errorDetails:null,pendingRequests:[],queuedRequestId:options.requestId});this.checkGeneration(task.id,options.generation);
    this.queue.push({taskId:task.id,...options});this.publish(queued,'queued');void this.drain();return this.store.read(task.id);
  }
  async fork(options={}){
    await this.init();const {taskId}=options;
    if(this.scheduling.has(taskId)||this.runs.has(taskId)||this.starting.has(taskId)||this.queue.some(row=>row.taskId===taskId))throw failure('请先停止原工作任务再续建','AGENT_BUSY');
    this.scheduling.add(taskId);const generation=this.generation(taskId),promise=this.forkScheduled(options,generation);this.preparations.set(taskId,promise);
    try{return await promise;}finally{this.scheduling.delete(taskId);if(this.preparations.get(taskId)===promise)this.preparations.delete(taskId);}
  }
  async forkScheduled({taskId,text,expectedConnectionFingerprint},generation){
    const source=this.store.read(taskId);await this.guard(source);this.checkGeneration(taskId,generation);
    if(source.journalError||this.store.corrupt?.has(taskId))throw failure('工作任务原始日志损坏，不能创建不完整续建证据；原文件已保留','AGENT_JOURNAL_CORRUPT');
    if(source.outcomeUnknown&&!(typeof text==='string'&&text.trim()))throw failure('上次操作结果尚未确认，请填写继续说明并先核对实际结果','AGENT_CONTINUE_INSTRUCTION_REQUIRED');
    if(text!=null&&(typeof text!=='string'||text.length>512*1024))throw failure('继续任务的内容无效','AGENT_INSTRUCTION_REQUIRED');
    await this.store.verifyTask?.(taskId);this.checkGeneration(taskId,generation);
    let binding;
    if(source.binding.provider==='deepseek'&&!source.binding.workTransport){
      if(typeof expectedConnectionFingerprint!=='string'||!expectedConnectionFingerprint)throw failure('请先核对当前工作连接再续建任务','AGENT_FORK_CONFIRMATION_REQUIRED');
      const connection=await this.connectionResolver(clone(source),{legacyFork:true,expectedConnectionFingerprint});binding=agentBinding(connection);this.checkGeneration(taskId,generation);
      if(binding.connectionFingerprint!==expectedConnectionFingerprint)throw failure('角色工作连接或模型已经改变；此任务保持原绑定，需先恢复原配置','AGENT_BINDING_CHANGED');
      if(binding.provider==='deepseek'&&!binding.workTransport)throw failure('旧 DeepSeek 工作记录缺少实际工作通道证据，请核对连接后续建任务，原记录保留','AGENT_WORK_TRANSPORT_UNVERIFIED');
    }else ({binding}=await this.verifyBinding(source));
    this.checkGeneration(taskId,generation);
    const body={version:1,taskId:source.id,revision:source.revision,scope:clone(source.scope),workspace:clone(source.workspace),binding:clone(source.binding),instruction:source.instruction,outcomeUnknown:source.outcomeUnknown===true,unresolvedChecks:clone(source.unresolvedChecks??[]),events:clone(source.events.filter(event=>['text','tool','user'].includes(event.type)))},sourceEvidence={...body,sha256:digest(body)};
    const forked=await this.create({...source.scope,workspace:source.workspace.path,title:source.title+' · 续建',instruction:source.instruction},{expectedBinding:binding,check:()=>this.checkGeneration(taskId,generation),metadata:{sourceEvidence,sourceGuidance:text??null,continuedFrom:{taskId:source.id,revision:source.revision,sha256:sourceEvidence.sha256},pendingEvidence:true,status:'paused-recoverable'}});this.publish(forked,'forked');return forked;
  }
  async drain(){
    if(this.closed)return;
    for(const entry of [...this.queue]){
      const task=this.store.read(entry.taskId);if(this.runs.has(task.id)||this.starting.has(task.id)||task.writing&&this.writerLocks.has(task.workspace.id))continue;
      this.queue.splice(this.queue.indexOf(entry),1);if(task.writing)this.writerLocks.set(task.workspace.id,task.id);
      const promise=this.run(task,entry);this.starting.set(task.id,promise);promise.catch(()=>{}).finally(()=>{this.starting.delete(task.id);if(this.writerLocks.get(task.workspace.id)===task.id)this.writerLocks.delete(task.workspace.id);void this.drain();});
    }
  }
  async run(initial,entry){
    const id=initial.id,run={taskId:id,adapter:null,controller:new AbortController(),tail:Promise.resolve(),seen:new Set(),pending:new Map(),unresolvedTools:new Map((initial.unresolvedChecks??[]).map(check=>[check.key,check])),eventError:null,sessionId:null,turnId:null,requestId:entry.requestId,secrets:[],cancelled:false,submitted:false};this.runs.set(id,run);
    let completion;
    const checkRun=()=>{this.checkGeneration(id,entry.generation);if(run.cancelled||run.controller.signal.aborted)throw failure('工作任务已取消','ABORT_ERR');};
    try{
      let task=this.store.read(id);await this.guard(task);checkRun();
      const actual=await canonicalAgentWorkspace(task.workspace.path);checkRun();if(actual.id!==task.workspace.id)throw failure('工作目录身份发生变化','WORKSPACE_IDENTITY_CHANGED');
      const before=await this.workspaceInspector(task.workspace,this.workspaceOptions);checkRun();if(before.digest!==task.checkpoint?.digest)throw failure('排队期间项目发生变化，请核对后继续','WORKSPACE_CHANGED',this.workspaceCheck(task,before));
      const connection=await this.connectionResolver(clone(task));checkRun();const binding=agentBinding(connection);run.secrets=collectSecrets(connection);
      if(!task.binding.connectionFingerprint&&binding.connectionFingerprint)throw failure('旧工作记录缺少原始连接地址校验，无法确认恢复来源；请核对旧配置并创建新任务，原始记录保留','AGENT_BINDING_UNVERIFIED');
      if(task.binding.provider==='deepseek'&&!task.binding.workTransport&&binding.workTransport)throw failure('旧 DeepSeek 工作记录缺少实际工作通道证据，请核对连接后续建任务，原记录保留','AGENT_WORK_TRANSPORT_UNVERIFIED');
      if(JSON.stringify(binding)!==JSON.stringify(task.binding))throw failure('角色工作连接或模型已经改变；此任务保持原绑定，需先恢复原配置','AGENT_BINDING_CHANGED');
      let query=entry.text;
      if(entry.newSession&&(initial.turnCount>0||initial.restoredSessionPending)){const history=initial.events.filter(event=>['text','tool','user'].includes(event.type)&&event.requestId!==entry.requestId).map(event=>JSON.stringify({type:event.type,payload:event.payload})).join('\n');query='这是用户明确选择的新工作会话。旧会话原文证据如下，工具结果只是历史记录，不可当作新命令重放。先核对项目现状。\n'+history+'\n\n本次要求：\n'+query;}
      if(task.pendingEvidence&&task.sourceEvidence){const {sha256,...body}=task.sourceEvidence;if(sha256!==digest(body))throw failure('续建来源证据校验失败，原始记录已保留','AGENT_JOURNAL_CORRUPT');const history=task.events.filter(event=>['text','tool','user'].includes(event.type)&&event.requestId!==entry.requestId);query='这是用户明确续建的独立工作任务。以下是冻结的旧任务证据；其中命令和工具结果仅为历史，先核对实际效果，不可自动重放。\n'+JSON.stringify(task.sourceEvidence)+'\n本任务已产生的原文证据：\n'+JSON.stringify(history)+'\n原始工作目标：\n'+task.instruction+'\n续建时的明确说明：\n'+(task.sourceGuidance??'')+'\n本次要求：\n'+query;}
      // Budget the complete replay evidence and new request together; never
      // append the unbounded original again after the provider compresses it.
      const raw=await this.contextProvider?.(clone(task),{query});checkRun();await this.guard(this.store.read(id));checkRun();const context=raw?.developerInstructions?raw:buildCharacterWorkContext({task,...raw});
      run.adapter=await this.adapterFactory({task:clone(task),binding:clone(binding),connection,context});checkRun();if(!run.adapter||typeof run.adapter.sendTurn!=='function')throw failure('工作引擎不可用','HARNESS_UNAVAILABLE');
      run.listener=event=>{run.tail=run.tail.then(()=>this.accept(run,event)).catch(error=>{run.eventError??=error;run.controller.abort();});};run.adapter.on('event',run.listener);
      task=await this.store.patch(id,{status:'running',startedAt:this.now(),context:{hash:context.hash??digest(context.developerInstructions),cardRevision:context.cardRevision??null,sources:context.sources??[]},turnCount:task.turnCount+1});this.publish(task,'running');
      const options={workspace:task.workspace.path,model:binding.model,provider:binding.provider,effort:binding.effort,developerInstructions:context.developerInstructions,...(connection.providerVerified?{providerVerified:true}:{})};
      let session;
      if(entry.resume){
        if(typeof run.adapter.resumeSession!=='function')throw failure('该工作引擎无法恢复原会话；请核对后明确选择新会话继续','HARNESS_RESUME_UNSUPPORTED');
        session=await run.adapter.resumeSession({...options,sessionId:task.sessionId,usageBaseline:lastAgentUsageBaseline(task,task.sessionId)});
      }else session=await run.adapter.startSession(options);
      checkRun();if(session.model!==binding.model||session.provider&&session.provider!==binding.provider)throw failure('工作引擎实际使用的模型或厂商与固定绑定不符','HARNESS_MODEL_MISMATCH');
      if(!session.sessionId||entry.resume&&session.sessionId!==task.sessionId)throw failure('工作会话身份发生变化','HARNESS_SESSION_MISMATCH');
      run.sessionId=session.sessionId;await this.store.patch(id,{sessionId:session.sessionId,sessionCapabilities:session.capabilities??{},sessionRecovery:entry.newSession?'new-session-with-records':entry.resume?'native':'new',outcomeUnknown:false});
      await this.guard(this.store.read(id));checkRun();
      const prompt=context.queryText??query;
      checkRun();await this.store.patch(id,{pendingAttempt:{...this.store.read(id).pendingAttempt,submitted:true,submittedAt:this.now()}});checkRun();run.submitted=true;const result=await run.adapter.sendTurn({sessionId:session.sessionId,text:prompt,model:binding.model,effort:binding.effort,signal:run.controller.signal,clientMessageId:entry.requestId});await run.tail;
      if(run.eventError)throw run.eventError;await this.guard(this.store.read(id));if(run.cancelled||run.controller.signal.aborted)throw failure('工作任务已取消','ABORT_ERR');
      if(result.status!=='completed')throw failure('工作执行结果尚未确认','AGENT_OUTCOME_UNKNOWN');
      if(run.unresolvedTools.size)throw failure('本轮仍有失败的工具或检查，任务尚未完成。请核对后继续修复。','AGENT_CHECKS_FAILED',{checks:[...run.unresolvedTools.values()]});
      const checkpoint=await this.workspaceInspector(task.workspace,this.workspaceOptions);checkRun();
      completion={status:'completed',completedAt:this.now(),turnId:result.turnId??run.turnId,completedRequestId:entry.requestId,checkpoint,pendingRequests:[],pendingAttempt:null,unresolvedChecks:[],restoredSessionPending:false,pendingEvidence:false,outcomeUnknown:false,error:null,errorCode:null,errorDetails:null};
    }catch(error){
      await run.tail.catch(()=>{});const task=this.store.read(id),code=run.eventError?.code??error.code??'AGENT_FAILED';
      const failureDetails=(run.eventError??error).details;
      // Only the task-owned transport knows whether Codex's sendTurn reached
      // an upstream model. Its lifetime counter includes prior tool rounds.
      if(code==='HARNESS_WORK_CONTEXT_CAPACITY'&&failureDetails?.upstreamSubmitted===false&&failureDetails.upstreamAttempts===0)run.submitted=false;
      const recoverable=['AGENT_BINDING_CHANGED','AGENT_BINDING_UNVERIFIED','AGENT_WORK_TRANSPORT_UNVERIFIED','HARNESS_MODEL_MISMATCH','HARNESS_PROVIDER_MISMATCH','HARNESS_MODEL_UNAVAILABLE','HARNESS_PROVIDER_UNVERIFIED','HARNESS_RESUME_UNSUPPORTED','WORKSPACE_CHANGED','WORKSPACE_IDENTITY_CHANGED','WORKSPACE_LINK_UNSUPPORTED','AGENT_STALE_SCOPE','HARNESS_UNAVAILABLE','HARNESS_EFFORT_UNSUPPORTED','ABORT_ERR','HARNESS_DISCONNECTED','HARNESS_TIMEOUT','AGENT_OUTCOME_UNKNOWN','AGENT_SERVICE_CLOSED','AGENT_CHECKS_FAILED'].includes(code)||code.startsWith('HARNESS_WORK_');
      const next=await this.store.patch(id,{status:recoverable?'paused-recoverable':'failed',error:redactAgentValue(String((run.eventError??error).message),run.secrets),errorCode:code,errorDetails:redactAgentValue(failureDetails??null,run.secrets),unresolvedChecks:[...run.unresolvedTools.values()],outcomeUnknown:code!=='AGENT_CHECKS_FAILED'&&run.submitted,pendingRequests:[],...(!run.submitted&&task.pendingAttempt?{pendingAttempt:{...task.pendingAttempt,submitted:false}}:{})});this.publish(next,'stopped');
    }finally{
      if(run.cancelTimer)clearTimeout(run.cancelTimer);if(run.listener)run.adapter?.removeListener('event',run.listener);
      try{await this.disposeAdapter(run);if(completion){await this.guard(this.store.read(id));checkRun();const completed=await this.store.patch(id,completion);this.publish(completed,'completed');}}
      catch(error){const task=this.store.read(id);const paused=await this.store.patch(id,{status:'paused-recoverable',error:redactAgentValue(String(error.message),run.secrets),errorCode:error.code==='ABORT_ERR'||error.code==='AGENT_SERVICE_CLOSED'||error.code==='AGENT_STALE_SCOPE'?error.code:'HARNESS_DISPOSE_FAILED',outcomeUnknown:run.submitted||task.outcomeUnknown});this.publish(paused,'stopped');}
      if(run.cancelTimer)clearTimeout(run.cancelTimer);this.runs.delete(id);
    }
  }
  disposeAdapter(run){if(!run.adapter)return Promise.resolve();return run.disposal??=Promise.resolve().then(()=>run.adapter.dispose?.());}
  async accept(run,input){
    const task=this.store.read(run.taskId);await this.guard(task);if(this.runs.get(run.taskId)!==run||run.controller.signal.aborted&&input.type!=='status')return;
    if(input.replay)return; // ACP load history cannot re-enter text, usage or memory.
    if(run.sessionId&&input.sessionId&&input.sessionId!==run.sessionId)return;
    const key=eventKey(input);if(key&&run.seen.has(key))return;if(key)run.seen.add(key);
    const event=redactAgentValue({type:input.type,requestId:run.requestId,sessionId:input.sessionId??run.sessionId,turnId:input.turnId??null,itemId:input.itemId??null,replay:false,payload:input.payload??{}},run.secrets);
    if(event.turnId)run.turnId=event.turnId;
    if(!['text','tool','status','usage','request'].includes(event.type))return;
    if(event.type==='tool'){
      const item=event.payload.item??event.payload.update??event.payload,state=event.payload.state??item.status,exitCode=item.exitCode??item.exit_code??item.rawOutput?.exitCode??item.result?.exitCode;
      const key=String(item.command??item.rawInput?.command??item.rawInput?.commandLine??item.path??item.rawInput?.path??item.title??item.type??item.kind??event.itemId??'tool');
      const failed=['failed','error','denied'].includes(state)||Number.isInteger(exitCode)&&exitCode!==0;
      if(failed)run.unresolvedTools.set(key,{key,itemId:event.itemId,turnId:event.turnId,exitCode:exitCode??null,tool:item.type??item.kind??item.title??null});
      else if(['completed','complete','succeeded','success'].includes(state)||exitCode===0)run.unresolvedTools.delete(key);
    }
    if(event.type==='request'){
      const requestId=event.payload.requestId;if(requestId==null)throw failure('工作引擎请求缺少标识','AGENT_REQUEST_INVALID');if(!await this.allowRequest(run,task,event.payload))return;run.pending.set(String(requestId),event.payload);
      await this.store.patch(task.id,{status:'waiting-for-user',pendingRequests:[...run.pending.values()]});
    }
    if(event.type==='status'&&['model-mismatch','disconnected'].includes(event.payload.status))throw failure(event.payload.status==='model-mismatch'?'执行器更改了模型，任务已暂停':'工作执行器连接中断',event.payload.status==='model-mismatch'?'HARNESS_MODEL_MISMATCH':'HARNESS_DISCONNECTED');
    const saved=await this.store.append(task.id,event);this.publish(saved,'output',saved.events.at(-1));
    if(event.type==='usage'&&event.payload.billable!==false&&event.payload.usage)await this.onUsage({...event.payload,taskId:task.id,scope:clone(task.scope),workspaceId:task.workspace.id,workspace:task.workspace.path,nativeSessionId:event.sessionId,turnId:event.turnId,connection:clone(task.binding),requestId:run.requestId,eventId:key??`${task.id}:${saved.revision}`});
  }
  async allowRequest(run,task,request,result){
    const denial=await this.requestPolicy?.({task:clone(task),request:clone(request),tools:clone(task.events),...(result===undefined?{}:{result:clone(result)})});if(!denial?.denied)return true;
    await run.adapter.respondToRequest({requestId:request.requestId,result:denial.result});
    const saved=await this.store.append(task.id,{type:'status',requestId:run.requestId,sessionId:run.sessionId,payload:{status:'permission-denied',requestId:request.requestId,method:request.method,reason:redactAgentValue(denial.reason,run.secrets),request:redactAgentValue(request,run.secrets)}});this.publish(saved,'output',saved.events.at(-1));return false;
  }
  async respond({taskId,requestId,result,error}={}){
    const task=this.store.read(taskId);await this.guard(task);const run=this.runs.get(taskId);if(!run||!run.pending.has(String(requestId)))throw failure('该输入请求不存在或已处理','AGENT_REQUEST_EXPIRED');
    const pending=run.pending.get(String(requestId));run.pending.delete(String(requestId));
    if(!await this.allowRequest(run,task,pending,result)){const saved=await this.store.patch(taskId,{status:run.pending.size?'waiting-for-user':'running',pendingRequests:[...run.pending.values()]});this.publish(saved,'request-response');return saved;}
    try{await run.adapter.respondToRequest({requestId,result,error});}catch(failure){if(this.runs.get(taskId)===run)run.pending.set(String(requestId),pending);throw failure;}
    const saved=await this.store.patch(taskId,{status:run.pending.size?'waiting-for-user':'running',pendingRequests:[...run.pending.values()]});await this.store.append(taskId,{type:'request-response',requestId:run.requestId,payload:{requestId,answered:true,rejected:!!error}});this.publish(saved,'request-response');return this.store.read(taskId);
  }
  async present({taskId,requestId}={}){
    const key=taskId+':'+requestId;if(this.presenting.has(key))return this.presenting.get(key);
    const promise=this.presentOnce({taskId,requestId});this.presenting.set(key,promise);try{return await promise;}finally{if(this.presenting.get(key)===promise)this.presenting.delete(key);}
  }
  async presentOnce({taskId,requestId}={}){
    let task=this.store.read(taskId);await this.guard(task);
    if(task.status!=='completed'||!requestId||requestId!==task.completedRequestId)throw failure('工作报告尚未完成或已不是当前轮次','AGENT_PRESENTATION_INVALID');
    const eventId=`work:${taskId}:${requestId}`;if(task.experienceEventId===eventId)return task;
    // Freeze the presentation time before touching the companion store. If a
    // process exits between the two commits, replay has the same source hash.
    if(task.pendingPresentation?.requestId!==requestId)task=await this.store.patch(taskId,{pendingPresentation:{requestId,at:this.now()}});
    const source=workExperienceSource(task,{text:eventText(task.events.filter(event=>event.requestId===requestId)),eventId,at:task.pendingPresentation.at});
    // The receiver must deduplicate source.id as well: a process can exit after
    // the callback commits but before this journal records its acknowledgement.
    await this.onExperience(source,clone(task));const saved=await this.store.patch(taskId,{experienceEventId:eventId,presentedAt:task.pendingPresentation.at,pendingPresentation:null,experienceError:null});this.publish(saved,'presented');return saved;
  }
  async cancel({taskId}={}){
    const task=this.store.read(taskId);await this.guard(task);this.generations.set(taskId,this.generation(taskId)+1);this.invalidateChecks(taskId);const queued=this.queue.findIndex(row=>row.taskId===taskId);
    if(queued>=0){this.queue.splice(queued,1);const next=await this.store.patch(taskId,{status:'paused-recoverable',error:null,outcomeUnknown:false});this.publish(next,'cancelled');return next;}
    const run=this.runs.get(taskId);if(!run){if(this.scheduling.has(taskId)){const next=await this.store.patch(taskId,{status:'paused-recoverable',error:null,errorCode:null,errorDetails:null,pendingRequests:[],outcomeUnknown:false});this.publish(next,'cancelled');return next;}return task;}
    run.cancelled=true;const saved=await this.store.patch(taskId,{status:'cancelling'});this.publish(saved,'cancelling');run.controller.abort();
    // ABORT signal asks the owned adapter to interrupt; timeout closes only it.
    run.cancelTimer=setTimeout(()=>{this.disposeAdapter(run).catch(()=>{});},this.cancelTimeoutMs);run.cancelTimer.unref?.();return saved;
  }
  async wait(taskId){
    while(this.queue.some(row=>row.taskId===taskId)||this.starting.has(taskId)||this.runs.has(taskId)||this.preparations.has(taskId)){
      const promise=this.starting.get(taskId)??this.preparations.get(taskId);if(promise)await promise.catch(()=>{});else await new Promise(resolve=>setTimeout(resolve,5));
    }return this.store.read(taskId);
  }
  async pauseCharacter(characterId){const ids=this.store.list({characterId}).filter(task=>LIVE.has(task.status)||this.queue.some(entry=>entry.taskId===task.id)).map(task=>task.id);for(const taskId of ids)await this.cancel({taskId});await Promise.all(ids.map(id=>this.starting.get(id)).filter(Boolean));return !this.store.list({characterId}).some(task=>LIVE.has(task.status));}
  assertCharacterIdle(characterId){if(this.store.list({characterId}).some(task=>LIVE.has(task.status)||this.queue.some(entry=>entry.taskId===task.id)))throw failure('请先暂停该角色的工作任务，再保存或切换人生','AGENT_LIFE_BUSY');}
  snapshotLife({characterId,lifeId,operationId}={}){
    this.assertCharacterIdle(characterId);const tasks=this.store.list({characterId,lifeId,...(operationId?{operationId}:{})}).map(row=>this.store.read(row.id));if(!tasks.length)return null;
    if(tasks.some(task=>task.journalError))throw failure('工作任务原始日志损坏，不能创建不完整人生备份；原文件已保留','AGENT_JOURNAL_CORRUPT');
    const evidence={version:1,characterId,lifeId,tasks};return {...evidence,sha256:workEvidenceHash(evidence)};
  }
  async restoreLife({characterId,lifeId,operationId,evidence,transactionId}={}){
    await this.init();validateWorkEvidence(evidence,{characterId,lifeId});this.assertCharacterIdle(characterId);if(!transactionId||!operationId)throw failure('工作证据恢复事务缺少标识','AGENT_RESTORE_INVALID');
    const ids=[];
    for(const source of evidence.tasks){
      // The same life transaction can replay after a power loss. It creates
      // independent paused records; it never replays commands or project files.
      const id='task-'+digest([transactionId,source.id]).slice(0,40),old=this.store.get(id);ids.push(id);if(old?.restorationComplete)continue;
      if(!old){const {events,revision,updatedAt,...metadata}=source;await this.store.create({...metadata,id,scope:{...source.scope,characterId,lifeId,operationId},status:'paused-recoverable',pendingRequests:[],originalCreatedAt:source.createdAt,restoredFrom:{taskId:source.id,transactionId,sha256:evidence.sha256}});}
      const done=new Set(this.store.read(id).events.map(event=>event.restoredEventIndex));
      for(const [index,event]of source.events.entries())if(!done.has(index))await this.store.append(id,{...event,sourceSequence:event.sequence,restoredEventIndex:index,restoredEvidence:true});
      await this.store.patch(id,{status:'paused-recoverable',sessionId:null,archivedNativeSessionId:source.sessionId??source.archivedNativeSessionId??null,restoredSessionPending:true,turnCount:source.turnCount??0,completedRequestId:source.completedRequestId??null,experienceEventId:source.experienceEventId??null,pendingRequests:[],outcomeUnknown:source.outcomeUnknown===true||LIVE.has(source.status),recoveryReason:'life-restored',error:'已恢复工作记录。项目文件保持当前状态，继续前将重新核对，并以档案证据创建独立新会话。',restorationComplete:true});
    }
    return {restoredTaskIds:ids,sha256:evidence.sha256,externalFilesChanged:false};
  }
  async action(action,payload={}){await this.init();switch(action){case'create':return this.create(payload);case'start':return this.start(payload);case'continue':return this.continue(payload);case'fork':return this.fork(payload);case'cancel':return this.cancel(payload);case'respond':return this.respond(payload);case'present':return this.present(payload);case'list':return this.list(payload.scope??payload);case'read':return this.read(payload);case'inspect-workspace':return this.inspectWorkspace(payload);default:throw Error('未知的工作任务操作');}}
  async dispose(){if(this.closed)return;this.closed=true;this.confirmations.clear();this.queue.length=0;for(const taskId of this.scheduling)this.generations.set(taskId,this.generation(taskId)+1);for(const run of this.runs.values()){run.cancelled=true;run.controller.abort();this.disposeAdapter(run).catch(()=>{});}await Promise.allSettled([...this.preparations.values(),...this.starting.values()]);await this.store.flush();}
}
