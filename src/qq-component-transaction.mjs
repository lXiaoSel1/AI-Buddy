import {lstat,readFile,readdir,realpath,rm,mkdir} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeAtomic} from './atomic-write.mjs';

export const QQ_PREPARATION_FILE='.buddy-prepare.json';
const KIND='ai-buddy-qq-component-preparation';
const fail=code=>Object.assign(Error(code),{code});
const same=(a,b)=>process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b);
const identity=info=>({dev:String(info.dev),ino:String(info.ino)});
async function noLinks(path){for(let p=resolve(path);;p=dirname(p)){try{if((await lstat(p)).isSymbolicLink())throw fail('QQ_COMPONENT_LINK_DENIED');}catch(e){if(e.code!=='ENOENT')throw e;}if(p===dirname(p))break;}}
async function plain(path){await noLinks(path);try{return await lstat(path,{bigint:true});}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function alive(pid){try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
function validateRecord(value,directory,info,descriptor){
 const valid=value?.schemaVersion===1&&value.kind===KIND&&/^[a-f0-9-]{36}$/.test(value.transactionId??'')&&typeof value.directory==='string'&&same(value.directory,directory)&&value.directoryIdentity?.dev===String(info.dev)&&value.directoryIdentity?.ino===String(info.ino)&&value.version===descriptor.version&&value.sha256===descriptor.sha256&&value.archiveBytes===descriptor.bytes&&value.expandedBytes===descriptor.expandedBytes&&value.partial==='napcat-'+descriptor.version+'.part'&&value.stage==='stage-'+value.transactionId&&['preparing','downloading','extracting','committed','interrupted'].includes(value.phase)&&Number.isSafeInteger(value.owner?.pid)&&value.owner.pid>0&&typeof value.owner.birth==='string'&&Number.isFinite(Date.parse(value.createdAt));
 if(!valid)throw fail('QQ_COMPONENT_RECOVERY_REQUIRED');return value;
}
async function readRecord(directory,info,descriptor){
 const path=join(directory,QQ_PREPARATION_FILE),st=await plain(path);if(!st)return null;if(!st.isFile()||st.size>65536n)throw fail('QQ_COMPONENT_RECOVERY_REQUIRED');
 let value;try{value=JSON.parse(await readFile(path,'utf8'));}catch{throw fail('QQ_COMPONENT_RECOVERY_REQUIRED');}return validateRecord(value,directory,info,descriptor);
}
async function assertContainer(directory,expected){const st=await plain(directory);if(!st?.isDirectory()||!same(await realpath(directory),directory)||identity(st).dev!==expected.dev||identity(st).ino!==expected.ino)throw fail('QQ_COMPONENT_RECOVERY_REQUIRED');}
async function removeStage(directory,record,descriptor){
 await assertContainer(directory,record.directoryIdentity);const stage=resolve(directory,record.stage),rel=relative(directory,stage);if(rel!==record.stage||isAbsolute(rel)||rel.includes(sep))throw fail('QQ_COMPONENT_RECOVERY_REQUIRED');
 const st=await plain(stage);if(!st)return;if(!st.isDirectory())throw fail('QQ_COMPONENT_RECOVERY_REQUIRED');
 const expected=new Map(descriptor.files.map(row=>[row.path,row])),allowedDirectories=new Set();for(const name of expected.keys()){const parts=name.split('/');for(let i=1;i<parts.length;i++)allowedDirectories.add(parts.slice(0,i).join('/'));}
 let seen=0;async function walk(path){for(const entry of await readdir(path,{withFileTypes:true})){if(++seen>10000)throw fail('QQ_COMPONENT_RECOVERY_REQUIRED');const child=join(path,entry.name),info=await plain(child),name=relative(stage,child).split(sep).join('/');if(info?.isDirectory()){if(!allowedDirectories.has(name))throw fail('QQ_COMPONENT_RECOVERY_REQUIRED');await walk(child);}else if(name==='buddy-component.json'&&info?.isFile()&&info.size<=512n){let proof;try{proof=JSON.parse(await readFile(child,'utf8'));}catch{throw fail('QQ_COMPONENT_RECOVERY_REQUIRED');}if(proof.version!==descriptor.version||proof.sha256!==descriptor.sha256||Object.keys(proof).length!==2)throw fail('QQ_COMPONENT_RECOVERY_REQUIRED');}else if(!info?.isFile()||!expected.has(name)||info.size>BigInt(expected.get(name).bytes))throw fail('QQ_COMPONENT_RECOVERY_REQUIRED');}}
 await walk(stage);await assertContainer(directory,record.directoryIdentity);await rm(stage,{recursive:true,force:false});
}

/** Call only while holding the component's OS-owned preparation lease. No
 * wildcard cleanup: an unknown stage, changed directory, or live foreign owner
 * remains untouched. Account HOME never enters this component container. */
export async function openQqPreparation(directory,descriptor){
 await noLinks(directory);await mkdir(directory,{recursive:true});directory=await realpath(directory);const info=await lstat(directory,{bigint:true});
 let record=await readRecord(directory,info,descriptor);const names=await readdir(directory);if(names.length>16)throw fail('QQ_COMPONENT_RECOVERY_REQUIRED');
 const allowed=new Set(['napcat-'+descriptor.version,'napcat-'+descriptor.version+'.part',QQ_PREPARATION_FILE,...(record?[record.stage]:[])]);
 for(const name of names){if(!allowed.has(name))throw fail('QQ_COMPONENT_RECOVERY_REQUIRED');await noLinks(join(directory,name));}
 if(record){if(record.owner.pid!==process.pid&&alive(record.owner.pid))throw fail('QQ_COMPONENT_PREPARATION_BUSY');await removeStage(directory,record,descriptor);}
 const marker=join(directory,QQ_PREPARATION_FILE),partial=join(directory,'napcat-'+descriptor.version+'.part');
 const partInfo=await plain(partial);if(partInfo&&(!partInfo.isFile()||partInfo.size>BigInt(descriptor.bytes)))throw fail('QQ_COMPONENT_RECOVERY_REQUIRED');
 async function store(phase){await assertContainer(directory,identity(info));record={...record,phase};await noLinks(marker);writeAtomic(marker,JSON.stringify(record));}
 async function begin(){const transactionId=randomUUID();record={schemaVersion:1,kind:KIND,transactionId,directory,directoryIdentity:identity(info),version:descriptor.version,sha256:descriptor.sha256,archiveBytes:descriptor.bytes,expandedBytes:descriptor.expandedBytes,partial:'napcat-'+descriptor.version+'.part',stage:'stage-'+transactionId,phase:'preparing',owner:{pid:process.pid,birth:new Date(Date.now()-process.uptime()*1000).toISOString()},createdAt:new Date().toISOString()};await store('preparing');return join(directory,record.stage);}
 return {
  directory,partial,
  begin,
  phase:store,
  async cleanupStage(){if(record)await removeStage(directory,record,descriptor);},
  async interrupted(){if(record)await store('interrupted');},
  async complete(){await assertContainer(directory,identity(info));if(!record&&partInfo)await begin();if(record){await removeStage(directory,record,descriptor);await noLinks(partial);await rm(partial,{force:true});await noLinks(marker);await rm(marker,{force:true});}},
 };
}
