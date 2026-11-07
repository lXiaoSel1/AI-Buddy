import {randomUUID,createHash} from 'node:crypto';
import {readFile,stat,mkdir,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {writeAtomic} from './atomic-write.mjs';
import {legacyUpdateKey, selectStableUpdate, stablePatchUpdate} from './plugin-update-policy.mjs';
import {canonicalPluginJson,pluginId,parsePluginVersion,pluginCompatibility,satisfiesVersionRange} from './plugin-manifest.mjs';
import {verifyPluginCatalog,resolvePluginInstallPlan,catalogPackages} from './plugin-catalog.mjs';
import {assertPluginTreeNoLinks,inspectPluginArchive,extractPluginArchive,verifyInstalledPlugin} from './plugin-archive.mjs';
import {defaultPluginSource,OFFICIAL_SOURCE_ID,LEGACY_SOURCE_ID,MAX_PLUGIN_SOURCES,SOURCE_PREVIEW_TTL_MS,pluginSourceFingerprint,pluginSourceUrlIdentity,sourceIsOfficial,isVoiceSourceAuthorized,previewPluginSource,fetchPluginJson} from './plugin-sources.mjs';
import {renamePluginPath as rename} from './plugin-files.mjs';
import {isVoicePackage,supportsVoiceManifest} from './voice/package-contract.mjs';

export const PLUGIN_SOURCE_BACKEND=Symbol('AI Buddy source storage boundary');
const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:canonicalPluginJson(value)).digest('hex');
const fail=(message,code='PLUGIN_SOURCE_OPERATION_FAILED')=>{throw Object.assign(Error(message),{code});};
const clone=value=>structuredClone(value);
const json=async(path,fallback)=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}};
const sourceId=value=>{if(value!==OFFICIAL_SOURCE_ID&&value!==LEGACY_SOURCE_ID&&!/^[a-f0-9-]{36}$/.test(value??''))fail('扩展来源身份无效','PLUGIN_SOURCE_INVALID');return value;};
const summaryManifest=manifest=>Object.fromEntries(Object.entries(manifest).filter(([key])=>key!=='files'));

/** Source trust and new packages are independent of the legacy registry. Every
 * write is serialized through the r5 maintenance/installation lock. */
