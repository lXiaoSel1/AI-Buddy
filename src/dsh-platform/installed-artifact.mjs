import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';

const fail=()=>Object.assign(Error('Installed native package differs from the approved exact archive'),{code:'DSH_INSTALLED_ARTIFACT_MISMATCH'});
const inside=(root,path)=>{const delta=relative(root,path);return delta===''||!isAbsolute(delta)&&delta!=='..'&&!delta.startsWith('..'+sep);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
/** Reuse observes an exact existing package; it never repairs or rewrites it. */
export async function verifyInstalledDshArtifact({profileRoot,packageName,exactVersion,files}){
  if(!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(packageName??'')||!(files instanceof Map)||!files.has('package.json'))throw fail();
  const profile=await realpath(resolve(profileRoot)),entry=join(profile,'node_modules',...packageName.split('/')),root=await realpath(entry);
  // pnpm owns the package-root junction. Every entry below that root must be
  // an ordinary file/directory, and that junction must stay inside this HOME.
  if(!inside(profile,root))throw fail();
  const directories=new Set(['']);
  for(const path of files.keys()){
    if(path.includes('\\')||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..'))throw fail();
    const parts=path.split('/');parts.pop();while(parts.length){directories.add(parts.join('/'));parts.pop();}
  }
  async function census(){
    const entries=new Map(),queue=[''];
    while(queue.length){const parent=queue.shift();for(const name of await readdir(join(root,parent))){const key=parent?parent+'/'+name:name,info=await lstat(join(root,key),{bigint:true});
      if(info.isSymbolicLink())throw fail();
      if(info.isDirectory()){if(!directories.has(key))throw fail();entries.set(key,'directory');queue.push(key);}
      else if(info.isFile()){if(!files.has(key))throw fail();entries.set(key,'file');}
      else throw fail();
    }}return entries;
  }
  const before=await census(),pending=[...files];
  if([...files.keys()].some(key=>before.get(key)!=='file'))throw fail();
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(16,pending.length)},async()=>{while(cursor<pending.length){const [key,expected]=pending[cursor++],path=join(root,key),first=await lstat(path,{bigint:true});if(!first.isFile()||first.isSymbolicLink()||sha(await readFile(path))!==expected)throw fail();const last=await lstat(path,{bigint:true});if(!last.isFile()||last.isSymbolicLink()||first.ino!==last.ino||first.size!==last.size||first.mtimeNs!==last.mtimeNs||first.ctimeNs!==last.ctimeNs)throw fail();}}));
  const identity=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  if(identity.name!==packageName||identity.version!==exactVersion)throw fail();
  const after=await census();
  if(JSON.stringify([...before].sort())!==JSON.stringify([...after].sort())||await realpath(entry)!==root)throw fail();
  return {verified:true,packageName,exactVersion,files:files.size,closure:'exact-archive-files-and-directories',packageRoot:root};
}
