import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,createWriteStream,existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,realpathSync,lstatSync} from 'node:fs';
import {lstat,readdir,realpath,readFile,statfs,mkdir} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep,dirname,basename} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {createInterface} from 'node:readline';
import {spawn} from 'node:child_process';
import {createSnapshotStorage} from './storage.mjs';
import {writeAtomic} from './atomic-write.mjs';
import {registeredDataPath,normalizedPipe} from './installation-record.mjs';
import {requestLocalControl} from './local-control.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=p=>JSON.parse(readFileSync(p,'utf8'));
const excluded=new Set(['chromium','crash-reports']);
const temporary=new Set(['work-tokens.json.tmp','data-import.lock','runtime-instance.lock']);
const under=(root,path)=>{const p=resolve(root,path);if(!p.startsWith(resolve(root)+sep))throw Error('导入路径越界');return p;};
const canonical=path=>{try{return realpathSync.native(resolve(path)).toLowerCase();}catch{return resolve(path).toLowerCase();}};
function noLinks(path){for(let p=resolve(path);;p=dirname(p)){if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw Error('导入目标包含链接，不能写入：'+p);if(dirname(p)===p)break;}return path;}
const aborted=()=>Object.assign(Error('导入已取消；当前资料保持不变'),{name:'AbortError'});
export const IMPORT_GUARD='import-work-paused.json';

export async function fileSha(path,signal){const hash=createHash('sha256');for await(const chunk of createReadStream(path)){if(signal?.aborted)throw aborted();hash.update(chunk);}return hash.digest('hex');}
export function fileIndexSha(files){return digest(files.map(f=>f.path+'\t'+f.bytes+'\t'+f.sha256+'\n').join(''));}
export async function importInventory(root,{signal,onFile=()=>{}}={}){
 root=await realpath(root);const files=[],exclusions=[],stack=[{path:root,prefix:''}];
 while(stack.length){if(signal?.aborted)throw aborted();const dir=stack.pop();
  for(const entry of await readdir(dir.path,{withFileTypes:true})){
   const path=join(dir.path,entry.name),rel=dir.prefix+entry.name;
   if(!dir.prefix&&(excluded.has(entry.name)||temporary.has(entry.name))){exclusions.push(rel);continue;}
   const info=await lstat(path);if(info.isSymbolicLink())throw Error('存档内包含链接，不能安全复制：'+rel);
   if(info.isDirectory())stack.push({path,prefix:rel+'/'});
   else if(info.isFile()){
    if(!Number.isSafeInteger(info.size))throw Error('存档文件过大：'+rel);
    const hash=await fileSha(path,signal),after=await lstat(path);
    if(info.size!==after.size||info.mtimeMs!==after.mtimeMs||info.ino!==after.ino)throw Error('来源存档正在变化，请退出旧版后重新预览：'+rel);
    const row={path:rel,bytes:info.size,sha256:hash};files.push(row);onFile(row);
   }else throw Error('存档包含不支持的文件类型：'+rel);
  }
 }
 files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 return {files,exclusions,bytes:files.reduce((n,f)=>n+f.bytes,0),sha256:fileIndexSha(files)};
}

// Inspection never opens a game, publishes a snapshot, or runs retention.
export async function inspectSnapshot(path){
 const journal=path+'.snapshots/commits.jsonl';
 if(!existsSync(journal)){if(!existsSync(path))return null;const s=await lstat(path);if(s.isSymbolicLink()||!s.isFile())throw Error('存档记录不可读取：'+path);return JSON.parse(await readFile(path,'utf8'));}
 for(const limit of [64,1024,16384]){
  const candidates=[];const lines=createInterface({input:createReadStream(journal),crlfDelay:Infinity});
  for await(const line of lines){try{const row=JSON.parse(line);if(typeof row.file==='string'&&basename(row.file)===row.file&&/^[a-f0-9]{64}$/i.test(row.sha256)){candidates.push(row);if(candidates.length>limit)candidates.shift();}}catch{}}
  for(const row of candidates.reverse()){
   const file=join(dirname(journal),row.file);try{const s=await lstat(file);if(s.isSymbolicLink()||!s.isFile())continue;if(await fileSha(file)!==row.sha256.toLowerCase())continue;return JSON.parse(await readFile(file,'utf8'));}catch{}
  }
  if(candidates.length<limit)break;
 }
 throw Error('没有可验证的有效存档提交：'+path);
}

