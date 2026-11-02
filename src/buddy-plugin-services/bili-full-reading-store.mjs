import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,openSync,fsyncSync,closeSync,existsSync,lstatSync,readdirSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {writeBiliReadingAtomic} from './bili-reading-storage.mjs';

const fail=code=>Object.assign(Error(code),{code});
const need=(v,code)=>{if(!v)throw fail(code);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fixedKeys=['schemaVersion','readingMode','readingId','scope','scopeHash','owner','video','parts','availableParts','config','model','sheets','cues','units','planHash','estimatedCalls','createdAt'];
const fixedSet=new Set(fixedKeys);
const duplicateKeys=new Set(['schemaVersion','readingMode','readingId','scopeHash','owner']);
const folders={'source-plan':'source-plans',request:'requests',receipt:'receipts',note:'notes','frame-map':'frame-maps'};
const version=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;}

export function fullReadingUnits(source,checkpoint){
 const done=new Set(checkpoint.completedUnitIds??[]);let units=source.units;
 for(const budget of checkpoint.pageBudgets??[]){need(Number.isSafeInteger(budget)&&budget>=256,'BILI_FULL_CHECKPOINT_INVALID');units=units.flatMap(unit=>{if(unit.kind!=='text'||done.has(unit.id)||unit.item.text.length<=budget)return [unit];const out=[];for(let at=0;at<unit.item.text.length;){let end=Math.min(unit.item.text.length,at+budget);if(end<unit.item.text.length&&/[\uD800-\uDBFF]/.test(unit.item.text[end-1]))end--;const item={...unit.item,charStart:unit.item.charStart+at,charEnd:unit.item.charStart+end,text:unit.item.text.slice(at,end)};item.id=item.cueId+'@'+item.charStart+'-'+item.charEnd;item.spanSha256=hash(item.text);out.push({...unit,id:item.id,item});at=end;}return out;});}
 return units;
}

/** Immutable source/receipts are published once. Only the small mutable index is
 * replaced. There is one immutable source cache; every checkpoint is read from
 * disk, then its identity/owner/version is checked against the hashed source. */
export function createBiliFullReadingStore({directory,onWrite=()=>{},budget={limit:2*1024*1024*1024,used:0}}){
 need(isAbsolute(directory??''),'BILI_FULL_DIRECTORY_REQUIRED');const records=join(directory,'readings');mkdirSync(records,{recursive:true});for(const folder of Object.values(folders))mkdirSync(join(directory,folder),{recursive:true});let cachedSource=null;
 for(const folder of [records,...Object.values(folders).map(name=>join(directory,name))])for(const name of readdirSync(folder)){if(!name.endsWith('.json'))continue;const stat=lstatSync(join(folder,name));need(stat.isFile()&&!stat.isSymbolicLink(),'BILI_VISION_CACHE_INVALID');budget.used+=stat.size;}
 const file=id=>{need(typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id),'BILI_VISION_READING_INVALID');return join(records,id+'.json');};
 function objectPath(kind,sha256){need(Object.hasOwn(folders,kind)&&/^[a-f0-9]{64}$/.test(sha256),'BILI_FULL_REFERENCE_INVALID');return join(directory,folders[kind],sha256+'.json');}
 function get(kind,sha256){const path=objectPath(kind,sha256),stat=lstatSync(path);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=256*1024*1024,'BILI_FULL_SOURCE_MISMATCH');if(kind==='source-plan'&&cachedSource?.sha256===sha256&&cachedSource.version===version(stat))return cachedSource.value;const bytes=readFileSync(path);need(hash(bytes)===sha256,'BILI_FULL_SOURCE_MISMATCH');let value;try{value=JSON.parse(bytes);}catch{throw fail('BILI_FULL_SOURCE_MISMATCH');}if(kind==='source-plan'){value=freeze(value);cachedSource={sha256,version:version(stat),value};}return value;}
 function put(kind,value){const bytes=Buffer.from(JSON.stringify(value)),sha256=hash(bytes),path=objectPath(kind,sha256);need(bytes.length<=256*1024*1024,'BILI_FULL_STORAGE_PAUSED');if(existsSync(path)){get(kind,sha256);return sha256;}need(budget.used+bytes.length<=budget.limit,'BILI_FULL_STORAGE_PAUSED');try{writeFileSync(path,bytes,{flag:'wx'});budget.used+=bytes.length;const fd=openSync(path,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}onWrite({kind,sha256,bytes:bytes.length});}catch(error){if(error.code!=='EEXIST')throw error;get(kind,sha256);}return sha256;}
 function save(row){
  if(!row.sourcePlanHash){const source=Object.fromEntries(fixedKeys.filter(k=>row[k]!==undefined).map(k=>[k,row[k]]));source.baseTextBudget=row.textBudget;row.sourcePlanHash=put('source-plan',source);}
  const value=Object.fromEntries(Object.entries(row).filter(([k])=>!fixedSet.has(k)||duplicateKeys.has(k)));
  // Current prepared material is bounded. Previously submitted raw requests and
  // provider results must live in immutable receipts, never in every checkpoint.
  need((value.batches??[]).every(b=>b.material===undefined&&b.result===undefined),'BILI_FULL_CHECKPOINT_RAW_DENIED');
  need((value.summaryNodes??[]).every(n=>n.text===undefined&&typeof n.textRef==='string'),'BILI_FULL_CHECKPOINT_RAW_DENIED');
  const bytes=JSON.stringify(value),path=file(row.readingId),size=Buffer.byteLength(bytes),beforeStat=existsSync(path)?lstatSync(path):null;need(!beforeStat||beforeStat.isFile()&&!beforeStat.isSymbolicLink(),'BILI_FULL_CHECKPOINT_INVALID');const before=beforeStat?.size??0;need(budget.used+size-before<=budget.limit,'BILI_FULL_STORAGE_PAUSED');writeBiliReadingAtomic(path,bytes);budget.used+=size-before;onWrite({kind:'checkpoint',readingId:row.readingId,bytes:size});
 }
 function load(id){
  let checkpoint;try{const path=file(id),stat=lstatSync(path);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=256*1024*1024,'BILI_FULL_CHECKPOINT_INVALID');checkpoint=JSON.parse(readFileSync(path,'utf8'));}catch(error){if(error.code?.startsWith('BILI_'))throw error;throw fail('BILI_VISION_READING_UNAVAILABLE');}
  need(checkpoint.readingId===id&&checkpoint.readingMode==='full-v1'&&checkpoint.schemaVersion===1&&typeof checkpoint.sourcePlanHash==='string','BILI_FULL_CHECKPOINT_INVALID');
  need(Object.keys(checkpoint).every(k=>!fixedSet.has(k)||duplicateKeys.has(k)),'BILI_FULL_CHECKPOINT_INVALID');
  const source=get('source-plan',checkpoint.sourcePlanHash);
  need(source.schemaVersion===checkpoint.schemaVersion&&source.readingMode===checkpoint.readingMode&&source.readingId===id&&source.scopeHash===checkpoint.scopeHash&&JSON.stringify(source.owner)===JSON.stringify(checkpoint.owner),'BILI_VISION_SCOPE_DENIED');
  return {...source,...checkpoint,units:fullReadingUnits(source,checkpoint)};
 }
 return {file,load,save,put,get};
}
