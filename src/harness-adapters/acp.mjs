import {EventEmitter} from 'node:events';
import {isAbsolute,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {HarnessRpcProcess} from '../agent-runtime-manager.mjs';

const failure=(message,code)=>Object.assign(Error(message),{code});
const modelOption=options=>(options??[]).find(value=>value.category==='model'||value.id==='model');
const currentModel=value=>modelOption(value?.configOptions)?.currentValue??value?.models?.currentModelId??null;
const possibleValues=option=>(option?.options??[]).flatMap(value=>value.group?value.options??[]:[value]).map(value=>value.value);

/** ACP v1 client. Filesystem and terminal reverse RPC are deliberately not advertised. */
export class AcpWorkAdapter extends EventEmitter {
  constructor({binary,args=['acp'],cwd,env,spawnImpl,requestTimeoutMs=30000,expectedModel,expectedProvider,developerInstructions='',rpc}={}){
    super();Object.assign(this,{expectedModel,expectedProvider,developerInstructions});this.sessions=new Map();this.turns=new Map();this.nextTurnId=1;this.initialized=null;this.disposed=false;
    this.rpc=rpc??new HarnessRpcProcess({binary,args,cwd,env,spawnImpl,requestTimeoutMs});this.rpc.on('notification',message=>this.notification(message));this.rpc.on('request',message=>this.serverRequest(message));this.rpc.on('disconnect',error=>this.disconnected(error));
  }
  get busy(){return this.turns.size>0;}
  event(type,{sessionId,turnId,itemId,...payload}={},replay=false){this.emit('event',{type,sessionId:sessionId??null,turnId:turnId??null,itemId:itemId??null,replay,payload});}
  async probe(){if(this.initialized)return this.initialized;this.initialized=(async()=>{await this.rpc.start();const result=await this.rpc.request('initialize',{protocolVersion:1,clientInfo:{name:'ai_buddy_work',version:'2.0.0'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});if(result.protocolVersion!==1)throw failure('ACP 协议版本不受支持','ACP_PROTOCOL_UNSUPPORTED');this.agentCapabilities=result.agentCapabilities??{};return {kind:'acp',agentInfo:result.agentInfo??null,authMethods:result.authMethods??[],capabilities:this.agentCapabilities};})();try{return await this.initialized;}catch(error){this.initialized=null;throw error;}}
  validateOptions({workspace,model=this.expectedModel,provider=this.expectedProvider,providerVerified=false}={}){if(!isAbsolute(workspace??''))throw failure('请选择绝对路径的工作目录','WORKSPACE_REQUIRED');if(!model)throw failure('未选择工作模型','MODEL_REQUIRED');if(provider&&!providerVerified)throw failure('ACP 未提供可验证的厂商身份，请先核对引擎连接配置','HARNESS_PROVIDER_UNVERIFIED');return {workspace,model,provider};}
  async selectModel(sessionId,response,model){let actual=currentModel(response);if(actual!==model){const option=modelOption(response.configOptions);if(!option||!possibleValues(option).includes(model))throw failure('工作引擎未提供角色绑定的模型','HARNESS_MODEL_UNAVAILABLE');const changed=await this.rpc.request('session/set_config_option',{sessionId,configId:option.id,value:model});response={...response,...changed};actual=currentModel(response);if(actual!==model)throw failure('工作执行器实际模型与角色绑定不一致','HARNESS_MODEL_MISMATCH');}return response;}
  async startSession(options={}){await this.probe();const selected=this.validateOptions(options);const response=await this.rpc.request('session/new',{cwd:selected.workspace,mcpServers:[]});const session={sessionId:response.sessionId,...selected,developerInstructions:options.developerInstructions??this.developerInstructions,capabilities:this.agentCapabilities,replaying:false,workspaceVerified:true};if(!session.sessionId)throw failure('工作引擎没有返回会话 ID','SESSION_ID_MISSING');this.sessions.set(session.sessionId,session);try{await this.selectModel(session.sessionId,response,selected.model);}catch(error){this.sessions.delete(session.sessionId);throw error;}return this.publicSession(session);}
  publicSession(session){return {sessionId:session.sessionId,model:session.model,provider:session.provider??null,workspace:session.workspace,workspaceVerified:session.workspaceVerified,capabilities:session.capabilities,identityInjection:'per-turn-context'};}
  async resumeSession({sessionId,...options}={}){
    await this.probe();const selected=this.validateOptions(options);let workspaceVerified=false;
    if(this.agentCapabilities.sessionCapabilities?.list){let cursor;const seen=new Set();for(let page=0;page<100;page++){const result=await this.rpc.request('session/list',{cwd:selected.workspace,...(cursor?{cursor}:{})});const row=result.sessions?.find(value=>value.sessionId===sessionId);if(row){if(resolve(row.cwd)!==resolve(selected.workspace))throw failure('工作会话属于其他项目','HARNESS_WORKSPACE_MISMATCH');workspaceVerified=true;break;}if(!result.nextCursor)break;if(seen.has(result.nextCursor))throw failure('ACP 会话列表分页无效','ACP_PAGINATION_INVALID');seen.add(result.nextCursor);cursor=result.nextCursor;}}
    const supportsResume=!!this.agentCapabilities.sessionCapabilities?.resume;if(!supportsResume&&!this.agentCapabilities.loadSession)throw failure('工作引擎不支持恢复会话','HARNESS_RESUME_UNSUPPORTED');
    const session={sessionId,...selected,developerInstructions:options.developerInstructions??this.developerInstructions,capabilities:this.agentCapabilities,replaying:!supportsResume,workspaceVerified};this.sessions.set(sessionId,session);
    try{const response=await this.rpc.request(supportsResume?'session/resume':'session/load',{sessionId,cwd:selected.workspace,mcpServers:[]});await this.selectModel(sessionId,response,selected.model);}catch(error){this.sessions.delete(sessionId);throw error;}finally{session.replaying=false;}
    this.event('status',{sessionId,status:'resumed',workspaceVerified});return this.publicSession(session);
  }
  async sendTurn({sessionId,text,model,effort,signal,clientMessageId}={}){
    const session=this.sessions.get(sessionId);if(!session)throw failure('工作会话尚未加载','SESSION_NOT_LOADED');if(this.turns.has(sessionId))throw failure('当前工作会话仍在执行','HARNESS_BUSY');if(model&&model!==session.model)throw failure('工作任务不能静默切换模型','HARNESS_MODEL_MISMATCH');if(signal?.aborted)throw failure('工作任务已取消','ABORT_ERR');
    const run={sessionId,turnId:clientMessageId??'acp-turn-'+randomUUID(),signal,aborted:false,error:null};this.turns.set(sessionId,run);const abort=()=>{run.aborted=true;try{this.rpc.notify('session/cancel',{sessionId});this.event('status',{sessionId,turnId:run.turnId,status:'cancelling'});}catch(error){run.error=error;}};signal?.addEventListener('abort',abort,{once:true});
    try{
      if(effort!=null){const config=await this.rpc.request('session/set_config_option',{sessionId,configId:'thinking',value:effort});const actual=config.configOptions?.find(value=>value.id==='thinking')?.currentValue;if(actual!==effort)throw failure('工作执行器未确认推理强度','HARNESS_EFFORT_MISMATCH');}
      const prompt=[];if(session.developerInstructions)prompt.push({type:'resource',resource:{uri:'ai-buddy://character-context',mimeType:'text/plain',text:session.developerInstructions}});prompt.push({type:'text',text:String(text??'')});
      const result=await this.rpc.request('session/prompt',{sessionId,prompt},0x7fffffff);if(run.error)throw run.error;
      const status=result.stopReason==='end_turn'?'completed':result.stopReason==='cancelled'?'interrupted':'failed';this.event('status',{sessionId,turnId:run.turnId,status,stopReason:result.stopReason});if(status!=='completed')throw failure(status==='interrupted'?'工作任务已取消':'工作任务未正常完成',status==='interrupted'?'ABORT_ERR':'HARNESS_TURN_FAILED');return {sessionId,turnId:run.turnId,status};
    }finally{signal?.removeEventListener('abort',abort);if(this.turns.get(sessionId)===run)this.turns.delete(sessionId);}
  }
  notification({method,params:p={}}){if(method!=='session/update')return;const session=this.sessions.get(p.sessionId);if(!session)return;const update=p.update??{},run=this.turns.get(p.sessionId),scope={sessionId:p.sessionId,turnId:run?.turnId??null};
    if(update.sessionUpdate==='agent_message_chunk')this.event('text',{...scope,itemId:update._meta?.itemId??null,text:update.content?.type==='text'?update.content.text:'',content:update.content},session.replaying);
    else if(update.sessionUpdate==='tool_call'||update.sessionUpdate==='tool_call_update')this.event('tool',{...scope,itemId:update.toolCallId,state:update.status??'pending',update},session.replaying);
    else if(update.sessionUpdate==='usage_update')this.event('usage',{...scope,usage:null,contextUsage:update,billable:false},session.replaying);
    else if(update.sessionUpdate==='config_option_update'){const actual=currentModel(update);if(actual&&actual!==session.model){if(run){run.error=failure('工作执行器更换了绑定模型，任务已暂停','HARNESS_MODEL_MISMATCH');try{this.rpc.notify('session/cancel',{sessionId:p.sessionId});}catch{}}this.event('status',{...scope,status:'model-mismatch',actualModel:actual,expectedModel:session.model},session.replaying);}}
    else if(update.sessionUpdate!=='agent_thought_chunk')this.event('status',{...scope,update},session.replaying);
  }
  serverRequest(message){const p=message.params??{},session=this.sessions.get(p.sessionId);if(message.method==='session/request_permission'&&session){this.event('request',{sessionId:p.sessionId,turnId:this.turns.get(p.sessionId)?.turnId,requestId:message.id,method:message.method,params:p});return;}this.rpc.respond({requestId:message.id,error:{code:-32601,message:'Client capability not implemented'}});}
  respondToRequest(answer){this.rpc.respond(answer);}
  async cancelTurn({sessionId,turnId}={}){const run=this.turns.get(sessionId);if(!run||turnId&&run.turnId!==turnId)throw failure('工作轮次不存在','TURN_NOT_RUNNING');run.aborted=true;this.rpc.notify('session/cancel',{sessionId});this.event('status',{sessionId,turnId:run.turnId,status:'cancelling'});return {requested:true,sessionId,turnId:run.turnId};}
  disconnected(error){for(const run of this.turns.values())run.error=failure(error.message,'HARNESS_DISCONNECTED');this.event('status',{status:'disconnected',code:error.code});}
  dispose(){if(this.disposed)return;this.disposed=true;this.rpc.dispose();this.sessions.clear();}
}