export async function hasBusinessData(dataRoot){
 if(!existsSync(dataRoot))return false;
 return (await readdir(dataRoot)).some(name=>!excluded.has(name)&&!temporary.has(name)&&name!==IMPORT_GUARD&&name!=='captures');
}
export async function importSummary(dataRoot,files){
 const companion=await inspectSnapshot(join(dataRoot,'galgame/companion.json'));
 const global=await inspectSnapshot(join(dataRoot,'galgame/storages/dsh-whale-galgame/global.json'));
 const models=await inspectSnapshot(join(dataRoot,'model-connections.json'));
 const cgs=await inspectSnapshot(join(dataRoot,'cg-jobs.json'));
 if(!companion&&!global&&!models&&!files.some(f=>/^(settings\.json|.*\.sqlite(?:3)?$|api-usage\.jsonl$)/.test(f.path)))throw Error('所选目录没有可识别的 AI 酱存档，请选择旧程序或实际存档目录');
 const values=o=>Object.values(o??{}),conversations=values(companion?.conversations),groups=values(companion?.groups);
 return {characters:values(companion?.cards??global?.characters).length,personas:values(companion?.personas).length,
  conversations:conversations.length,messages:conversations.reduce((n,c)=>n+(c.messages?.length??0),0)||values(global?.characters).reduce((n,c)=>n+(c.chatLines?.length??0),0),groups:groups.length,
  memoryEvents:values(companion?.lives).reduce((n,l)=>n+values(l.memory?.events).length,0),lifeArchives:files.filter(f=>/\.zip$/i.test(f.path)&&/life|人生|archive/.test(f.path)).length,
  cgs:cgs?.jobs?.length??0,connections:models?.profiles?.length??0};
}

export async function resolveImportSource(selected){
 const selectedRoot=await realpath(resolve(selected));if(!(await lstat(selectedRoot)).isDirectory())throw Error('请选择存档文件夹');
 let sourceRoot=null,dataRoot=selectedRoot,sourcePipe=null;
 if(existsSync(join(selectedRoot,'local/current-build.json'))){
  sourceRoot=selectedRoot;const record=existsSync(join(selectedRoot,'local/installation.json'))?json(join(selectedRoot,'local/installation.json')):null;
  if(record&&(record.schemaVersion!==1||typeof record.version!=='string'))throw Error('旧安装记录损坏，请直接选择实际存档目录');
  dataRoot=registeredDataPath(selectedRoot,record?.dataPath,{mustExist:true});sourcePipe=normalizedPipe(record?.pipe);
 }
 dataRoot=await realpath(dataRoot);return {sourceRoot,sourceDataRoot:dataRoot,sourcePipe};
}

async function sourceStopped(source,query=requestLocalControl){
 if(!source.sourceRoot||!source.sourcePipe)return;
 let s;try{s=await query(source.sourcePipe,{command:'installation-status'},{timeoutMs:1200});}catch(error){if(['ENOENT','ECONNREFUSED'].includes(error.code))return;throw Error('无法确认旧版已经退出，请先关闭旧版再重试：'+error.message);}
 if(s?.dataRoot&&canonical(s.dataRoot)===canonical(source.sourceDataRoot)||s?.build&&canonical(s.build).startsWith(canonical(source.sourceRoot)+sep))throw Error('旧版仍在运行，请先正常退出旧版再导入');
}

