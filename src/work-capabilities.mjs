import {createHash} from 'node:crypto';
import {apiBaseUrl} from './model-presets.mjs';
import {modelEfforts,profileEffort,REASONING_EFFORTS} from './reasoning-settings.mjs';
import {DEEPSEEK_CODING_BASE,DEEPSEEK_CODING_BASE_VERSION} from './harness-profiles/deepseek-coding-instructions.mjs';
import {RESPONSES_NORMALIZER_VERSION} from './harness-profiles/responses-normalizer.mjs';
import {estimateMemoryTokens} from './companion-memory.mjs';

// Checked against api-docs.deepseek.com/api/create-response/ and the official
// Codex integration on 2026-10-23. These are capabilities, never model aliases.
export const WORK_CAPABILITY_VERSION='work-routing-2026-10-23-v1';
export const DEEPSEEK_CATALOG_VERSION='deepseek-responses-2026-10-23-v1';
const officialModels=new Set(['deepseek-flash','deepseek-v4-pro']);
const officialEfforts=Object.freeze(['none','low','high','max']);
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const failure=(message,code)=>Object.assign(Error(message),{code});
const unavailable=(reason,code)=>({available:false,code,reason});
const capacity=value=>Number.isSafeInteger(Number(value))&&Number(value)>=2048&&Number(value)<=2000000?Number(value):null;
const rowFor=profile=>(profile.models??[]).find(row=>row.id===profile.model||row.model===profile.model);

/** Local, non-billable capability resolution. It never probes or changes a connection. */
export function resolveWorkCapability(profile={}){
  if(typeof profile.model!=='string'||!profile.model.trim())return unavailable('请选择工作模型','MODEL_REQUIRED');
  const model=profile.model,effort=Object.hasOwn(profile,'effort')&&!Object.hasOwn(profile,'reasoningEffort')?profile.effort:profileEffort(profile);
  if(profile.kind==='codex')return {available:true,compatibility:'native-runtime',transport:{version:1,ruleVersion:WORK_CAPABILITY_VERSION,normalizerVersion:null,protocol:'codex',endpoint:null,mapping:'native-codex',catalogVersion:null,catalogHash:null,model,effort:effort??null}};
  if(profile.kind==='kimi')return {available:true,compatibility:'optional-runtime',transport:{version:1,ruleVersion:WORK_CAPABILITY_VERSION,normalizerVersion:null,protocol:'acp',endpoint:null,mapping:'kimi-acp-profile',catalogVersion:null,catalogHash:null,model,effort:effort??null}};
  if(profile.kind!=='deepseek')return unavailable('当前连接尚未适配工作执行器','HARNESS_UNSUPPORTED_CONNECTION');
  let endpoint,url;try{endpoint=apiBaseUrl(profile.baseUrl);url=new URL(endpoint);}catch(error){return unavailable(error.message,'HARNESS_WORK_ENDPOINT_INVALID');}
  const official=url.protocol==='https:'&&url.hostname==='api.deepseek.com'&&(!url.port||url.port==='443')&&['/','/v1'].includes(url.pathname);
  if(!official&&profile.protocol!=='responses')return unavailable('该连接仅声明聊天协议，尚不支持工作任务；请选择明确支持 Responses 的连接。普通聊天仍可使用。','HARNESS_WORK_PROTOCOL_UNSUPPORTED');
  if(official&&!['chat-completions','responses'].includes(profile.protocol))return unavailable('该连接未声明受支持的 DeepSeek 聊天或 Responses 协议','HARNESS_WORK_PROTOCOL_UNSUPPORTED');
  const row=rowFor(profile);
  if(row?.supportsTools===false||row?.supports_tools===false||row?.capabilities?.tools===false||row?.capabilities?.tool_use===false)return unavailable('所选模型明确不支持工作工具','HARNESS_WORK_TOOLS_UNSUPPORTED');
  if(official&&!officialModels.has(model))return unavailable('该模型不在已核对的 DeepSeek 官方 Responses 工作目录中，请核对模型 ID；不会自动更换模型','HARNESS_WORK_MODEL_UNVERIFIED');
  const efforts=official?[...officialEfforts]:modelEfforts(row)??[];
  if(effort!=null&&(!REASONING_EFFORTS.includes(effort)||!efforts.includes(effort)))return unavailable('该工作模型没有声明支持所选 effort，请选择模型默认或已支持档位','HARNESS_WORK_EFFORT_UNSUPPORTED');
  const declaredContextWindow=official?1048576:capacity(row?.contextWindow??row?.context_window??row?.contextLength??row?.inputTokenLimit??row?.max_input_tokens);
  const selectedBudget=capacity(profile.contextTokens)??capacity(row?.contextWindow??row?.context_window??row?.contextLength??row?.inputTokenLimit??row?.max_input_tokens)??272000;
  const contextWindow=Math.min(selectedBudget,declaredContextWindow??selectedBudget);
  const declaredDefault=row?.defaultReasoningEffort??row?.default_reasoning_effort??null;
  const modelCapabilities={model,contextWindow,declaredContextWindow,effectiveContextWindow:contextWindow,reasoningEfforts:efforts,defaultReasoningEffort:official?'high':efforts.includes(declaredDefault)?declaredDefault:null,tools:['function','apply_patch'],stateless:true,codingBaseVersion:DEEPSEEK_CODING_BASE_VERSION,codingBaseHash:digest(DEEPSEEK_CODING_BASE),normalizerVersion:RESPONSES_NORMALIZER_VERSION};
  const transport={version:1,ruleVersion:WORK_CAPABILITY_VERSION,normalizerVersion:RESPONSES_NORMALIZER_VERSION,protocol:'responses',endpoint:official?'https://api.deepseek.com':endpoint,mapping:official?'deepseek-official-root':'explicit-responses',catalogVersion:DEEPSEEK_CATALOG_VERSION,catalogHash:digest(modelCapabilities),model,effort:effort??null};
  return {available:true,compatibility:official?'documented-official':'configuration-only',transport,modelCapabilities};
}
export function requireWorkCapability(profile){const value=resolveWorkCapability(profile);if(!value.available)throw failure(value.reason,value.code);return value;}
export function workTransportBinding(capability){if(!capability?.available||!capability.transport)throw failure(capability?.reason??'工作传输尚未确认',capability?.code??'HARNESS_WORK_TRANSPORT_UNVERIFIED');return structuredClone(capability.transport);}

