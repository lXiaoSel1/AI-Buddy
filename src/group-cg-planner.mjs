import {REASONING_EFFORTS,profileEffort} from './reasoning-settings.mjs';

const automatic=()=>({enabled:false,connectionId:null});
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const text=value=>typeof value==='string'?value:'';

/** Persist only a connection reference; credentials belong to the model router. */
export function normalizePhotoPlannerBinding(raw){
 if(!plain(raw)||typeof raw.enabled!=='boolean')throw Error('提示词策划连接设置无效');
 if(!raw.enabled)return automatic();
 if(typeof raw.connectionId!=='string'||!raw.connectionId.trim()||raw.connectionId.length>200)throw Error('请选择提示词策划使用的聊天连接');
 return {enabled:true,connectionId:raw.connectionId.trim()};
}

function plannerError(error){
 const message=text(error instanceof Error?error.message:error);
 if(/已删除|不存在/.test(message))return '提示词策划连接已删除，请重新选择';
 if(/停用/.test(message))return '提示词策划连接已停用，请重新选择';
 if(/不支持聊天/.test(message))return '提示词策划连接不支持聊天，请重新选择';
 if(/未设置模型|模型 ID/.test(message))return '提示词策划连接未设置模型，请先配置模型 ID';
 if(/未选择|尚未选择/.test(message))return '提示词策划尚未选择可用的聊天连接';
 return '提示词策划连接暂不可用，请检查聊天连接配置';
}

function resolve(provider,binding){
 const profiles=Array.isArray(provider?.state?.profiles)?provider.state.profiles:[];
 let route=null,routeError=null;
 if(typeof provider?.resolveConnection==='function'){
  try{route=provider.resolveConnection(binding);}catch(error){routeError=plannerError(error);}
 }
 let profile=null;
 if(binding?.enabled===true)profile=profiles.find(row=>row?.id===binding.connectionId)??null;
 else{
  try{profile=typeof provider?.selected==='function'?provider.selected():null;}catch{routeError??=plannerError(null);}
  profile??=profiles.find(row=>row?.id===(route?.connectionId??route?.id??provider?.state?.activeId))??null;
 }
 const connectionId=profile?.id??route?.connectionId??route?.id??binding?.connectionId??null;
 const model=text(profile?.model??route?.model);
 let error=routeError;
 if(!error){
  if(binding?.enabled===true&&!profile)error='提示词策划连接已删除，请重新选择';
  else if(!profile&&!model)error='提示词策划尚未选择可用的聊天连接';
  else if(profile?.enabled===false)error='提示词策划连接已停用，请重新选择';
  else if(profile?.capabilities?.chat===false)error='提示词策划连接不支持聊天，请重新选择';
  else if(!model.trim())error='提示词策划连接未设置模型，请先配置模型 ID';
  else if(route?.error)error=plannerError(route.error);
 }
 const effort=profile?profileEffort(profile):route?.reasoningEffort;
 return {connectionId:typeof connectionId==='string'?connectionId:null,name:text(profile?.name??route?.name),model,reasoningEffort:REASONING_EFFORTS.includes(effort)?effort:null,error};
}

/** Public, credential-free view for one group's CG prompt-planning selector. */
export function groupPhotoPlanner(group,cards,provider){
 const binding=group?.photoPlannerBinding==null?automatic():normalizePhotoPlannerBinding(group.photoPlannerBinding);
 const automaticBinding=cards?.[group?.entryCharacterId??group?.memberIds?.[0]]?.modelBinding??automatic();
 const effective=resolve(provider,binding.enabled?binding:automaticBinding),seen=new Set();
 const profiles=Array.isArray(provider?.state?.profiles)?provider.state.profiles:[];
 const options=profiles.filter(row=>typeof row?.id==='string'&&!seen.has(row.id)&&(seen.add(row.id),true)).map(profile=>{
  const resolved=resolve(provider,{enabled:true,connectionId:profile.id});
  return {id:profile.id,name:resolved.name,model:resolved.model,reasoningEffort:resolved.reasoningEffort,available:!resolved.error,error:resolved.error};
 });
 return {binding,enabled:provider?.enabled===true,effective,options};
}

/** Saving can happen offline; explicit online generation must not silently fall back. */
export function validatePhotoPlanner(group,cards,provider,raw,{requireOnline=false}={}){
 const binding=normalizePhotoPlannerBinding(raw);
 if(binding.enabled){
  const view=groupPhotoPlanner({...group,photoPlannerBinding:binding},cards,provider);
  if(view.effective.error)throw Error(view.effective.error);
  if(requireOnline&&provider?.enabled!==true)throw Error('提示词策划需要联网聊天，请先开启联网聊天');
 }
 return binding;
}
