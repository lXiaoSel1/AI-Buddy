import {isAbsolute} from 'node:path';
import {CodexWorkAdapter} from './harness-adapters/codex.mjs';
import {requireWorkCapability,workTransportBinding,deepseekModelCatalog,deepseekBaseInstructions} from './work-capabilities.mjs';
import {createResponsesNormalizer,RESPONSES_NORMALIZER_VERSION} from './harness-profiles/responses-normalizer.mjs';
import {harnessFailure as failure,profileHash as hash,profileToml as toml,agentProcessEnvironment,resolveHarnessRuntime,validateWorkTask,workProfileHome,atomicProfileText} from './harness-profiles/shared.mjs';
export {agentProcessEnvironment} from './harness-profiles/shared.mjs';

/** The core owns only local Codex and DeepSeek. Optional engines are injected. */
export function createAgentAdapterFactory({dataRoot,binaryResolver,kimiFactory,resolveRuntime,env=process.env,spawnImpl,requestTimeoutMs=30000}={}){
  if(!isAbsolute(dataRoot??''))throw failure('工作执行器资料根目录无效','AGENT_PROFILE_PATH_INVALID');
  return async({task,connection,context={},binding=task?.binding}={})=>{
    validateWorkTask(task,connection);const kind=connection.kind,workspace=task.workspace.path,developerInstructions=String(context.developerInstructions??''),model=connection.model;
    if(kind==='kimi'){if(typeof kimiFactory!=='function')throw failure('Kimi 工作引擎尚未安装或启用','HARNESS_UNAVAILABLE');return kimiFactory({task,binding,connection,context,profileOptions:{dataRoot},dataRoot,resolveRuntime,env,spawnImpl,requestTimeoutMs});}
    if(!['codex','deepseek'].includes(kind))throw failure('当前连接尚未通过工作执行器适配，请选择已支持的连接','HARNESS_UNSUPPORTED_CONNECTION');
    const processEnv=agentProcessEnvironment(env),nativeProvider=kind==='codex'?'openai':'deepseek';
    if(binding?.provider&&binding.provider!==nativeProvider)throw failure('工作厂商和任务绑定不一致','HARNESS_PROVIDER_MISMATCH');
    const capability=kind==='deepseek'?requireWorkCapability(connection):null;
    if(capability&&binding?.workTransport&&JSON.stringify(binding.workTransport)!==JSON.stringify(workTransportBinding(capability)))throw failure('工作传输与任务冻结的来源不一致','HARNESS_WORK_TRANSPORT_CHANGED');
    if(typeof binaryResolver!=='function')throw failure('未配置 Codex 执行器发现','HARNESS_UNAVAILABLE');const runtime=await resolveHarnessRuntime(await binaryResolver({kind:'codex'}));
    if(kind==='codex'){
      const adapter=new CodexWorkAdapter({...runtime,cwd:workspace,env:processEnv,spawnImpl,requestTimeoutMs,expectedModel:model,expectedProvider:nativeProvider,developerInstructions,args:['-c','model_provider="openai"','-c','forced_login_method="chatgpt"']});
      adapter.profileReceipt={version:1,kind:'codex',authentication:'existing-codex-login',model,provider:nativeProvider,runtime,contextHash:hash(developerInstructions),isolatedProcess:true,authCopied:false};return adapter;
    }
    if(typeof connection.key!=='string'||!connection.key)throw failure('所选连接尚未配置工作认证','HARNESS_AUTH_REQUIRED');
    const endpoint=capability.transport.endpoint,{home,identity}=await workProfileHome(dataRoot,'deepseek',task);processEnv.CODEX_HOME=home;
    const catalogPath=home+'/models.json',catalogText=JSON.stringify(deepseekModelCatalog(capability),null,2)+'\n';
    const reservedOutputTokens=context.capacity?.reservedOutputTokens??context.capacity?.reserveTokens;
    let adapter;const normalizer=await createResponsesNormalizer({endpoint,model,key:connection.key,instructions:deepseekBaseInstructions(developerInstructions),effort:capability.transport.effort,supportedEfforts:capability.modelCapabilities.reasoningEfforts,defaultEffort:capability.modelCapabilities.defaultReasoningEffort,contextTokens:capability.modelCapabilities.effectiveContextWindow,reservedOutputTokens,onViolation:error=>adapter?.rejectTransport(error)});
    processEnv.AI_BUDDY_SELECTED_WORK_KEY=normalizer.token;
    const configText=['model = '+toml(model),'model_provider = "deepseek"','forced_login_method = "api"','web_search = "disabled"','disable_response_storage = true','model_catalog_json = '+toml(catalogPath),'[model_providers.deepseek]','name = "DeepSeek"','base_url = '+toml(normalizer.endpoint),'wire_api = "responses"','env_key = "AI_BUDDY_SELECTED_WORK_KEY"','requires_openai_auth = false','supports_websockets = false','request_max_retries = 0','stream_max_retries = 0',''].join('\n');
    try{
      await atomicProfileText(home,'models.json',catalogText);await atomicProfileText(home,'config.toml',configText);adapter=new CodexWorkAdapter({...runtime,cwd:workspace,env:processEnv,spawnImpl,requestTimeoutMs,expectedModel:model,expectedProvider:nativeProvider,baseInstructions:deepseekBaseInstructions(developerInstructions),supportedEfforts:capability.modelCapabilities.reasoningEfforts});
      const dispose=adapter.dispose.bind(adapter);adapter.dispose=()=>{normalizer.close();dispose();};
      adapter.profileReceipt={version:2,kind,identity,home,model,provider:nativeProvider,protocol:'responses',endpoint,transport:workTransportBinding(capability),compatibility:capability.compatibility,runtime,catalogFileHash:hash(catalogText),configHash:hash(configText),contextHash:hash(developerInstructions),authentication:'selected-connection-backend-memory',keyPersisted:false,identityInjection:'system-instructions-with-coding-base',normalizerVersion:RESPONSES_NORMALIZER_VERSION};
      await atomicProfileText(home,'PROFILE.json',JSON.stringify(adapter.profileReceipt,null,2)+'\n');return adapter;
    }catch(error){normalizer.close();adapter?.dispose();throw error;}
  };
}