export async function createPluginSourceManager({legacy,root,dataRoot,appVersion,apiVersion,onUpdate=()=>{},now=Date.now,voiceTestFingerprint}={}){
 const backend=legacy[PLUGIN_SOURCE_BACKEND],control=join(root,'local/plugins'),sourceFile=join(control,'sources.json'),registryFile=join(control,'registry-v2.json');
 let sourcesRecord=await json(sourceFile,{schemaVersion:1,sources:{}}),registry=await json(registryFile,{schemaVersion:2,packages:{}}),closed=false,active=null;
 const catalogs=new Map(),previews=new Map(),plans=new Map(),updatePlans=new Map(),generations=new Map(),requests=new Set(),verified=new Set();
 const verificationKey=(sid,saved)=>sid+':'+saved.manifest.id+'@'+saved.manifest.version+':'+saved.archive.sha256;
 function validate(){
  if(sourcesRecord?.schemaVersion!==1||!sourcesRecord.sources||typeof sourcesRecord.sources!=='object'||Array.isArray(sourcesRecord.sources)||registry?.schemaVersion!==2||!registry.packages||typeof registry.packages!=='object'||Array.isArray(registry.packages))fail('扩展来源或独立登记损坏；旧资料保留','PLUGIN_SOURCE_STORAGE_INVALID');
  for(const[sid,row]of Object.entries(sourcesRecord.sources)){sourceId(sid);if(!row||row.sourceId!==sid||row.keyFingerprint!==pluginSourceFingerprint(row.publicKey)||typeof row.enabled!=='boolean'||typeof row.removed!=='boolean')fail('扩展来源身份校验失败','PLUGIN_SOURCE_STORAGE_INVALID');if(sid===LEGACY_SOURCE_ID||sid===OFFICIAL_SOURCE_ID&&(row.keyFingerprint!==defaultPluginSource().keyFingerprint||pluginSourceUrlIdentity(row.url)!==pluginSourceUrlIdentity(defaultPluginSource().url)))fail('保留的扩展来源身份不能被替换','PLUGIN_SOURCE_STORAGE_INVALID');}
  for(const[id,row]of Object.entries(registry.packages)){pluginId(id);sourceId(row?.sourceId);if(!row.versions||typeof row.versions!=='object'||Array.isArray(row.versions)||!row.versions[row.current]||row.previous&&!row.versions[row.previous]||typeof row.enabled!=='boolean'||!Number.isSafeInteger(row.dataSchemaVersion)||row.dataSchemaVersion<1)fail('扩展独立登记版本损坏；资料已保留','PLUGIN_SOURCE_STORAGE_INVALID');for(const[version,saved]of Object.entries(row.versions)){if(saved?.manifest?.id!==id||saved.manifest.version!==version||!saved.archive||!/^[a-f0-9]{64}$/.test(saved.archive.sha256??'')||saved.directory!=='packages/'+row.sourceId+'/'+id+'/'+version+'-'+saved.archive.sha256.slice(0,16))fail('扩展独立登记路径损坏；资料已保留','PLUGIN_SOURCE_STORAGE_INVALID');pluginCompatibility(saved.manifest,{appVersion,apiVersion});}}
 }
 validate();
 function allSources(){return {[OFFICIAL_SOURCE_ID]:defaultPluginSource(),...sourcesRecord.sources};}
 function source(sid,{available=false}={}){sourceId(sid);const row=allSources()[sid];if(!row)fail('扩展来源不存在','PLUGIN_SOURCE_NOT_FOUND');if(available&&(row.removed||!row.enabled))fail('扩展来源已停用或移除','PLUGIN_SOURCE_DISABLED');return row;}
 function sourceSummary(row){return {sourceId:row.sourceId,name:row.name,url:row.url??null,catalogUrl:row.catalogUrl??null,keyFingerprint:row.keyFingerprint??null,official:sourceIsOfficial(row.url,row),enabled:row.enabled!==false,removed:row.removed===true,cachedAt:row.cachedAt??null,lastError:row.lastError??null,packageCount:catalogs.get(row.sourceId)?.packages.length??0};}
 const legacySource=()=>({sourceId:LEGACY_SOURCE_ID,name:'旧版扩展登记',url:null,keyFingerprint:null,official:false,enabled:true,removed:false,cachedAt:null,lastError:null});
 function refs(id){const result=[],old=legacy.snapshot().installed??{};if(id==null){for(const[key,row]of Object.entries(old))result.push({id:key,sourceId:LEGACY_SOURCE_ID,row,legacy:true});for(const[key,row]of Object.entries(registry.packages))result.push({id:key,sourceId:row.sourceId,row});}else{if(old[id])result.push({id,sourceId:LEGACY_SOURCE_ID,row:old[id],legacy:true});if(registry.packages[id])result.push({id,sourceId:registry.packages[id].sourceId,row:registry.packages[id]});}return result;}
 function chosen(id,sid){pluginId(id);if(sid!=null)sourceId(sid);const values=refs(id).filter(row=>sid==null||row.sourceId===sid);if(values.length!==1)fail(values.length?'该扩展 ID 同时存在不同来源登记；请明确选择后清理':'扩展尚未安装',values.length?'PLUGIN_SOURCE_AMBIGUOUS':'PLUGIN_NOT_INSTALLED');return values[0];}
 function generation(sid){return Math.max(generations.get(sid)??0,allSources()[sid]?.generation??0);}
 function invalidate(sid){if(active?.sourceId===sid&&active.phase==='committing')fail('正在提交扩展，暂不能修改其来源','PLUGIN_BUSY');generations.set(sid,generation(sid)+1);for(const[id,plan]of plans)if(plan.sourceId===sid)plans.delete(id);if(active?.sourceId===sid)active.controller.abort(Object.assign(Error('扩展来源已改变，下载已取消'),{code:'PLUGIN_SOURCE_CHANGED'}));}
 function assertReady(){if(closed)fail('扩展服务已关闭','PLUGIN_CLOSED');if(!legacy.snapshot().service?.usable)fail('扩展服务尚未就绪','PLUGIN_SERVICE_NOT_READY');}
 function snapshot(){const base=legacy.snapshot(),installed={...base.installed};for(const[id,row]of Object.entries(registry.packages)){if(installed[id]){delete installed[id];continue;}installed[id]={...row};}for(const [id,row] of Object.entries(installed)){
  const sid=row.sourceId??LEGACY_SOURCE_ID;
  if(isVoicePackage(id))row.activation=activation(sid,row.versions[row.current].manifest,matchingRef(sid,id,row.current));
  row.versions=Object.fromEntries(Object.entries(row.versions).map(([version,saved])=>[version,{...saved,manifest:summaryManifest(saved.manifest),sourceId:sid}]));
 }return {...base,packages:(base.packages??[]).map(item=>({...item,manifest:summaryManifest(item.manifest)})),operation:active?{id:active.id,phase:active.phase,sourceId:active.sourceId,packageId:active.packageId,downloadedBytes:active.downloadedBytes,totalBytes:active.totalBytes}:base.operation,installed,sources:[...Object.values(allSources()).map(sourceSummary),...(Object.keys(base.installed??{}).length||base.packages?.length?[legacySource()]:[])],counts:{sources:Object.values(allSources()).filter(x=>!x.removed).length,installed:refs().length,available:[...catalogs.values()].reduce((sum,c)=>sum+c.packages.length,0)},ambiguousIds:[...new Set(refs().map(x=>x.id))].filter(id=>refs(id).length>1)};}
 function update(){try{onUpdate(snapshot());}catch{}}
 async function legacyResult(value){const result=await value;return result?.schemaVersion===1&&result.service&&result.installed?snapshot():result;}
 const delegate=(method,...args)=>legacyResult(legacy[method](...args));
 function under(path){const value=resolve(control,path),rel=relative(control,value);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))fail('扩展路径越界','PLUGIN_PATH_INVALID');return value;}
 const sourceDirectory=sid=>join(control,'sources',sourceId(sid));
 async function reload(){sourcesRecord=await json(sourceFile,{schemaVersion:1,sources:{}});registry=await json(registryFile,{schemaVersion:2,packages:{}});validate();}
 const persistSources=()=>writeAtomic(sourceFile,JSON.stringify(sourcesRecord));
 const persistRegistry=()=>writeAtomic(registryFile,JSON.stringify(registry));
 function checkWatermark(row,catalog){const prior=row.watermark;if(!prior)return;const before=Date.parse(prior.generatedAt),next=Date.parse(catalog.generatedAt);if(next<before)fail('来源目录时间早于已验证缓存','PLUGIN_CATALOG_ROLLBACK');if(next===before&&catalog.verified.payloadSha256!==prior.payloadSha256)fail('同一来源目录时间出现不同内容','PLUGIN_CATALOG_EQUIVOCATION');}
 async function saveCatalog(row,catalog,envelope){checkWatermark(row,catalog);const dir=sourceDirectory(row.sourceId);await assertPluginTreeNoLinks(dir);await mkdir(join(dir,'proofs'),{recursive:true});const encoded=typeof envelope==='string'?envelope:JSON.stringify(envelope);writeAtomic(join(dir,'proofs',catalog.verified.payloadSha256+'.json'),encoded);writeAtomic(join(dir,'catalog.json'),encoded);catalogs.set(row.sourceId,catalog);return {...row,catalogId:row.catalogId??catalog.id,cachedAt:new Date(now()).toISOString(),lastError:null,watermark:{generatedAt:catalog.generatedAt,payloadSha256:catalog.verified.payloadSha256}};}
 for(const row of Object.values(allSources()))try{const envelope=await json(join(sourceDirectory(row.sourceId),'catalog.json'),null);if(envelope){const catalog=verifyPluginCatalog(envelope,{trustedKeys:{[row.keyId]:row.publicKey}});checkWatermark(row,catalog);catalogs.set(row.sourceId,catalog);}}catch(error){sourcesRecord.sources[row.sourceId]={...row,lastError:{code:error.code??'PLUGIN_SOURCE_CACHE_INVALID',message:error.message}};}
 async function mutation(run){assertReady();return backend.mutation(async()=>{await reload();try{return await run();}catch(error){await reload();throw error;}});}
 async function preview(url){assertReady();for(const[id,row]of previews)if(row.expiresAt<=now())previews.delete(id);if(previews.size>=20)fail('待确认来源过多，请先完成或稍后重试','PLUGIN_SOURCE_PREVIEW_LIMIT');const controller=new AbortController();requests.add(controller);try{const value=await previewPluginSource(url,{fetchImpl:backend.fetchImpl,signal:controller.signal}),sameAddress=row=>pluginSourceUrlIdentity(row.url)===pluginSourceUrlIdentity(value.source.url)||pluginSourceUrlIdentity(row.catalogUrl)===pluginSourceUrlIdentity(value.source.catalogUrl),rows=Object.values(allSources()),existing=rows.find(row=>sameAddress(row)&&row.keyFingerprint===value.source.keyFingerprint),changed=rows.find(row=>sameAddress(row)&&row.keyFingerprint!==value.source.keyFingerprint),sid=value.source.official?OFFICIAL_SOURCE_ID:existing?.sourceId??randomUUID(),previewId=randomUUID(),expiresAt=now()+SOURCE_PREVIEW_TTL_MS;previews.set(previewId,{...value,sourceId:sid,expiresAt,descriptorHash:value.descriptorHash,catalogHash:value.catalog.verified.payloadSha256});return {previewId,expiresAt,source:{...value.source,sourceId:sid},keyChanged:!existing&&!!changed,previousFingerprint:!existing?changed?.keyFingerprint??null:null,packageCount:value.packageCount,signatureValid:true};}finally{requests.delete(controller);}}
 async function add({previewId,keyFingerprint}){
  assertReady();const value=previews.get(previewId);if(!value||value.expiresAt<=now())fail('来源预览已过期，请重新核对','PLUGIN_SOURCE_PREVIEW_EXPIRED');if(value.source.keyFingerprint!==keyFingerprint)fail('确认的公钥指纹不一致','PLUGIN_SOURCE_FINGERPRINT_MISMATCH');invalidate(value.sourceId);
  return mutation(async()=>{
   if(value.expiresAt<=now()||previews.get(previewId)!==value)fail('来源预览已过期，请重新核对','PLUGIN_SOURCE_PREVIEW_EXPIRED');
   const rows=allSources(),equivalent=Object.values(rows).find(row=>row.keyFingerprint===value.source.keyFingerprint&&(pluginSourceUrlIdentity(row.url)===pluginSourceUrlIdentity(value.source.url)||pluginSourceUrlIdentity(row.catalogUrl)===pluginSourceUrlIdentity(value.source.catalogUrl))),sid=equivalent?.sourceId??value.sourceId,prior=rows[sid];
   if((!prior||prior.removed)&&Object.values(rows).filter(x=>!x.removed).length>=MAX_PLUGIN_SOURCES)fail('最多添加 20 个扩展来源','PLUGIN_SOURCE_LIMIT');
   let row={...value.source,sourceId:sid,enabled:true,removed:false,generation:generation(sid),watermark:prior?.watermark??null};if(prior&&prior.keyFingerprint!==row.keyFingerprint)fail('现有来源公钥不能被覆盖','PLUGIN_SOURCE_KEY_CHANGED');
   row=await saveCatalog(row,value.catalog,value.envelope);sourcesRecord.sources[row.sourceId]=row;persistSources();previews.delete(previewId);update();return snapshot();
  });
 }
 async function changeSource(sid,patch){source(sid);invalidate(sid);return mutation(async()=>{const row=source(sid);sourcesRecord.sources[sid]={...row,...patch,generation:generation(sid)};persistSources();update();return snapshot();});}
 async function refreshOne(sid){
  const original=source(sid,{available:true}),revision=generation(sid),controller=new AbortController();requests.add(controller);
  try{const envelope=await fetchPluginJson(original.catalogUrl,{fetchImpl:backend.fetchImpl,signal:controller.signal,maximum:16*1024*1024+20000}),catalog=verifyPluginCatalog(envelope,{trustedKeys:{[original.keyId]:original.publicKey}});
   if(original.catalogId&&catalog.id!==original.catalogId)fail('来源目录身份发生变化','PLUGIN_SOURCE_CHANGED');
   if(generation(sid)!==revision)fail('来源在刷新期间发生变化','PLUGIN_SOURCE_CHANGED');checkWatermark(source(sid),catalog);
   // Invalidate before queuing for the write lock, so an uncommitted download
   // can release that lock. Committing transactions are explicitly too late.
   if(catalogs.get(sid)?.verified.payloadSha256!==catalog.verified.payloadSha256)invalidate(sid);
   const accepted=generation(sid);
   return await mutation(async()=>{const row=source(sid,{available:true});if(generation(sid)!==accepted||row.keyFingerprint!==original.keyFingerprint)fail('来源在刷新期间发生变化','PLUGIN_SOURCE_CHANGED');checkWatermark(row,catalog);sourcesRecord.sources[sid]=await saveCatalog({...row,generation:generation(sid)},catalog,envelope);persistSources();update();});
  }catch(error){if(closed)return;try{await mutation(async()=>{const row=source(sid);if(row.keyFingerprint!==original.keyFingerprint||generation(sid)!==revision&&error.code==='PLUGIN_SOURCE_CHANGED')return;sourcesRecord.sources[sid]={...row,lastError:{code:error.code??'PLUGIN_SOURCE_FETCH_FAILED',message:String(error.message).slice(0,2000)}};persistSources();update();});}catch{}}
  finally{requests.delete(controller);}
 }
 async function refresh(sid,{onlyInstalled=false}={}){assertReady();const requested=onlyInstalled?new Set(refs().filter(ref=>!ref.legacy).map(ref=>ref.sourceId)):null;const ids=sid?[source(sid,{available:true}).sourceId]:Object.values(allSources()).filter(x=>x.enabled&&!x.removed&&(!requested||requested.has(x.sourceId))).map(x=>x.sourceId);let cursor=0;await Promise.all(Array.from({length:Math.min(4,ids.length)},async()=>{while(cursor<ids.length)await refreshOne(ids[cursor++]);}));return snapshot();}
 function matchingRef(sid,id,version){return refs(id).find(row=>row.sourceId===sid&&row.row.versions[version]);}
 function activation(sid,manifest,ref){if(manifest.kind==='runtime')return {supported:false,usable:false,state:'dependency'};const voice=isVoicePackage(manifest.id),sourceRow=sid===LEGACY_SOURCE_ID?null:source(sid);const supported=voice?supportsVoiceManifest(manifest)&&isVoiceSourceAuthorized(sid,sourceRow?.keyFingerprint,voiceTestFingerprint):manifest.kind==='plugin'&&manifest.id==='ai-buddy.kimi-engine'&&manifest.activationEvents.includes('onHarness:kimi')&&manifest.capabilities.includes('harness.register');if(voice&&(sourceRow?.removed||sourceRow?.enabled===false))return {supported:false,usable:false,state:'source-disabled'};if(!supported)return {supported:false,usable:false,state:'unsupported',reason:'当前主程序尚无此扩展的激活入口'};if(ref&&refs(manifest.id).length!==1)return {supported:true,usable:false,state:'unsupported',reason:'存在不同来源的重复登记，请先明确清理'};if(!ref||ref.row.current!==manifest.version)return {supported:true,usable:false,state:'not-installed'};if(!ref.row.enabled)return {supported:true,usable:false,state:'disabled'};if(sid!==LEGACY_SOURCE_ID&&!verified.has(verificationKey(sid,ref.row.versions[manifest.version])))return {supported:true,usable:false,state:'disabled',reason:'本地扩展文件未通过来源与哈希校验'};for(const[id,range]of Object.entries(manifest.dependencies)){const dep=refs(id).find(row=>row.sourceId===sid);if(!dep||!satisfiesVersionRange(dep.row.current,range)||refs(id).length!==1||sid!==LEGACY_SOURCE_ID&&!verified.has(verificationKey(sid,dep.row.versions[dep.row.current])))return {supported:true,usable:false,state:'missing-dependency'};}return {supported:true,usable:true,state:'ready'};}
 function itemFor(sid,item,{full=false,sourceRow=null}={}){const ref=matchingRef(sid,item.manifest.id,item.manifest.version),row=sourceRow??(sid===LEGACY_SOURCE_ID?legacySource():sourceSummary(source(sid))),manifest=full?clone(item.manifest):summaryManifest(item.manifest);return {sourceId:sid,source:clone(row),manifest,archive:clone(item.archive),installed:!!ref,current:ref?.row.current===item.manifest.version,enabled:ref?.row.enabled??false,previous:ref?.row.previous??null,...pluginCompatibility(item.manifest,{appVersion,apiVersion}),activation:activation(sid,item.manifest,ref)};}
 function legacyItems(){const snapshot=legacy.snapshot(),values=new Map();for(const item of snapshot.packages??[])values.set(item.manifest.id+'@'+item.manifest.version,item);for(const row of Object.values(snapshot.installed??{}))for(const saved of Object.values(row.versions))values.set(saved.manifest.id+'@'+saved.manifest.version,saved);return [...values.values()];}
 function search({query='',sourceId:sid,kind='all',page=1,pageSize=50}={}){if(sid!=null)sourceId(sid);if(!['all','installed','plugin','runtime','asset'].includes(kind))fail('扩展分类无效','PLUGIN_SEARCH_INVALID');const needle=String(query).trim().toLocaleLowerCase(),values=new Map();
  if(sid==null||sid===LEGACY_SOURCE_ID)for(const item of legacyItems())values.set(LEGACY_SOURCE_ID+':'+item.manifest.id+'@'+item.manifest.version,itemFor(LEGACY_SOURCE_ID,item));
  for(const row of Object.values(allSources()))if((sid==null||sid===row.sourceId)&&row.enabled&&!row.removed)for(const item of catalogs.get(row.sourceId)?.packages??[])values.set(row.sourceId+':'+item.manifest.id+'@'+item.manifest.version,itemFor(row.sourceId,item));
  if(kind==='installed')for(const ref of refs())if(sid==null||sid===ref.sourceId)for(const saved of Object.values(ref.row.versions))values.set(ref.sourceId+':'+ref.id+'@'+saved.manifest.version,itemFor(ref.sourceId,saved));
  const filtered=[...values.values()].filter(item=>(kind==='all'||kind==='installed'&&item.installed||item.manifest.kind===kind)&&(!needle||[item.manifest.id,item.manifest.name,item.manifest.description,item.manifest.author,...(item.manifest.tags??[])].join(' ').toLocaleLowerCase().includes(needle))).sort((a,b)=>a.manifest.name.localeCompare(b.manifest.name)||a.sourceId.localeCompare(b.sourceId)||a.manifest.version.localeCompare(b.manifest.version));page=Math.max(1,Math.floor(Number(page)||1));pageSize=Math.min(50,Math.max(1,Math.floor(Number(pageSize)||50)));return {items:filtered.slice((page-1)*pageSize,page*pageSize),total:filtered.length,page,pageSize};}
 function details({sourceId:sid,id,version}){sourceId(sid);pluginId(id);parsePluginVersion(version);let item;if(sid===LEGACY_SOURCE_ID)item=legacyItems().find(x=>x.manifest.id===id&&x.manifest.version===version);else item=catalogs.get(sid)?.packages.find(x=>x.manifest.id===id&&x.manifest.version===version)??(registry.packages[id]?.sourceId===sid?registry.packages[id]?.versions[version]:null);if(!item)fail('扩展版本不存在','PLUGIN_NOT_FOUND');return itemFor(sid,item,{full:true});}
 function checkSourceConflict(id,sid){for(const installed of refs(id))if(installed.sourceId!==sid)fail('该扩展已由其他来源安装，请先明确卸载；原数据会保留','PLUGIN_SOURCE_CONFLICT');}
 backend.setPackageGuard(async packages=>{await reload();for(const item of packages)checkSourceConflict(item.manifest.id,LEGACY_SOURCE_ID);});
 function schemaFor(value){if(value&&(value.schemaVersion!==1||!Number.isSafeInteger(value.dataSchemaVersion)||value.dataSchemaVersion<1))fail('扩展资料版本记录无效；资料已保留','PLUGIN_DATA_SCHEMA_INVALID');return value;}
 async function inUse(id,sid){function depends(candidate,target,seen=new Set()){if(candidate===target)return true;if(seen.has(candidate))return false;seen.add(candidate);const ref=refs(candidate).find(x=>x.sourceId===sid),saved=ref?.row.versions[ref.row.current];return !!saved&&Object.keys(saved.manifest.dependencies).some(dep=>depends(dep,target,seen));}for(const ref of refs())if(ref.sourceId===sid&&depends(ref.id,id)&&(await backend.busy(ref.id)||backend.host?.isActive?.(ref.id)))return true;return false;}
 async function plan(sid,requestsValue){assertReady();const row=source(sid,{available:true}),catalog=catalogs.get(sid);if(!catalog)fail('来源尚无已验证目录，请先刷新','PLUGIN_SOURCE_NOT_CACHED');const installed=[];for(const[id,value]of Object.entries(registry.packages))if(value.sourceId===sid)for(const[version,item]of Object.entries(value.versions))try{await verifySaved(item,sid);installed.push({id,version,sha256:item.archive.sha256});}catch{}const value=resolvePluginInstallPlan(catalog,requestsValue,{installed,appVersion,apiVersion});for(const item of value.packages)checkSourceConflict(item.manifest.id,sid);const planId=hash({sourceId:sid,key:row.keyFingerprint,catalog:value.catalogSha256,generation:generation(sid),plan:value});const result={...value,planId,sourceId:sid,keyFingerprint:row.keyFingerprint,generation:generation(sid),catalogSha256:catalog.verified.payloadSha256};plans.set(planId,result);return clone(result);}
 function checkPlan(value){const row=source(value.sourceId,{available:true});if(generation(value.sourceId)!==value.generation||row.keyFingerprint!==value.keyFingerprint||catalogs.get(value.sourceId)?.verified.payloadSha256!==value.catalogSha256)fail('来源或目录已改变，请重新核对安装计划','PLUGIN_SOURCE_CHANGED');for(const item of value.packages)checkSourceConflict(item.manifest.id,value.sourceId);return row;}
 function updateCandidates(automatic = false) {
  const base = legacy.snapshot(), rows = [], errors = [];
  const installed = refs(), seen = new Set(), ambiguousIds = new Set();
  for (const ref of installed) { if (seen.has(ref.id)) ambiguousIds.add(ref.id); else seen.add(ref.id); }
  for (const ref of installed) {
   if (ambiguousIds.has(ref.id)) continue;
   const prior = ref.row.versions[ref.row.current], origin = ref.legacy ? null : source(ref.sourceId), catalog = catalogs.get(ref.sourceId);
   const items = ref.legacy ? base.packages ?? [] : catalog?.packages ?? [];
   const schema = ref.row.dataSchemaVersion ?? prior.manifest.dataSchemaVersion;
   const incompatibleSchema = manifest => manifest.dataSchemaVersion !== schema || !manifest.compatibleDataVersions.includes(schema);
   const candidates = items.filter(({manifest}) => manifest.id === ref.id && (!automatic ||
     stablePatchUpdate(ref.row.current, manifest.version) && !incompatibleSchema(manifest) &&
     manifest.capabilities.every(value => prior.manifest.capabilities.includes(value))));
   const selected = selectStableUpdate(candidates, ref.row.current,
     item => pluginCompatibility(item.manifest, {appVersion, apiVersion}).compatible, item => item.manifest.version);
   const error = ref.legacy ? base.catalogError && {code: 'PLUGIN_SOURCE_FETCH_FAILED', message: base.catalogError} : origin.lastError;
   if (error && !errors.some(value => value.sourceId === ref.sourceId)) errors.push({sourceId: ref.sourceId, error});
   if (!selected) continue;
   const {target, compatible} = selected;
   const addedCapabilities = target.manifest.capabilities.filter(value => !prior.manifest.capabilities.includes(value));
   const incompatibleData = incompatibleSchema(target.manifest);
   const changed = !ref.legacy && prior.sourceProof?.keyFingerprint !== origin.keyFingerprint;
   const available = compatible && !error && !changed && (ref.legacy || (origin.enabled && !origin.removed));
   rows.push({backend: 'buddy-v1', id: ref.id, sourceId: ref.sourceId, packageName: target.manifest.name, packageKey: legacyUpdateKey(ref.sourceId, ref.id),
     from: ref.row.current, to: target.manifest.version, digest: target.archive.sha256, addedCapabilities, incompatibleData, bytes: target.archive.bytes,
     state: !available ? 'unavailable' : addedCapabilities.length || incompatibleData ? 'needs-user' : 'available',
     changes: target.releaseNotes ? [{version: target.manifest.version, notes: target.releaseNotes}] : [],
     ...(!available ? {error: error ?? (changed ? {code: 'PLUGIN_SOURCE_CHANGED', message: 'Installed publisher identity changed'} :
      !compatible ? {code: 'PLUGIN_INCOMPATIBLE', message: 'Update requires a compatible app, API or platform'} : {code: 'PLUGIN_SOURCE_DISABLED', message: 'Plugin source is disabled or removed'})} : {})});
  }
  return {updates: rows, errors};
 }
 async function refreshUpdateSources() {
  await refresh(null, {onlyInstalled: true});
  if (refs().some(ref => ref.legacy)) await legacy.refreshCatalog();
 }
 function exactUpdate(request, mode) {
  const row = updateCandidates(mode === 'auto').updates.find(value => value.packageKey === request.packageKey && value.id === request.id &&
    value.sourceId === request.sourceId && value.from === request.from && value.to === request.to && value.digest === request.digest);
  if (!row || row.state === 'unavailable' || row.incompatibleData) fail('Plugin update changed or is unavailable; check updates again', 'PLUGIN_UPDATE_CHANGED');
  return row;
 }
 async function updateApproval(plan) {
  const {expected, mode, selected} = plan, row = exactUpdate(expected, mode);
  const ref = chosen(row.id, row.sourceId), prior = ref.row.versions[row.from];
  if (ref.row.enabled !== plan.enabled || prior.archive.sha256 !== plan.fromDigest || (ref.legacy ? backend.catalogDigest() : catalogs.get(row.sourceId)?.verified.payloadSha256) !== selected.catalogSha256)
   fail('Installed plugin or signed catalog changed after review', 'PLUGIN_UPDATE_CHANGED');
  if (mode === 'auto') {
   const preferences = join(dataRoot, 'community', 'preferences-v1.json');
   await assertPluginTreeNoLinks(preferences);
   const prefs = await json(preferences, {});
   if (prefs.updatePolicies?.[row.packageKey] !== 'auto') fail('Automatic updates were turned off; review this update manually', 'PLUGIN_AUTO_UPDATE_DISABLED');
  }
 }
 async function planUpdate(request) {
  const mode = request.mode;
  if (!['review', 'manual', 'auto'].includes(mode)) fail('Invalid plugin update mode', 'PLUGIN_UPDATE_CHANGED');
  const row = exactUpdate(request, mode), ref = chosen(row.id, row.sourceId);
  if (mode === 'auto' && await inUse(row.id, row.sourceId)) fail('Extension is in use; waiting for an idle update slot', 'PLUGIN_BUSY');
  const choices = [{id: row.id, version: row.to}], prior = ref.row.versions[row.from];
  if (ref.legacy) await backend.assertCatalogPublisher(prior);
  const selected = ref.legacy ? await legacy.plan(choices) : await plan(row.sourceId, choices);
  const rootItem = selected.packages.find(value => value.manifest.id === row.id);
  if (!rootItem || rootItem.archive.sha256 !== row.digest) fail('Signed plugin update digest changed', 'PLUGIN_UPDATE_CHANGED');
  const dependencyChanges = selected.packages.filter(value => value !== rootItem).flatMap(item => {
   const prior = refs(item.manifest.id).find(record => record.sourceId === row.sourceId)?.row;
   return prior?.current === item.manifest.version && prior.versions[prior.current]?.archive.sha256 === item.archive.sha256 ? [] :
    [{id: item.manifest.id, from: prior?.current ?? null, to: item.manifest.version}];
  });
  const requiresReview = row.addedCapabilities.length > 0 || dependencyChanges.length > 0 || mode === 'auto' && !stablePatchUpdate(row.from, row.to);
  const planId = randomUUID(), pin = {expected: row, mode, selected, enabled: ref.row.enabled, fromDigest: prior.archive.sha256, requiresReview};
  if (mode !== 'auto' || !requiresReview) await updateApproval(pin);
  updatePlans.set(planId, pin); while (updatePlans.size > 64) updatePlans.delete(updatePlans.keys().next().value);
  return {planId, packageKey: row.packageKey, from: row.from, to: row.to, downloadBytes: selected.downloadBytes, unpackedBytes: selected.unpackedBytes, addedCapabilities: row.addedCapabilities, dependencyChanges, requiresReview};
 }
 async function installUpdate(request) {
  const pin = updatePlans.get(request.planId);
  if (!pin || (request.packageKey !== undefined && request.packageKey !== pin.expected.packageKey) || (request.digest !== undefined && request.digest !== pin.expected.digest))
   fail('Plugin update confirmation expired', 'PLUGIN_UPDATE_CHANGED');
  if (pin.requiresReview && pin.mode !== 'review') fail('Plugin update must be explicitly reviewed', 'PLUGIN_UPDATE_REVIEW_REQUIRED');
  updatePlans.delete(request.planId);
  const check = () => updateApproval(pin);
  await check();
  return pin.expected.sourceId === LEGACY_SOURCE_ID ? legacyResult(legacy.install({planId: pin.selected.planId, updateCheck: check})) : install(pin.selected.planId, check);
 }
 async function verifySaved(saved,sid){const key=verificationKey(sid,saved);verified.delete(key);const origin=saved.sourceProof,pinned=source(sid);if(!origin||origin.sourceId!==sid||origin.keyFingerprint!==pluginSourceFingerprint(origin.publicKey)||origin.keyFingerprint!==pinned.keyFingerprint)fail('扩展安装来源证明无效','PLUGIN_SOURCE_PROOF_INVALID');if(!/^[a-f0-9]{64}$/.test(origin.catalogSha256??''))fail('扩展目录证明哈希无效','PLUGIN_SOURCE_PROOF_INVALID');const proof=join(sourceDirectory(sid),'proofs',origin.catalogSha256+'.json');await assertPluginTreeNoLinks(proof);const envelope=await json(proof,null),catalog=verifyPluginCatalog(envelope,{trustedKeys:{[origin.keyId]:origin.publicKey}});if(catalog.verified.payloadSha256!==origin.catalogSha256||!catalog.packages.some(item=>canonicalPluginJson(item.manifest)===canonicalPluginJson(saved.manifest)&&canonicalPluginJson(item.archive)===canonicalPluginJson(saved.archive)))fail('扩展文件与原来源签名不一致','PLUGIN_SOURCE_PROOF_INVALID');if(!saved.directory.startsWith('packages/'+sid+'/'+saved.manifest.id+'/'))fail('扩展代码目录与来源不符','PLUGIN_SOURCE_PROOF_INVALID');await verifyInstalledPlugin(under(saved.directory),saved.manifest);verified.add(key);return saved;}
 async function download(item,signal){
  const complete=join(control,'cache',item.archive.sha256+'.zip'),partial=complete+'.partial';let offset=0;
  try{const bytes=await readFile(complete);if(bytes.length===item.archive.bytes&&hash(bytes)===item.archive.sha256)return bytes;}catch(error){if(error.code!=='ENOENT')throw error;}
  try{offset=(await stat(partial)).size;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(offset>item.archive.bytes){await rm(partial);offset=0;}
  if(offset===item.archive.bytes){const bytes=await readFile(partial);if(hash(bytes)===item.archive.sha256){await rename(partial,complete);return bytes;}await rm(partial);offset=0;}
  const response=await backend.fetchImpl(item.archive.url,{headers:offset?{Range:'bytes='+offset+'-'}:{},signal});
  if(response.status===206){const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')??'');if(!range||Number(range[1])!==offset||Number(range[2])!==item.archive.bytes-1||Number(range[3])!==item.archive.bytes){await response.body?.cancel().catch(()=>{});fail('扩展断点续传范围无效','PLUGIN_DOWNLOAD_INVALID');}}
  else if(response.status===200)offset=0;else{await response.body?.cancel().catch(()=>{});fail('扩展下载失败：HTTP '+response.status,'PLUGIN_DOWNLOAD_FAILED');}
  const{open}=await import('node:fs/promises'),file=await open(partial,offset?'a':'w');let count=offset;
  try{for await(const chunk of response.body){if(signal.aborted)throw signal.reason;count+=chunk.length;if(count>item.archive.bytes)fail('扩展下载超过签名长度','PLUGIN_DOWNLOAD_INVALID');await file.write(chunk);if(active){active.downloadedBytes=count;update();}}await file.sync();}finally{await file.close();}
  const bytes=await readFile(partial);if(count!==item.archive.bytes||hash(bytes)!==item.archive.sha256){if(count===item.archive.bytes)await rm(partial,{force:true});fail('扩展下载校验失败','PLUGIN_DOWNLOAD_INVALID');}
  await rename(partial,complete);return bytes;
 }
 async function install(planId,updateCheck){const selected=plans.get(planId);if(!selected)fail('安装计划已过期，请重新核对','PLUGIN_PLAN_EXPIRED');checkPlan(selected);return mutation(async()=>{const origin=checkPlan(selected),id=randomUUID(),stage=join(control,'staging',id),journal=join(control,'transactions',id+'.json'),controller=new AbortController();active={id,phase:'preparing',sourceId:selected.sourceId,controller};update();const next=clone(registry),prepared=[];try{
  if(updateCheck)await updateCheck();
  if(await backend.availableBytes(control)<selected.downloadBytes+selected.unpackedBytes+16*1024*1024)fail('安装扩展的可用磁盘空间不足','PLUGIN_DISK_SPACE');await mkdir(stage,{recursive:true});writeAtomic(journal,JSON.stringify({id,phase:'preparing',stage:'staging/'+id,planId,sourceId:selected.sourceId}));
  for(const item of selected.packages){if(controller.signal.aborted)throw controller.signal.reason;active.packageId=item.manifest.id;active.totalBytes=item.archive.bytes;const prior=next.packages[item.manifest.id],saved=prior?.versions[item.manifest.version],dataDir=join(dataRoot,'plugins',selected.sourceId,item.manifest.id),schema=schemaFor(await json(join(dataDir,'.schema.json'),null)),schemaVersion=schema?.dataSchemaVersion??prior?.dataSchemaVersion??item.manifest.dataSchemaVersion;if(item.manifest.dataSchemaVersion!==schemaVersion||!item.manifest.compatibleDataVersions.includes(schemaVersion))fail('扩展资料版本需要明确迁移；代码未切换','PLUGIN_DATA_MIGRATION_REQUIRED');if(saved&&saved.archive.sha256!==item.archive.sha256)fail('已发布的同一来源版本不能替换内容','PLUGIN_VERSION_CHANGED');if(item.reuse&&saved){await verifySaved(saved,selected.sourceId);prepared.push({item,saved});continue;}active.phase='downloading';update();const bytes=await download(item,controller.signal),inspected=inspectPluginArchive(bytes,item.manifest);if(await backend.availableBytes(control)<inspected.unpackedBytes+4*1024*1024)fail('解压扩展的可用磁盘空间不足','PLUGIN_DISK_SPACE');active.phase='extracting';update();const staged=join(stage,item.manifest.id);await extractPluginArchive(bytes,staged,item.manifest,{signal:controller.signal});prepared.push({item,staged,saved:{manifest:item.manifest,archive:item.archive,directory:'packages/'+selected.sourceId+'/'+item.manifest.id+'/'+item.manifest.version+'-'+item.archive.sha256.slice(0,16),sourceProof:{sourceId:selected.sourceId,url:origin.url,keyId:origin.keyId,publicKey:origin.publicKey,keyFingerprint:origin.keyFingerprint,catalogSha256:selected.catalogSha256},installedAt:new Date(now()).toISOString()}});}
  checkPlan(selected);if(controller.signal.aborted)throw controller.signal.reason;for(const {item}of prepared)if(await inUse(item.manifest.id,selected.sourceId))fail('扩展正在使用，请先停止对应工作任务','PLUGIN_BUSY');
  const projected=clone(next.packages);for(const {item,saved}of prepared){const prior=projected[item.manifest.id];projected[item.manifest.id]={...prior,sourceId:selected.sourceId,current:item.manifest.version,versions:{...prior?.versions,[item.manifest.version]:saved}};}for(const row of Object.values(projected))for(const[dep,range]of Object.entries(row.versions[row.current].manifest.dependencies)){const selected=projected[dep];if(!selected||selected.sourceId!==row.sourceId||!satisfiesVersionRange(selected.current,range))fail('安装会破坏现有扩展的同源依赖','PLUGIN_DEPENDENCY_ERROR');}
  if(updateCheck)await updateCheck();checkPlan(selected);if(controller.signal.aborted)throw controller.signal.reason;
  active.phase='committing';update();writeAtomic(journal,JSON.stringify({id,phase:'prepared',stage:'staging/'+id,planId,sourceId:selected.sourceId}));
  for(const {item,staged,saved}of prepared){const target=under(saved.directory);if(staged){await mkdir(resolve(target,'..'),{recursive:true});await assertPluginTreeNoLinks(target);try{await stat(target);await verifyInstalledPlugin(target,item.manifest);}catch(error){if(error.code!=='ENOENT')throw error;await rename(staged,target);}}const prior=next.packages[item.manifest.id];next.packages[item.manifest.id]={sourceId:selected.sourceId,current:item.manifest.version,previous:prior?.current&&prior.current!==item.manifest.version?prior.current:prior?.previous??null,enabled:prior?.enabled??false,versions:{...prior?.versions,[item.manifest.version]:saved},dataSchemaVersion:prior?.dataSchemaVersion??item.manifest.dataSchemaVersion};const dataDir=join(dataRoot,'plugins',selected.sourceId,item.manifest.id);await assertPluginTreeNoLinks(dataDir);await mkdir(dataDir,{recursive:true});if(!await json(join(dataDir,'.schema.json'),null))writeAtomic(join(dataDir,'.schema.json'),JSON.stringify({schemaVersion:1,dataSchemaVersion:next.packages[item.manifest.id].dataSchemaVersion}));}
  registry=next;persistRegistry();for(const{saved}of prepared)verified.add(verificationKey(selected.sourceId,saved));plans.delete(planId);await rm(journal,{force:true});return snapshot();
 }catch(error){writeAtomic(journal,JSON.stringify({id,phase:'failed',stage:'staging/'+id,planId,sourceId:selected.sourceId,error:error.message}));throw error;}finally{await assertPluginTreeNoLinks(stage);await rm(stage,{recursive:true,force:true});active=null;update();}});}
 async function resolveInstalled(id,opts={}){
  const ref=chosen(id,opts.sourceId);if(refs(id).length!==1)fail('该扩展 ID 同时存在不同来源登记；请明确选择后清理','PLUGIN_SOURCE_AMBIGUOUS');
  if(ref.legacy)return {...await legacy.resolveInstalled(id,opts),sourceId:LEGACY_SOURCE_ID,sourceProof:{sourceId:LEGACY_SOURCE_ID,legacyVerified:true}};
  assertReady();if(isVoicePackage(id))source(ref.sourceId,{available:true});const saved=ref.row.versions[ref.row.current];if(opts.requireEnabled!==false&&!ref.row.enabled)fail('扩展尚未启用','PLUGIN_DISABLED');
  if(!pluginCompatibility(saved.manifest,{appVersion,apiVersion}).compatible)fail('扩展与当前程序或接口不兼容','PLUGIN_INCOMPATIBLE');
  try{for(const[dep,range]of Object.entries(saved.manifest.dependencies)){if(refs(dep).length!==1)fail('同源运行依赖存在重复登记','PLUGIN_SOURCE_AMBIGUOUS');const selected=chosen(dep,ref.sourceId),dependency=selected.row.versions[selected.row.current];if(!satisfiesVersionRange(selected.row.current,range)||!pluginCompatibility(dependency.manifest,{appVersion,apiVersion}).compatible)fail('同源运行依赖缺失或不兼容','PLUGIN_DEPENDENCY_ERROR');await verifySaved(dependency,ref.sourceId);}
   await verifySaved(saved,ref.sourceId);const directory=join(dataRoot,'plugins',ref.sourceId,id),schema=schemaFor(await json(join(directory,'.schema.json'),null));if(schema&&!saved.manifest.compatibleDataVersions.includes(schema.dataSchemaVersion))fail('扩展不能读取当前资料版本','PLUGIN_DATA_MIGRATION_REQUIRED');
   assertReady();return {manifest:saved.manifest,directory:under(saved.directory),dataDirectory:directory,version:saved.manifest.version,archiveSha256:saved.archive.sha256,sourceId:ref.sourceId,sourceProof:clone(saved.sourceProof)};
  }catch(error){update();throw error;}
 }
 async function installedAction(type,id,sid){const ref=chosen(id,sid);if(ref.legacy)return delegate('action',{action:type,id});return mutation(async()=>{const current=chosen(id,ref.sourceId),row=current.row,saved=row.versions[row.current];if(type==='enable'){if(!activation(ref.sourceId,saved.manifest,ref).supported)fail('当前主程序尚无此扩展的激活入口','PLUGIN_ACTIVATION_UNSUPPORTED');await resolveInstalled(id,{sourceId:ref.sourceId,requireEnabled:false});row.enabled=true;}
  else if(type==='disable'){if(await inUse(id,ref.sourceId))fail('扩展正在使用，请先停止工作任务','PLUGIN_BUSY');await backend.host?.stop?.(id);row.enabled=false;}
  else if(type==='rollback'){if(!row.previous||!row.versions[row.previous])fail('没有可回退的同源版本','PLUGIN_NO_ROLLBACK');if(await inUse(id,ref.sourceId))fail('扩展正在使用','PLUGIN_BUSY');const previous=row.versions[row.previous];await verifySaved(previous,ref.sourceId);if(!pluginCompatibility(previous.manifest,{appVersion,apiVersion}).compatible)fail('旧版本与当前程序或接口不兼容','PLUGIN_INCOMPATIBLE');const schema=schemaFor(await json(join(dataRoot,'plugins',ref.sourceId,id,'.schema.json'),null));if(!previous.manifest.compatibleDataVersions.includes(schema?.dataSchemaVersion??row.dataSchemaVersion))fail('旧代码不能读取当前资料版本','PLUGIN_DATA_MIGRATION_REQUIRED');for(const[dep,range]of Object.entries(previous.manifest.dependencies)){if(refs(dep).length!==1)fail('同源运行依赖存在重复登记','PLUGIN_SOURCE_AMBIGUOUS');const selected=chosen(dep,ref.sourceId);if(!satisfiesVersionRange(selected.row.current,range))fail('旧版本依赖不兼容','PLUGIN_DEPENDENCY_ERROR');await verifySaved(selected.row.versions[selected.row.current],ref.sourceId);}const projected=clone(registry.packages);const target=projected[id];target.previous=row.current;target.current=row.previous;for(const entry of Object.values(projected))for(const[dep,range]of Object.entries(entry.versions[entry.current].manifest.dependencies)){const selected=projected[dep];if(!selected||selected.sourceId!==entry.sourceId||!satisfiesVersionRange(selected.current,range))fail('Rollback would invalidate an installed same-source dependency','PLUGIN_DEPENDENCY_ERROR');}registry.packages=projected;}
  else if(type==='uninstall'){for(const other of refs())if(other.id!==id&&Object.hasOwn(other.row.versions[other.row.current].manifest.dependencies,id))fail('其他已安装扩展依赖此包','PLUGIN_DEPENDENCY_ERROR');if(await backend.busy(id))fail('扩展正在使用','PLUGIN_BUSY');await backend.host?.stop?.(id);delete registry.packages[id];persistRegistry();for(const saved of Object.values(row.versions)){const path=under(saved.directory);await assertPluginTreeNoLinks(path);await rm(path,{recursive:true,force:true});}update();return snapshot();}
  persistRegistry();update();return snapshot();});}
 function cancel(){if(active?.phase==='committing')return false;if(active){active.controller.abort(Object.assign(Error('扩展下载已取消'),{code:'PLUGIN_CANCELLED'}));return true;}return legacy.cancel();}
 async function action(request={}){const {action:type,sourceId:sid,id}=request;if(type==='status')return snapshot();if(type==='update-candidates'){if(request.refresh===true)await refreshUpdateSources();const candidates=updateCandidates();return request.includeAutomatic===true?{...candidates,automaticUpdates:updateCandidates(true).updates}:candidates;}if(type==='plan-update')return planUpdate(request);if(type==='install-update')return installUpdate(request);if(type==='cancel')return cancel();if(type==='sources-list')return {sources:snapshot().sources};if(type==='sources-preview')return preview(request.url);if(type==='sources-add')return add(request);if(type==='sources-refresh')return refresh(sid);if(type==='sources-disable'){if(typeof request.disabled!=='boolean')fail('停用来源必须明确传入布尔值','PLUGIN_SOURCE_INVALID');return changeSource(sid,{enabled:!request.disabled});}if(type==='sources-remove')return changeSource(sid,{enabled:false,removed:true});if(type==='search')return search(request);if(type==='details')return details(request);if(type==='plan'&&sid!=null&&sid!==LEGACY_SOURCE_ID)return plan(sid,request.requests);if(type==='install'&&plans.has(request.planId))return install(request.planId);if(['enable','disable','rollback','uninstall'].includes(type)){const ref=chosen(id,sid);return installedAction(type,id,ref.sourceId);}return delegate('action',request);}
 function resolveTrustedSource(sid){assertReady();const row=source(sid);return clone({sourceId:row.sourceId,descriptorId:row.descriptorId??row.id,keyId:row.keyId,publicKey:row.publicKey,keyFingerprint:row.keyFingerprint,url:row.url,catalogUrl:row.catalogUrl,enabled:row.enabled!==false,removed:row.removed===true,generation:generation(sid)});}
 async function close(){if(closed)return;closed=true;for(const controller of requests)controller.abort();active?.controller.abort();previews.clear();plans.clear();updatePlans.clear();await legacy.close();}
 // Read-only proof validation does not acquire or create the installer lock.
 for(const row of Object.values(registry.packages))for(const saved of Object.values(row.versions))try{await verifySaved(saved,row.sourceId);}catch{}
 return {snapshot,action,resolveInstalled,resolveTrustedSource,close,loadCatalog:value=>delegate('loadCatalog',value),refreshCatalog:()=>delegate('refreshCatalog'),plan:legacy.plan,install:value=>plans.has(value?.planId)?install(value.planId):delegate('install',value),enable:id=>installedAction('enable',id),disable:id=>installedAction('disable',id),rollback:id=>installedAction('rollback',id),uninstall:id=>installedAction('uninstall',id),activate:legacy.activate,importOffline:value=>delegate('importOffline',value),prepareOffline:(...args)=>delegate('prepareOffline',...args),installOffline:value=>delegate('installOffline',value),cancel};
}