export async function pauseImportedWork(dataRoot,{planId,sourceIdentity,now=Date.now()}={}){
 const original=await inspectSnapshot(join(dataRoot,'cg-jobs.json'));let pausedCgs=0;
 if(original){const jobs=structuredClone(original);for(const job of jobs.jobs??[])if(['queued','planning','generating'].includes(job.status)){job.pausedFrom=job.status;job.status='paused';job.pauseReason='import';job.pausedAt=now;pausedCgs++;}
  if(pausedCgs)await createSnapshotStorage(join(dataRoot,'cg-jobs.json'),{retention:false}).writeText(JSON.stringify(jobs));}
 const companion=await inspectSnapshot(join(dataRoot,'galgame/companion.json'));let interruptedRequests=0;
 if(companion){const next=structuredClone(companion);for(const conversation of Object.values(next.conversations??{}))for(const message of conversation.messages??[])if(message.presentation==='pending'||['pending','pending-presentation','generating','draft'].includes(message.status)){message.status='interrupted';if(message.presentation==='pending')message.presentation='discarded';message.interruptedByImport=planId;interruptedRequests++;}
  for(const group of Object.values(next.groups??{}))if(group.pending&&!group.pending.settlement){group.importedPending=group.pending;group.pending=null;interruptedRequests++;}
  if(interruptedRequests)await createSnapshotStorage(join(dataRoot,'galgame/companion.json'),{retention:false}).writeText(JSON.stringify(next));}
 writeAtomic(join(dataRoot,IMPORT_GUARD),JSON.stringify({version:1,active:true,planId,sourceIdentity,pausedCgs,interruptedRequests,at:now}));
 return {pausedCgs,interruptedRequests};
}

