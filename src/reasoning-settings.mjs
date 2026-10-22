export const REASONING_EFFORTS=Object.freeze(['none','minimal','low','medium','high','xhigh','max','ultra']);
export const effortProtocol=protocol=>['codex','responses','chat-completions'].includes(protocol);
export function profileEffort(profile){
 if(Object.hasOwn(profile??{},'reasoningEffort'))return profile.reasoningEffort==null||['','auto','default'].includes(profile.reasoningEffort)?null:profile.reasoningEffort;
 return profile?.kind==='codex'?'low':null;
}
export function modelEfforts(model){
 const declared=[model?.supportedReasoningEfforts,model?.supported_reasoning_efforts,model?.effort?.supported_levels,model?.capabilities?.reasoning_effort].find(Array.isArray);
 if(!declared)return null;
 return [...new Set(declared.map(row=>typeof row==='string'?row:row?.reasoningEffort).filter(value=>REASONING_EFFORTS.includes(value)))];
}
// Verified 2026-10-22. Exact official endpoints/models only: a proxy with the
// same model name may expose different capabilities and must declare its own.
// Sources: api-docs.deepseek.com/api/create-chat-completion/ and
// docs.x.ai/developers/model-capabilities/text/reasoning
function documentedEfforts(profile){
 let host;try{host=new URL(profile.baseUrl).hostname;}catch{return null;}
 if(host==='api.deepseek.com'&&['deepseek-flash','deepseek-v4-pro'].includes(profile.model))return ['none','low','high','max'];
 if(host==='api.x.ai'){
  if(['grok-4.6','grok-4.7'].includes(profile.model))return ['low','medium','high','xhigh'];
  if(profile.model==='grok-4.5')return ['low','medium','high'];
 }
 return null;
}
export function effortSupport(profile,models=profile?.models??[]){
 if(!effortProtocol(profile?.protocol))return {levels:[],source:'protocol'};
 const row=models.find(row=>row.id===profile.model||row.model===profile.model),declared=modelEfforts(row);
 const documented=profile.kind==='codex'?null:documentedEfforts(profile);
 if(declared!==null){
  // DeepSeek's catalog excludes the separately documented thinking-off value.
  const levels=declared.length&&row?.effort?.supported_levels&&documented?.includes('none')?['none',...declared.filter(x=>x!=='none')]:declared;
  // Normalized catalogs retain the already added none value through saves.
  return {levels,source:'catalog'};
 }
 return {levels:documented??[],source:documented?'documented':'unknown'};
}
export const effortChoices=(profile,models)=>effortSupport(profile,models).levels;
export function validateProfileEffort(profile){
 const effort=profileEffort(profile);
 if(effort===null)return;
 if(!REASONING_EFFORTS.includes(effort)||!effortProtocol(profile.protocol))throw Error('当前协议不支持该推理强度，请选择模型默认');
 const support=effortSupport(profile);
 // Preserve legacy Codex profiles until a live catalog is available; Codex
 // validates each turn itself. Generic APIs must not invent a universal list.
 if(support.source==='unknown'&&profile.kind==='codex')return;
 if(!support.levels.includes(effort))throw Error('该模型不支持所选推理强度，请获取模型列表或选择模型默认');
}
export function cleanModelCatalog(rows){
 const found=new Set();return (Array.isArray(rows)?rows:[]).filter(row=>typeof row?.id==='string'&&row.id.trim()&&row.id.length<=200&&!found.has(row.id)&&(found.add(row.id),true)).slice(0,1000).map(row=>({
  id:row.id,name:String(row.name??row.displayName??row.id).slice(0,300),
  ...(typeof row.model==='string'?{model:row.model.slice(0,200)}:{}),
  ...(typeof row.description==='string'?{description:row.description.slice(0,1000)}:{}),
  ...(modelEfforts(row)!==null?{supportedReasoningEfforts:modelEfforts(row).map(value=>({reasoningEffort:value,description:String(row.supportedReasoningEfforts?.find?.(item=>item?.reasoningEffort===value)?.description??'').slice(0,500)}))}:{}),
  ...(REASONING_EFFORTS.includes(row.defaultReasoningEffort??row.default_reasoning_effort??row.effort?.default_level??row.capabilities?.default_reasoning_effort)?{defaultReasoningEffort:row.defaultReasoningEffort??row.default_reasoning_effort??row.effort?.default_level??row.capabilities?.default_reasoning_effort}:{}),
  ...(typeof row.isDefault==='boolean'?{isDefault:row.isDefault}:{})
  ,...Object.fromEntries(['contextWindow','context_window','contextLength','inputTokenLimit','max_input_tokens'].filter(key=>Number.isSafeInteger(row[key])&&row[key]>=2048&&row[key]<=2000000).map(key=>[key,row[key]]))
  ,...Object.fromEntries(['maxOutputTokens','max_output_tokens','outputTokenLimit'].filter(key=>Number.isSafeInteger(row[key])&&row[key]>=256&&row[key]<=2000000).map(key=>[key,row[key]]))
 }));
}
