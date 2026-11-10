const codes=new Set(['invalid_request','invalid_request_error','invalid_request_body','invalid_parameter','invalid_api_key','authentication_error','permission_denied','permission_error','not_found_error','model_not_found','unsupported_parameter','unsupported_value','context_length_exceeded','rate_limit_error','rate_limit_exceeded','insufficient_quota','internal_server_error','server_error','overloaded_error','bad_request','bad_request_error']);
const params=new Set(['messages','tools','model','max_tokens','max_completion_tokens','max_output_tokens','reasoning_effort','reasoning','stream','stream_options','temperature','top_p','system','input','instructions','generationConfig']);
const permitted=(value,secrets)=>typeof value==='string'&&!secrets.some(secret=>typeof secret==='string'&&secret&&value.includes(secret));
export function safeProviderRequestId(value,secrets=[]){return permitted(value,secrets)&&/^(?:req[-_][A-Za-z0-9_-]{1,100}|[a-fA-F0-9]{16,64}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$/.test(value)?value:undefined;}
export function apiHttpError(status,metadata={}){
 const message=status===401?'API Key 无效，请重新配置':status===403?'当前账户没有该模型的访问权限':status===404?'服务地址或模型 ID 不存在':status===429?'请求受限或额度不足，请稍后重试':status>=500?'模型服务暂时不可用，请稍后重试':'API 请求失败，请检查模型和协议配置';
 return Object.assign(Error(message+' (HTTP '+status+')'),{code:'API_HTTP_ERROR',httpError:{status,...metadata}});
}
function retryAfterDelay(value){
 if(typeof value!=='string')return undefined;value=value.trim();let delay;
 if(/^\d+$/.test(value))delay=Number(value)*1000;
 else if(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value))delay=Math.max(0,Date.parse(value)-Date.now());
 return Number.isSafeInteger(delay)&&delay>=0?delay:undefined;
}
export async function readApiHttpError(response,{signal,secrets=[]}={}){
 const retryAfterMs=response.status===429?retryAfterDelay(response.headers.get('retry-after')):undefined;
 const metadata={},reader=response.body?.getReader();let raw='',timer,stopRead,stopped=false;
 const stoppedRead=new Promise(resolve=>{stopRead=()=>{stopped=true;resolve(null);void reader?.cancel().catch(()=>{});};});
 if(reader){
  timer=setTimeout(stopRead,500);signal?.addEventListener('abort',stopRead,{once:true});if(signal?.aborted)stopRead();
  try{const decoder=new TextDecoder();let bytes=0;for(;;){const chunk=await Promise.race([reader.read(),stoppedRead]);if(!chunk)break;if(chunk.done){raw+=decoder.decode();break;}bytes+=chunk.value.byteLength;if(bytes>=16*1024){stopRead();raw='';break;}raw+=decoder.decode(chunk.value,{stream:true});}}
  catch{raw='';}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',stopRead);void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
 }
 if(signal?.aborted)throw Object.assign(Error('请求已取消'),{code:'ABORT_ERR'});
 let body;try{if(!stopped)body=JSON.parse(raw);}catch{}raw='';
 const error=body?.error&&typeof body.error==='object'?body.error:body;
 for(const field of ['code','type'])if(permitted(error?.[field],secrets)&&codes.has(error[field]))metadata[field]=error[field];
 if(permitted(error?.param,secrets)&&params.has(error.param))metadata.param=error.param;
 const requestId=[response.headers.get('x-request-id'),response.headers.get('request-id'),response.headers.get('x-ms-request-id'),body?.request_id,body?.requestId,error?.request_id].map(value=>safeProviderRequestId(value,secrets)).find(Boolean);if(requestId)metadata.requestId=requestId;
 const failure=apiHttpError(response.status,metadata);if(retryAfterMs!==undefined)failure.retryAfterMs=retryAfterMs;return failure;
}
