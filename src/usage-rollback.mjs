import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createSnapshotStorage} from './storage.mjs';

// Call only after the monitor writer has stopped. Export the latest committed
// facts, including post-upgrade requests; old snapshots and journal prefixes stay.
export async function exportUsageForRollback(dataRoot){
 const result={version:1,legacy:0,generic:0,completedAt:null};
 const legacy=join(dataRoot,'usage-ledger-v2/legacy.sqlite');
 if(existsSync(legacy)){
  const db=new DatabaseSync(legacy,{readOnly:true});
  try{if(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='ready'").get()?.value||'false')){
   const root=join(dataRoot,'monitor-index-v005.json.snapshots'),file=new Date().toISOString().replaceAll(':','-')+'-'+randomUUID()+'.json';mkdirSync(root,{recursive:true});
   const fd=openSync(join(root,file),'wx'),sha=createHash('sha256');
   const write=text=>{const bytes=Buffer.from(text);sha.update(bytes);let offset=0;while(offset<bytes.length)offset+=writeSync(fd,bytes,offset,bytes.length-offset);};
   try{write('{"version":1,"ledger":{');for(const[kind,index]of ['sessions','codex','claude','files'].map((x,i)=>[x,i])){
    write(index===3?'},"files":[':(index?',':'')+JSON.stringify(kind)+':[');let first=true;
    for(const row of db.prepare('SELECT key,value FROM facts WHERE kind=? ORDER BY seq').iterate(kind)){write((first?'':',')+'['+JSON.stringify(row.key)+','+row.value+']');first=false;result.legacy++;}write(']');
   }write(',"deltaFile":"monitor-deltas-v005-rollback-'+Date.now()+'.jsonl"}');fsyncSync(fd);}finally{closeSync(fd);}
   const log=openSync(join(root,'commits.jsonl'),'a');try{writeSync(log,'\n'+JSON.stringify({file,sha256:sha.digest('hex'),timestamp:new Date().toISOString()})+'\n');fsyncSync(log);}finally{closeSync(log);}result.legacySnapshot=join(root,file);
  }}finally{db.close();}
 }
 const generic=join(dataRoot,'usage-ledger-v2/generic.sqlite');
 if(existsSync(generic)){
  const db=new DatabaseSync(generic,{readOnly:true});try{if(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='ready'").get()?.value||'false')){
   const fd=openSync(join(dataRoot,'token-events-v1.jsonl'),'a');try{writeSync(fd,'\n');for(const row of db.prepare("SELECT value FROM facts WHERE kind='generic' ORDER BY seq").iterate()){writeSync(fd,row.value+'\n');result.generic++;}fsyncSync(fd);}finally{closeSync(fd);}
   const state=JSON.parse(db.prepare("SELECT value FROM meta WHERE key='state'").get()?.value||'{"files":[]}');
   await createSnapshotStorage(join(dataRoot,'token-index-v1.json'),{retainText:false,compactReceipt:true}).writeText(JSON.stringify({...state,version:1}));
  }}finally{db.close();}
 }
 result.completedAt=new Date().toISOString();return result;
}
