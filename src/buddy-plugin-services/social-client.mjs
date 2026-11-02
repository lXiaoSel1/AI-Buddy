import {SOCIAL_CONTRACT_VERSION,SOCIAL_METHODS} from './social-contract.mjs';

const fields=Object.freeze({
 'social.context.read':['query'],
 'activity.lease':['activityId'],
 'activity.check':['leaseId','generation'],
 'activity.finish':['leaseId','status'],
 'experience.append':['eventRef'],
 'proactive.offer':['eventRef','kind','text','expiresAt'],
 'models.request':['connectionRef','messages','system','background','leaseId','purpose','replyStylePolicy'],
 'search.native':['query','leaseId'],
 'owner.work.propose':['eventRef','projectId'],
 'owner.work.approve':['eventRef','taskId','challengeId'],
 'owner.work.read':['eventRef','taskId'],
 'owner.work.cancel':['eventRef','taskId','planVersion'],
});
const invalid=message=>Object.assign(Error(message),{code:'BUDDY_REQUEST_INVALID'});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function string(value,name,{optional=false,empty=false,max=300}={}){
 if(optional&&value===undefined)return;
 if(typeof value!=='string'||!empty&&!value.trim()||value.length>max||value.includes('\0'))throw invalid('Invalid '+name);
}
function payloadFor(method,input){
 if(!SOCIAL_METHODS.includes(method)||!fields[method])throw invalid('Unsupported social client method');
 if(!object(input)||Object.keys(input).some(key=>!fields[method].includes(key)))throw invalid('Unknown or not allowed social payload field');
 let payload;try{payload=structuredClone(input);}catch{throw invalid('Invalid social payload');}
 if(JSON.stringify(payload).length>1024*1024)throw invalid('Invalid social payload size');
 for(const name of ['eventRef','activityId','leaseId','connectionRef','projectId','taskId','challengeId'])if(payload[name]!==undefined)string(payload[name],name);
 if(method==='social.context.read'||method==='search.native')string(payload.query,'query',{optional:method==='social.context.read',empty:method==='social.context.read',max:200000});
 if(method==='activity.lease')string(payload.activityId,'activityId');
 if(method==='activity.check'){string(payload.leaseId,'leaseId');if(!Number.isSafeInteger(payload.generation)||payload.generation<1)throw invalid('Invalid lease generation');}
 if(method==='activity.finish'){string(payload.leaseId,'leaseId');if(!['completed','failed','cancelled','unknown'].includes(payload.status))throw invalid('Invalid activity terminal status');}
 if(['experience.append','proactive.offer','owner.work.propose','owner.work.approve','owner.work.read','owner.work.cancel'].includes(method))string(payload.eventRef,'eventRef');
 if(['owner.work.read','owner.work.cancel'].includes(method))string(payload.taskId,'taskId');
 if(method==='owner.work.cancel'&&(!Number.isSafeInteger(payload.planVersion)||payload.planVersion<1))throw invalid('Invalid plan version');
 if(method==='proactive.offer'){
  if(payload.kind!==undefined&&!['share','selftalk'].includes(payload.kind))throw invalid('Invalid candidate kind');
  string(payload.text,'text',{optional:true,empty:true,max:200000});
  if(payload.expiresAt!==undefined&&payload.expiresAt!==null&&(!Number.isFinite(payload.expiresAt)||payload.expiresAt<0))throw invalid('Invalid candidate expiry');
 }
 if(method==='models.request'){
  string(payload.connectionRef,'connectionRef');string(payload.system,'system',{optional:true,empty:true,max:200000});
  string(payload.purpose,'purpose',{optional:true,max:64});
  if(payload.replyStylePolicy!==undefined){const policy=payload.replyStylePolicy;if(!object(policy)||Object.keys(policy).some(key=>!['defaultStyle','conversationStyle'].includes(key))||Object.values(policy).some(value=>!['inherit','brief','natural','detailed'].includes(value)))throw invalid('Invalid QQ reply style policy');}
  if(payload.background!==undefined&&typeof payload.background!=='boolean')throw invalid('Invalid background flag');
  if(!Array.isArray(payload.messages)||!payload.messages.length||payload.messages.length>10000||payload.messages.some(row=>!object(row)||Object.keys(row).some(key=>!['role','content'].includes(key))||!['user','assistant'].includes(row.role)||typeof row.content!=='string'||row.content.length>200000))throw invalid('Invalid social model messages');
 }
 if(method==='owner.work.propose')string(payload.projectId,'projectId');
 if(method==='owner.work.approve'){
  if((payload.taskId!==undefined)===(payload.challengeId!==undefined))throw invalid('Invalid approval request: select task challenge or explicit challenge approval');
 }
 return payload;
}

/** Thin transport client. Core alone issues tokens, evidence, leases and owner proofs. */
export function createSocialClient({pluginId,contextToken,invoke}={}){
 string(pluginId,'pluginId');string(contextToken,'contextToken',{max:8192});if(typeof invoke!=='function')throw invalid('Invalid social invoke transport');
 async function calls(method,payload={},options={}){
  const body=payloadFor(method,payload),signal=options?.signal;
  if(signal?.aborted)throw Object.assign(Error('Social call cancelled'),{code:'ABORT_ERR'});
  // Do not catch/rewrite Core errors, create evidence, retry a submission, or
  // attach a work principal. A leaseId is only an opaque Core reference.
  return invoke({pluginId,contextToken,method,payload:body},signal?{signal}:{});
 }
 return Object.freeze({version:SOCIAL_CONTRACT_VERSION,calls,
  context:(payload={},options)=>calls('social.context.read',payload,options),
  lease:(payload,options)=>calls('activity.lease',payload,options),
  check:(payload,options)=>calls('activity.check',payload,options),
  finish:(payload,options)=>calls('activity.finish',payload,options),
  append:(payload,options)=>calls('experience.append',payload,options),
  offer:(payload,options)=>calls('proactive.offer',payload,options),
  model:(payload,options)=>calls('models.request',payload,options),
  search:(payload,options)=>calls('search.native',payload,options),
  owner:Object.freeze({propose:(payload,options)=>calls('owner.work.propose',payload,options),read:(payload,options)=>calls('owner.work.read',payload,options),cancel:(payload,options)=>calls('owner.work.cancel',payload,options),challenge:(payload,options)=>calls('owner.work.approve',payload,options),approve:(payload,options)=>calls('owner.work.approve',payload,options)}),
 });
}
