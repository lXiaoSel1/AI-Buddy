import {createReadStream} from 'node:fs';
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,basename} from 'node:path';
import {monitorDeltaRows,orphanMonitorDeltas} from './monitor-cache.mjs';
async function digest(path,end){const h=createHash('sha256');for await(const b of createReadStream(path,end===undefined?{}:{end}))h.update(b);return h.digest('hex');}
async function committed(dataRoot,name){const root=join(dataRoot,name+'.snapshots');let lines;try{lines=(await readFile(join(root,'commits.jsonl'),'utf8')).split('\n');}catch(e){if(e.code==='ENOENT')return null;throw e;}for(const line of lines.reverse()){let c;try{c=JSON.parse(line);if(basename(c.file)!==c.file)continue;const path=join(root,c.file);if(await digest(path)===c.sha256)return {...c,path,size:(await stat(path)).size};}catch{}}return null;}
export async function migrateLegacy(repo,dataRoot){
 if(repo.meta('ready'))return {mode:'sqlite',sessions:new Map(repo.entries('sessions')),files:new Map(repo.entries('files'))};
 // A partial transaction only touches pending. Completed import batches are
 // durable but the database is not advertised as ready until all hashes match.
 const current=await committed(dataRoot,'monitor-index-v005.json'),source=current||await committed(dataRoot,'monitor-index-v004.json');
 const identity=source?.sha256||'empty';
 // Restart incomplete imports from stable keys, never from an arbitrary byte in JSON.
 repo.transaction(()=>{repo.db.exec('DELETE FROM facts; DELETE FROM pending; DELETE FROM changes');repo.meta('migrationIdentity',identity);});
 let deltaFile,transactions=0,invalid=0,entries=0;
 async function importFile(path,size,isBase=false){
  const hashBefore=await digest(path,size-1);let completed=0,batchRows=0,batchBytes=0;
  repo.db.exec('BEGIN');
  try{
  for await(const item of monitorDeltaRows(path,{streamEntries:true,end:size-1})){
   if(item.begin)repo.discardPending();
   if(item.invalid){invalid++;repo.discardPending();}
   if(item.entry){let{kind,key,value}=item.entry;
    if(kind==='codex')key=value.session+':'+createHash('sha256').update(JSON.stringify([value.timestamp,value.usage.input,value.usage.output,value.usage.cacheRead,value.usage.reasoning])).digest('hex');
    repo.put(kind,key,value);entries++;batchRows++;batchBytes+=JSON.stringify(value).length;
    if(batchRows>=500||batchBytes>=2*1024*1024){repo.flush();repo.meta('migrationProgress',{path,entries,transactions});repo.db.exec('COMMIT; BEGIN');batchRows=0;batchBytes=0;await new Promise(r=>setImmediate(r));}
   }
   if(item.row){repo.publish({'migrationProgress':{path,entries,transactions:++transactions}});completed++;if(item.row.deltaFile)deltaFile=item.row.deltaFile;}
  }
  repo.discardPending();if(isBase&&!completed)throw Error('历史快照不完整，保留旧索引');
  if(await digest(path,size-1)!==hashBefore)throw Error('历史索引在迁移期间被改写，请重试');
  repo.db.exec('COMMIT');
  }catch(e){repo.db.exec('ROLLBACK');repo.discardPending();throw e;}
  return {path,bytes:size,sha256:hashBefore,transactions:completed};
 }
 const inputs=[];
 if(source){inputs.push(await importFile(source.path,source.size,true));if(inputs[0].sha256!==source.sha256)throw Error('历史快照校验失败');}
 // v004 file offsets cannot be trusted for v005 parsing. Preserve its facts,
 // then recover every valid orphan delta exactly as the previous monitor did.
 const deltas=current?(deltaFile?[deltaFile]:[]):[...new Set([...(deltaFile?[deltaFile]:[]),...await orphanMonitorDeltas(dataRoot)])];
 if(!current)repo.db.exec("DELETE FROM facts WHERE kind='files'");
 for(const name of deltas){if(basename(name)!==name)throw Error('Invalid index delta');const path=join(dataRoot,name);let size;try{size=(await stat(path)).size;}catch(e){if(e.code==='ENOENT')continue;throw e;}if(size)inputs.push(await importFile(path,size));}
 repo.publish({ready:true,migration:{version:2,inputs,entries,transactions,invalid,completedAt:new Date().toISOString()}});
 return {mode:source?'sqlite-migration':'cold',sessions:new Map(repo.entries('sessions')),files:new Map(repo.entries('files')),invalid};
}
