const MAX_ERROR_BYTES=64*1024;
function scalar(value){return typeof value==='string'||typeof value==='number'?String(value):'';}
export function sanitizeCgError(value,secrets=[]){
 let text=scalar(value);
 for(const secret of secrets.filter(s=>typeof s==='string'&&s.length>0))for(const variant of [secret,encodeURIComponent(secret),JSON.stringify(secret).slice(1,-1)])text=text.split(variant).join('[redacted]');
 return text.replace(/data:image\/[^\s"']+/gi,'[image redacted]')
  .replace(/Bearer\s+[^\s"',;]+/gi,'Bearer [redacted]')
  .replace(/\b(?:sk-|ark-)[a-zA-Z0-9_-]{12,}/g,'[redacted]')
  .replace(/((?:api[_-]?key|authorization|access[_-]?token|secret)\s*[=:]\s*["']?)[^\s"',;&]+/gi,'$1[redacted]')
  .replace(/https?:\/\/[^\s"'<>]+/gi,url=>{try{const u=new URL(url);u.username='';u.password='';u.search='';u.hash='';return u.toString();}catch{return '[url]';}})
  .replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,900);
}
export function cgServiceError(status,data,headers,profile={},prompt=''){
 const secrets=[profile.key,prompt],clean=v=>sanitizeCgError(v,secrets);
 const payload=data?.error??data?.Error??data?.ResponseMetadata?.Error??data??{};
 const code=clean(payload.code??payload.Code??payload.type),reason=clean(typeof payload==='string'?payload:payload.message??payload.Message??payload.msg);
 const requestId=clean(headers?.get?.('x-request-id')??headers?.get?.('x-tt-logid')??data?.request_id??data?.RequestId??data?.ResponseMetadata?.RequestId??payload.request_id).replace(/[^a-zA-Z0-9_.:-]/g,'').slice(0,160);
 const prefix=status>=200&&status<300?'绘图服务返回错误':`绘图接口请求失败（HTTP ${status}）`;
 const fallback=status===401||status===403?'请检查 API Key、项目权限与地域':status===429?'额度不足或请求过于频繁':status>=500?'绘图服务暂时不可用':'服务未返回具体错误信息';
 const error=new Error([prefix,code&&`[${code}]`,reason||fallback,requestId&&`请求 ID：${requestId}`].filter(Boolean).join(' · '));
 error.details={status,code:code||null,reason:reason||fallback,requestId:requestId||null};return error;
}
export async function cgHttpError(response,profile,prompt){
 let data=null;
 try{
  const chunks=[];let bytes=0;
  for await(const chunk of response.body??[]){bytes+=chunk.length;if(bytes>MAX_ERROR_BYTES)break;chunks.push(Buffer.from(chunk));}
  if(bytes<=MAX_ERROR_BYTES)data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }catch{/* Never expose raw HTML, credentials or an unbounded response. */}
 return cgServiceError(response.status,data,response.headers,profile,prompt);
}
