import {randomUUID} from 'node:crypto';
import {connectionIdentity} from './service-identity.mjs';
import {readApiHttpError} from './api-http-error.mjs';
import {nativeSearchCapability,nativeSearchTools,normalizeSearchSource,safeSearchUrl,checkNativeSearch,citationEvidence,nativeSearchFailure as fail} from './native-search.mjs';

const copy=value=>structuredClone(value);
const cloneMessages=options=>(options.messages??[]).map(message=>({role:message.role==='assistant'?'assistant':'user',content:typeof message.content==='string'?message.content:(message.content??[]).map(p=>p.text??'').join('\n')}));
async function readBounded(response,signal,limit){
 const reader=response.body?.getReader();if(!reader)return '';
 const decoder=new TextDecoder(),abort=()=>{void reader.cancel(signal?.reason).catch(()=>{});};let result='',bytes=0;
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 try{for(;;){const {done,value}=await reader.read();if(signal?.aborted)throw fail('联网搜索已取消','ABORT_ERR');if(done)break;bytes+=value.byteLength;if(bytes>limit)throw fail('联网响应过大','NATIVE_SEARCH_RESPONSE_LIMIT');result+=decoder.decode(value,{stream:true});}return result+decoder.decode();}
 finally{signal?.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function* jsonPayloads(response,signal){
 if(!response.headers.get('content-type')?.includes('text/event-stream')){const raw=await readBounded(response,signal,16*1024*1024);let value;try{value=JSON.parse(raw);}catch{throw fail('模型返回了无效数据','NATIVE_SEARCH_PROTOCOL');}yield value;return;}
 const reader=response.body.getReader(),decoder=new TextDecoder(),abort=()=>{void reader.cancel(signal?.reason).catch(()=>{});};let buffer='',lines=[],bytes=0;
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>16*1024*1024)throw fail('模型响应过大','NATIVE_SEARCH_RESPONSE_LIMIT');buffer+=decoder.decode(value,{stream:true});let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at).replace(/\r$/,'');buffer=buffer.slice(at+1);if(!line){if(lines.length){const data=lines.join('\n');lines=[];if(data!=='[DONE]'){let item;try{item=JSON.parse(data);}catch{throw fail('模型返回了无效数据','NATIVE_SEARCH_PROTOCOL');}yield item;}else yield {type:'native-stream-done'};}}else if(line.startsWith('data:'))lines.push(line.slice(5).trimStart());}}buffer+=decoder.decode();if(buffer.startsWith('data:'))lines.push(buffer.slice(5).trim());if(lines.length){const data=lines.join('\n');if(data!=='[DONE]')yield JSON.parse(data);else yield {type:'native-stream-done'};}}
 finally{signal?.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
function route(profile){return profile.protocol==='gemini'?'/models/'+encodeURIComponent(profile.model.replace(/^models\//,''))+':streamGenerateContent?alt=sse':profile.protocol==='anthropic'?'/messages':profile.protocol==='responses'?'/responses':'/chat/completions';}
function publicTool(item,state){
 const type=item.type,name=item.name??item.function?.name??(type==='web_search_call'?'web_search':null),id=item.id??item.call_id??item.tool_use_id;
 if(!name||!['web_search','web_fetch','native_web_search','native_web_search_pro','native_web_fetch'].includes(name))return;
 const status=item.status??(type==='server_tool_use'?'started':'completed'),key=String(id??name)+':'+status;if(state.toolEvents.has(key))return;state.toolEvents.add(key);state.pending.push({type:'native-search-tool',provider:state.profile.kind,model:state.profile.model,id:id??null,name,status,query:typeof item.action?.query==='string'?item.action.query:typeof item.input?.query==='string'?item.input.query:undefined});
}
// A URL is reported once; when the answer later cites a URL already reported as a search result, the same row
// is reported again with cited:true so the chip can list cited sources first (orderSearchSources merges by URL).
function source(item,state,extra={}){const normalized=normalizeSearchSource(item,{provider:state.profile.kind,model:state.profile.model,retrievedAt:new Date().toISOString(),...extra});if(!normalized)return;const cited=citationEvidence(extra.evidenceType),known=state.sources.get(normalized.url);if(known){if(cited&&known.cited!==true){known.cited=true;state.pending.push({type:'native-search-sources',sources:[{...known}]});}return;}if(cited)normalized.cited=true;state.sources.set(normalized.url,normalized);state.pending.push({type:'native-search-sources',sources:[normalized]});}
function evidence(value,state){
 if(value.item?.type==='function_call'||(value.output??value.response?.output??[]).some(item=>['function_call','custom_tool_call','mcp_call','computer_call','code_interpreter_call'].includes(item.type)))throw fail('模型返回了未授权的本地或执行工具','NATIVE_SEARCH_TOOL_DENIED');
 const annotation=value.annotation;if(annotation?.type==='url_citation'||annotation?.type==='web_search_result_location')source(annotation,state,{evidenceType:annotation.type});
 const item=value.item;if(item?.type==='web_search_call'){
  publicTool(item,state);for(const row of [...(item.action?.sources??[]),...(item.results??[])])source(row,state,{evidenceType:'web_search_call'});
 }
 const outputs=value.response?.output??value.output??[];for(const output of outputs){if(output.type==='web_search_call'){publicTool(output,state);for(const row of [...(output.action?.sources??[]),...(output.results??[])])source(row,state,{evidenceType:'web_search_call'});}for(const block of output.content??[])for(const cite of block.annotations??[])if(cite.type==='url_citation')source(cite,state,{evidenceType:'url_citation'});}
 const block=value.content_block;
 if(block?.type==='server_tool_use')publicTool(block,state);
 for(const candidate of value.candidates??[]){const metadata=candidate.groundingMetadata;for(const chunk of metadata?.groundingChunks??[])if(chunk.web)source(chunk.web,state,{evidenceType:'groundingMetadata'});if(metadata?.webSearchQueries?.length)publicTool({type:'web_search_call',id:'gemini-search',action:{query:metadata.webSearchQueries.join('; ')}},state);for(const metadata of candidate.urlContextMetadata?.urlMetadata??[])if(metadata.urlRetrievalStatus==='URL_RETRIEVAL_STATUS_SUCCESS')source({url:metadata.retrievedUrl},state,{evidenceType:'urlContextMetadata'});}
 const search=value.search_info??value.choices?.[0]?.message?.search_info??value.choices?.[0]?.delta?.search_info;for(const item of search?.search_results??[])source({url:item.url??item.link,title:item.title},state,{evidenceType:'search_info'});if(search?.search_results?.length)publicTool({type:'web_search_call',id:'qwen-search'},state);
 if(state.profile.kind==='qwen'&&Number((value.usage??value.response?.usage)?.x_tools?.web_search?.count)>0)publicTool({type:'web_search_call',id:'qwen-search'},state);
}
function anthropicBlockEvidence(block,state){
 if(['tool_use','server_tool_use'].includes(block.type)&&!['web_search','web_fetch'].includes(block.name))throw fail('模型返回了未授权工具','NATIVE_SEARCH_TOOL_DENIED');
 if(block.type==='server_tool_use')publicTool({...block,status:'completed'},state);
 if(block.type==='web_search_tool_result'){
  if(!Array.isArray(block.content)&&block.content?.type==='web_search_tool_result_error')state.pending.push({type:'native-search-status',status:'failed',reason:String(block.content.error_code??'search_failed'),provider:state.profile.kind});
  for(const row of Array.isArray(block.content)?block.content:[])if(row.type==='web_search_result')source(row,state,{evidenceType:'web_search_tool_result'});
 }
 if(block.type==='web_fetch_tool_result'){const content=block.content;if(content?.type==='web_fetch_result')source({url:content.url,title:content.content?.title},state,{evidenceType:'web_fetch_tool_result'});else if(content?.type?.endsWith('_error'))state.pending.push({type:'native-search-status',status:'failed',reason:String(content.error_code??'fetch_failed')});}
 for(const cite of block.citations??[])if(['web_search_result_location','web_fetch_result_location'].includes(cite.type))source(cite,state,{evidenceType:cite.type});
}
function anthropicAccumulate(value,state){
 if(value.type==='message_start'){state.responseId=value.message?.id??state.responseId;state.blocks=copy(value.message?.content??[]);}
 if(value.type==='content_block_start'){state.blocks[value.index]=copy(value.content_block);anthropicBlockEvidence(value.content_block,state);}
 if(value.type==='content_block_delta'){
  const block=state.blocks[value.index],delta=value.delta;if(!block||!delta)return;
  if(delta.type==='text_delta')block.text=(block.text??'')+(delta.text??'');
  else if(delta.type==='input_json_delta')block._input=(block._input??'')+(delta.partial_json??'');
  else if(delta.type==='thinking_delta')block.thinking=(block.thinking??'')+(delta.thinking??'');
  else if(delta.type==='signature_delta')block.signature=(block.signature??'')+(delta.signature??'');
  else if(delta.type==='citations_delta'&&delta.citation){(block.citations??=[]).push(copy(delta.citation));anthropicBlockEvidence(block,state);}
 }
 if(value.type==='content_block_stop'){const block=state.blocks[value.index];if(block?._input){try{block.input=JSON.parse(block._input);}catch{throw fail('服务端工具参数不完整','NATIVE_SEARCH_PROTOCOL');}delete block._input;}if(block)anthropicBlockEvidence(block,state);}
 if(value.type==='message_delta')state.stopReason=value.delta?.stop_reason??state.stopReason;
 if(!value.type&&Array.isArray(value.content)){state.blocks=copy(value.content);state.stopReason=value.stop_reason;for(const block of state.blocks)anthropicBlockEvidence(block,state);}
}
function chatCalls(value,state){const choice=value.choices?.[0],delta=choice?.delta??choice?.message;if(delta?.reasoning_content)state.reasoning+=(delta.reasoning_content??'');for(const raw of delta?.tool_calls??[]){const index=raw.index??state.calls.size,call=state.calls.get(index)??{id:'',type:'function',function:{name:'',arguments:''}};if(raw.id)call.id+=raw.id;if(raw.type)call.type=raw.type;if(raw.function?.name)call.function.name+=raw.function.name;if(raw.function?.arguments)call.function.arguments+=raw.function.arguments;if(call.function.arguments.length>65536)throw fail('联网工具参数过大','NATIVE_SEARCH_ARGUMENT_LIMIT');state.calls.set(index,call);}if(choice?.finish_reason)state.stopReason=choice.finish_reason;}
function currentModel(value,profile){const actual=value.model??value.message?.model??value.response?.model;if(typeof actual!=='string')return;const family=profile.model.replace(/-latest$/,'');if(actual===profile.model||actual.replace(/-\d{4}-?\d{2}-?\d{2}$/,'')===family)return;throw fail('模型服务返回了不同模型，已停止联网流程','NATIVE_SEARCH_MODEL_MISMATCH');}
function collectRestSources(data,state){for(const row of data.search_results??data.results??data.data?.results??data.items??[])source(row,state,{evidenceType:'official-search-api'});}
async function restTool(profile,capability,call,options,environment,state){
 await checkNativeSearch(options);const name=call.function?.name,known=['native_web_search','native_web_search_pro','native_web_fetch'];if(call.type!=='function'||!known.includes(name)||name==='native_web_search_pro'&&capability.restProvider!=='kimi')throw fail('模型请求了未授权的联网工具','NATIVE_SEARCH_TOOL_DENIED');
 if(!call.id)throw fail('联网工具缺少调用标识','NATIVE_SEARCH_PROTOCOL');let args;try{args=JSON.parse(call.function.arguments);}catch{throw fail('联网工具参数格式无效','NATIVE_SEARCH_ARGUMENTS');}if(!args||typeof args!=='object'||Array.isArray(args))throw fail('联网工具参数格式无效','NATIVE_SEARCH_ARGUMENTS');
 const fetchPage=name==='native_web_fetch';let body;if(fetchPage){const url=safeSearchUrl(args.url);if(!url||Object.keys(args).some(k=>k!=='url'))throw fail('联网抓取地址无效或超出公开网页范围','NATIVE_SEARCH_ARGUMENTS');body={url};}else{if(typeof args.query!=='string'||!args.query.trim()||[...args.query].length>128||Object.keys(args).some(k=>k!=='query'))throw fail('搜索词须为1到128个字符','NATIVE_SEARCH_ARGUMENTS');body={query:args.query};}
 const repeated=JSON.stringify([name,body]);if(state.completedCalls.has(call.id)||state.lastTool===repeated)throw fail('联网工具重复提交且没有新进展，已暂停','NATIVE_SEARCH_NO_PROGRESS');state.lastTool=repeated;
 const toolId=randomUUID(),started=Date.now(),root=new URL(profile.baseUrl).origin,path=fetchPage?'/v1/tools/fetch':name==='native_web_search_pro'?'/v1/tools/search_pro':'/v1/tools/search',wireBody=!fetchPage&&capability.restProvider==='kimi'?{text_query:body.query}:body;let response,data,submitted=false,httpError=null;
 publicTool({id:call.id,name,status:'started',input:body},state);
 try{const init={method:'POST',headers:environment.headers(profile),body:JSON.stringify(wireBody),signal:options.signal,redirect:'error'};await checkNativeSearch(options);await environment.submission?.beforeSend({providerRequestId:toolId,requestKind:'native-search-tool'});environment.submission?.attempt();submitted=true;response=await environment.fetch(root+path,init);await environment.submission?.confirm({status:response.status});if(!response.ok){const error=await readApiHttpError(response,{signal:options.signal,secrets:[profile.key]});httpError=error.httpError;throw error;}const text=await readBounded(response,options.signal,8*1024*1024);try{data=JSON.parse(text);}catch{throw fail('搜索服务返回了无效数据','NATIVE_SEARCH_PROTOCOL');}await checkNativeSearch(options);if(fetchPage){if(typeof data.content!=='string'&&typeof data.markdown!=='string'&&typeof data.data?.content!=='string')throw fail('抓取服务未返回有效正文','NATIVE_SEARCH_FETCH_EMPTY');source({url:body.url,title:data.title??data.data?.title},state,{evidenceType:'official-fetch-api'});}else collectRestSources(data,state);state.completedCalls.add(call.id);publicTool({id:call.id,name,status:'completed'},state);return data;}
 finally{if(submitted)environment.onUsage({requestId:toolId,profileId:profile.id,provider:profile.kind,connectionIdentity:connectionIdentity(profile),model:profile.model,purpose:options.purpose??'galgame',activityOriginId:options.activityOriginId,timestamp:new Date().toISOString(),usage:environment.normalizeUsage({},profile.protocol),serviceUsage:{kind:fetchPage?'fetch':name==='native_web_search_pro'?'search-pro':'search',requests:response?.ok&&data?1:null,state:data?'completed':options.signal?.aborted?'cancelled':'unknown'},usageEvidence:'official-search-api-no-token-counter'});environment.audit({type:'native-search-api',requestId:toolId,traceId:options.traceId,provider:profile.kind,status:response?.status??null,...(httpError?{httpError}:{}),durationMs:Date.now()-started});}
}
export async function* streamNativeSearch(profile,options,environment){
 const capability=nativeSearchCapability(profile);if(!capability.supported||capability.mode==='codex')throw fail(capability.reason);
 await checkNativeSearch(options);yield {type:'native-search-status',status:'available',capability};
 const state={profile,toolEvents:new Set(),sources:new Map(),pending:[],completedCalls:new Set(),lastTool:null};
 const baseBody=environment.requestBody(profile,options),messages=profile.protocol==='chat-completions'?[...(options.system?[{role:'system',content:options.system}]:[]),...cloneMessages(options)]:copy(baseBody.messages??[]);
 if(capability.mode==='qwen'){baseBody.enable_search=true;baseBody.include_tool_usage=true;baseBody.search_options={enable_source:true};}else baseBody.tools=nativeSearchTools(capability);
 let requestRound=0,totalText=0,progressSignature=null;
 for(;;){
  await checkNativeSearch(options);const body={...baseBody,...(['client-rest','anthropic'].includes(capability.mode)?{messages:copy(messages)}:{})},requestId=randomUUID(),started=Date.now();let response,submitted=false,finished=false,output='',httpError=null;
  Object.assign(state,{usage:null,truncated:false,stopReason:null,calls:new Map(),reasoning:'',blocks:[],responseId:null,reportedModel:null});
  try{
   const url=profile.baseUrl+route(profile),init={method:'POST',headers:environment.headers(profile),body:JSON.stringify(body),signal:options.signal,redirect:'error'};
   await checkNativeSearch(options);await environment.submission?.beforeSend({providerRequestId:requestId,requestKind:'native-search-model',round:requestRound});environment.submission?.attempt();options.onTiming?.({name:'request-submitted'});submitted=true;
   response=await environment.fetch(url,init);await environment.submission?.confirm({status:response.status});options.onTiming?.({name:'response-headers'});if(!response.ok){const error=await readApiHttpError(response,{signal:options.signal,secrets:[profile.key]});httpError=error.httpError;throw error;}
   for await(const value of jsonPayloads(response,options.signal)){
    const reportedUsage=value.response?.usage??value.usage??value.message?.usage??value.usageMetadata;if(reportedUsage)state.usage={...state.usage,...reportedUsage};
    if(options.signal?.aborted)throw fail('联网搜索已取消','ABORT_ERR');state.reportedModel=value.model??value.message?.model??value.response?.model??state.reportedModel;currentModel(value,profile);evidence(value,state);
    if(capability.mode==='anthropic')anthropicAccumulate(value,state);
    if(capability.mode==='client-rest')chatCalls(value,state);
    let parsed;if(value.type==='native-stream-done'){finished=true;parsed={};}
    else if(capability.mode==='client-rest'&&value.choices?.[0]?.finish_reason==='tool_calls')parsed=environment.parsePayload({...value,choices:value.choices.map(c=>({...c,finish_reason:null}))},profile,state);
    else parsed=environment.parsePayload(value,profile,state);
    finished||=!!parsed.done;
    if(parsed.text){if(!totalText)options.onTiming?.({name:'first-delta'});totalText+=parsed.text.length;output+=parsed.text;if(totalText>1024*1024)throw fail('模型回复过长','NATIVE_SEARCH_RESPONSE_LIMIT');yield {type:'text-delta',text:parsed.text};}
    while(state.pending.length)yield state.pending.shift();
   }
   if(!finished&&!(capability.mode==='client-rest'&&state.stopReason==='tool_calls'))throw fail('联网模型连接中断，未自动重复提交','NATIVE_SEARCH_INTERRUPTED');
  }catch(error){if(environment.submission&&!environment.submission.attempted)throw error;if(options.signal?.aborted)throw fail('联网搜索已取消','ABORT_ERR');if(error?.code||/^(?:API|模型|当前账户|服务地址|请求受限)/.test(error?.message??''))throw error;throw Object.assign(fail('无法连接联网模型服务，请检查地址或网络','NATIVE_SEARCH_NETWORK'),{cause:error});}
  finally{if(submitted)environment.onUsage({requestId,providerRequestId:response?.ok?response.headers.get('x-request-id')??state.responseId??null:httpError?.requestId??null,profileId:profile.id,provider:profile.kind,connectionIdentity:connectionIdentity(profile),model:profile.model,purpose:options.purpose??'galgame',activityOriginId:options.activityOriginId,timestamp:new Date().toISOString(),usage:environment.normalizeUsage(state.usage??{},profile.protocol),actualModel:state.reportedModel,nativeSearchUsage:copy(state.usage?.server_tool_use??state.usage?.server_side_tool_usage_details??state.usage?.x_tools??state.usage?.plugins??null),completionState:finished?'completed':options.signal?.aborted?'cancelled':'interrupted'});environment.audit({type:'native-search-model-request',requestId,traceId:options.traceId,provider:profile.kind,model:profile.model,status:response?.status??null,...(httpError?{httpError}:{}),round:requestRound++,completed:finished,durationMs:Date.now()-started});}
  if(state.truncated){yield {type:'finish',reason:{kind:'length'}};return;}
  if(capability.mode==='client-rest'&&state.calls.size){
   const calls=[...state.calls.values()];messages.push({role:'assistant',content:output||null,...(state.reasoning?{reasoning_content:state.reasoning}:{}),tool_calls:copy(calls)});
   for(const call of calls){await checkNativeSearch(options);const result=await restTool(profile,capability,call,options,environment,state);while(state.pending.length)yield state.pending.shift();messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify({sourceKind:'official-search-material',untrustedContent:true,result})});}
   continue;
  }
  if(capability.mode==='anthropic'&&state.stopReason==='pause_turn'){
   const signature=JSON.stringify(state.blocks);if(signature===progressSignature||!state.blocks.length)throw fail('服务端搜索暂停后没有新进展，请手动继续','NATIVE_SEARCH_NO_PROGRESS');progressSignature=signature;messages.push({role:'assistant',content:copy(state.blocks)});continue;
  }
  if(capability.mode==='anthropic'&&state.stopReason==='tool_use')throw fail('模型请求了未授权的本地工具','NATIVE_SEARCH_TOOL_DENIED');
  await checkNativeSearch(options);if(!totalText)throw fail('模型没有返回正文','NATIVE_SEARCH_EMPTY');options.onTiming?.({name:'model-complete'});yield {type:'native-search-status',status:state.toolEvents.size||state.sources.size?'completed':'not-used',sourceCount:state.sources.size};yield {type:'finish',reason:{kind:'stop'}};return;
 }
}
