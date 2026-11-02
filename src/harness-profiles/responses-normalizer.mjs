import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {estimateMemoryTokens} from '../companion-memory.mjs';

export const RESPONSES_NORMALIZER_VERSION='responses-only-2026-10-24-v2-budget';
const failure=(message,code)=>Object.assign(Error(message),{code});
const maxBytes=32*1024*1024;
const eventBoundary=buffer=>{const lf=buffer.indexOf('\n\n'),crlf=buffer.indexOf('\r\n\r\n');return lf<0?(crlf<0?null:[crlf,4]):crlf<0||lf<crlf?[lf,2]:[crlf,4];};
function verifyModel(response,expected){if(response?.model!==expected)throw failure('供应商实际返回的模型与固定工作模型不一致，任务已暂停','HARNESS_MODEL_MISMATCH');}
function frameEvent(frame){const lines=frame.toString('utf8').split(/\r?\n/),data=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data)return null;if(data==='[DONE]')return {done:true};let event;try{event=JSON.parse(data);}catch{throw failure('Responses 流包含无效 JSON 事件','HARNESS_RESPONSE_PROTOCOL_INVALID');}return event;}
export function withoutDuplicateTrustedInstructions(input,instructions){
  if(!Array.isArray(input))return input;
  return input.flatMap(row=>{
    if(row?.role!=='developer')return [row];
    if(typeof row.content==='string')return row.content===instructions?[]:[row];
    if(!Array.isArray(row.content))return [row];
    const content=row.content.filter(part=>!(part?.type==='input_text'&&part.text===instructions));
    return content.length===row.content.length?[row]:content.length?[{...row,content}]:[];
  });
}
async function send(res,chunk){if(res.destroyed)throw failure('工作请求已断开','ABORT_ERR');if(res.write(chunk))return;await new Promise((resolve,reject)=>{const finish=()=>{cleanup();resolve();},fail=()=>{cleanup();reject(failure('工作请求已断开','ABORT_ERR'));},cleanup=()=>{res.off('drain',finish);res.off('close',fail);res.off('error',fail);};res.once('drain',finish);res.once('close',fail);res.once('error',fail);});}

/** Task-owned Responses compatibility boundary. No Chat translation, credentials,
 * prompt bodies or tool output are logged or persisted here. */
