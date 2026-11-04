import {createHash,randomUUID} from 'node:crypto';

const copy=v=>structuredClone(v),hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=(code,message=code)=>Object.assign(Error(message),{code});
const auth=p=>hash({id:p.id,kind:p.kind,protocol:p.protocol,baseUrl:p.baseUrl,keyCiphertext:p.keyCiphertext??null,enabled:p.enabled!==false});
/** Recipes persist selection, never credentials; current authorization is checked at dispatch and commit. */
export function createGameModelBindings({economy,getProvider,getContext,now=Date.now}){
 const running=new Map();let closed=false,closePromise;
 function prepare({id,scope,modelBinding}){const old=economy.binding(id);if(old){assertCurrent(old);return old;}const p=getProvider();if(!p?.enabled)throw fail('GAME_MODEL_OFFLINE');const selected=p.captureConnection(modelBinding);if(!selected||selected.enabled===false||selected.capabilities?.chat===false)throw fail('GAME_MODEL_UNAVAILABLE');const recipe=Object.fromEntries(['id','kind','protocol','baseUrl','model','reasoningEffort','contextTokens'].filter(k=>selected[k]!==undefined).map(k=>[k,selected[k]]));if(!recipe.model)throw fail('GAME_MODEL_UNAVAILABLE');return {id,scope:copy(scope),recipe,authEpoch:auth(selected),createdAt:now()};}
 function capture(spec){const value=prepare(spec);return economy.binding(value.id)??economy.binding(value);}
 function assertCurrent(binding){if(closed)throw fail('GAME_MODEL_CLOSED');const p=getProvider(),current=p?.state?.profiles.find(row=>row.id===binding.recipe.id);if(!p?.enabled||!current||auth(current)!==binding.authEpoch||current.enabled===false||current.capabilities?.chat===false)throw fail('GAME_BINDING_REVOKED');if(current.kind==='claude-code'||current.protocol==='work')throw fail('GAME_CHAT_ROUTE_UNAVAILABLE');return {...copy(current),...copy(binding.recipe),keyCiphertext:current.keyCiphertext};}
 async function check(binding,guard=async()=>{}){await guard();await getProvider()?.ready;return assertCurrent(binding);}
 async function request({bindingId,requestId=randomUUID(),messages,system,scope,purpose='game-action',receiptKey,guard=async()=>{},signal}){
  const binding=economy.binding(bindingId);if(!binding)throw fail('GAME_BINDING_MISSING');for(const k of ['characterId','personaId','lifeId','operationId'])if(scope?.[k]!==binding.scope[k])throw fail('GAME_MODEL_SCOPE_DENIED');
  const fingerprint=hash({bindingId,messages,system,scope,purpose,receiptKey}),receipt={id:requestId,bindingId,fingerprint,purpose,receiptKey},prior=economy.request(requestId);if(prior){if(prior.fingerprint!==fingerprint)throw fail('GAME_REQUEST_CONFLICT');if(prior.state==='completed')return copy(prior.result);throw fail('GAME_REQUEST_ALREADY_SUBMITTED','原请求尚未确认；请查询状态，明确重试需新请求编号');}
  if(running.has(requestId))throw fail('GAME_MODEL_BUSY');const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const task=(async()=>{const p=getProvider(),profile=await check(binding,guard);combined.throwIfAborted();economy.request({...receipt,state:'queued',createdAt:now()});let output='';
   try{await p.runCaptured(profile,async()=>{await check(binding,guard);combined.throwIfAborted();economy.request({...receipt,state:'submitted',createdAt:now()});
    const execute=async()=>{for await(const part of p.stream({messages:copy(messages),system,scope:copy(scope),purpose,nativeSearch:{allowed:false},gameBinding:{model:profile.model,provider:profile.kind},signal:combined})){await check(binding,guard);combined.throwIfAborted();if(part.type==='text-delta')output+=part.text??'';if(part.type==='finish'&&['error','aborted','length'].includes(part.reason?.kind))throw fail('GAME_MODEL_INCOMPLETE');}};
    if(p.withRequestContext)await p.withRequestContext({scope:copy(scope),purpose},execute);else await execute();
   },combined);await check(binding,guard);combined.throwIfAborted();assertCurrent(binding);const result={requestId,text:output,connection:{id:profile.id,kind:profile.kind,model:profile.model},usageAccounting:'core-model-router'};economy.request({...receipt,state:'completed',result,at:now()});return result;
   }catch(error){economy.request({...receipt,state:combined.aborted?'cancelled':'failed',code:error.code??'GAME_MODEL_FAILED',at:now(),autoRetry:false});throw error;}
  })();running.set(requestId,{requestId,controller,task});try{return await task;}finally{if(running.get(requestId)?.task===task)running.delete(requestId);}
 }
 return {capture,prepare,check,request,assertPrepared:assertCurrent,assert(bindingId){const binding=economy.binding(bindingId);if(!binding)throw fail('GAME_BINDING_MISSING');return assertCurrent(binding);},status:id=>economy.request(id),cancel(requestId){for(const row of running.values())if(row.requestId===requestId)row.controller.abort();return {cancelRequested:true};},close(){if(closePromise)return closePromise;closed=true;closePromise=Promise.resolve().then(async()=>{for(const row of running.values())row.controller.abort();await Promise.allSettled([...running.values()].map(row=>row.task));});return closePromise;}};
}
