import {EventEmitter} from 'node:events';
import {join,resolve,relative,isAbsolute,dirname,basename,sep} from 'node:path';
import {realpath,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {AgentTaskStore,redactAgentValue} from './agent-task-store.mjs';
import {AgentTaskService} from './agent-task-service.mjs';
import {createAgentAdapterFactory} from './agent-work-profile.mjs';
import {defaultContextCapacity} from './context-capacity.mjs';
import {apiBaseUrl} from './model-presets.mjs';
import {connectionIdentity} from './service-identity.mjs';
import {resolveWorkCapability,workTransportBinding,workContextOverheadTokens} from './work-capabilities.mjs';
import {resolveHarnessRuntime} from './harness-profiles/shared.mjs';

const ACTIONS=new Set(['create','start','continue','cancel','respond','present','list','read','inspect-workspace','characters','capabilities','fork']);
const SCOPE_FIELDS=['characterId','personaId','lifeId','operationId'];
const failure=(message,code)=>Object.assign(Error(message),{code});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const matches=(task,scope)=>SCOPE_FIELDS.every(key=>task.scope?.[key]===scope?.[key]);
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
export function agentConnectionFingerprint(profile){
  const value={kind:profile.kind,protocol:profile.protocol??profile.kind,baseUrl:profile.kind==='codex'?'':apiBaseUrl(profile.baseUrl),model:profile.model,effort:profile.reasoningEffort??profile.effort??null};
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
const permissionMethods=new Set(['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','session/request_permission']);
function requestDenial(request,reason){return {denied:true,reason,result:request.method==='session/request_permission'?{outcome:{outcome:'cancelled'}}:request.method==='item/permissions/requestApproval'?{permissions:{},scope:'turn'}:{decision:'decline'}};}
const within=(root,path)=>{const rel=relative(root,path);return !rel||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);};
async function authorizedPath(root,value){
  if(typeof value!=='string'||!value||value.includes('\0')||/^[a-z][a-z0-9+.-]*:\/\//i.test(value))throw Error('权限路径类型或格式无效');
  const target=resolve(root,value),tail=[];
  // Resolve existing ancestors before containment, including Windows 8.3 path
  // aliases. Missing new files inherit the verified real parent directory.
  let cursor=target;for(;;){try{await lstat(cursor);if(!within(root,resolve(await realpath(cursor),...tail)))throw Error('权限路径或链接指向项目外目录');return;}catch(error){if(error.code!=='ENOENT')throw error;const parent=dirname(cursor);if(parent===cursor)throw Error('无法验证权限路径');tail.unshift(basename(cursor));cursor=parent;}}
}
/** Enforces explicit native permission paths, not arbitrary shell semantics. */
export async function agentRequestPolicy({task,request,result,tools=[]}){
  if(!permissionMethods.has(request.method))return null;
  try{
    const root=await realpath(task.workspace.path),paths=[];
    const path=value=>{if(value!=null){if(typeof value!=='string')throw Error('权限路径必须是字符串');paths.push(value);}};
    const filesystem=value=>{if(value==null)return;if(!object(value))throw Error('文件权限必须是 JSON 对象');for(const key of ['read','write'])if(value[key]!=null){if(!Array.isArray(value[key]))throw Error('文件权限路径必须是数组');for(const item of value[key]){if(typeof item!=='string')throw Error('文件权限路径必须是字符串');path(item);}}if(value.entries!=null){if(!Array.isArray(value.entries))throw Error('文件权限 entries 必须是数组');for(const entry of value.entries){if(!object(entry)||!object(entry.path)||!['read','write','deny'].includes(entry.access))throw Error('文件权限 entry 类型无效');const item=entry.path;if(item.type==='path'){if(typeof item.path!=='string')throw Error('文件权限 entry 缺少路径');path(item.path);}else if(item.type==='special'&&item.value?.kind==='project_roots')path(item.value.subpath??root);else throw Error('不能验证通配或特殊目录授权');}}};
    const profile=value=>{if(value!=null){if(!object(value))throw Error('权限声明必须是 JSON 对象');filesystem(value.fileSystem);}};
    const p=request.method==='session/request_permission'?request.params:request;if(!object(p))throw Error('原生权限参数必须是 JSON 对象');path(p.cwd);path(p.grantRoot);profile(p.additionalPermissions);profile(p.permissions);
    if(p.commandActions!=null){if(!Array.isArray(p.commandActions))throw Error('命令路径描述必须是数组');for(const action of p.commandActions){if(!object(action))throw Error('命令路径描述类型无效');path(action.path);}}
    if(request.method==='session/request_permission'){
      const tool=p.toolCall;if(!object(tool)||typeof tool.toolCallId!=='string')throw Error('ACP 权限请求缺少工具身份');
      const rows=[...tools.filter(row=>row.type==='tool'&&row.itemId===tool.toolCallId).map(row=>row.payload.update??row.payload.item??row.payload),tool];let filePath=false;
      for(const row of rows){let input=row.rawInput;if(input==null)for(const content of row.content??[]){const raw=content.type==='content'&&content.content?.type==='text'?content.content.text:null;if(raw&&raw.trim().startsWith('{')){try{input=JSON.parse(raw);}catch{throw Error('ACP 工具参数不是有效 JSON');}}}if(input!=null){if(!object(input))throw Error('ACP 工具参数必须是 JSON 对象');path(input.path);path(input.cwd);path(input.workdir);if(input.path!=null)filePath=true;}
        if(row.locations!=null){if(!Array.isArray(row.locations))throw Error('ACP 工具位置必须是数组');for(const location of row.locations){if(!object(location))throw Error('ACP 工具位置类型无效');path(location.path);filePath=true;}}}
      if(['Write','Edit','MultiEdit','Read'].includes(tool.title)&&!filePath)throw Error('ACP 文件权限缺少可校验路径');
      if(result!=null){if(!object(result)||!object(result.outcome))throw Error('ACP 权限答案必须是 JSON 对象');if(result.outcome.outcome==='selected'){const choice=(p.options??[]).find(option=>option.optionId===result.outcome.optionId);if(!choice||!['allow_once','reject_once','reject_always'].includes(choice.kind))throw Error('只允许本次授权，不能扩大为会话持续授权');}else if(result.outcome.outcome!=='cancelled')throw Error('ACP 权限答案无效');}
    }else if(request.method==='item/permissions/requestApproval'&&result!=null){if(!object(result)||!object(result.permissions)||result.scope&&result.scope!=='turn')throw Error('权限答案只允许当前轮次');profile(result.permissions);}
    else if(result!=null&&(!object(result)||!['accept','decline','cancel'].includes(result.decision)))throw Error('只允许本次批准，不能增加持续权限规则');
    for(const value of paths)await authorizedPath(root,value);return null;
  }catch(error){return requestDenial(request,String(error.message));}
}

/** Trusted boundary between renderer actions, current view identity and native workers. */
export class AgentHostService extends EventEmitter {
  constructor({dataRoot,getGame,binaryResolver,kimiFactory,resolveRuntime,adapterFactory,runtimeCheck,onEvent=()=>{},onActivity=()=>{},onUsage=()=>{},now=Date.now,store,serviceOptions={},profileOptions={}}={}){
    super();if(typeof getGame!=='function')throw Error('工作主机缺少游戏上下文入口');Object.assign(this,{dataRoot,getGame,onEvent,onActivity,onUsage,binaryResolver,kimiFactory,runtimeCheck});this.injectedAdapterFactory=!!adapterFactory;this.closed=false;this.eventTail=Promise.resolve();
    this.store=store??new AgentTaskStore({root:join(dataRoot,'agent-tasks'),now});this.turnConnections=new Map();
    const makeAdapter=adapterFactory??createAgentAdapterFactory({dataRoot,binaryResolver,kimiFactory,resolveRuntime,...profileOptions});
    this.service=new AgentTaskService({...serviceOptions,store:this.store,now,adapterFactory:async options=>{
      // Capture only the public request identity. A later card/profile edit must
      // not reattribute usage, and credentials never enter this map or journal.
      const captured=connectionIdentity(options.connection);this.turnConnections.set(options.task.id,captured);
      try{const adapter=await makeAdapter(options),dispose=adapter?.dispose?.bind(adapter);if(adapter)adapter.dispose=(...args)=>{if(this.turnConnections.get(options.task.id)===captured)this.turnConnections.delete(options.task.id);return dispose?.(...args);};return adapter;}
      catch(error){if(this.turnConnections.get(options.task.id)===captured)this.turnConnections.delete(options.task.id);throw error;}
    },
      connectionResolver:(task,options)=>this.connection(task,options),contextProvider:async(task,options)=>{const profile=await this.game().workConnection(task.scope.characterId);return this.game().workContext(task,{...options,systemOverheadTokens:workContextOverheadTokens(profile)});},
      // A background task keeps its fixed Persona even when the visible UI changes.
      scopeResolver:task=>this.game().workScope(task.scope.characterId,task.scope.personaId),
      requestPolicy:agentRequestPolicy,
      onEvent:event=>this.queueEvent(event),onUsage:value=>this.onUsage({...value,connectionIdentity:structuredClone(this.turnConnections.get(value.taskId)??null)}),
      onExperience:source=>this.game().recordWorkExperience(source),
    });
    this.lifeBridge={assertIdle:characterId=>this.assertCharacterIdle(characterId),pauseCharacter:characterId=>this.pauseCharacter(characterId),snapshot:scope=>{this.assertCharacterIdle(scope?.characterId);return this.service.snapshotLife(scope);},restore:spec=>{this.assertCharacterIdle(spec?.characterId);return this.service.restoreLife(spec);}};
  }
  game(){const game=this.getGame();if(!game||typeof game.workScope!=='function'||typeof game.workConnection!=='function'||typeof game.workContext!=='function')throw failure('工作功能正在准备，请稍候','AGENT_GAME_NOT_READY');return game;}
  async init(){await this.service.init();return this;}
  async currentScope(characterId){const scope=await this.game().workScope(characterId);if(!scope||SCOPE_FIELDS.some(key=>typeof scope[key]!=='string'||!scope[key]))throw failure('无法确认当前工作身份','AGENT_SCOPE_INVALID');return scope;}
  async accessible(task){try{return matches(task,await this.currentScope(task.scope.characterId));}catch{return false;}}
  async ownedTask(taskId){if(typeof taskId!=='string')throw failure('工作任务 ID 无效','AGENT_TASK_INVALID');const task=this.store.read(taskId);if(!await this.accessible(task))throw failure('该工作记录不属于当前身份或当前人生','AGENT_SCOPE_DENIED');return task;}
  async profileCapability(profile){
    const resolved=resolveWorkCapability(profile),capability={...resolved,connectionId:profile?.id??null,...(profile?.id?{connectionFingerprint:agentConnectionFingerprint(profile)}:{})};if(!capability.available)return capability;
    try{
      if(this.runtimeCheck)await this.runtimeCheck(profile);
      else if(!this.injectedAdapterFactory&&['codex','deepseek'].includes(profile.kind)){
        if(typeof this.binaryResolver!=='function')throw failure('工作执行器尚未安装','HARNESS_UNAVAILABLE');await resolveHarnessRuntime(await this.binaryResolver({kind:'codex'}));
      }else if(!this.injectedAdapterFactory&&profile.kind==='kimi'&&typeof this.kimiFactory!=='function')throw failure('Kimi 工作引擎尚未安装或启用','HARNESS_UNAVAILABLE');
      return capability;
    }catch(error){return {available:false,code:error.code??'HARNESS_UNAVAILABLE',reason:redactAgentValue(String(error.message),[profile.key]),transport:capability.transport,modelCapabilities:capability.modelCapabilities};}
  }
  async capabilities(characterId){
    const scope=await this.currentScope(characterId??this.game().context?.().characterId);
    try{const profile=await this.game().workConnection(scope.characterId);return await this.profileCapability(profile);}
    catch(error){return {available:false,code:error.code??'AGENT_CONNECTION_INVALID',reason:String(error.message)};}
  }
  async connection(task,options={}){
    const characterId=task.scope?.characterId??task.characterId,profile=await this.game().workConnection(characterId);if(!profile||typeof profile!=='object')throw failure('角色未配置可用工作连接','AGENT_CONNECTION_INVALID');
    if(task.expectedConnectionFingerprint&&agentConnectionFingerprint(profile)!==task.expectedConnectionFingerprint)throw failure('工作表单中的连接已经变化，请重新核对后创建任务','AGENT_BINDING_CHANGED');
    const legacyFork=options.legacyFork===true&&task.binding?.provider==='deepseek'&&!task.binding.workTransport;
    if(options.legacyFork===true&&(!legacyFork||typeof options.expectedConnectionFingerprint!=='string'||options.expectedConnectionFingerprint!==agentConnectionFingerprint(profile)))throw failure('工作表单中的连接已经变化，请重新核对后创建任务','AGENT_BINDING_CHANGED');
    if(!legacyFork&&task.binding?.connectionFingerprint&&agentConnectionFingerprint(profile)!==task.binding.connectionFingerprint)throw failure('角色工作连接或模型已经改变；此任务保持原绑定，需先恢复原配置','AGENT_BINDING_CHANGED');
    const kind=profile.kind,provider=kind==='codex'?'openai':kind,harness=kind==='kimi'?'acp':'codex';
    if(!['codex','deepseek','kimi'].includes(kind))throw failure('当前角色连接尚未适配工作执行器','HARNESS_UNSUPPORTED_CONNECTION');
    if(typeof profile.id!=='string'||!profile.id||!profile.model)throw failure('工作连接缺少身份或模型','AGENT_CONNECTION_INVALID');
    const capability=await this.profileCapability(profile);if(!capability.available)throw failure(capability.reason,capability.code);
    const row=profile.models?.find(value=>value.id===profile.model||value.model===profile.model),declared=profile.contextTokens??row?.contextWindow??row?.context_window??row?.contextLength??row?.inputTokenLimit??row?.max_input_tokens;
    const contextTokens=Number.isSafeInteger(Number(declared))&&Number(declared)>=2048&&Number(declared)<=2000000?Number(declared):defaultContextCapacity().tokens;
    return {...profile,connectionId:profile.id,provider,harness,effort:profile.reasoningEffort??null,contextTokens,connectionFingerprint:agentConnectionFingerprint(profile),...(kind==='deepseek'?{workTransport:workTransportBinding(capability)}:{})};
  }
  queueEvent(event){
    try{this.onActivity({taskId:event.taskId,status:event.status});}catch{}
    this.eventTail=this.eventTail.catch(()=>{}).then(async()=>{if(this.closed||!event.scope)return;const task={scope:event.scope};if(!await this.accessible(task))return;const publicEvent=redactAgentValue(event);this.emit('event',publicEvent);try{await this.onEvent(publicEvent);}catch{}});return this.eventTail;
  }
  async characters(){
    const game=this.game(),view=typeof game.action==='function'?await game.action('view',{}):{},state=view?.companion??view?.view?.companion??{};
    const active=typeof game.context==='function'?game.context():{},rows=state.characters??view.characters??[];
    const characters=[];for(const row of rows){let scope;try{scope=await this.currentScope(row.id);}catch{continue;}if(active.personaId&&scope.personaId!==active.personaId)continue;const connection=row.effectiveConnection;
      characters.push({id:row.id,name:row.name??row.effective?.name??row.id,...(row.avatar?{avatar:row.avatar}:{}),effectiveConnection:connection?pick(connection,['mode','connectionId','name','model','error']):null,workCapability:await this.capabilities(row.id)});
    }
    return {characters,personaId:active.personaId??state.personaId??state.activePersonaId??null,characterId:active.characterId??state.characterId??null};
  }
  async action(action,payload={}){
    if(this.closed)throw failure('工作主机已关闭','AGENT_SERVICE_CLOSED');if(typeof action!=='string'||!ACTIONS.has(action))throw failure('未知的工作主机操作','AGENT_ACTION_INVALID');if(!object(payload))throw failure('工作操作参数无效','AGENT_ACTION_INVALID');await this.init();
    if(action==='characters')return this.characters();
    if(action==='capabilities')return this.capabilities(payload.characterId);
    if(action==='list'){
      const rows=this.store.list(),result=[],scopes=new Map(),characterId=payload.characterId??payload.scope?.characterId;
      for(const row of rows){if(!row.scope||characterId&&row.scope.characterId!==characterId)continue;let scope=scopes.get(row.scope.characterId);if(scope===undefined){try{scope=await this.currentScope(row.scope.characterId);}catch{scope=null;}scopes.set(row.scope.characterId,scope);}if(scope&&matches(row,scope))result.push(row);}
      return result;
    }
    if(action==='create'){
      const scope=await this.currentScope(payload.characterId??this.game().context?.().characterId);
      for(const source of [payload,payload.scope])if(object(source))for(const field of SCOPE_FIELDS)if(source[field]!=null&&source[field]!==scope[field])throw failure('工作任务不能使用其他身份或旧人生','AGENT_SCOPE_DENIED');
      const instruction=payload.instruction??payload.goal;return this.service.create({...scope,...pick(payload,['workspace','title','expectedConnectionFingerprint']),instruction});
    }
    const task=await this.ownedTask(payload.taskId);
    if(action==='read')return task;
    const safe={taskId:task.id,...pick(payload,action==='start'?['workspaceConfirmation','acceptWorkspaceDigest']:action==='continue'?['text','workspaceConfirmation','acceptWorkspaceDigest','newSession']:action==='inspect-workspace'?['requestId']:action==='respond'?['requestId','result','error']:action==='present'?['requestId']:action==='fork'?['text','expectedConnectionFingerprint']:[])};
    return this.service.action(action,safe);
  }
  busy(){return this.service.runs.size>0||this.service.queue.length>0||this.service.starting.size>0||this.service.presenting.size>0||this.service.scheduling.size>0||this.service.preparations.size>0;}
  activeCharacterTaskIds(characterId){
    const active=new Set([...this.service.runs.keys(),...this.service.starting.keys(),...this.service.scheduling,...this.service.queue.map(row=>row.taskId)]);
    for(const key of this.service.presenting.keys())active.add(key.slice(0,key.indexOf(':')));
    return this.store.list({characterId}).filter(row=>active.has(row.id)).map(row=>row.id);
  }
  assertCharacterIdle(characterId){if(this.activeCharacterTaskIds(characterId).length)throw failure('请先暂停该角色的工作任务，再保存或切换人生','AGENT_LIFE_BUSY');return this.service.assertCharacterIdle(characterId);}
  async pauseCharacter(characterId){
    const ids=this.activeCharacterTaskIds(characterId);await this.service.pauseCharacter(characterId);
    for(const taskId of ids)if(this.service.runs.has(taskId)||this.service.queue.some(row=>row.taskId===taskId))await this.service.cancel({taskId});
    await Promise.all(ids.map(taskId=>this.service.wait(taskId)));
    // A report commit cannot be cancelled halfway across the two stores.
    await Promise.all([...this.service.presenting.entries()].filter(([key])=>ids.includes(key.slice(0,key.indexOf(':')))).map(([,promise])=>promise));
    this.assertCharacterIdle(characterId);return true;
  }
  async flushEvents(){await this.eventTail;}
  async close(){if(this.closed)return;this.closed=true;await this.service.dispose();this.turnConnections.clear();await this.eventTail.catch(()=>{});this.removeAllListeners();}
}
