import {estimateMemoryTokens} from './companion-memory.mjs';
import {defaultContextCapacity} from './context-capacity.mjs';
import {profileEffort} from './reasoning-settings.mjs';
import {nativeSearchCapability,nativeSearchTools} from './native-search.mjs';
import {checkedImages,imageInputCapability} from './model-images.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';

const modelObservation=new AsyncLocalStorage();
const modelLifecycle=new AsyncLocalStorage();
// Host-only async scope. The serializable request never carries an observer.
export function withR95ModelObservation(observe,operation){if(typeof observe!=='function'||typeof operation!=='function')throw Error('Private model observation requires host callbacks');return modelObservation.run(observe,operation);}
export function withR95ModelLifecycle(observe,operation){if(typeof observe!=='function'||typeof operation!=='function')throw Error('Private model lifecycle requires host callbacks');return modelLifecycle.run(observe,operation);}

const copy=value=>structuredClone(value);
const failure=(message,code)=>Object.assign(Error(message),{code});
const aborted=signal=>{if(signal?.aborted)throw failure('请求已取消','ABORT_ERR');};
const validTokens=n=>Number.isSafeInteger(n)&&n>=512&&n<=2000000;
const capacityError=capacity=>failure('结构化请求及输出预留超过所选上下文预算；原文完整保留，本次未提交最终模型请求','MEMORY_CONTEXT_CAPACITY');
function connectionState(profile){
 if(!profile)return null;
 return {id:profile.id,kind:profile.kind,protocol:profile.protocol,baseUrl:profile.baseUrl??'',model:profile.model,reasoningEffort:profileEffort(profile),contextTokens:profile.contextTokens??null,keyCiphertext:profile.keyCiphertext??null};
}
function frozenCapacity(provider,binding,profile){
 const supplied=provider.resolveContextCapacity?.(binding),model=profile?.models?.find(value=>value.id===profile.model||value.model===profile.model);
 if(validTokens(profile?.contextTokens))return {tokens:profile.contextTokens,source:'connection-setting',verified:false};
 if(validTokens(supplied?.tokens))return copy(supplied);
 for(const key of ['contextWindow','context_window','contextLength','inputTokenLimit','max_input_tokens'])if(validTokens(model?.[key]))return {tokens:model[key],source:'model-catalog',verified:true};
 return defaultContextCapacity();
}
function outputReserve(setting,profile,capacity){
 const model=profile?.models?.find(value=>value.id===profile.model||value.model===profile.model),declared=model?.maxOutputTokens??model?.max_output_tokens??model?.outputTokenLimit,ceiling=Number.isSafeInteger(declared)&&declared>0?Math.min(65536,declared):65536;
 if(setting==='auto')return Math.min(ceiling,8192,Math.max(256,Math.floor(capacity.tokens/4)));
 if(!Number.isSafeInteger(setting)||setting<256||setting>65536)throw failure('模型最多输出设置无效；未替换用户配置','R95_OUTPUT_LIMIT_INVALID');
 return Math.min(ceiling,setting);
}
function inputCost(system,messages,profile,selection){
 // Count the actual nested message-text escaping, not a raw string length.
 // The largest applicable native-search tool declaration is reserved even if
 // Core later denies search; no capability/permission is granted here.
 const capability=nativeSearchCapability(profile??{}),tools=capability.supported?nativeSearchTools(capability):[];
 const images=messages.flatMap(m=>Array.isArray(m.content)?m.content.filter(p=>p.type==='image'):[]),textMessages=images.length?messages.map(m=>({...m,content:Array.isArray(m.content)?m.content.filter(p=>p.type!=='image'):m.content})):messages;
 return estimateMemoryTokens({model:selection.model,reasoningEffort:selection.reasoningEffort,system,messages:textMessages,...(tools.length?{tools}:{})})+256+images.length*8192;
}
function historyMessages(rows){
 if(rows==null)return [];
 if(!Array.isArray(rows))throw failure('记忆 history 格式无效','R95_MEMORY_INVALID');
 return rows.map(row=>{
  if(!row||!['user','assistant'].includes(row.role)||typeof row.text!=='string')throw failure('记忆 history 只允许已许可的用户和角色原文','R95_MEMORY_INVALID');
  return {role:row.role,content:[{type:'text',text:row.text}]};
 });
}

/** Core-only structured request. The owner persists originals and validates
 * life/cancellation in withOrigin; ModelRouter remains the sole transport,
 * native-search observer and actual-use accounting owner. */
