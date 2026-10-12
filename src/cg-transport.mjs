import {connectionIdentity} from './service-identity.mjs';
import {fitReferences} from './cg-reference-registry.mjs';
import {readFileSync} from 'node:fs';
import {localEndpoint} from './model-presets.mjs';
const MAX_IMAGE=32*1024*1024,MAX_JSON=48*1024*1024;
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(Error('CG 请求已中断'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});
export async function limitedBytes(response,max=MAX_IMAGE){
 if(Number(response.headers.get('content-length'))>max){await response.body?.cancel();throw Error('图片或接口响应过大');}
 const chunks=[];let size=0;
 for await(const chunk of response.body??[]){size+=chunk.length;if(size>max)throw Error('图片或接口响应过大');chunks.push(Buffer.from(chunk));}
 return Buffer.concat(chunks);
}
function httpError(status){return Error(status===401||status===403?'绘图鉴权失败，请检查 API Key 与地域':status===429?'绘图额度不足或请求过于频繁':status>=500?'绘图服务暂时不可用':'绘图接口请求失败（HTTP '+status+'）');}
export const wanPath=(base,path)=>base.replace(/\/api\/v1$/,'')+'/api/v1/'+path;
const wanImage=data=>data?.output?.choices?.[0]?.message?.content?.find(row=>row?.image||row?.url)?.image??data?.output?.choices?.[0]?.message?.content?.find(row=>row?.url)?.url??data?.output?.results?.[0]?.url;
export class CgTransport{
 constructor({fetchImpl=fetch,onUsage=()=>{},pollInterval=10000}={}){Object.assign(this,{fetchImpl,onUsage,pollInterval});}
 headers(profile){return profile.protocol==='gemini-images'?{'x-goog-api-key':profile.key}:{...(profile.key?{authorization:'Bearer '+profile.key}:{})};}
 async request(profile,url,{method='GET',body,headers={}}={},signal){
  let response;try{response=await this.fetchImpl(url,{method,signal,redirect:'error',headers:{...this.headers(profile),...(typeof body==='string'?{'content-type':'application/json'}:{}),...headers},...(body?{body}:{})});}catch{throw Error(signal?.aborted?'CG 请求已中断或超时':'绘图服务连接失败');}
  if(!response.ok){await response.body?.cancel();throw httpError(response.status);}
  try{return JSON.parse((await limitedBytes(response,MAX_JSON)).toString('utf8'));}catch(error){if(error.message.includes('过大'))throw error;throw Error('绘图接口返回格式无效');}
 }
 async image(ref,signal){
  if(typeof ref!=='string'||!ref)throw Error('绘图服务没有返回图片');
  if(ref.startsWith('data:image/')){const match=ref.match(/^data:image\/[-+\w.]+;base64,([A-Za-z0-9+/=\s]+)$/);if(!match||match[1].length>MAX_JSON)throw Error('图片数据无效');return Buffer.from(match[1],'base64');}
  let url;try{url=new URL(ref);}catch{throw Error('图片地址无效');}
  if(url.username||url.password||(url.protocol!=='https:'&&!(url.protocol==='http:'&&localEndpoint(ref))))throw Error('图片地址须使用 HTTPS');
  let response;try{response=await this.fetchImpl(url,{signal,redirect:'error'});}catch{throw Error('CG 图片下载失败');}
  if(!response.ok){await response.body?.cancel();throw Error('CG 图片下载失败');}return limitedBytes(response);
 }
 async listModels(profile,signal){
  const url=profile.protocol==='gemini-images'?profile.baseUrl+'/models':profile.protocol.startsWith('wan-')?profile.baseUrl.replace(/\/api\/v1$/,'')+'/compatible-mode/v1/models':profile.baseUrl+'/models';
  const data=await this.request(profile,url,{},signal);
  return (data.data??data.models??[]).map(row=>({id:String(row.id??row.name??'').replace(/^models\//,''),name:String(row.displayName??row.id??row.name??'')})).filter(row=>row.id).slice(0,1000);
 }
 async check(profile,signal){
  try{const models=await this.listModels(profile,signal);return {ok:true,message:'连接成功；未生成图片',models};}
  catch(error){if(!error.message.includes('HTTP 404')&&!error.message.includes('HTTP 405'))throw error;return {ok:true,message:'服务可访问；请生成测试图验证绘图模型',models:[]};}
 }
 usage(profile,data){const numeric=value=>Object.fromEntries(Object.entries(value??{}).filter(([,v])=>typeof v==='number'));this.onUsage({purpose:'cg',provider:profile.kind,connectionIdentity:connectionIdentity(profile),model:profile.model,usage:numeric(data.usage)});}
 async generate(profile,{prompt,references=[],signal,remoteTask,onRemoteTask=async()=>{},onSubmit=async()=>{}}){
  const options=profile.options??{},refs=fitReferences(profile,references);let data,ref;
  if(!remoteTask)await onSubmit();
  if(profile.protocol==='openai-images'){
   const settings={model:profile.model,n:1,prompt,...(options.size?{size:options.size}:/^(gpt-image-1|gpt-image-1\.5|gpt-image-1-mini)$/.test(profile.model)?{size:'1536x1024'}:{}),...(options.quality&&options.quality!=='auto'?{quality:options.quality}:{})};
   if(refs.length){const form=new FormData();for(const [key,value] of Object.entries(settings))form.append(key,String(value));for(let i=0;i<refs.length;i++)form.append('image[]',new Blob([readFileSync(refs[i].path)],{type:refs[i].mime??'image/png'}),'character-'+i+'.png');data=await this.request(profile,profile.baseUrl+'/images/edits',{method:'POST',body:form},signal);}
   else data=await this.request(profile,profile.baseUrl+'/images/generations',{method:'POST',body:JSON.stringify(settings)},signal);
   ref=data.data?.[0]?.b64_json?'data:image/png;base64,'+data.data[0].b64_json:data.data?.[0]?.url;
  }else if(profile.protocol==='gemini-images'){
   const input=[{type:'text',text:prompt},...refs.map(row=>({type:'image',mime_type:row.mime??'image/png',data:readFileSync(row.path).toString('base64')}))];
   data=await this.request(profile,profile.baseUrl+'/interactions',{method:'POST',body:JSON.stringify({model:profile.model,input,response_format:{type:'image',aspect_ratio:'16:9',image_size:options.size||'1K',mime_type:'image/png'},store:false})},signal);
   const image=data.output_image??data.interaction?.output_image;ref=image?.data?'data:'+(image.mime_type??'image/png')+';base64,'+image.data:image?.uri;
  }else if(profile.protocol==='wan-image'){
   if(!refs.length)throw Error('此万相连接需要角色参考图，请选择文生图协议');if(prompt.length>2000)throw Error('角色与场景描述过长，请缩短后重试');
   data=await this.request(profile,wanPath(profile.baseUrl,'services/aigc/multimodal-generation/generation'),{method:'POST',body:JSON.stringify({model:profile.model,input:{messages:[{role:'user',content:[{text:prompt},...refs.map(row=>({image:'data:'+(row.mime??'image/png')+';base64,'+readFileSync(row.path).toString('base64')}))]}]},parameters:{size:options.size||'1280*720',n:1,enable_interleave:false}})},signal);ref=wanImage(data);
  }else if(['wan-t2i','wan-t2i-legacy'].includes(profile.protocol)){
   let task=remoteTask;
   if(!task){
    const modern=profile.protocol==='wan-t2i';
    data=await this.request(profile,wanPath(profile.baseUrl,modern?'services/aigc/image-generation/generation':'services/aigc/text2image/image-synthesis'),{method:'POST',headers:{'X-DashScope-Async':'enable'},body:JSON.stringify({model:profile.model,input:modern?{messages:[{role:'user',content:[{text:prompt}]}]}:{prompt},parameters:{size:options.size||'1696*960',n:1,prompt_extend:false}})},signal);
    const id=data.output?.task_id;if(typeof id!=='string'||!id)throw Error('万相没有返回任务编号');task={id};await onRemoteTask(task);
   }
   while(true){
    data=await this.request(profile,wanPath(profile.baseUrl,'tasks/'+encodeURIComponent(task.id)),{},signal);
    const status=data.output?.task_status;
    if(status==='SUCCEEDED'){ref=wanImage(data);break;}
    if(!['PENDING','RUNNING'].includes(status))throw Error('万相绘图任务失败，请手动重试');
    await sleep(this.pollInterval,signal);
   }
  }else throw Error('绘图协议不受支持');
  this.usage(profile,data);return {buffer:await this.image(ref,signal),revisedPrompt:data.data?.[0]?.revised_prompt??null};
 }
}
