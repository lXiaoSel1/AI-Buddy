import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
async function hashPrefix(path,size){const hash=createHash('sha256');if(size)for await(const chunk of createReadStream(path,{end:size-1}))hash.update(chunk);return hash.digest('hex');}
export async function migrateGeneric(repo,path,ledger,state){
 if(repo.meta('ready'))return;
 const size=await stat(path).then(s=>s.size).catch(e=>{if(e.code==='ENOENT')return 0;throw e;}),before=size?await hashPrefix(path,size):null;
 repo.db.exec("DELETE FROM facts WHERE kind='generic'");repo.discardPending();let count=0,bytes=0;
 repo.db.exec('BEGIN');
 try{
  if(size){const reader=createInterface({input:createReadStream(path,{end:size-1}),crlfDelay:Infinity});for await(const line of reader){if(Buffer.byteLength(line)>8*1024*1024)throw Error('历史用量记录超过8 MiB限制');let row;try{row=JSON.parse(line);}catch{continue;}ledger.ingest(row,false);count++;bytes+=line.length;
   if(count%500===0||bytes>=2*1024*1024){repo.publish({genericMigration:{source:path,size,sha256:before,count,ready:false}});repo.db.exec('COMMIT; BEGIN');bytes=0;await new Promise(r=>setImmediate(r));}
  }}
  if(size&&await hashPrefix(path,size)!==before)throw Error('历史用量文件在迁移期间发生改写');
  repo.publish({ready:true,state,genericMigration:{source:path,size,sha256:before,count,ready:true}});repo.db.exec('COMMIT');
 }catch(e){repo.db.exec('ROLLBACK');repo.discardPending();throw e;}
}