export async function createResponsesNormalizer({endpoint,model,effort=null,supportedEfforts=[],defaultEffort=null,instructions,key,contextTokens=272000,reservedOutputTokens,fetchImpl=fetch,onViolation=()=>{},requestTimeoutMs=120000}={}){
  if(!endpoint||!model||typeof key!=='string'||!key||typeof instructions!=='string'||!instructions)throw failure('Responses 工作规范化配置不完整','HARNESS_NORMALIZER_CONFIG_INVALID');
  if(!Number.isSafeInteger(contextTokens)||contextTokens<2048)throw failure('工作上下文容量无效','HARNESS_NORMALIZER_CONFIG_INVALID');
  const outputReserve=reservedOutputTokens??Math.min(2400,Math.floor(contextTokens/4));
  if(!Number.isSafeInteger(outputReserve)||outputReserve<0)throw failure('工作回复预留无效','HARNESS_NORMALIZER_CONFIG_INVALID');
  const token=randomBytes(32).toString('hex'),controllers=new Set();let closed=false,upstreamAttempts=0;
  const upstream=endpoint.replace(/\/+$/,'')+'/responses';
  const server=createServer(async(req,res)=>{
    if(closed){res.writeHead(503);res.end();return;}
    if(req.method!=='POST'||req.url!=='/responses'||req.headers.origin!==undefined||req.headers.authorization!=='Bearer '+token){res.writeHead(403);res.end();return;}
    const controller=new AbortController();controllers.add(controller);const timer=setTimeout(()=>controller.abort(),requestTimeoutMs);timer.unref?.();
    const abort=()=>{if(!res.writableEnded)controller.abort();};req.once('aborted',abort);res.once('close',abort);
    try{
      let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>maxBytes)throw failure('工作请求超过安全大小限制','HARNESS_RESPONSE_REQUEST_TOO_LARGE');chunks.push(chunk);}
      let request;try{request=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw failure('工作请求不是有效 JSON','HARNESS_RESPONSE_PROTOCOL_INVALID');}
      if(request.model!==model)throw failure('工作请求尝试更换固定模型','HARNESS_MODEL_MISMATCH');
      if(request.previous_response_id!=null||request.conversation!=null||request.background===true)throw failure('所选工作接口需要客户端保存完整历史，不能使用服务端会话状态','HARNESS_STATELESS_REQUIRED');
      const incomingEffort=request.reasoning?.effort??null,expectedEffort=effort??defaultEffort;
      if(incomingEffort!==expectedEffort||incomingEffort!=null&&!supportedEfforts.includes(incomingEffort))throw failure('工作请求的 effort 与固定模型配置不一致','HARNESS_WORK_EFFORT_UNSUPPORTED');
      // Only the builder-owned coding + character text receives system priority.
      // Native user/tool/history items are retained byte-for-byte as JSON values.
      const normalized={...request,input:withoutDuplicateTrustedInstructions(request.input,instructions),instructions,store:false};delete normalized.previous_response_id;delete normalized.conversation;delete normalized.background;
      const inputTokens=estimateMemoryTokens({instructions:normalized.instructions,input:normalized.input??[],tools:normalized.tools??[]}),reserve=Math.max(outputReserve,Number.isSafeInteger(normalized.max_output_tokens)&&normalized.max_output_tokens>0?normalized.max_output_tokens:0);
      if(inputTokens+reserve>contextTokens){const capacity={tokens:contextTokens,estimatedInputTokens:inputTokens,reservedOutputTokens:reserve};throw Object.assign(failure('最终工作请求及回复预留超过所选上下文容量；原文和工具记录保留，请减少工作上下文或明确调整容量后重试','HARNESS_WORK_CONTEXT_CAPACITY'),{capacity,recoverable:true,details:{capacity,recoverable:true,upstreamSubmitted:upstreamAttempts>0,upstreamAttempts}});}
      upstreamAttempts++;
      const response=await fetchImpl(upstream,{method:'POST',redirect:'manual',headers:{'content-type':'application/json',accept:request.stream===false?'application/json':'text/event-stream',authorization:'Bearer '+key},body:JSON.stringify(normalized),signal:controller.signal});
      if(!response.ok){await response.body?.cancel().catch(()=>{});res.writeHead(response.status,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'HARNESS_UPSTREAM_HTTP_ERROR',message:'所选工作供应商返回 HTTP '+response.status+'；没有自动重试或更换连接。'}}));return;}
      if(request.stream===false){const payload=await response.json();verifyModel(payload,model);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(payload));return;}
      if(!response.headers.get('content-type')?.includes('text/event-stream'))throw failure('所选供应商没有返回 Responses 事件流','HARNESS_RESPONSE_PROTOCOL_INVALID');
      let buffer=Buffer.alloc(0),created=false,terminal=false;
      for await(const chunk of response.body){
        buffer=Buffer.concat([buffer,chunk]);if(buffer.length>maxBytes)throw failure('Responses 单条事件过大','HARNESS_RESPONSE_PROTOCOL_INVALID');
        for(let boundary;(boundary=eventBoundary(buffer));){const [at,size]=boundary,frame=buffer.subarray(0,at+size);buffer=buffer.subarray(at+size);const event=frameEvent(frame);
          if(event?.done){if(!terminal)throw failure('Responses 在终止事件之前结束','HARNESS_RESPONSE_PROTOCOL_INVALID');}
          else if(event){if(event.type==='response.created'){verifyModel(event.response,model);created=true;}else if(!created)throw failure('Responses 缺少可核验模型的 created 事件','HARNESS_RESPONSE_PROTOCOL_INVALID');
            if(event.response?.model!=null)verifyModel(event.response,model);
            if(['response.completed','response.incomplete','response.failed'].includes(event.type))terminal=true;
          }
          if(!res.headersSent)res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});await send(res,frame);
        }
      }
      if(buffer.length&&buffer.toString('utf8').trim())throw failure('Responses 最后事件不完整','HARNESS_RESPONSE_PROTOCOL_INVALID');
      if(!terminal)throw failure('Responses 流在终止事件前中断','HARNESS_RESPONSE_PROTOCOL_INVALID');res.end();
    }catch(error){const wasAborted=controller.signal.aborted;controller.abort();if(!wasAborted){try{const violation=failure(error.code?.startsWith?.('HARNESS_')?error.message:'工作 Responses 连接中断',error.code?.startsWith?.('HARNESS_')?error.code:'HARNESS_RESPONSE_CONNECTION_FAILED');if(error.code==='HARNESS_WORK_CONTEXT_CAPACITY')Object.assign(violation,{capacity:{...error.capacity},recoverable:true,details:{capacity:{...error.capacity},recoverable:true,upstreamSubmitted:upstreamAttempts>0,upstreamAttempts}});onViolation(violation);}catch{}}
      if(!res.headersSent){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:error.code?.startsWith?.('HARNESS_')?error.code:'HARNESS_RESPONSE_CONNECTION_FAILED',message:error.code?.startsWith?.('HARNESS_')?error.message:'工作 Responses 连接中断'}}));}else res.destroy();
    }finally{clearTimeout(timer);controllers.delete(controller);req.off('aborted',abort);res.off('close',abort);}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  return {version:RESPONSES_NORMALIZER_VERSION,endpoint:'http://127.0.0.1:'+server.address().port,token,upstream,
    close(){if(closed)return;closed=true;for(const controller of controllers)controller.abort();server.closeAllConnections();server.close();},get activeRequests(){return controllers.size;},get upstreamAttempts(){return upstreamAttempts;},get closed(){return closed;}};
}
