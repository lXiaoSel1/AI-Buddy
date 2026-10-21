export const REASONING_EFFORTS=Object.freeze(['none','minimal','low','medium','high','xhigh','max','ultra']);
export const effortProtocol=protocol=>['codex','responses','chat-completions'].includes(protocol);
export function profileEffort(profile){
 if(Object.hasOwn(profile??{},'reasoningEffort'))return profile.reasoningEffort==null||['','auto','default'].includes(profile.reasoningEffort)?null:profile.reasoningEffort;
 return profile?.kind==='codex'?'low':null;
}
export function modelEfforts(model){
 if(!Array.isArray(model?.supportedReasoningEfforts))return null;
 return [...new Set(model.supportedReasoningEfforts.map(row=>typeof row==='string'?row:row?.reasoningEffort).filter(value=>REASONING_EFFORTS.includes(value)))];
}
export function effortChoices(profile,models=profile?.models??[]){
 const row=models.find(row=>row.id===profile.model||row.model===profile.model),declared=modelEfforts(row);
 if(!effortProtocol(profile.protocol))return [];
 return declared??(profile.kind==='codex'?[]:REASONING_EFFORTS.filter(value=>value!=='ultra'));
}
export function cleanModelCatalog(rows){
 const found=new Set();return (Array.isArray(rows)?rows:[]).filter(row=>typeof row?.id==='string'&&row.id.trim()&&row.id.length<=200&&!found.has(row.id)&&(found.add(row.id),true)).slice(0,1000).map(row=>({
  id:row.id,name:String(row.name??row.displayName??row.id).slice(0,300),
  ...(typeof row.model==='string'?{model:row.model.slice(0,200)}:{}),
  ...(typeof row.description==='string'?{description:row.description.slice(0,1000)}:{}),
  ...(Array.isArray(row.supportedReasoningEfforts)?{supportedReasoningEfforts:(row.supportedReasoningEfforts).filter(item=>REASONING_EFFORTS.includes(typeof item==='string'?item:item?.reasoningEffort)).map(item=>({reasoningEffort:typeof item==='string'?item:item.reasoningEffort,description:typeof item?.description==='string'?item.description.slice(0,500):''}))}:{}),
  ...(REASONING_EFFORTS.includes(row.defaultReasoningEffort)?{defaultReasoningEffort:row.defaultReasoningEffort}:{}),
  ...(typeof row.isDefault==='boolean'?{isDefault:row.isDefault}:{})
  ,...Object.fromEntries(['contextWindow','context_window','contextLength','inputTokenLimit','max_input_tokens'].filter(key=>Number.isSafeInteger(row[key])&&row[key]>=2048&&row[key]<=2000000).map(key=>[key,row[key]]))
 }));
}