export function createDataImportService({root,dataRoot,build,pipe,manager,onboarding=false,chooseSource=async()=>null,onState=()=>{},onBarrier=()=>{},onCreateNew=async()=>{},query=requestLocalControl,launchCommit=null,freeBytes=null,copyCheckpoint=()=>{}}){
 root=resolve(root);dataRoot=resolve(dataRoot);const plans=new Map();let selected=null,controller=null,active=null,closed=false;
 let state={onboarding,phase:'idle',canCancel:false};
 const currentGuard=()=>{try{const value=json(join(dataRoot,IMPORT_GUARD));return value?.version===1&&typeof value.active==='boolean'?value:{version:1,active:true,invalid:true};}catch(error){return error.code==='ENOENT'?null:{version:1,active:true,invalid:true};}};
 const view=()=>({...structuredClone(state),importedWorkPaused:currentGuard()?.active===true});
 function update(patch){state={...state,...patch};onState(view());}
 const save=(file,value)=>{mkdirSync(dirname(file),{recursive:true});writeAtomic(file,JSON.stringify(value,null,2));};
 function pending(){if(active||['copying','verifying','waiting','switching'].includes(state.phase))throw Error('已有导入正在进行');}
 async function choose(){pending();const value=await chooseSource();if(!value)return {cancelled:true};selected=await realpath(value);return {source:selected};}
 async function preview({source,sourceClosed=false}={}){
  pending();if(sourceClosed!==true)throw Error('请先退出旧版，并确认来源应用已经关闭');if(!selected||canonical(source)!==canonical(selected))throw Error('请先通过选择文件夹指定旧存档');
  update({phase:'previewing',error:null,canCancel:false});
  try{
   const location=await resolveImportSource(selected);if(canonical(location.sourceDataRoot)===canonical(dataRoot))throw Error('当前正在使用的资料无需导入，请选择已退出旧版的存档');
   const id=randomUUID(),targetDataPath='local/data-profiles/import-'+id,targetDataRoot=noLinks(under(root,targetDataPath)),directory=noLinks(under(root,'local/data-imports/'+id));
   if(canonical(targetDataRoot).startsWith(canonical(location.sourceDataRoot)+sep))throw Error('来源目录不能包含导入目标目录');
   await sourceStopped(location,query);
   const index=await importInventory(location.sourceDataRoot),summary=await importSummary(location.sourceDataRoot,index.files);
   const currentRecord=join(root,'local/installation.json');if(!existsSync(currentRecord))throw Error('安装记录尚未就绪，请先完成初始化');
   const recordSha=await fileSha(currentRecord);const identity=digest(JSON.stringify({source:location.sourceDataRoot,files:index.sha256}));
   const plan={schemaVersion:1,id,root,expectedBuild:relative(root,build).replaceAll('\\','/'),expectedInstallationSha256:recordSha,pipe,targetDataPath,sourceIdentity:identity,
    ...location,files:index.files,filesSha256:index.sha256,bytes:index.bytes,exclusions:index.exclusions,summary,directory,targetDataRoot};
   plans.set(id,plan);save(join(directory,'preview-plan.json'),plan);
   const publicPlan={planId:id,sourceRoot:location.sourceRoot,sourceDataRoot:location.sourceDataRoot,targetDataRoot,sourceIdentity:identity,files:index.files.length,bytes:index.bytes,summary,exclusions:index.exclusions,warnings:['不会合并或覆盖现有资料；导入后旧资料和当前资料均保留','导入的未完成工作将暂停；跨电脑的密钥和本机登录可能需要重新配置']};
   update({phase:'idle',plan:publicPlan,canCancel:true});return publicPlan;
  }catch(error){update({phase:'failed',error:error.message,canCancel:false});throw error;}
 }
 async function execute(plan){
  const stage=under(root,'local/data-profiles/.import-'+plan.id+'.staging');const signal=controller.signal;
  try{
   if(await fileSha(join(root,'local/installation.json'))!==plan.expectedInstallationSha256)throw Error('安装或资料选择已变化，请重新预览');
   await sourceStopped(plan,query);
   const before=await importInventory(plan.sourceDataRoot,{signal});if(before.sha256!==plan.filesSha256)throw Error('来源存档已变化，请重新预览');
   const disk=freeBytes?await freeBytes():await statfs(root,{bigint:true}).then(s=>s.bavail*s.bsize);const required=BigInt(plan.bytes)+64n*1024n*1024n;if(BigInt(disk)<required)throw Error('磁盘空间不足，导入未开始；现有资料保持不变');
   noLinks(stage);await mkdir(dirname(stage),{recursive:true});noLinks(dirname(stage));await mkdir(stage,{recursive:false});noLinks(stage);let done=0,filesCopied=0;update({phase:'copying',canCancel:true,progress:{bytesCopied:0,totalBytes:plan.bytes,filesCopied:0,totalFiles:plan.files.length}});
   for(const file of plan.files){
    if(signal.aborted)throw aborted();const from=noLinks(under(plan.sourceDataRoot,file.path)),to=noLinks(under(stage,file.path));await mkdir(dirname(to),{recursive:true});noLinks(dirname(to));const hash=createHash('sha256');let fileBytes=0;
    await pipeline(createReadStream(from),new Transform({transform(chunk,_encoding,cb){if(fileBytes+chunk.length>file.bytes||done+chunk.length>plan.bytes){cb(Error('来源文件大小已变化，已停止导入：'+file.path));return;}hash.update(chunk);fileBytes+=chunk.length;done+=chunk.length;cb(null,chunk);}}),createWriteStream(to,{flags:'wx'}),{signal});
    if(fileBytes!==file.bytes||hash.digest('hex')!==file.sha256)throw Error('复制校验失败，来源可能正在变化：'+file.path);filesCopied++;await copyCheckpoint({file,stage,filesCopied});
    update({progress:{bytesCopied:done,totalBytes:plan.bytes,filesCopied,totalFiles:plan.files.length}});
   }
   update({phase:'verifying'});const copied=await importInventory(stage,{signal});if(copied.sha256!==plan.filesSha256)throw Error('导入副本校验失败');
   const after=await importInventory(plan.sourceDataRoot,{signal});if(after.sha256!==plan.filesSha256)throw Error('来源在复制期间发生变化，已停止切换');
   await sourceStopped(plan,query);if(signal.aborted)throw aborted();
   const normalization=await pauseImportedWork(stage,{planId:plan.id,sourceIdentity:plan.sourceIdentity});
   const final=await importInventory(stage,{signal});if(signal.aborted)throw aborted();
   renameSync(stage,plan.targetDataRoot);
   const commit={schemaVersion:1,id:plan.id,root,expectedInstallationSha256:plan.expectedInstallationSha256,expectedBuild:plan.expectedBuild,pipe,targetDataPath:plan.targetDataPath,
    sourceIdentity:plan.sourceIdentity,filesSha256:final.sha256,files:final.files,state:'ready'};
   const commitPath=join(plan.directory,'commit-plan.json');save(commitPath,commit);save(join(plan.directory,'COPY-RECEIPT.json'),{sourceFilesSha256:plan.filesSha256,targetFilesSha256:final.sha256,sourceUnchanged:true,normalization,at:new Date().toISOString()});
   update({phase:'waiting',canCancel:true});
   if(launchCommit){await launchCommit(commit,commitPath);update({phase:'complete',canCancel:false});active=null;onBarrier(false);}
   else {
    if(!manager||!existsSync(manager))throw Error('同版本维护器缺失，请修复程序后重试；导入副本已保留');
    const receipt=join(plan.directory,'commit-receipt.json');
    const child=spawn(manager,['--headless','--action=data-import-commit','--root='+root,'--import-plan='+commitPath,'--receipt='+receipt],{windowsHide:true,detached:true,stdio:'ignore'});
    await new Promise((yes,no)=>{child.once('error',no);child.once('spawn',yes);});
    child.unref();
    child.once('exit',code=>{if(closed)return;try{const result=json(receipt);update({phase:result.ok?'complete':'failed',error:result.error??null,canCancel:false});}catch{update({phase:'failed',error:'维护器退出，原资料指向已保留或将恢复；请查看导入回执（'+code+'）',canCancel:false});}finally{active=null;onBarrier(false);}});
   }
  }catch(error){update({phase:signal.aborted?'cancelled':'failed',error:error.message,canCancel:false});active=null;onBarrier(false);}
 }
 async function start({planId,sourceClosed=false}={}){
  pending();if(sourceClosed!==true)throw Error('请确认旧版应用已经退出');const plan=plans.get(planId);if(!plan||state.plan?.planId!==planId)throw Error('导入预览已过期，请重新选择');
  controller=new AbortController();active=plan;onBarrier(true);update({phase:'copying',canCancel:true,error:null});void execute(plan);return {started:true,planId};
 }
 async function cancel({planId}={}){
  if(planId&&active?.id!==planId&&state.plan?.planId!==planId)throw Error('导入任务不匹配');
  if(active&&state.phase==='waiting'){
   let commitStatus;try{commitStatus=json(join(active.directory,'commit-status.json'));}catch{}
   if(commitStatus?.canCancel===false||['switching','verifying','complete'].includes(commitStatus?.phase))throw Error('正在切换资料，请等待完成');
   writeFileSync(join(active.directory,'cancel.request'),'cancel\n',{flag:'w'});update({canCancel:false});return {ok:true,cancelling:true};
  }
  if(active){if(!state.canCancel)throw Error('正在切换资料，请等待完成');controller.abort();return {ok:true,cancelling:true};}
  state={onboarding:state.onboarding,phase:'idle',canCancel:false};onState(view());return {ok:true};
 }
 return {choose,preview,start,cancel,state(){if(active&&state.phase==='waiting'){try{const s=json(join(active.directory,'commit-status.json'));state={...state,...s};}catch{}}return view();},
  async createNew(){pending();if(!state.onboarding)throw Error('当前资料已经初始化');await onCreateNew();return {ok:true};},
  async resumeWork(){const guard=currentGuard();if(guard?.active){guard.active=false;guard.resumedAt=Date.now();writeAtomic(join(dataRoot,IMPORT_GUARD),JSON.stringify(guard));}onState(view());return {ok:true};},
  automaticWorkAllowed:()=>currentGuard()?.active!==true,
  close(){closed=true;if(active&&['copying','verifying'].includes(state.phase))controller?.abort();},
 };
}
