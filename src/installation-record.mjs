import {readFileSync,existsSync,lstatSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {resolve,join,dirname,isAbsolute,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const imported=/^local\/data-profiles\/import-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function failure(message,code='INSTALLATION_RECOVERY_REQUIRED'){const e=Error(message);e.code=code;return e;}
function noLinks(path){for(let p=resolve(path);;p=dirname(p)){if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw failure('安装或存档路径包含链接，请恢复有效路径 / Linked installation/data path');if(dirname(p)===p)break;}return path;}
function json(file,optional=false){if(!existsSync(file)){if(optional)return null;throw failure('安装记录缺失 / Installation record missing');}try{return JSON.parse(readFileSync(noLinks(file),'utf8'));}catch(e){if(e.code==='INSTALLATION_RECOVERY_REQUIRED')throw e;throw failure('安装记录损坏，请选择恢复或重新登记存档 / Invalid installation record: '+file);}}
function relative(root,value){if(typeof value!=='string'||!value||value.includes('\\')||isAbsolute(value)||value.split('/').some(p=>!p||p==='.'||p==='..'||p.includes(':')))throw failure('安装路径不合法 / Invalid installation path');const full=resolve(root,value);if(!full.startsWith(resolve(root)+sep))throw failure('安装路径越界 / Installation path escaped');return noLinks(full);}
function validateRecord(value){if(!value||Array.isArray(value)||value.schemaVersion!==1||typeof value.version!=='string'||typeof value.build!=='string'||typeof value.runtime!=='string'||typeof value.manager!=='string'||!['30fps','60fps'].includes(value.edition)||!Array.isArray(value.characters)||!value.characters.length||value.characters.some(c=>typeof c!=='string')||value.characters.length!==new Set(value.characters).size)throw failure('安装记录字段不完整或损坏 / Invalid installation record');return value;}
export function registeredDataPath(root,value,{mustExist=true}={}){
 let data;
 if(value==null||value==='')data=join(resolve(root),'local/data-v003');
 else if(typeof value!=='string')throw failure('存档登记路径损坏 / Invalid registered data path');
 else if(isAbsolute(value))data=resolve(value);
 else if(imported.test(value))data=relative(root,value);
 else throw failure('相对存档路径仅允许已导入资料 / Invalid relative registered data path');
 noLinks(data);
 if(mustExist&&value!=null&&value!==''&&(!existsSync(data)||!lstatSync(data).isDirectory()))throw failure('已登记的存档目录不存在，请恢复目录或导入旧存档 / Registered data directory is missing: '+data);
 return data;
}
export function normalizedPipe(value){if(value==null||value==='')return '\\\\.\\pipe\\whale-companion-v001';if(typeof value!=='string')throw failure('本地管道配置损坏 / Invalid pipe');const name=value.replace(/^\\\\\.\\pipe\\/,'');if(!/^[a-zA-Z0-9_.-]{1,180}$/.test(name))throw failure('本地管道配置损坏 / Invalid pipe');return '\\\\.\\pipe\\'+name;}
export function resolveInstallation({root,build,explicitData,explicitPipe,verifyImportId,cwd=process.cwd()}){
 root=resolve(root);build=resolve(build);const recordPath=join(root,'local/installation.json');
 const previousBytes=existsSync(recordPath)?readFileSync(noLinks(recordPath)):null;
 const previous=previousBytes?validateRecord(json(recordPath)):null;
 const pointer=json(join(root,'local/current-build.json'),true);const marker=json(join(root,'local/portable-defaults.json'),true);
 let installation=previous,portableDefaultsApplied=false;
 if(marker){
  if(marker.schemaVersion!==1||!marker.pointer||!marker.installation)throw failure('免安装包默认元数据损坏 / Invalid portable defaults');
  const p=marker.pointer;const current=pointer&&resolve(root,pointer.path??'')===build&&['version','appVersion','path','animationProfile','manifestSha256'].every(k=>p[k]===pointer[k])&&['path','executable','sha256'].every(k=>p.runtime?.[k]===pointer.runtime?.[k]);
  if(current){
   const defaults=validateRecord(marker.installation);
   if(defaults.build!==p.path||defaults.runtime!==p.runtime?.path||defaults.version!==p.version||defaults.edition!==p.animationProfile||defaults.manifestSha256!==p.manifestSha256||!/^[a-f0-9]{64}$/.test(defaults.manifestSha256??''))throw failure('免安装包默认元数据与程序不一致 / Portable defaults do not match pointer');
   for(const key of ['build','runtime','manager'])relative(root,defaults[key]);
   installation={...defaults,dataPath:previous?.dataPath??null,pipe:previous?.pipe??null,dataInitialized:previous?.dataInitialized??defaults.dataInitialized??false,initialCharacter:defaults.characters.includes(previous?.initialCharacter)?previous.initialCharacter:defaults.initialCharacter};portableDefaultsApplied=true;
  }
 }
 if(installation){for(const key of ['build','runtime','manager'])relative(root,installation[key]);}
 const journalPath=join(root,'local/installer/data-import-transaction.json');const transaction=json(journalPath,true);
 if(transaction&&['switching','switched','verifying'].includes(transaction.phase)){
  const verified=verifyImportId===transaction.id&&transaction.plan?.id===transaction.id&&transaction.plan?.expectedBuild===installation?.build&&resolve(root,transaction.plan.expectedBuild)===build&&transaction.plan?.targetDataPath===installation?.dataPath;
  if(!verified){const error=failure('上次存档切换中断，需要恢复先前资料 / Interrupted data import requires recovery','DATA_IMPORT_RECOVERY_REQUIRED');error.journalPath=journalPath;throw error;}
 }
 const data=explicitData!==undefined?noLinks(resolve(cwd,explicitData)):registeredDataPath(root,installation?.dataPath);
 if(explicitData===undefined&&installation?.dataInitialized===true&&(!existsSync(data)||!lstatSync(data).isDirectory()))throw failure('已初始化的默认存档目录不存在，请恢复存档 / Initialized personal-data directory is missing: '+data);
 if(explicitData!==undefined&&(!explicitData||typeof explicitData!=='string'))throw failure('显式存档目录不合法 / Invalid explicit data directory');
 const pipe=normalizedPipe(explicitPipe??installation?.pipe);
 const needsCommit=!!installation&&JSON.stringify(installation)!==JSON.stringify(previous);
 return {root,build,installation,data,pipe,needsCommit,previousSha256:previousBytes?hash(previousBytes):null,portableDefaultsApplied,recordPath};
}
export function commitInstallation(state){
 if(!state.needsCommit)return state.installation;
 const current=existsSync(state.recordPath)?readFileSync(noLinks(state.recordPath)):null;
 if((current?hash(current):null)!==state.previousSha256)throw failure('安装记录已改变，请重启重试 / Installation record changed');
 const parent=dirname(state.recordPath);mkdirSync(parent,{recursive:true});noLinks(parent);
 if(current){const backup=join(parent,'installation-backups',Date.now()+'-'+randomUUID()+'.json');mkdirSync(dirname(backup),{recursive:true});writeFileSync(backup,current,{flag:'wx'});}
 const temp=join(parent,'.installation-'+randomUUID()+'.tmp');const bytes=JSON.stringify(state.installation,null,2)+'\n';const fd=openSync(temp,'wx');try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,state.recordPath);state.previousSha256=hash(bytes);state.needsCommit=false;return state.installation;
}
export function markInstallationInitialized(state,activeDataRoot){
 if(!state.installation||resolve(activeDataRoot)!==registeredDataPath(state.root,state.installation.dataPath,{mustExist:false}))return false;
 const current=json(state.recordPath);if(current.build!==state.installation.build||current.dataPath!==state.installation.dataPath||current.pipe!==state.installation.pipe)throw failure('安装资料选择已改变，请重启 / Installation profile changed');
 if(current.dataInitialized===true){state.installation.dataInitialized=true;return false;}
 if(!existsSync(activeDataRoot)||!lstatSync(activeDataRoot).isDirectory())throw failure('存档尚未初始化 / Data has not initialized');
 const bytes=readFileSync(state.recordPath);const next={...current,dataInitialized:true};commitInstallation({...state,installation:next,needsCommit:true,previousSha256:hash(bytes)});Object.assign(state.installation,next);return true;
}
