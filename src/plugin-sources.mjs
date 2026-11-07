import {createHash,createPublicKey} from 'node:crypto';
import {pluginId,pluginHttpsUrl,canonicalPluginJson} from './plugin-manifest.mjs';
import {verifyPluginCatalog,OFFICIAL_PLUGIN_TRUST_KEYS} from './plugin-catalog.mjs';

export const OFFICIAL_SOURCE_ID='official';
export const LEGACY_SOURCE_ID='legacy';
export const OFFICIAL_SOURCE_DESCRIPTOR_URL='https://raw.githubusercontent.com/lXiaoSel1/AI-Buddy-Extensions/main/source.json';
export const OFFICIAL_SOURCE_CATALOG_URL='https://raw.githubusercontent.com/lXiaoSel1/AI-Buddy-Extensions/main/catalog.json';
export const MAX_PLUGIN_SOURCES=20;
export const SOURCE_PREVIEW_TTL_MS=300000;
// GitHub owner/repository names are case-insensitive; branch and file names are not.
export function pluginSourceUrlIdentity(value){const url=new URL(value);if(url.hostname.toLowerCase()==='raw.githubusercontent.com'){const parts=url.pathname.split('/');if(parts.length>=5){parts[1]=parts[1].toLowerCase();parts[2]=parts[2].toLowerCase();url.pathname=parts.join('/');}}return url.toString();}
const failure=(message,code='PLUGIN_SOURCE_INVALID')=>Object.assign(Error(message),{code});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max=200)=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f]/.test(value))throw failure('扩展来源资料格式无效');return value.trim();};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function pluginSourceFingerprint(publicKey){
 const parts=text(publicKey,1000).split(/\s+/);if(parts[0]!=='ssh-ed25519'||!/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1]??''))throw failure('扩展来源需要 Ed25519 OpenSSH 公钥');
 const blob=Buffer.from(parts[1],'base64');let at=0;const field=()=>{if(at+4>blob.length)throw failure('扩展来源公钥无效');const count=blob.readUInt32BE(at);at+=4;if(count>blob.length-at)throw failure('扩展来源公钥无效');const value=blob.subarray(at,at+count);at+=count;return value;};
 if(field().toString()!=='ssh-ed25519')throw failure('扩展来源公钥无效');const raw=field();if(raw.length!==32||at!==blob.length)throw failure('扩展来源公钥无效');createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),raw]),format:'der',type:'spki'});
 return 'SHA256:'+createHash('sha256').update(blob).digest('base64').replace(/=+$/,'');
}
export function parsePluginSourceDescriptor(value){
 if(!object(value)||value.schemaVersion!==1)throw failure('不支持的扩展来源描述');
 const allowed=new Set(['schemaVersion','id','name','catalogUrl','publicKey','keyId','repositoryUrl','feedbackUrl']);if(Object.keys(value).some(k=>!allowed.has(k)))throw failure('扩展来源包含未知字段');
 pluginId(value.id);pluginId(value.keyId);const row={schemaVersion:1,id:value.id,name:text(value.name),catalogUrl:pluginHttpsUrl(value.catalogUrl),publicKey:text(value.publicKey,1000),keyId:value.keyId};pluginSourceFingerprint(row.publicKey);
 for(const key of ['repositoryUrl','feedbackUrl'])if(value[key]!=null)row[key]=pluginHttpsUrl(value[key]);return row;
}
export function resolvePluginSourceInput(input){
 let value=text(input,2048);if(/^github\.com\//i.test(value))value='https://'+value;let url;try{url=new URL(value);}catch{throw failure('请输入 HTTPS 来源描述或 GitHub 仓库地址');}
 if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search)throw failure('扩展来源必须使用不含凭据的 HTTPS 地址');
 if(url.hostname.toLowerCase()==='github.com'){
  const parts=url.pathname.replace(/\/$/,'').split('/').filter(Boolean);if(parts.length!==2||!parts.every(x=>/^[A-Za-z0-9_.-]+$/.test(x)))throw failure('请填写 GitHub 仓库主页，不是分支、文件或 README 地址');
  const repository=parts[1].replace(/\.git$/,'');if(!repository||repository==='.'||repository==='..')throw failure('GitHub 仓库地址无效');return {kind:'github',owner:parts[0],repository,url:'https://github.com/'+parts[0]+'/'+repository};
 }
 if(!url.pathname.toLowerCase().endsWith('.json'))throw failure('直接来源地址必须指向 JSON 描述文件');return {kind:'descriptor',url:url.toString()};
}
export async function fetchPluginJson(url,{fetchImpl=fetch,signal,maximum=1024*1024}={}){
 let target=new URL(url);const controller=AbortSignal.timeout(30000),combined=signal?AbortSignal.any([signal,controller]):controller;
 for(let redirects=0;redirects<=4;redirects++){
  if(target.protocol!=='https:'||target.username||target.password||target.hash)throw failure('扩展来源重定向地址无效','PLUGIN_SOURCE_FETCH_FAILED');
  const response=await fetchImpl(target.toString(),{redirect:'manual',headers:{accept:'application/vnd.github+json, application/json','user-agent':'AI-Buddy-Extensions'},signal:combined});
  if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel().catch(()=>{});if(!location||redirects===4)throw failure('扩展来源重定向过多','PLUGIN_SOURCE_FETCH_FAILED');target=new URL(location,target);continue;}
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw failure('读取扩展来源失败：HTTP '+response.status,'PLUGIN_SOURCE_FETCH_FAILED');}
  let count=0;const chunks=[],reader=response.body?.getReader();if(reader)try{while(true){const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>maximum){await reader.cancel().catch(()=>{});throw failure('扩展来源文件超过大小限制','PLUGIN_SOURCE_TOO_LARGE');}chunks.push(Buffer.from(value));}}catch(error){await reader.cancel(error).catch(()=>{});throw error;}finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw failure('扩展来源返回的内容不是有效 JSON','PLUGIN_SOURCE_FETCH_FAILED');}
 }
 throw failure('扩展来源读取失败','PLUGIN_SOURCE_FETCH_FAILED');
}
export function sourceIsOfficial(url,descriptor){return pluginSourceUrlIdentity(url)===pluginSourceUrlIdentity(OFFICIAL_SOURCE_DESCRIPTOR_URL)&&pluginSourceUrlIdentity(descriptor.catalogUrl)===pluginSourceUrlIdentity(OFFICIAL_SOURCE_CATALOG_URL)&&descriptor.keyId==='ai-buddy-release'&&pluginSourceFingerprint(descriptor.publicKey)===pluginSourceFingerprint(OFFICIAL_PLUGIN_TRUST_KEYS['ai-buddy-release']);}
export function defaultPluginSource(){const publicKey=OFFICIAL_PLUGIN_TRUST_KEYS['ai-buddy-release'];return {sourceId:OFFICIAL_SOURCE_ID,descriptorId:'ai-buddy.extensions',name:'AI Buddy 官方扩展',url:OFFICIAL_SOURCE_DESCRIPTOR_URL,catalogUrl:OFFICIAL_SOURCE_CATALOG_URL,publicKey,keyId:'ai-buddy-release',keyFingerprint:pluginSourceFingerprint(publicKey),official:true,enabled:true,removed:false,generation:0,cachedAt:null,lastError:null};}
export async function previewPluginSource(input,{fetchImpl=fetch,signal}={}){
 const resolved=resolvePluginSourceInput(input);let url=resolved.url,raw;
 if(resolved.kind==='github'){
  const base='https://api.github.com/repos/'+encodeURIComponent(resolved.owner)+'/'+encodeURIComponent(resolved.repository),repo=await fetchPluginJson(base,{fetchImpl,signal});const branch=text(repo.default_branch,300);
  const file=await fetchPluginJson(base+'/contents/source.json?ref='+encodeURIComponent(branch),{fetchImpl,signal});
  if(!object(file)||file.type!=='file'||file.name!=='source.json'||file.encoding!=='base64'||typeof file.content!=='string')throw failure('GitHub 仓库根目录缺少有效 source.json');
  const encoded=file.content.replace(/\s/g,'');if(encoded.length>2*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw failure('GitHub source.json 编码无效');try{raw=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));}catch{throw failure('GitHub source.json 不是有效 JSON');}
  const owner=typeof repo.owner?.login==='string'&&/^[A-Za-z0-9_.-]+$/.test(repo.owner.login)?repo.owner.login:resolved.owner,repository=typeof repo.name==='string'&&/^[A-Za-z0-9_.-]+$/.test(repo.name)?repo.name:resolved.repository;
  url='https://raw.githubusercontent.com/'+owner+'/'+repository+'/'+branch.split('/').map(encodeURIComponent).join('/')+'/source.json';
 }else raw=await fetchPluginJson(url,{fetchImpl,signal});
 const descriptor=parsePluginSourceDescriptor(raw),envelope=await fetchPluginJson(descriptor.catalogUrl,{fetchImpl,signal,maximum:16*1024*1024+20000}),catalog=verifyPluginCatalog(envelope,{trustedKeys:{[descriptor.keyId]:descriptor.publicKey}});
 const source={...descriptor,descriptorId:descriptor.id,url,keyFingerprint:pluginSourceFingerprint(descriptor.publicKey),official:sourceIsOfficial(url,descriptor)};
 return {source,catalog,envelope,signatureValid:true,packageCount:catalog.packages.length,descriptorHash:sha(canonicalPluginJson(descriptor))};
}
export function isVoiceSourceAuthorized(sourceId, keyFingerprint, testFingerprint) {
  return sourceId===LEGACY_SOURCE_ID ||
    (sourceId===OFFICIAL_SOURCE_ID && keyFingerprint===defaultPluginSource().keyFingerprint) ||
    (!!testFingerprint && keyFingerprint===testFingerprint);
}