/** A selected-model catalog, stored only inside the task-owned Codex home. */
export function deepseekModelCatalog(capability){
  if(!capability?.available||capability.transport?.protocol!=='responses')throw failure('DeepSeek 工作目录缺少已确认的 Responses 传输','HARNESS_WORK_TRANSPORT_UNVERIFIED');
  const m=capability.modelCapabilities;
  return {models:[{slug:m.model,display_name:m.model,description:'AI Buddy selected Responses work model',prefer_websockets:false,support_verbosity:false,default_verbosity:null,apply_patch_tool_type:'freeform',web_search_tool_type:'text',input_modalities:['text'],truncation_policy:{mode:'tokens',limit:10000},supports_parallel_tool_calls:true,tool_mode:null,multi_agent_version:'v2',use_responses_lite:false,include_skills_usage_instructions:false,auto_review_model_override:null,context_window:m.effectiveContextWindow,max_context_window:m.effectiveContextWindow,effective_context_window_percent:95,auto_compact_token_limit:Math.floor(m.effectiveContextWindow*0.9),comp_hash:'3000',reasoning_summary_format:'experimental',default_reasoning_summary:'none',default_reasoning_level:m.defaultReasoningEffort,supported_reasoning_levels:m.reasoningEfforts.map(effort=>({effort,description:effort})),shell_type:'shell_command',visibility:'list',minimal_client_version:'0.144.0',supported_in_api:true,availability_nux:null,upgrade:null,priority:1,experimental_supported_tools:[],model_messages:{instructions_template:DEEPSEEK_CODING_BASE}}]};
}
export function deepseekBaseInstructions(context=''){
  return DEEPSEEK_CODING_BASE+'\n\n# AI Buddy character and task-authorized context\nCodex is the execution framework, not your model or character identity. The selected provider and model remain fixed by AI Buddy. Preserve the coding and tool instructions above while applying this trusted character context.\n\n'+String(context);
}
/** Fixed instruction + current native tool-definition allowance only. Final wire
 * input is measured independently; project AGENTS/history can still exceed it. */
export function workContextOverheadTokens(profile){return profile?.kind==='deepseek'?estimateMemoryTokens(deepseekBaseInstructions(''))+12000:0;}
