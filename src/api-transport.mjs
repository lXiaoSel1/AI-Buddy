import {CHAT_FINISH_IDLE_MS,isUsageObject,readSseEvents} from './api-sse.mjs';
import {connectionIdentity} from './service-identity.mjs';
import {randomUUID} from 'node:crypto';
import {cleanModelCatalog,effortSupport,validateProfileEffort,effortProtocol} from './reasoning-settings.mjs';
import {streamNativeSearch} from './native-search-transport.mjs';
import {checkedImagePart,imageDataUrl} from './model-images.mjs';
import {createModelSubmission} from './model-submission.mjs';
import {apiHttpError,readApiHttpError} from './api-http-error.mjs';
import {officialCacheProvider,requestCacheOptions,summaryCacheOptions,supportsKimiCacheTtl} from './api-cache-capabilities.mjs';
const textOf=value=>typeof value==='string'?value:Array.isArray(value)?value.filter(part=>part.type==='text'||part.type==='input_text'||part.type==='output_text').map(part=>part.text??'').join('\n'):'';
const messagesOf=options=>(options.messages??[]).map(message=>{const role=message.role==='assistant'?'assistant':'user',mixed=Array.isArray(message.content)&&message.content.some(p=>p.type==='image');if(!mixed)return {role,content:textOf(message.content)};if(role!=='user')throw Error('MODEL_IMAGE_INVALID');return {role,content:message.content.map(p=>p.type==='image'?checkedImagePart(p):p.type==='text'&&typeof p.text==='string'?{type:'text',text:p.text}:(()=>{throw Error('MODEL_IMAGE_INVALID');})())};});
const partsOf=message=>typeof message.content==='string'?[{type:'text',text:message.content}]:message.content;
const wireContent=(message,protocol)=>partsOf(message).map(p=>p.type==='text'?protocol==='responses'?{type:message.role==='assistant'?'output_text':'input_text',text:p.text}:protocol==='gemini'?{text:p.text}:{type:'text',text:p.text}:protocol==='anthropic'?{type:'image',source:{type:'base64',media_type:p.mimeType,data:p.data}}:protocol==='gemini'?{inlineData:{mimeType:p.mimeType,data:p.data}}:protocol==='responses'?{type:'input_image',image_url:imageDataUrl(p)}:{type:'image_url',image_url:{url:imageDataUrl(p)}});
const REASONING_EFFORTS=new Set(['none','minimal','low','medium','high','xhigh','max','ultra']);
const PROBE_WIRE_LIMIT=1024*1024;
const PROBE_DIAGNOSTIC_CODES=new Set(['MODEL_IMAGE_PROBE_RESPONSE_TOO_LARGE','MODEL_IMAGE_PROBE_INCOMPLETE','MODEL_IMAGE_PROBE_TIMEOUT','MODEL_OUTPUT_TRUNCATED','API_HTTP_ERROR','ABORT_ERR','MODEL_IMAGE_PROBE_FAILED']);
function requestBody(profile,options){
  // 'auto' leaves the output limit to the provider (Anthropic requires one, so 8192 there).
  const messages=messagesOf(options),budget=options.purpose==='emotion'?2048:options.maxTokens==='auto'?(profile.protocol==='anthropic'?8192:null):Math.max(1,Math.min(65536,Number(options.maxTokens)||2048));
  const effort=REASONING_EFFORTS.has(profile.reasoningEffort)?profile.reasoningEffort:undefined;
  if(profile.protocol==='gemini')return {systemInstruction:options.system?{parts:[{text:options.system}]}:undefined,contents:messages.map(message=>({role:message.role==='assistant'?'model':'user',parts:wireContent(message,'gemini')})),generationConfig:budget?{maxOutputTokens:budget}:{}};
  if(profile.protocol==='anthropic'){
    if(options.cacheContext?.kind==='private'){
      const content=messages.map(message=>Array.isArray(message.content)?{...message,content:wireContent(message,'anthropic')}:message);
      return {model:profile.model,system:options.system||undefined,messages:content,max_tokens:budget,stream:true};
    }
    const combined=[];for(const message of messages){const previous=combined.at(-1);if(previous?.role===message.role){if(typeof previous.content==='string'&&typeof message.content==='string')previous.content+='\n\n'+message.content;else previous.content=[...partsOf(previous),{type:'text',text:'\n\n'},...partsOf(message)];}else combined.push({...message});}for(const message of combined)if(Array.isArray(message.content))message.content=wireContent(message,'anthropic');
    return {model:profile.model,system:options.system||undefined,messages:combined,max_tokens:budget,stream:true};
  }
  if(profile.protocol==='responses')return {model:profile.model,instructions:options.system||undefined,input:messages.map(m=>Array.isArray(m.content)?{...m,content:wireContent(m,'responses')}:m),...(budget?{max_output_tokens:budget}:{}),stream:true,store:false,...(effort?{reasoning:{effort}}:{})};
  return {model:profile.model,messages:[...(options.system?[{role:'system',content:options.system}]:[]),...messages.map(m=>Array.isArray(m.content)?{...m,content:wireContent(m,'chat-completions')}:m)],...(budget?{max_tokens:budget}:{}),stream:true,stream_options:{include_usage:true},...(profile.protocol==='chat-completions'&&effort?{reasoning_effort:effort}:{})};
}
function headers(profile){return {'Content-Type':'application/json',...(profile.protocol==='gemini'?{'x-goog-api-key':profile.key}:profile.protocol==='anthropic'?{'x-api-key':profile.key,'anthropic-version':'2023-06-01'}:profile.key?{Authorization:'Bearer '+profile.key}:{})};}
export const apiError=apiHttpError;
const numeric=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const headerCount=(headers,name)=>{
  const value=headers?.get(name);
  return typeof value==='string'&&/^\d+$/.test(value)?numeric(Number(value)):null;
};
export function normalizeApiUsage(raw,protocol,{provider,complete=false,headers,requestedCacheTtl,cacheWriteMode,onCacheWriteHeaderMismatch}={}){
  const rawUsage=isUsageObject(raw)?raw:null;
  raw=rawUsage??{};
  const usageQuality=new Set();
  const first=(...values)=>{
    const valid=values.map(numeric).filter(value=>value!==null);
    if(new Set(valid).size>1)usageQuality.add('conflict');
    if(values.some(value=>value!==undefined&&numeric(value)===null))usageQuality.add('invalid-counter');
    return valid[0]??null;
  };
  const readAliases=[raw.input_tokens_details?.cached_tokens,raw.prompt_tokens_details?.cached_tokens,raw.cache_read_input_tokens,raw.cachedContentTokenCount,raw.total_cached_tokens,raw.prompt_cache_hit_tokens,raw.prompt_tokens_details?.prompt_cache_hit_tokens,raw.cached_tokens];
  const hit=first(raw.prompt_cache_hit_tokens,raw.prompt_tokens_details?.prompt_cache_hit_tokens);
  const miss=first(raw.prompt_cache_miss_tokens,raw.prompt_tokens_details?.prompt_cache_miss_tokens);
  let input=first(raw.input_tokens,raw.prompt_tokens,raw.promptTokenCount,raw.total_input_tokens);
  let cacheRead=first(...readAliases);
  const output=first(raw.output_tokens,raw.completion_tokens,raw.candidatesTokenCount,raw.total_output_tokens);
  const cacheIncluded=protocol!=='anthropic';
  if(cacheIncluded&&input===null&&hit!==null&&miss!==null&&numeric(hit+miss)!==null){
    input=hit+miss;
    usageQuality.add('calculated');
  }
  const kimi=provider==='kimi'&&protocol==='chat-completions';
  const completeKimiDetails=kimi&&complete&&isUsageObject(raw.prompt_tokens_details);
  if(cacheRead===null&&readAliases.every(value=>value===undefined)&&complete&&
    (completeKimiDetails||input!==null&&output!==null&&['deepseek','kimi'].includes(provider))){
    cacheRead=0;
    usageQuality.add('assumed-zero-required-field');
  }
  if(cacheIncluded&&input!==null&&cacheRead!==null&&miss!==null&&input-cacheRead!==miss)usageQuality.add('conflict');
  const includedWrite=[raw.prompt_tokens_details?.cache_write_tokens,raw.prompt_tokens_details?.cache_creation_input_tokens,raw.input_tokens_details?.cache_write_tokens];
  let cacheWrite,cacheWrite5m,cacheWrite1h;
  if(kimi){
    if(cacheWriteMode!==null)requestedCacheTtl=requestedCacheTtl==='1h'?'1h':'5m';
    const bodyWrite=raw.prompt_tokens_details?.cache_write_tokens;
    cacheWrite=first(bodyWrite);
    if(bodyWrite===undefined&&complete&&(completeKimiDetails||input!==null&&output!==null)){
      cacheWrite=0;
      usageQuality.add('assumed-zero-required-field');
    }
    cacheWrite5m=cacheWrite===null?null:requestedCacheTtl==='1h'?0:cacheWrite;
    cacheWrite1h=cacheWrite===null?null:requestedCacheTtl==='1h'?cacheWrite:0;
    const reported5m=headerCount(headers,'Msh-Usage-Cache-Write-Tokens-5m');
    const reported1h=headerCount(headers,'Msh-Usage-Cache-Write-Tokens-1h');
    if(cacheWrite!==null&&(reported5m!==null&&reported5m!==cacheWrite5m||reported1h!==null&&reported1h!==cacheWrite1h))
      onCacheWriteHeaderMismatch?.({requestedCacheTtl,cacheWrite,reported5m,reported1h});
  }else{
    cacheWrite=first(raw.cache_creation_input_tokens,...includedWrite,raw.cache_write_tokens);
    cacheWrite5m=numeric(raw.cache_creation?.ephemeral_5m_input_tokens);
    cacheWrite1h=numeric(raw.cache_creation?.ephemeral_1h_input_tokens);
    if(cacheWrite5m!==null&&cacheWrite1h!==null){
      const splitTotal=cacheWrite5m+cacheWrite1h;
      if(cacheWrite===null)cacheWrite=numeric(splitTotal);
      else if(cacheWrite!==splitTotal)usageQuality.add('conflict');
    }
    if(cacheWrite!==null&&((cacheWrite5m??0)>cacheWrite||(cacheWrite1h??0)>cacheWrite))usageQuality.add('conflict');
  }
  const cacheWriteIncluded=!cacheIncluded?false:cacheWrite===null?null:
    kimi||includedWrite.some(value=>numeric(value)===cacheWrite)||numeric(raw.cache_write_tokens)===cacheWrite&&protocol==='responses'?true:null;
  const reasoning=first(raw.output_tokens_details?.reasoning_tokens,raw.completion_tokens_details?.reasoning_tokens,raw.thoughtsTokenCount,raw.total_thought_tokens);
  const reportedTotal=first(raw.total_tokens,raw.totalTokenCount);
  const total=reportedTotal??(input!==null&&output!==null?input+output+(!cacheIncluded?(cacheRead??0)+(cacheWrite??0):0)+(protocol==='gemini'?(reasoning??0)+(numeric(raw.toolUsePromptTokenCount??raw.total_tool_use_tokens)??0):0):null);
  if(rawUsage&&!complete)usageQuality.add('incomplete-usage');
  const counters={input,output,cacheRead,cacheWrite,reasoning,total};
  return {...counters,cacheIncluded,cacheWriteIncluded,cacheWrite5m,cacheWrite1h,cacheWriteMode:cacheWriteMode??null,requestedCacheTtl:requestedCacheTtl??null,inputBasis:cacheIncluded?'total':'uncached',knownFields:Object.keys(counters).filter(key=>counters[key]!==null),usageSchemaVersion:2,usageQuality:[...usageQuality],totalQuality:reportedTotal!==null?'reported':total!==null?'calculated':'partial',rawUsage};
}
async function responseText(response,onActivity,probe=false,diagnostic=null){
  if(!probe&&(!onActivity||!response.body))return response.text();
  if(!response.body)throw Object.assign(Error('MODEL_IMAGE_PROBE_INCOMPLETE'),{code:'MODEL_IMAGE_PROBE_INCOMPLETE'});
  const decoder=new TextDecoder();let text='',bytes=0;
  for await(const chunk of response.body){if(chunk.byteLength)onActivity?.();bytes+=chunk.byteLength;if(diagnostic)diagnostic.wireBytes=bytes;if(bytes>(probe?PROBE_WIRE_LIMIT:2*1024*1024)){if(diagnostic){diagnostic.budgetLayer='wire';diagnostic.limit=PROBE_WIRE_LIMIT;}throw probe?Object.assign(Error('MODEL_IMAGE_PROBE_RESPONSE_TOO_LARGE'),{code:'MODEL_IMAGE_PROBE_RESPONSE_TOO_LARGE'}):Error('模型响应过大，请重试');}text+=decoder.decode(chunk,{stream:true});}
  return text+decoder.decode();
}
function parsePayload(value,profile,state,probe=false,collectFilteredUsage=false){
  let text='',done=false;
  // An output-limit stop is reported as truncation (finish kind 'length'), never as a normal stop.
  if(value.type==='response.incomplete'&&value.response?.incomplete_details?.reason==='max_output_tokens'){state.usage=value.response.usage??state.usage;state.truncated=true;return {text,done:true};}
  if(value.error||value.type==='error'||value.type==='response.failed'||value.type==='response.incomplete')throw Error('模型回复失败，请检查服务或稍后重试');
  if(profile.protocol==='gemini'){
    const candidate=value.candidates?.[0];text=(candidate?.content?.parts??[]).filter(part=>!part.thought).map(part=>part.text??'').join('');
    if(candidate?.finishReason){if(!['STOP','MAX_TOKENS'].includes(candidate.finishReason))throw Error('模型未返回可用回复，请重试');if(candidate.finishReason==='MAX_TOKENS')state.truncated=true;done=true;}
    if(value.promptFeedback?.blockReason)throw Error('模型未返回可用回复，请重试');if(value.usageMetadata)state.usage=value.usageMetadata;
  }else if(profile.protocol==='anthropic'){
    if(value.type==='content_block_delta'&&value.delta?.type==='text_delta')text=value.delta.text??'';
    if(value.type==='message_start')state.usage={...state.usage,...value.message?.usage};
    if(value.usage)state.usage={...state.usage,...value.usage};if(value.type==='message_delta'&&value.delta?.stop_reason==='max_tokens')state.truncated=true;if(value.type==='message_stop')done=true;
    if((!value.type||probe&&value.type==='message')&&value.content){text=value.content.filter(part=>part.type==='text').map(part=>part.text??'').join('');if(value.stop_reason==='max_tokens')state.truncated=true;done=true;}
  }else if(profile.protocol==='responses'){
    if(value.type==='response.output_text.delta')text=value.delta??'';
    if(value.type==='response.completed'){done=true;state.usage=value.response?.usage;}
    if(value.output&&!value.type){if(value.status==='incomplete'){if(value.incomplete_details?.reason!=='max_output_tokens')throw Error('模型回复失败，请检查服务或稍后重试');state.truncated=true;}text=value.output.flatMap(item=>item.content??[]).filter(part=>part.type==='output_text').map(part=>part.text??'').join('');done=true;state.usage=value.usage;}
  }else{
    const choice=value.choices?.[0];text=textOf(choice?.delta?.content??choice?.message?.content);done=!!choice?.finish_reason;if(choice?.finish_reason==='length')state.truncated=true;
    if(choice?.finish_reason==='content_filter'&&collectFilteredUsage){
      state.filtered=true;
      text='';
    }else if(choice?.finish_reason==='content_filter'||choice?.finish_reason==='tool_calls')throw Error('模型未返回聊天正文，请重试');
    if(isUsageObject(value.usage))state.usage=value.usage;
  }
  return {text,done};
}
// Capability evidence requires protocol completion, not a permissive JSON/SSE wrapper.
// Other purposes retain the existing compatibility behavior in parsePayload.
function probeTerminal(value,profile,state,streaming){
  if(profile.protocol==='anthropic'){
   if(streaming){if(value.type==='message_delta'&&typeof value.delta?.stop_reason==='string')state.probeStop=value.delta.stop_reason;return value.type==='message_stop'&&['end_turn','stop_sequence','max_tokens'].includes(state.probeStop);}
    return ['end_turn','stop_sequence','max_tokens'].includes(value.stop_reason);
  }
  if(profile.protocol==='responses')return streaming?value.type==='response.completed'&&value.response?.status==='completed'||value.type==='response.incomplete'&&state.truncated:value.status==='completed'||value.status==='incomplete'&&state.truncated;
  if(profile.protocol==='gemini')return ['STOP','MAX_TOKENS'].includes(value.candidates?.[0]?.finishReason);
  return ['stop','length'].includes(value.choices?.[0]?.finish_reason);
}
export async function fetchModelResponse(fetchImpl,input,init={}){
 const initial=new URL(input);let target=initial,options={...init,redirect:'manual'};
 for(let hop=0;;hop++){
  const response=await fetchImpl(target.href,options);if(![301,302,303,307,308].includes(response.status))return response;
  const location=response.headers.get('location');await response.body?.cancel();if(!location||hop>=5)throw Error('服务地址重定向过多');
  const next=new URL(location,target);if(next.hostname!==initial.hostname||next.username||next.password||!['http:','https:'].includes(next.protocol)||initial.protocol==='https:'&&next.protocol!=='https:')throw Object.assign(Error('服务地址跳转到了 '+next.origin+next.pathname+'，请直接填它'),{code:'NETWORK_REDIRECT'});
  if(response.status===303&&options.method!=='HEAD'||[301,302].includes(response.status)&&options.method==='POST'){options={...options,method:'GET'};delete options.body;const headers=new Headers(options.headers);headers.delete('content-type');options.headers=headers;}
  target=next;
 }
}
export class ApiTransport{
  constructor({fetchImpl=globalThis.fetch,onUsage=()=>{},audit=()=>{}}={}){this.fetch=(input,init)=>fetchModelResponse(fetchImpl,input,init);this.onUsage=onUsage;this.audit=audit;}
  async *stream(profile,options){
    const submission=createModelSubmission(options,'api',{requestId:randomUUID()});
    try{await submission.prepare();yield* this.streamRequest(profile,options,submission);await submission.complete();}catch(error){throw await submission.failure(error);}
  }
  async *streamRequest(profile,options,submission){
    if(effortProtocol(profile.protocol))validateProfileEffort(profile);
    const requestId=submission.details.requestId;
    const cache=requestCacheOptions(profile,options.cacheContext);
    const summaryRequest=options.purpose==='chat-window-compact';
    const summary=summaryRequest?summaryCacheOptions(profile):{};
    const modelBody=()=>({...requestBody(profile,options),...cache.body,...summary});
    const modelHeaders=()=>({...headers(profile),...cache.headers});
    const normalizeUsage=(raw,protocol,metadata)=>normalizeApiUsage(raw,protocol,{
      provider:officialCacheProvider(profile),requestedCacheTtl:cache.requestedCacheTtl,cacheWriteMode:supportsKimiCacheTtl(profile)?'ttl':null,
      onCacheWriteHeaderMismatch:counts=>this.audit({type:'api-cache-write-header-mismatch',requestId:metadata?.providerRequestId??requestId,...counts}),...metadata
    });
    if(options.nativeSearch?.allowed===true){yield* streamNativeSearch(profile,options,{fetch:this.fetch,onUsage:this.onUsage,audit:this.audit,requestBody:modelBody,headers,modelHeaders,normalizeUsage,apiError,parsePayload,submission});return;}
    const probe=options.purpose==='image-capability-probe',started=Date.now(),state={usage:null};let finished=false,usageComplete=false,finalUsage=false,outputLength=0,status=null,httpError=null,responseHeaders=null;
    // Probe-only counters contain no response content. completed still means a
    // protocol terminal was seen, not that the caller accepted capability proof.
    const diagnostic=probe?{format:null,wireBytes:0,answerBytes:0,budgetLayer:null,limit:PROBE_WIRE_LIMIT,errorCode:null}:null;
    const observeAnswer=text=>{if(!diagnostic)return;diagnostic.answerBytes+=Buffer.byteLength(text,'utf8');if(diagnostic.answerBytes>4096){diagnostic.errorCode='MODEL_IMAGE_PROBE_RESPONSE_TOO_LARGE';diagnostic.budgetLayer='answer';diagnostic.limit=4096;}else if(state.truncated)diagnostic.errorCode='MODEL_OUTPUT_TRUNCATED';};
    const route=profile.protocol==='gemini'?'/models/'+encodeURIComponent(profile.model.replace(/^models\//,''))+':streamGenerateContent?alt=sse':profile.protocol==='anthropic'?'/messages':profile.protocol==='responses'?'/responses':'/chat/completions';
    try{
      const url=profile.baseUrl+route,init={method:'POST',headers:modelHeaders(),body:JSON.stringify(modelBody()),signal:options.signal,redirect:'error'};
      await submission.beforeSend();submission.attempt();options.observeWireInput?.(true);options.onTiming?.({name:'request-submitted'});const response=await this.fetch(url,init);options.onStreamActivity?.();status=response.status;responseHeaders=response.ok?response.headers:null;await submission.confirm({status});options.onTiming?.({name:'response-headers'});const streaming=response.headers.get('content-type')?.includes('text/event-stream');if(diagnostic)diagnostic.format=streaming?'SSE':'JSON';if(!response.ok){const error=await readApiHttpError(response,{signal:options.signal,secrets:[profile.key]});httpError=error.httpError;throw error;}
      const chatTail=streaming&&profile.protocol==='chat-completions'?{deadline:0,timedOut:false}:null;
      const allowUsageDone=chatTail&&!probe&&!summaryRequest&&profile.kind==='custom';
      let usageOnlyTerminal=false;
      if(streaming){
        const readOptions={
          tail:chatTail,signal:options.signal,onActivity:options.onStreamActivity,limit:probe?PROBE_WIRE_LIMIT:16*1024*1024,
          onBytes:diagnostic?bytes=>{diagnostic.wireBytes=bytes;}:undefined,
          onLimit(){
            if(!probe)return Error('模型响应过大，请重试');
            diagnostic.budgetLayer='wire';
            diagnostic.limit=PROBE_WIRE_LIMIT;
            return Object.assign(Error('MODEL_IMAGE_PROBE_RESPONSE_TOO_LARGE'),{code:'MODEL_IMAGE_PROBE_RESPONSE_TOO_LARGE'});
          },
        };
        for await(const raw of readSseEvents(response,readOptions)){
          if(raw==='[DONE]'){
            if(chatTail){
              // Some compatible gateways omit finish_reason but send complete usage before DONE.
              finished||=usageOnlyTerminal;
              break;
            }
            if(!probe)finished=true;
            continue;
          }
          let value;
          try{value=JSON.parse(raw);}catch{throw Error('模型返回了无效数据，请检查协议');}
          const parsed=parsePayload(value,profile,state,probe,summaryRequest);
          finished||=probe?probeTerminal(value,profile,state,true):parsed.done;
          if(allowUsageDone)usageOnlyTerminal=Array.isArray(value.choices)&&value.choices.length===0&&
            numeric(value.usage?.prompt_tokens)!==null&&numeric(value.usage?.completion_tokens)!==null;
          if(chatTail&&finished){
            chatTail.deadline=performance.now()+CHAT_FINISH_IDLE_MS;
            if(isUsageObject(value.usage)&&(parsed.done||Array.isArray(value.choices)&&value.choices.length===0))finalUsage=true;
          }
          observeAnswer(parsed.text);
          if(parsed.text&&!state.filtered){
            if(!outputLength)options.onTiming?.({name:'first-delta'});
            outputLength+=parsed.text.length;
            if(outputLength>1024*1024)throw Error('模型回复过长，请重试');
            yield {type:'text-delta',text:parsed.text};
          }
        }
      }else{const raw=await responseText(response,options.onStreamActivity,probe,diagnostic);if(raw.length>2*1024*1024)throw Error('模型响应过大，请重试');let value;try{value=JSON.parse(raw);}catch{throw Error('模型返回了无效数据，请检查协议');}const parsed=parsePayload(value,profile,state,probe,summaryRequest);if(probe)finished=probeTerminal(value,profile,state,false);observeAnswer(parsed.text);if(parsed.text){outputLength=parsed.text.length;yield {type:'text-delta',text:parsed.text};}if(!probe)finished=parsed.done;}
      if(options.signal?.aborted)throw options.signal.reason;
      if(!finished)throw probe?Object.assign(Error('MODEL_IMAGE_PROBE_INCOMPLETE'),{code:'MODEL_IMAGE_PROBE_INCOMPLETE'}):Error('模型连接中断，请重试');options.onTiming?.({name:'model-complete'});
      usageComplete=(!chatTail||finalUsage||!chatTail.timedOut)&&(state.filtered||state.truncated||outputLength>0);
      if(state.filtered)throw Error('模型未返回聊天正文，请重试');
      if(state.truncated){yield {type:'finish',reason:{kind:'length'}};return;}
      if(!outputLength)throw Error('模型没有返回正文，请重试');
      let promptInput;
      if(options.onPromptUsage){
        const usage=normalizeUsage(state.usage,profile.protocol,{complete:usageComplete||finalUsage,headers:responseHeaders});
        const input=usage.input===null?null:usage.cacheIncluded===false
          ?usage.input+(usage.cacheRead??0)+(usage.cacheWriteIncluded===true?0:usage.cacheWrite??0)
          :usage.input;
        if(Number.isFinite(input)&&input>0)promptInput=input;
      }
      try{yield {type:'finish',reason:{kind:'stop'}};}
      finally{
        // Consumers can stop iteration immediately at finish.
        if(promptInput!==undefined)void Promise.resolve().then(()=>options.onPromptUsage(promptInput))
          .catch(error=>this.audit({type:'private-usage-calibration-failed',code:error?.code??error?.name??'UNKNOWN'}));
      }
    }catch(error){if(diagnostic)diagnostic.errorCode=options.signal?.aborted?(options.signal.reason?.code==='MODEL_IMAGE_PROBE_TIMEOUT'?'MODEL_IMAGE_PROBE_TIMEOUT':'ABORT_ERR'):PROBE_DIAGNOSTIC_CODES.has(error?.code)?error.code:diagnostic.errorCode??'MODEL_IMAGE_PROBE_FAILED';if(!submission.attempted)throw error;if(options.signal?.aborted)throw Error('请求已取消或超时',{cause:error});if(error.network||error?.message?.startsWith('MODEL_')||error?.message?.startsWith('API')||error?.message?.startsWith('模型')||error?.message?.startsWith('当前账户')||error?.message?.startsWith('服务地址')||error?.message?.startsWith('请求受限'))throw error;throw Error('无法连接模型服务，请检查地址或网络',{cause:error});}
    finally{if(submission.attempted)this.onUsage({requestId,profileId:profile.id,provider:profile.kind,protocol:profile.protocol,connectionIdentity:connectionIdentity(profile),model:profile.model,purpose:options.purpose??'galgame',activityOriginId:options.activityOriginId,scope:options.scope,timestamp:new Date().toISOString(),usage:normalizeUsage(state.usage,profile.protocol,{complete:usageComplete||finalUsage,headers:responseHeaders})});this.audit({type:'api-request',requestId,traceId:options.traceId,provider:profile.kind,connectionIdentity:connectionIdentity(profile),model:profile.model,status,...(httpError?{httpError}:{}),durationMs:Date.now()-started,submitted:submission.attempted,completed:finished,...diagnostic});}
  }
  async listModels(profile,signal){
    let response;try{response=await this.fetch(profile.baseUrl+'/models',{headers:headers(profile),signal,redirect:'error'});}catch(error){if(error.network||error.code==='NETWORK_REDIRECT')throw error;throw Error('无法获取模型列表，请检查地址或网络；也可手动填写');}
    if(!response.ok)throw await readApiHttpError(response,{signal,secrets:[profile.key]});let data;try{data=await response.json();}catch{throw Error('模型列表格式不兼容，请手动填写模型 ID');}
    const rows=profile.protocol==='gemini'?data.models:data.data;
    if(!Array.isArray(rows))throw Error('模型列表格式不兼容，请手动填写模型 ID');
    return cleanModelCatalog(rows.filter(row=>profile.protocol!=='gemini'||!row.supportedGenerationMethods||row.supportedGenerationMethods.includes('generateContent')).map(row=>{
      const id=String(row.id??row.name??'').replace(/^models\//,''),support=effortSupport({...profile,model:id},[{...row,id}]);
      return {...row,id,name:String(row.displayName??row.name??row.id??''),...(support.source==='catalog'||support.source==='documented'?{supportedReasoningEfforts:support.levels}:{})};
    }));
  }
}
