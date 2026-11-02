import {readdir,lstat,unlink} from 'node:fs/promises';
import {resolve,join,dirname,sep} from 'node:path';
const fail=code=>Object.assign(Error(code),{code});
const limits=Object.freeze({'t':32*1024*1024,'w/cache':32*1024*1024,'w/logs':4*1024*1024});
async function noLinks(path){for(let current=resolve(path);;current=dirname(current)){try{if((await lstat(current)).isSymbolicLink())throw fail('QQ_CACHE_LINK_DENIED');}catch(error){if(error.code!=='ENOENT')throw error;}if(current===dirname(current))break;}}
// Never visit the native QQ account directory or configuration. Pruning runs
// only before launch/after confirmed exit; active runtimes are measured only.
export async function inspectQqCache(profile,{prune=false,now=Date.now()}={}){
 await noLinks(profile);let totalBytes=0,files=0,removedBytes=0;
 for(const [relative,limit] of Object.entries(limits)){
  const root=resolve(profile,...relative.split('/'));if(!root.startsWith(resolve(profile)+sep))throw fail('QQ_CACHE_PATH_DENIED');
  await noLinks(root);const entries=[];
  async function visit(path,depth=0){if(depth>20)throw fail('QQ_CACHE_LIMIT_REACHED');let names;try{names=await readdir(path,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
   for(const entry of names){if(++files>10000)throw fail('QQ_CACHE_LIMIT_REACHED');const child=join(path,entry.name),stat=await lstat(child);if(stat.isSymbolicLink())throw fail('QQ_CACHE_LINK_DENIED');if(stat.isDirectory())await visit(child,depth+1);else if(stat.isFile())entries.push({path:child,bytes:stat.size,mtime:stat.mtimeMs});}
  }
  await visit(root);let bytes=entries.reduce((sum,row)=>sum+row.bytes,0);
  for(const row of entries.sort((a,b)=>a.mtime-b.mtime))if(prune&&(bytes>limit||row.mtime<now-7*86400000)){await noLinks(row.path);await unlink(row.path);bytes-=row.bytes;removedBytes+=row.bytes;}
  totalBytes+=bytes;
 }
 return {totalBytes,files,removedBytes,overLimit:totalBytes>128*1024*1024};
}
