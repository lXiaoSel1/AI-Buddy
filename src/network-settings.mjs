export const NETWORK_DEFAULTS=Object.freeze({schemaVersion:1,mode:'system',proxyUrl:'',githubMirror:'',huggingFaceMirror:''});
const invalid=message=>Object.assign(Error(message),{code:'NETWORK_SETTINGS_INVALID'});
function endpoint(value,{proxy=false}={}){
  if(typeof value!=='string')throw invalid('网络地址必须是文字');
  if(!value)return '';let url;try{url=new URL(String(value).trim());}catch{throw invalid('请填写有效的网络地址');}
  if(!(proxy?['http:','https:']:['https:']).includes(url.protocol))throw invalid(proxy?'暂时只支持 http 代理':'镜像地址需要使用 HTTPS');
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/')throw invalid('请填写不含账号、路径或查询参数的网络地址');
  return url.origin;
}
export function normalizeNetworkSettings(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(NETWORK_DEFAULTS,k))||value.schemaVersion!==undefined&&value.schemaVersion!==1)throw invalid('网络设置格式无效');
  const next={...NETWORK_DEFAULTS,...value};if(!['system','manual','direct'].includes(next.mode))throw invalid('代理模式无效');
  next.proxyUrl=endpoint(next.proxyUrl,{proxy:true});if(next.mode==='manual'&&!next.proxyUrl)throw invalid('请填写代理地址');
  next.githubMirror=endpoint(next.githubMirror);next.huggingFaceMirror=endpoint(next.huggingFaceMirror);return next;
}
const github=new Set(['github.com','raw.githubusercontent.com','release-assets.githubusercontent.com','objects.githubusercontent.com','objects-origin.githubusercontent.com']);
export function downloadRequestPlan(value,settings=NETWORK_DEFAULTS,{official=false}={}){
  const logical=new URL(value),config=normalizeNetworkSettings(settings),family=github.has(logical.hostname)?'github':logical.hostname==='huggingface.co'?'huggingface':null;
  const mirror=official?null:family&&config[family==='github'?'githubMirror':'huggingFaceMirror'];
  const request=new URL(logical);if(mirror){const target=new URL(mirror);request.host=target.host;request.protocol=target.protocol;}
  return {logicalUrl:logical.href,requestUrl:request.href,mirror:mirror?family:null};
}
export function isLoopback(value){try{return ['localhost','127.0.0.1','[::1]','::1'].includes(new URL(value).hostname);}catch{return false;}}
export function proxyRoutes(value){
  if(!value||value==='DIRECT')return [{kind:'direct'}];
  const routes=[];
  for(const part of String(value).split(';')){
    const entry=part.trim();if(entry==='DIRECT'){routes.push({kind:'direct'});continue;}
    if(/^https?:\/\//i.test(entry)){const url=endpoint(entry,{proxy:true});routes.push({kind:new URL(url).protocol.slice(0,-1),url});continue;}
    const match=/^(PROXY|HTTPS|HTTP)\s+([^\s]+)$/i.exec(entry);if(!match)continue;
    const url=endpoint((match[1].toUpperCase()==='HTTPS'?'https://':'http://')+match[2],{proxy:true});routes.push({kind:new URL(url).protocol.slice(0,-1),url});
  }
  if(!routes.length)throw Object.assign(Error('系统代理协议暂不支持'),{code:'NETWORK_PROXY_UNSUPPORTED'});
  return routes;
}
