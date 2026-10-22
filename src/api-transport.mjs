import {connectionIdentity} from './service-identity.mjs';
import {randomUUID} from 'node:crypto';
import {cleanModelCatalog,effortSupport,validateProfileEffort,effortProtocol} from './reasoning-settings.mjs';
const textOf=value=>typeof value==='string'?value:Array.isArray(value)?value.filter(part=>part.type==='text'||part.type==='input_text'||part.type==='output_text').map(part=>part.text??'').join('\n'):'';
const messagesOf=options=>(options.messages??[]).map(message=>({role:message.role==='assistant'?'assistant':'user',content:textOf(message.content)}));
const REASONING_EFFORTS=new Set(['none','minimal','low','medium','high','xhigh','max','ultra']);
function requestBody(profile,options){
  // 'auto' leaves the output limit to the provider (Anthropic requires one, so 8192 there).
  const messages=messagesOf(options),budget=options.purpose==='emotion'?2048:options.maxTokens==='auto'?(profile.protocol==='anthropic'?8192:null):Math.max(1,Math.min(65536,Number(options.maxTokens)||2048));
  const effort=REASONING_EFFORTS.has(profile.reasoningEffort)?profile.reasoningEffort:undefined;
  if(profile.protocol==='gemini')return {systemInstruction:options.system?{parts:[{text:options.system}]}:undefined,contents:messages.map(message=>({role:message.role==='assistant'?'model':'user',parts:[{text:message.content}]})),generationConfig:budget?{maxOutputTokens:budget}:{}};
  if(profile.protocol==='anthropic'){
    const combined=[];for(const message of messages){if(combined.at(-1)?.role===message.role)combined.at(-1).content+='\n\n'+message.content;else combined.push({...message});}
    return {model:profile.model,system:options.system||undefined,messages:combined,max_tokens:budget,stream:true};
  }
  if(profile.protocol==='responses')return {model:profile.model,instructions:options.system||undefined,input:messages,...(budget?{max_output_tokens:budget}:{}),stream:true,store:false,...(effort?{reasoning:{effort}}:{})};
  return {model:profile.model,messages:[...(options.system?[{role:'system',content:options.system}]:[]),...messages],...(budget?{max_tokens:budget}:{}),stream:true,stream_options:{include_usage:true},...(profile.protocol==='chat-completions'&&effort?{reasoning_effort:effort}:{})};
}
function headers(profile){return {'Content-Type':'application/json',...(profile.protocol==='gemini'?{'x-goog-api-key':profile.key}:profile.protocol==='anthropic'?{'x-api-key':profile.key,'anthropic-version':'2023-06-01'}:profile.key?{Authorization:'Bearer '+profile.key}:{})};}
export function apiError(status){return Error(status===401?'API Key 无效，请重新配置':status===403?'当前账户没有该模型的访问权限':status===404?'服务地址或模型 ID 不存在':status===429?'请求受限或额度不足，请稍后重试':status>=500?'模型服务暂时不可用，请稍后重试':'API 请求失败，请检查模型和协议配置');}
const numeric=value=>Number.isFinite(value)&&value>=0?value:null;
export function normalizeApiUsage(raw={},protocol){
  const input=numeric(raw.input_tokens??raw.prompt_tokens??raw.promptTokenCount??raw.total_input_tokens),output=numeric(raw.output_tokens??raw.completion_tokens??raw.candidatesTokenCount??raw.total_output_tokens),cached=numeric(raw.input_tokens_details?.cached_tokens??raw.prompt_tokens_details?.cached_tokens??raw.cache_read_input_tokens??raw.cachedContentTokenCount??raw.total_cached_tokens),reasoning=numeric(raw.output_tokens_details?.reasoning_tokens??raw.completion_tokens_details?.reasoning_tokens??raw.thoughtsTokenCount??raw.total_thought_tokens);
  const cacheWrite=numeric(raw.cache_creation_input_tokens);
  return {input,output,cacheRead:cached,cacheWrite,reasoning,total:numeric(raw.total_tokens??raw.totalTokenCount)??(input!==null&&output!==null?input+output+(protocol==='anthropic'?(cached??0)+(cacheWrite??0):0)+(protocol==='gemini'?(reasoning??0)+(numeric(raw.toolUsePromptTokenCount??raw.total_tool_use_tokens)??0):0):null)};
}
async function* events(response){
  const decoder=new TextDecoder();let buffer='',data=[],bytes=0;
  for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>16*1024*1024)throw Error('模型响应过大，请重试');buffer+=decoder.decode(chunk,{stream:true});
    let newline;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline).replace(/\r$/,'');buffer=buffer.slice(newline+1);if(!line){if(data.length){yield data.join('\n');data=[];}}else if(line.startsWith('data:'))data.push(line.slice(5).trimStart());}
  }
  buffer+=decoder.decode();if(buffer.startsWith('data:'))data.push(buffer.slice(5).trim());if(data.length)yield data.join('\n');
}
function parsePayload(value,profile,state){
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
    if(!value.type&&value.content){text=value.content.filter(part=>part.type==='text').map(part=>part.text??'').join('');if(value.stop_reason==='max_tokens')state.truncated=true;done=true;}
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
export class ApiTransport{
  constructor({fetchImpl=globalThis.fetch,onUsage=()=>{},audit=()=>{}}={}){this.fetch=fetchImpl;this.onUsage=onUsage;this.audit=audit;}
  async *stream(profile,options){
    if(effortProtocol(profile.protocol))validateProfileEffort(profile);
    const requestId=randomUUID(),started=Date.now(),state={usage:null};let finished=false,outputLength=0,status=null;
    const route=profile.protocol==='gemini'?'/models/'+encodeURIComponent(profile.model.replace(/^models\//,''))+':streamGenerateContent?alt=sse':profile.protocol==='anthropic'?'/messages':profile.protocol==='responses'?'/responses':'/chat/completions';
    try{
      const response=await this.fetch(profile.baseUrl+route,{method:'POST',headers:headers(profile),body:JSON.stringify(requestBody(profile,options)),signal:options.signal,redirect:'error'});status=response.status;if(!response.ok){await response.body?.cancel().catch(()=>{});throw apiError(status);}
      if(response.headers.get('content-type')?.includes('text/event-stream')){
        for await(const raw of events(response)){if(raw==='[DONE]'){finished=true;continue;}let value;try{value=JSON.parse(raw);}catch{throw Error('模型返回了无效数据，请检查协议');}const parsed=parsePayload(value,profile,state);finished||=parsed.done;if(parsed.text){outputLength+=parsed.text.length;if(outputLength>1024*1024)throw Error('模型回复过长，请重试');yield {type:'text-delta',text:parsed.text};}}
      }else{const raw=await response.text();if(raw.length>2*1024*1024)throw Error('模型响应过大，请重试');let value;try{value=JSON.parse(raw);}catch{throw Error('模型返回了无效数据，请检查协议');}const parsed=parsePayload(value,profile,state);if(parsed.text){outputLength=parsed.text.length;yield {type:'text-delta',text:parsed.text};}finished=parsed.done;}
      if(!finished)throw Error('模型连接中断，请重试');
      if(state.truncated){yield {type:'finish',reason:{kind:'length'}};return;}
      if(!outputLength)throw Error('模型没有返回正文，请重试');yield {type:'finish',reason:{kind:'stop'}};
    }catch(error){if(options.signal?.aborted)throw Error('请求已取消或超时');if(error?.message?.startsWith('API')||error?.message?.startsWith('模型')||error?.message?.startsWith('当前账户')||error?.message?.startsWith('服务地址')||error?.message?.startsWith('请求受限'))throw error;throw Error('无法连接模型服务，请检查地址或网络');}
    finally{this.onUsage({requestId,profileId:profile.id,provider:profile.kind,connectionIdentity:connectionIdentity(profile),model:profile.model,purpose:options.purpose??'galgame',timestamp:new Date().toISOString(),usage:normalizeApiUsage(state.usage||{},profile.protocol)});this.audit({type:'api-request',requestId,provider:profile.kind,connectionIdentity:connectionIdentity(profile),model:profile.model,status,durationMs:Date.now()-started,completed:finished});}
  }
  async listModels(profile,signal){
    let response;try{response=await this.fetch(profile.baseUrl+'/models',{headers:headers(profile),signal,redirect:'error'});}catch{throw Error('无法获取模型列表，请检查地址或网络；也可手动填写');}
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw apiError(response.status);}let data;try{data=await response.json();}catch{throw Error('模型列表格式不兼容，请手动填写模型 ID');}
    const rows=profile.protocol==='gemini'?data.models:data.data;
    if(!Array.isArray(rows))throw Error('模型列表格式不兼容，请手动填写模型 ID');
    return cleanModelCatalog(rows.filter(row=>profile.protocol!=='gemini'||!row.supportedGenerationMethods||row.supportedGenerationMethods.includes('generateContent')).map(row=>{
      const id=String(row.id??row.name??'').replace(/^models\//,''),support=effortSupport({...profile,model:id},[{...row,id}]);
      return {...row,id,name:String(row.displayName??row.name??row.id??''),...(support.source==='catalog'||support.source==='documented'?{supportedReasoningEfforts:support.levels}:{})};
    }));
  }
}
