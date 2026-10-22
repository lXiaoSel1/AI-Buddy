import {createHash} from 'node:crypto';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {lstatSync,mkdirSync,readFileSync,realpathSync} from 'node:fs';

const bad=message=>Error('CG 资源校验失败：'+message);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const identifier=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,180}$/.exec(id)?.[0]===id;
const basename=path=>typeof path==='string'?path.replaceAll('\\','/').split('/').at(-1):null;
function noLinks(root,path,{file=false,required=false}={}){
 const rel=relative(root,path);if(rel.startsWith('..')||isAbsolute(rel))throw bad('文件超出当前存档目录');
 const paths=[root];for(const part of rel.split(/[\\/]/).filter(Boolean))paths.push(join(paths.at(-1),part));
 for(let i=0;i<paths.length;i++){
  let stat;try{stat=lstatSync(paths[i]);}catch(error){if(error.code==='ENOENT'&&!required)return;throw bad('当前存档中的参考图或任务目录不存在');}
  if(stat.isSymbolicLink())throw bad('任务目录和参考图不能是链接或联接');
  if(i<paths.length-1&&!stat.isDirectory())throw bad('任务目录无效');
  if(i===paths.length-1&&(file?!stat.isFile():!stat.isDirectory()))throw bad(file?'参考图不是普通文件':'任务目录无效');
 }
 // Resolve once more to reject an existing path whose physical destination is
 // outside this data root. Never resolve any path from a previous installation.
 const actual=realpathSync(path),base=realpathSync(root),physical=relative(base,actual);
 if(physical.startsWith('..')||isAbsolute(physical))throw bad('文件超出当前存档目录');
}
/** Resolve only canonical identities inside this data root. Legacy absolute
 * fields are filename hints, never paths to open or search for missing files. */
export function cgJobPaths(dataRoot,job,{references=true,createDirectory=false,validate=true}={}){
 if(!identifier(job?.id))throw bad('任务标识无效');
 const root=resolve(dataRoot),directoryRef='cg-assets/'+job.id,directory=resolve(root,...directoryRef.split('/'));
 if(job.directoryRef!=null&&job.directoryRef!==directoryRef)throw bad('任务目录引用与任务标识不一致');
 if(job.directoryRef==null&&job.directory!=null&&basename(job.directory)!==job.id)throw bad('旧任务目录与任务标识不一致');
 noLinks(root,directory);
 if(createDirectory){mkdirSync(directory,{recursive:true});noLinks(root,directory,{required:true});}
 const refs=references?(job.references??[]).map((ref,index)=>{
  const name='reference-'+index+'.png',assetRef=directoryRef+'/'+name,path=join(directory,name);
  if(ref.assetRef!=null&&ref.assetRef!==assetRef)throw bad('参考图引用与任务标识不一致');
  if(ref.assetRef==null&&ref.path!=null&&basename(ref.path)!==name)throw bad('旧参考图文件名无效');
  const value={...ref,assetRef,path};
  if(validate){
   noLinks(root,path,{file:true,required:true});
   if(typeof ref.sha256!=='string'||!/^[a-f0-9]{64}$/.test(ref.sha256)||hash(readFileSync(path))!==ref.sha256)throw bad('参考图 SHA-256 不一致，请恢复原始参考图后继续');
  }
  return value;
 }):[];
 return {directoryRef,directory,references:refs};
}
export function assertCgRemoteResume(job){
 if(!job.remoteTask)return;
 if(!['wan-t2i','wan-t2i-legacy'].includes(job.profile?.protocol)||job.profile?.kind==='codex')throw Error('此连接不支持继续查询已有远程 CG 任务；不会自动重新提交，请确认后新建或重试');
 if(typeof job.remoteTask.id!=='string'||!job.remoteTask.id.trim()||job.remoteTask.id.length>512||/[\u0000-\u001f\u007f]/.test(job.remoteTask.id))throw Error('无法确认已有远程 CG 任务编号；不会自动重新提交');
}
export function cgAssetPath(dataRoot,ref){
 if(typeof ref!=='string'||!ref.startsWith('cg-assets/')||ref.split('/').some(part=>!part||part==='.'||part==='..'||/^[a-zA-Z0-9_.-]+$/.exec(part)?.[0]!==part))throw bad('图片文件引用无效');
 const root=resolve(dataRoot),path=resolve(root,...ref.split('/'));noLinks(root,path,{file:true,required:true});return path;
}
