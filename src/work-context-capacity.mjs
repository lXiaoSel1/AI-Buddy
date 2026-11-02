import {defaultContextCapacity} from './context-capacity.mjs';
const valid=value=>Number.isSafeInteger(value)&&value>=2048&&value<=2000000;
const fail=(code,message)=>Object.assign(Error(message),{code});
export function workContextCapacity(binding={},provider){
 const values=[],declared=binding.parameters?.contextTokens;
 if(declared!=null){if(!valid(declared))throw fail('WORK_CONTEXT_CAPACITY','The approved work context limit is invalid');values.push({tokens:declared,source:'approved-native-binding',verified:false});}
 if(binding.connectionRef){
  const profile=provider?.captureConnection?.({enabled:true,connectionId:binding.connectionRef});
  if(!profile||profile.id!==binding.connectionRef)throw fail('WORK_CONNECTION_DENIED','The approved work connection is unavailable');
  if(profile.contextTokens!=null){if(!valid(profile.contextTokens))throw fail('WORK_CONTEXT_CAPACITY','The work connection context limit is invalid');values.push({tokens:profile.contextTokens,source:'work-connection-setting',verified:false});}
  const model=profile.models?.find(row=>row.id===binding.model||row.model===binding.model),tokens=model?.contextWindow??model?.context_window??model?.contextLength??model?.inputTokenLimit??model?.max_input_tokens;
  if(valid(tokens))values.push({tokens,source:'work-model-catalog',verified:true});
 }
 values.sort((a,b)=>a.tokens-b.tokens);
 return {...(values[0]??defaultContextCapacity()),engine:binding.engine??null,model:binding.model??null,connectionRef:binding.connectionRef??null};
}
