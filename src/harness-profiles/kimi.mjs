import {AcpWorkAdapter} from '../harness-adapters/acp.mjs';
import {apiBaseUrl} from '../model-presets.mjs';
import {harnessFailure as failure,profileHash as hash,profileToml as toml,agentProcessEnvironment,resolveHarnessRuntime,validateWorkTask,workProfileHome,atomicProfileText} from './shared.mjs';

/** Optional-package implementation. The core receives this factory by injection only. */
export async function createKimiWorkAdapter({task,binding=task?.binding,connection,context={},profileOptions={},runtime,resolveRuntime,env=process.env,spawnImpl,requestTimeoutMs=30000,dataRoot=profileOptions.dataRoot}={}){
  validateWorkTask(task,connection);if(connection.kind!=='kimi')throw failure('Kimi 工作引擎不能替换其他厂商连接','HARNESS_UNSUPPORTED_CONNECTION');if(binding?.provider&&binding.provider!=='kimi')throw failure('工作厂商和任务绑定不一致','HARNESS_PROVIDER_MISMATCH');
  if(typeof connection.key!=='string'||!connection.key)throw failure('所选连接尚未配置工作认证','HARNESS_AUTH_REQUIRED');
  if(!runtime&&typeof resolveRuntime!=='function')throw failure('Kimi 工作引擎尚未安装或启用','HARNESS_UNAVAILABLE');
  const selectedRuntime=await resolveHarnessRuntime(runtime??await resolveRuntime('kimi'));
  const protocol=connection.protocol??'chat-completions';if(!['chat-completions','responses'].includes(protocol))throw failure('Kimi 工作引擎尚未适配该连接协议','HARNESS_UNSUPPORTED_CONNECTION');
  const capacity=Number(connection.contextTokens);if(!Number.isSafeInteger(capacity)||capacity<2048||capacity>2000000)throw failure('Kimi 工作引擎需要已确定的上下文容量','HARNESS_CONTEXT_REQUIRED');
  const endpoint=apiBaseUrl(connection.baseUrl),{home,identity}=await workProfileHome(dataRoot,'kimi',task),model=connection.model,developerInstructions=String(context.developerInstructions??'');
  const processEnv=agentProcessEnvironment(env);delete processEnv.CODEX_HOME;processEnv.KIMI_CODE_HOME=home;processEnv.AI_BUDDY_SELECTED_WORK_KEY=connection.key;
  const configText=['default_model = '+toml(model),'default_permission_mode = "manual"','telemetry = false','auto_session_title = false','merge_all_available_skills = false','builtin_product_skills = false','[providers.kimi]','type = '+toml(protocol==='responses'?'openai_responses':'kimi'),'base_url = '+toml(endpoint),'api_key_env = "AI_BUDDY_SELECTED_WORK_KEY"','[models.'+toml(model)+']','provider = "kimi"','model = '+toml(model),'max_context_size = '+capacity,'capabilities = ["tool_use"]',''].join('\n');
  await atomicProfileText(home,'config.toml',configText);await atomicProfileText(home,'SYSTEM.md','${base_prompt}\n\n'+developerInstructions+'\n');
  const adapter=new AcpWorkAdapter({...selectedRuntime,cwd:task.workspace.path,env:processEnv,spawnImpl,requestTimeoutMs,expectedModel:model,expectedProvider:'kimi',developerInstructions:''});
  for(const method of ['startSession','resumeSession']){const original=adapter[method].bind(adapter);adapter[method]=async options=>({...await original({...options,provider:'kimi',providerVerified:true,developerInstructions:''}),identityInjection:'isolated-system-profile'});}
  adapter.profileReceipt={version:1,kind:'kimi',identity,home,model,provider:'kimi',protocol,endpoint,runtime:selectedRuntime,configHash:hash(configText),contextHash:hash(developerInstructions),authentication:'selected-connection-env',keyPersisted:false,identityInjection:'isolated-system-profile'};
  await atomicProfileText(home,'PROFILE.json',JSON.stringify(adapter.profileReceipt,null,2)+'\n');return adapter;
}