export async function runR95Model({provider,card,scope,system,input,memory,memoryArgs={},signal,withOrigin,withMemoryContext=(_metadata,fn)=>fn(),checkCurrent,parseOutput,activityKind='chat',originId,hostImages=null,beforeModelSubmit=null,onModelLifecycle=null,presentationInstructions=''}={}){
 if(!provider||typeof provider.stream!=='function'||typeof withOrigin!=='function')throw failure('本体模型请求入口尚未就绪','R95_MODEL_UNAVAILABLE');
 if(typeof presentationInstructions!=='string')throw failure('表达指令必须由宿主提供','R95_SYSTEM_INVALID');
  if(typeof system!=='string')throw failure('本体系统指令必须由宿主提供','R95_SYSTEM_INVALID');
 if(checkCurrent!=null&&typeof checkCurrent!=='function'||parseOutput!=null&&typeof parseOutput!=='function'||beforeModelSubmit!=null&&typeof beforeModelSubmit!=='function'||onModelLifecycle!=null&&typeof onModelLifecycle!=='function')throw failure('请求检查及结果解析仅接受宿主私有函数','R95_HOST_CALLBACK_INVALID');
 const frozenCard=copy(card),frozenScope=copy(scope),binding=copy(card?.modelBinding??null);
 if(!frozenCard?.id||frozenCard.id!==frozenScope?.characterId)throw failure('角色请求归属无效','R95_SCOPE_INVALID');
 let query;try{query=JSON.stringify(input);}catch{throw failure('结构化请求不能序列化；原始数据未修改','R95_INPUT_INVALID');}if(typeof query!=='string')throw failure('结构化请求为空','R95_INPUT_INVALID');
 const requestInput=JSON.parse(query);aborted(signal);await provider.ready;aborted(signal);
 const lifecycleObserver=modelLifecycle.getStore(),dispatchLifecycle=onModelLifecycle||lifecycleObserver?async event=>{if(onModelLifecycle)await onModelLifecycle(copy(event));if(lifecycleObserver)await lifecycleObserver({scope:copy(frozenScope),input:copy(requestInput),event:copy(event)});}:null;
 const images=hostImages===null?null:checkedImages(hostImages);
 if(provider.enabled===false)throw failure('联网聊天关闭','R95_MODEL_DISABLED');
 const route=provider.resolveConnection?.(binding);if(route?.error)throw failure(route.error,'R95_CONNECTION_UNAVAILABLE');
 const profile=copy(provider.captureConnection?.(binding)??null),dedicated=binding?.enabled===true;
 if((typeof provider.captureConnection==='function'||dedicated)&&!profile)throw failure(dedicated?'角色专属连接无法捕获；不能回落全局或猜测模型配置':'全局聊天连接不存在','R95_CONNECTION_UNAVAILABLE');
 if(profile&&(profile.enabled===false||profile.capabilities?.chat===false||!profile.model))throw failure('角色聊天连接不可用或不支持聊天','R95_CONNECTION_UNAVAILABLE');
 if(dedicated&&profile?.id&&profile.id!==binding.connectionId)throw failure('角色专属连接与捕获结果不符','R95_CONNECTION_UNAVAILABLE');
 if(images){const capability=imageInputCapability(profile);if(!capability.supported)throw failure(capability.reason,capability.reason);}
 if(dedicated&&typeof provider.runCaptured!=='function'&&typeof provider.runProfile!=='function')throw failure('角色专属连接缺少执行入口，不能回落全局连接','R95_CONNECTION_UNAVAILABLE');
 const selected=profile?{provider:profile.id,model:profile.model,reasoningEffort:profileEffort(profile)}:dedicated?{provider:binding.connectionId,model:route?.model,reasoningEffort:null}:{...copy(provider.currentSelection?.()??{}),reasoningEffort:profileEffort(provider.selected?.())};
 if(!selected.provider||!selected.model)throw failure('无法冻结实际聊天连接及模型','R95_CONNECTION_UNAVAILABLE');
 const capacity=frozenCapacity(provider,binding,profile),setting=provider.outputLimit?.()??8192,reserve=outputReserve(setting,profile,capacity),expected=connectionState(profile);
 const systemTokens=inputCost([system,presentationInstructions].filter(Boolean).join('\n'),[],profile,selected);
 if(systemTokens+reserve+64>=capacity.tokens)throw Object.assign(capacityError(capacity),{capacity:copy(capacity)});
 if(memoryArgs.queryInHistory===true)throw failure('本次结构化输入尚未在记忆历史中，不能省略','R95_MEMORY_INVALID');
 return withOrigin(frozenScope,activityKind,async activityOriginId=>{
  aborted(signal);activityOriginId??=originId;
  const current=async()=>{aborted(signal);if(typeof checkCurrent==='function'&&(await checkCurrent(copy(frozenScope),activityOriginId))===false)throw failure('人生、操作代次或请求来源已撤销','R95_REQUEST_STALE');aborted(signal);};
  await current();
  const knowledge=!images&&typeof memory?.context==='function'?await withMemoryContext({card:copy(frozenCard),connection:copy(profile),frozenContextCapacity:copy(capacity),scope:copy(frozenScope),checkCurrent:current},()=>memory.context({...copy(memoryArgs),characterId:frozenScope.characterId,personaId:frozenScope.personaId,conversationId:memoryArgs.conversationId??frozenScope.conversationId,query,queryInHistory:false,systemTokens,reserveTokens:reserve})):null;
  await current();
  if(knowledge?.lifeId&&knowledge.lifeId!==frozenScope.lifeId||knowledge?.operationId&&knowledge.operationId!==frozenScope.operationId)throw failure('记忆结果属于另一人生或操作代次','R95_MEMORY_STALE');
  const queryText=knowledge&&Object.hasOwn(knowledge,'queryText')?knowledge.queryText:query;
  if(typeof queryText!=='string'||!queryText.trim())throw failure('记忆压缩后的当前输入无效；不重新提交未压缩原文','R95_MEMORY_INVALID');
  if(knowledge?.text!=null&&typeof knowledge.text!=='string')throw failure('记忆正文格式无效','R95_MEMORY_INVALID');
  const finalSystem=[system,knowledge?.text,presentationInstructions].filter(value=>value!=null&&value!=='').join('\n'),messages=[...historyMessages(knowledge?.messages),{role:'user',content:[{type:'text',text:queryText},...(images??[])]}];
  const contextTokens=Math.min(capacity.tokens,validTokens(knowledge?.capacity?.tokens)?knowledge.capacity.tokens:capacity.tokens),requestCost=inputCost(finalSystem,messages,profile,selected);
  if(requestCost+reserve+64>contextTokens)throw Object.assign(capacityError(capacity),{capacity:{...copy(capacity),tokens:contextTokens,estimatedInputTokens:requestCost,reserveTokens:reserve}});
  const run=async()=>{
   await current();if(provider.enabled===false)throw failure('联网聊天关闭','R95_MODEL_DISABLED');
   const selectionNow=provider.currentSelection?.(),live=provider.selected?.();
   if(selectionNow&&(selectionNow.provider!==selected.provider||selectionNow.model!==selected.model)||expected&&live&&JSON.stringify(connectionState(live))!==JSON.stringify(expected))throw failure('捕获的角色连接、模型或推理强度已变化；未提交','R95_CONNECTION_CHANGED');
   if(typeof provider.withFrozenBudget!=='function'){
    const currentLimit=provider.outputLimit?.()??8192,currentCapacity=provider.resolveContextCapacity?.(binding)??capacity;
    if(currentLimit!==setting||currentCapacity.tokens!==capacity.tokens)throw failure('请求排队期间输出或上下文预算已变化；请重新核对','R95_BUDGET_CHANGED');
   }
   const stream=async()=>{
    await current();let output='',partsBytes=0,observed=false;const parts=[];
    const parse=()=>typeof parseOutput==='function'?parseOutput({text:output,parts,requestId:activityOriginId}):JSON.parse(output.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
    const observe=async()=>{const callback=modelObservation.getStore();if(callback){const result=await parse();await callback({scope:copy(frozenScope),input:copy(requestInput),result:copy(result)});}observed=true;};
    const boundary=provider.supportsSubmissionLifecycle===true&&(beforeModelSubmit||dispatchLifecycle)?{beforeModelSubmit:async()=>{await current();if(beforeModelSubmit)await beforeModelSubmit();await current();},checkModelSubmit:current,...(dispatchLifecycle?{onModelLifecycle:dispatchLifecycle}:{})}:{};
    // Unknown injected providers retain the conservative claim-before-stream
    // contract. Only an instrumented transport can assert definite not-sent.
    if(beforeModelSubmit&&!boundary.beforeModelSubmit){await beforeModelSubmit();await current();}
    for await(const chunk of provider.stream({provider:selected.provider,model:selected.model,reasoningEffort:selected.reasoningEffort,system:finalSystem,messages,purpose:typeof requestInput?.kind==='string'?requestInput.kind:'social',activityOriginId,scope:copy(frozenScope),signal,userLimit:true,maxTokens:reserve,...(images||beforeModelSubmit?{singleSubmission:true}:{}),...boundary})){
     if(typeof parseOutput==='function'){let part;try{part=copy(chunk);partsBytes+=Buffer.byteLength(JSON.stringify(part),'utf8');}catch{throw failure('模型事件不能安全复制','R95_EVENT_INVALID');}if(partsBytes>16*1024*1024)throw failure('模型事件总量过大','R95_RESPONSE_TOO_LARGE');parts.push(part);}
     if(chunk.type==='text-delta'){output+=chunk.text??'';if(Buffer.byteLength(output,'utf8')>1024*1024)throw failure('模型回复过长','R95_RESPONSE_TOO_LARGE');}
     if(chunk.type==='finish'&&['error','aborted','length'].includes(chunk.reason?.kind))throw failure(chunk.reason?.failure?.message??(chunk.reason?.kind==='length'?'结构化模型回复被截断':'模型请求失败或取消'),chunk.reason?.kind==='length'?'MODEL_OUTPUT_TRUNCATED':'R95_MODEL_FAILED');
     if(chunk.type==='finish'&&chunk.reason?.kind==='stop'&&!observed)await observe();
     await current();
    }
    if(!observed)await observe();await current();const result=await parse();await current();return result;
   };
   return typeof provider.withFrozenBudget==='function'?provider.withFrozenBudget({outputLimit:setting,contextTokens:capacity.tokens},stream):stream();
  };
  if(profile&&typeof provider.runCaptured==='function')return provider.runCaptured(profile,run,signal,{background:true});
  if(dedicated)return provider.runProfile(binding.connectionId,run,signal,{background:true});
  return typeof provider.runTurn==='function'?provider.runTurn(run,signal,{background:true}):run();
 },{signal,originId});
}
