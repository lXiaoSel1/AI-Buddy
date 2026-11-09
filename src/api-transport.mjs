import {connectionIdentity} from './service-identity.mjs';
import {randomUUID} from 'node:crypto';
import {cleanModelCatalog,effortSupport,validateProfileEffort,effortProtocol} from './reasoning-settings.mjs';
import {streamNativeSearch} from './native-search-transport.mjs';
import {checkedImagePart,imageDataUrl} from './model-images.mjs';
import {createModelSubmission} from './model-submission.mjs';
import {apiHttpError,readApiHttpError} from './api-http-error.mjs';
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
    const combined=[];for(const message of messages){const previous=combined.at(-1);if(previous?.role===message.role){if(typeof previous.content==='string'&&typeof message.content==='string')previous.content+='\n\n'+message.content;else previous.content=[...partsOf(previous),{type:'text',text:'\n\n'},...partsOf(message)];}else combined.push({...message});}for(const message of combined)if(Array.isArray(message.content))message.content=wireContent(message,'anthropic');
    return {model:profile.model,system:options.system||undefined,messages:combined,max_tokens:budget,stream:true};
  }
  if(profile.protocol==='responses')return {model:profile.model,instructions:options.system||undefined,input:messages.map(m=>Array.isArray(m.content)?{...m,content:wireContent(m,'responses')}:m),...(budget?{max_output_tokens:budget}:{}),stream:true,store:false,...(effort?{reasoning:{effort}}:{})};
  return {model:profile.model,messages:[...(options.system?[{role:'system',content:options.system}]:[]),...messages.map(m=>Array.isArray(m.content)?{...m,content:wireContent(m,'chat-completions')}:m)],...(budget?{max_tokens:budget}:{}),stream:true,stream_options:{include_usage:true},...(profile.protocol==='chat-completions'&&effort?{reasoning_effort:effort}:{})};
}
function headers(profile){return {'Content-Type':'application/json',...(profile.protocol==='gemini'?{'x-goog-api-key':profile.key}:profile.protocol==='anthropic'?{'x-api-key':profile.key,'anthropic-version':'2023-06-01'}:profile.key?{Authorization:'Bearer '+profile.key}:{})};}
export const apiError=apiHttpError;
const numeric=value=>Number.isFinite(value)&&value>=0?value:null;
export function normalizeApiUsage(raw={},protocol){
  const input=numeric(raw.input_tokens??raw.prompt_tokens??raw.promptTokenCount??raw.total_input_tokens),output=numeric(raw.output_tokens??raw.completion_tokens??raw.candidatesTokenCount??raw.total_output_tokens),cached=numeric(raw.input_tokens_details?.cached_tokens??raw.prompt_tokens_details?.cached_tokens??raw.cache_read_input_tokens??raw.cachedContentTokenCount??raw.total_cached_tokens),reasoning=numeric(raw.output_tokens_details?.reasoning_tokens??raw.completion_tokens_details?.reasoning_tokens??raw.thoughtsTokenCount??raw.total_thought_tokens);
  const cacheWrite=numeric(raw.cache_creation_input_tokens);
  return {input,output,cacheRead:cached,cacheWrite,reasoning,total:numeric(raw.total_tokens??raw.totalTokenCount)??(input!==null&&output!==null?input+output+(protocol==='anthropic'?(cached??0)+(cacheWrite??0):0)+(protocol==='gemini'?(reasoning??0)+(numeric(raw.toolUsePromptTokenCount??raw.total_tool_use_tokens)??0):0):null)};
}
async function* events(response,onActivity,probe=false,diagnostic=null){
  const decoder=new TextDecoder();let buffer='',data=[],bytes=0;
  for await(const chunk of response.body){if(chunk.byteLength)onActivity?.();bytes+=chunk.byteLength;if(diagnostic)diagnostic.wireBytes=bytes;if(bytes>(probe?PROBE_WIRE_LIMIT:16*1024*1024)){if(diagnostic){diagnostic.budgetLayer='wire';diagnostic.limit=PROBE_WIRE_LIMIT;}throw probe?Object.assign(Error('MODEL_IMAGE_PROBE_RESPONSE_TOO_LARGE'),{code:'MODEL_IMAGE_PROBE_RESPONSE_TOO_LARGE'}):Error('模型响应过大，请重试');}buffer+=decoder.decode(chunk,{stream:true});
    let newline;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline).replace(/\r$/,'');buffer=buffer.slice(newline+1);if(!line){if(data.length){yield data.join('\n');data=[];}}else if(line.startsWith('data:'))data.push(line.slice(5).trimStart());}
  }
  buffer+=decoder.decode();if(buffer.startsWith('data:'))data.push(buffer.slice(5).trim());if(data.length)yield data.join('\n');
}
async function responseText(response,onActivity,probe=false,diagnostic=null){
  if(!probe&&(!onActivity||!response.body))return response.text();
  if(!response.body)throw Object.assign(Error('MODEL_IMAGE_PROBE_INCOMPLETE'),{code:'MODEL_IMAGE_PROBE_INCOMPLETE'});
  const decoder=new TextDecoder();let text='',bytes=0;
  for await(const chunk of response.body){if(chunk.byteLength)onActivity?.();bytes+=chunk.byteLength;if(diagnostic)diagnostic.wireBytes=bytes;if(bytes>(probe?PROBE_WIRE_LIMIT:2*1024*1024)){if(diagnostic){diagnostic.budgetLayer='wire';diagnostic.limit=PROBE_WIRE_LIMIT;}throw probe?Object.assign(Error('MODEL_IMAGE_PROBE_RESPONSE_TOO_LARGE'),{code:'MODEL_IMAGE_PROBE_RESPONSE_TOO_LARGE'}):Error('模型响应过大，请重试');}text+=decoder.decode(chunk,{stream:true});}
  return text+decoder.decode();
}
function parsePayload(value,profile,state,probe=false){
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
    if(choice?.finish_reason==='content_filter'||choice?.finish_reason==='tool_calls')throw Error('模型未返回聊天正文，请重试');if(value.usage)state.usage=value.usage;
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
export class ApiTransport{
  constructor({fetchImpl=globalThis.fetch,onUsage=()=>{},audit=()=>{}}={}){this.fetch=fetchImpl;this.onUsage=onUsage;this.audit=audit;}
  async *stream(profile,options){
    const submission=createModelSubmission(options,'api',{requestId:randomUUID()});
    try{await submission.prepare();yield* this.streamRequest(profile,options,submission);await submission.complete();}catch(error){throw await submission.failure(error);}
  }
  async *streamRequest(profile,options,submission){
    if(effortProtocol(profile.protocol))validateProfileEffort(profile);
    if(options.nativeSearch?.allowed===true){yield* streamNativeSearch(profile,options,{fetch:this.fetch,onUsage:this.onUsage,audit:this.audit,requestBody,headers,normalizeUsage:normalizeApiUsage,apiError,parsePayload,submission});return;}
    const probe=options.purpose==='image-capability-probe',requestId=submission.details.requestId,started=Date.now(),state={usage:null};let finished=false,outputLength=0,status=null,httpError=null;
    // Probe-only counters contain no response content. completed still means a
    // protocol terminal was seen, not that the caller accepted capability proof.
    const diagnostic=probe?{format:null,wireBytes:0,answerBytes:0,budgetLayer:null,limit:PROBE_WIRE_LIMIT,errorCode:null}:null;
    const observeAnswer=text=>{if(!diagnostic)return;diagnostic.answerBytes+=Buffer.byteLength(text,'utf8');if(diagnostic.answerBytes>4096){diagnostic.errorCode='MODEL_IMAGE_PROBE_RESPONSE_TOO_LARGE';diagnostic.budgetLayer='answer';diagnostic.limit=4096;}else if(state.truncated)diagnostic.errorCode='MODEL_OUTPUT_TRUNCATED';};
    const route=profile.protocol==='gemini'?'/models/'+encodeURIComponent(profile.model.replace(/^models\//,''))+':streamGenerateContent?alt=sse':profile.protocol==='anthropic'?'/messages':profile.protocol==='responses'?'/responses':'/chat/completions';
    try{
      const url=profile.baseUrl+route,init={method:'POST',headers:headers(profile),body:JSON.stringify(requestBody(profile,options)),signal:options.signal,redirect:'error'};
      await submission.beforeSend();submission.attempt();options.onTiming?.({name:'request-submitted'});const response=await this.fetch(url,init);options.onStreamActivity?.();status=response.status;await submission.confirm({status});options.onTiming?.({name:'response-headers'});const streaming=response.headers.get('content-type')?.includes('text/event-stream');if(diagnostic)diagnostic.format=streaming?'SSE':'JSON';if(!response.ok){const error=await readApiHttpError(response,{signal:options.signal,secrets:[profile.key]});httpError=error.httpError;throw error;}
      if(streaming){
        for await(const raw of events(response,options.onStreamActivity,probe,diagnostic)){if(raw==='[DONE]'){if(!probe)finished=true;continue;}let value;try{value=JSON.parse(raw);}catch{throw Error('模型返回了无效数据，请检查协议');}const parsed=parsePayload(value,profile,state,probe);finished||=probe?probeTerminal(value,profile,state,true):parsed.done;observeAnswer(parsed.text);if(parsed.text){if(!outputLength)options.onTiming?.({name:'first-delta'});outputLength+=parsed.text.length;if(outputLength>1024*1024)throw Error('模型回复过长，请重试');yield {type:'text-delta',text:parsed.text};}}
      }else{const raw=await responseText(response,options.onStreamActivity,probe,diagnostic);if(raw.length>2*1024*1024)throw Error('模型响应过大，请重试');let value;try{value=JSON.parse(raw);}catch{throw Error('模型返回了无效数据，请检查协议');}const parsed=parsePayload(value,profile,state,probe);if(probe)finished=probeTerminal(value,profile,state,false);observeAnswer(parsed.text);if(parsed.text){outputLength=parsed.text.length;yield {type:'text-delta',text:parsed.text};}if(!probe)finished=parsed.done;}
      if(!finished)throw probe?Object.assign(Error('MODEL_IMAGE_PROBE_INCOMPLETE'),{code:'MODEL_IMAGE_PROBE_INCOMPLETE'}):Error('模型连接中断，请重试');options.onTiming?.({name:'model-complete'});
      if(state.truncated){yield {type:'finish',reason:{kind:'length'}};return;}
      if(!outputLength)throw Error('模型没有返回正文，请重试');yield {type:'finish',reason:{kind:'stop'}};
    }catch(error){if(diagnostic)diagnostic.errorCode=options.signal?.aborted?(options.signal.reason?.code==='MODEL_IMAGE_PROBE_TIMEOUT'?'MODEL_IMAGE_PROBE_TIMEOUT':'ABORT_ERR'):PROBE_DIAGNOSTIC_CODES.has(error?.code)?error.code:diagnostic.errorCode??'MODEL_IMAGE_PROBE_FAILED';if(!submission.attempted)throw error;if(options.signal?.aborted)throw Error('请求已取消或超时',{cause:error});if(error?.message?.startsWith('MODEL_')||error?.message?.startsWith('API')||error?.message?.startsWith('模型')||error?.message?.startsWith('当前账户')||error?.message?.startsWith('服务地址')||error?.message?.startsWith('请求受限'))throw error;throw Error('无法连接模型服务，请检查地址或网络',{cause:error});}
    finally{if(submission.attempted)this.onUsage({requestId,profileId:profile.id,provider:profile.kind,connectionIdentity:connectionIdentity(profile),model:profile.model,purpose:options.purpose??'galgame',activityOriginId:options.activityOriginId,scope:options.scope,timestamp:new Date().toISOString(),usage:normalizeApiUsage(state.usage||{},profile.protocol)});this.audit({type:'api-request',requestId,traceId:options.traceId,provider:profile.kind,connectionIdentity:connectionIdentity(profile),model:profile.model,status,...(httpError?{httpError}:{}),durationMs:Date.now()-started,submitted:submission.attempted,completed:finished,...diagnostic});}
  }
  async listModels(profile,signal){
    let response;try{response=await this.fetch(profile.baseUrl+'/models',{headers:headers(profile),signal,redirect:'error'});}catch{throw Error('无法获取模型列表，请检查地址或网络；也可手动填写');}
    if(!response.ok)throw await readApiHttpError(response,{signal,secrets:[profile.key]});let data;try{data=await response.json();}catch{throw Error('模型列表格式不兼容，请手动填写模型 ID');}
    const rows=profile.protocol==='gemini'?data.models:data.data;
    if(!Array.isArray(rows))throw Error('模型列表格式不兼容，请手动填写模型 ID');
    return cleanModelCatalog(rows.filter(row=>profile.protocol!=='gemini'||!row.supportedGenerationMethods||row.supportedGenerationMethods.includes('generateContent')).map(row=>{
      const id=String(row.id??row.name??'').replace(/^models\//,''),support=effortSupport({...profile,model:id},[{...row,id}]);
      return {...row,id,name:String(row.displayName??row.name??row.id??''),...(support.source==='catalog'||support.source==='documented'?{supportedReasoningEfforts:support.levels}:{})};
    }));
  }
}
