import {createHash} from 'node:crypto';
import {mkdirSync,realpathSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';

const sha=b=>createHash('sha256').update(b).digest('hex');
const ID=/^[a-zA-Z0-9_:.-]{1,200}$/,HASH=/^[a-f0-9]{64}$/;
const MAX_IMAGE=32*1024*1024,MAX_BUNDLE=50*1024*1024;
const fields=['id','status','charId','prompt','level','at','deletedAt','kind','label','personaId','groupId','sourceEventId','provider','model','connectionName','referenceMode','referenceNotice','theme','groupSource','characters','scene'];
function id(value){if(typeof value!=='string'||!ID.test(value)||value==='prototype'||Object.hasOwn(Object.prototype,value))throw Error('CG 标识无效');return value;}
function imageBytes(data){
 if(typeof data!=='string'||data.length>Math.ceil(MAX_IMAGE/3)*4+100)throw Error('CG 图片大小无效');
 const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
 if(!match)throw Error('CG 图片格式无效');
 const bytes=Buffer.from(match[2],'base64');
 if(!bytes.length||bytes.length>MAX_IMAGE||bytes.toString('base64')!==match[2])throw Error('CG 图片编码无效');
 const valid=match[1]==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):match[1]==='jpeg'?bytes[0]===255&&bytes[1]===216:bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
 if(!valid)throw Error('CG 图片格式与内容不符');
 return bytes;
}
function metadata(record){
 id(record.id);id(record.charId);
 const out=Object.fromEntries(fields.filter(k=>record[k]!==undefined).map(k=>[k,structuredClone(record[k])]));
 if(out.characters&&!Array.isArray(out.characters))throw Error('CG 角色名单无效');
 for(const c of out.characters??[])id(c.id);
 // Only finished local images can be ready. Imported tasks never submit work.
 if(!['ready','failed','cancelled'].includes(out.status)){out.status='failed';out.error='导入的未完成任务未自动提交';}
 return out;
}
export function exportPortableCgs(records,readAsset){
 const files=new Map(),cgs=[];
 for(const record of records){
  const row=metadata(record);
  if(record.status==='ready'){
   const dataUrl=record.dataUrl||readAsset(record.assetRef),bytes=imageBytes(dataUrl),key=sha(bytes);
   if(!files.has(key))files.set(key,{key,sha256:key,bytes:bytes.length,dataUrl});
   row.image=key;
  }
  cgs.push(row);
 }
 const bundle={version:1,files:[...files.values()],cgs};
 if(Buffer.byteLength(JSON.stringify(bundle))>MAX_BUNDLE)throw Error('合影附件超过 50 MiB，请分别导出群聊或备份完整数据目录 / Photo attachments exceed 50 MiB');
 return bundle;
}
export function validatePortableCgs(bundle){
 if(!bundle)return {files:[],cgs:[],idMap:{}};
 if(bundle.version!==1||!Array.isArray(bundle.files)||!Array.isArray(bundle.cgs)||bundle.cgs.length>1000||bundle.files.length>1000)throw Error('CG 附件格式无效');
 if(Buffer.byteLength(JSON.stringify(bundle))>MAX_BUNDLE)throw Error('CG 附件超过 50 MiB');
 const files=new Map(),ids=new Set(),idMap={};
 for(const file of bundle.files){
  if(!HASH.test(file.key)||file.key!==file.sha256||files.has(file.key))throw Error('CG 文件 key 或校验值无效');
  const bytes=imageBytes(file.dataUrl);
  if(bytes.length!==file.bytes||sha(bytes)!==file.sha256)throw Error('CG 图片 SHA-256 校验失败');
  files.set(file.key,{key:file.key,bytes});
 }
 const cgs=bundle.cgs.map(raw=>{
  const row=metadata(raw);
  if(ids.has(row.id))throw Error('CG 标识重复');ids.add(row.id);
  if(row.status==='ready'&&(!HASH.test(raw.image)||!files.has(raw.image)))throw Error('CG 图片附件缺失');
  const digest=sha(Buffer.from(JSON.stringify({record:row,image:raw.image??null})));
  const newId='imported-'+digest.slice(0,40);idMap[row.id]=newId;
  return {...row,id:newId,importedFrom:row.id,image:raw.image??null,seen:true,savedAsBg:false,automatic:false};
 });
 return {files:[...files.values()],cgs,idMap};
}
export function writePortableImages(dataRoot,codec,files){
 if(files.length&&!codec)throw Error('CG 图片解码器尚未就绪');
 // Decode the entire batch before publishing any image or gallery record.
 const decoded=files.map(file=>({...file,decoded:codec(file.bytes)}));
 const result=new Map();
 mkdirSync(join(dataRoot,'cg-assets'),{recursive:true});
 const root=realpathSync(join(dataRoot,'cg-assets'));
 for(const file of decoded){
  const directory=join(root,'portable-'+file.key);mkdirSync(directory,{recursive:true});
  const rel=relative(root,realpathSync(directory));
  if(rel.startsWith('..')||isAbsolute(rel))throw Error('CG 附件目录越界');
  // Preserve the exact original bytes. Rebuild only the disposable thumbnail.
  for(const [name,bytes]of [['image.png',file.bytes],['thumbnail.png',file.decoded.thumbnail??file.decoded.png]]){
   const path=join(directory,name);
   if(existsSync(path)){
    const resolved=realpathSync(path),within=relative(root,resolved);
    if(within.startsWith('..')||isAbsolute(within)||(name==='image.png'&&!readFileSync(path).equals(bytes)))throw Error('CG 附件路径或已有文件校验冲突');
   }else writeFileSync(path,bytes,{flag:'wx'});
  }
  result.set(file.key,{assetRef:'cg-assets/portable-'+file.key+'/image.png',thumbnailRef:'cg-assets/portable-'+file.key+'/thumbnail.png',sha256:file.key});
 }
 return result;
}
