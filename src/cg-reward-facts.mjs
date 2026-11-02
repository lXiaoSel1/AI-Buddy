import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,existsSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';

const json=JSON.stringify,parse=value=>value==null?null:JSON.parse(value);
const digest=value=>createHash('sha256').update(json(value)).digest('hex');
const id=value=>{if(typeof value!=='string'||!value||value.length>512)throw Error('CG reward identity 无效');return value;};
const safe=n=>Number.isSafeInteger(n)&&n>=0;
const terminal=status=>['ready','failed','cancelled'].includes(status);
function frozenScope(value){
 if(value==null)return null;
 if(typeof value!=='object'||Array.isArray(value))throw Error('CG reward scope 无效');
 return Object.fromEntries(['characterId','personaId','lifeId','operationId'].map(key=>[key,id(value[key])]));
}
// Missing usage is unknown, never zero. Only documented count fields are used;
// image counts, prices, estimates and model prose cannot become actual tokens.
export function cgUsageTotal(row){
 const value=row?.usage??{},totals=['total_tokens','totalTokens','total','totalTokenCount'].filter(key=>value[key]!=null).map(key=>value[key]);
 if(totals.length){if(totals.some(n=>!safe(n))||new Set(totals).size!==1)throw Error('CG usage 总量无效或互相冲突');return totals[0];}
 const input=value.input_tokens??value.inputTokens??value.prompt_tokens??value.promptTokenCount,output=value.output_tokens??value.outputTokens??value.completion_tokens??value.candidatesTokenCount;
 if(input==null||output==null)return null;
 if(!safe(input)||!safe(output)||!safe(input+output))throw Error('CG usage 输入输出无效');
 return input+output;
}
function compatibility(db){
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();if(!tables.length)return;
 if(!tables.some(row=>row.name==='meta'))throw Error('Unsupported CG reward schema 版本');
 const schema=db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get(),writer=db.prepare("SELECT value FROM meta WHERE key='minimumWriter'").get();
 if(schema&&parse(schema.value)!==1)throw Error('Unsupported CG reward schema 版本');
 if(writer&&parse(writer.value)!=='r95-cg-rewards-v1')throw Error('Unsupported CG reward minimum writer');
}

// Core-only, durable reward projection. This is not the token/fee ledger and
// does not publish activity. Actual accounting remains on the original path.
export function createCgRewardFacts({dataRoot,onRewardFact=null,now=Date.now,ackTimeoutMs=5000}={}){
 if(!isAbsolute(dataRoot??''))throw Error('CG reward 资料目录须为绝对路径');
 const directory=join(dataRoot,'companion-economy-v1'),path=join(directory,'cg-reward-facts.sqlite');
 if(existsSync(path)){const reader=new DatabaseSync(path,{readOnly:true});try{compatibility(reader);}finally{reader.close();}}
 mkdirSync(directory,{recursive:true});const db=new DatabaseSync(path);try{compatibility(db);}catch(error){db.close();throw error;}let closed=false,closing=false,draining=null,lastError=null;
 db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
 const version=db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get();if(version&&parse(version.value)!==1){db.close();throw Error('Unsupported CG reward schema');}
 db.exec(`CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,scope TEXT,historical INTEGER NOT NULL,status TEXT,completed TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,fingerprint TEXT,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS receipts(job_id TEXT NOT NULL,receipt_id TEXT NOT NULL,revision INTEGER NOT NULL,total INTEGER NOT NULL,fingerprint TEXT NOT NULL,provider TEXT,source_id TEXT,occurred_at TEXT,PRIMARY KEY(job_id,receipt_id));
 CREATE TABLE IF NOT EXISTS outbox(job_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,ack INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(job_id,revision));`);
 db.prepare("INSERT OR IGNORE INTO meta VALUES('schemaVersion','1')").run();db.prepare("INSERT OR IGNORE INTO meta VALUES('minimumWriter','\"r95-cg-rewards-v1\"')").run();
 function check(){if(closed||closing)throw Error('CG reward journal 已关闭');}
 function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}
 const jobRow=jobId=>db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
 function register(job,{historical=false}={}){
  const jobId=id(job?.id),scope=frozenScope(job.rewardScope),old=jobRow(jobId);
  if(old){if(job.rewardScope!==undefined&&json(parse(old.scope))!==json(scope))throw Error('CG reward scope 归属已冻结');return old;}
  db.prepare('INSERT INTO jobs(id,scope,historical,status,completed,created_at) VALUES(?,?,?,?,?,?)').run(jobId,json(scope),historical?1:0,job.status??'queued','[]',now());return jobRow(jobId);
 }
 function project(row){
  if(row.historical)return {accepted:false,reason:'historical-baseline'};
  const receipts=db.prepare('SELECT * FROM receipts WHERE job_id=? ORDER BY receipt_id').all(row.id),completed=parse(row.completed),actual=receipts.reduce((n,item)=>n+item.total,0);
  if(!safe(actual))throw Error('CG usage 聚合超出安全范围');
  let basis,units;if(receipts.length){basis='actual';units=actual;}else if(row.status==='ready'&&completed.length){basis='cg-fallback';units=completed.length*1300;}else return {accepted:false,reason:'no-reported-usage-or-completed-image'};
  const evidence={jobId:row.id,completedImageIds:completed,receipts:receipts.map(v=>({id:v.receipt_id,revision:v.revision,total:v.total,provider:v.provider,sourceId:v.source_id})),usageCoverage:receipts.length?'reported-only':'not-provided'};
  const fingerprint=digest({basis,units,evidence});if(fingerprint===row.fingerprint)return {accepted:true,duplicate:true};
  const revision=row.revision+1,fact={canonicalRequestId:'cg:'+row.id,revision,basis,origin:'cg-job-reconciled',sourceId:'cg-jobs',occurredAt:new Date(now()).toISOString(),baseline:false,live:true,purpose:'cg',scope:parse(row.scope),evidenceRef:'cg-reward:'+row.id+':'+digest(evidence),...(basis==='actual'?{totalTokens:units}:{status:'ready',completedImageIds:completed})};
  db.prepare('INSERT INTO outbox(job_id,revision,payload) VALUES(?,?,?)').run(row.id,revision,json(fact));db.prepare('UPDATE jobs SET revision=?,fingerprint=? WHERE id=?').run(revision,fingerprint,row.id);return {accepted:true,fact};
 }
 function observe(job){
  let row=jobRow(id(job?.id));if(!row)row=register(job,{historical:terminal(job.status)});
  if(job.rewardScope!==undefined&&json(parse(row.scope))!==json(frozenScope(job.rewardScope)))throw Error('CG reward scope 归属已冻结');
  const completed=job.status==='ready'&&typeof job.sha256==='string'&&/^[a-f0-9]{64}$/i.test(job.sha256)&&typeof job.assetRef==='string'&&job.assetRef&&Number.isFinite(job.completedAt)?[job.id+':'+job.sha256]:parse(row.completed);
  db.prepare('UPDATE jobs SET status=?,completed=? WHERE id=?').run(job.status??row.status,json(completed),row.id);return project(jobRow(row.id));
 }
 async function drain(){
  if(closed)return {pending:0,lastError};if(draining)return draining;
  draining=(async()=>{
   if(typeof onRewardFact!=='function')return {pending:pending().length,lastError};
   while(!closed){const row=db.prepare('SELECT * FROM outbox WHERE ack=0 ORDER BY rowid LIMIT 1').get();if(!row)break;
    let timer;try{const result=await Promise.race([Promise.resolve().then(()=>onRewardFact(parse(row.payload))),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CG reward acknowledgement timeout')),ackTimeoutMs);})]);if(result?.accepted!==true){lastError='CG reward sink not ready';break;}db.prepare('UPDATE outbox SET ack=1 WHERE job_id=? AND revision=?').run(row.job_id,row.revision);lastError=null;}catch(error){lastError=String(error?.message??error).slice(0,300);break;}finally{clearTimeout(timer);}
   }
   return {pending:pending().length,lastError};
  })().finally(()=>{draining=null;});return draining;
 }
 function pending(){if(closed)return [];return db.prepare('SELECT payload FROM outbox WHERE ack=0 ORDER BY rowid').all().map(row=>parse(row.payload));}
 return {
  path,
  async initialize(jobs=[]){check();transaction(()=>{const first=!db.prepare("SELECT 1 FROM meta WHERE key='initializedAt'").get();for(const job of jobs){if(!jobRow(job.id))register(job,{historical:terminal(job.status)});observe(job);}if(first)db.prepare("INSERT INTO meta VALUES('initializedAt',?)").run(json(now()));});return drain();},
  registerJob(job){check();return transaction(()=>{const row=register(job);return {id:row.id,scope:parse(row.scope),historical:!!row.historical};});},
  async observeJob(job){check();const result=transaction(()=>observe(job));await drain();return result;},
  async recordUsage(value){check();const jobId=id(value?.cgJobId),row=jobRow(jobId);if(!row)return {accepted:false,reason:'unknown-cg-job'};
   if(value.scope!=null&&json(frozenScope(value.scope))!==json(parse(row.scope)))throw Error('CG usage scope 归属与任务不符');
   const receiptId=value.usageReceiptId;if(typeof receiptId!=='string'||!receiptId||receiptId.length>512)return {accepted:false,reason:'missing-request-identity'};
   const total=cgUsageTotal(value);if(total==null)return {accepted:false,reason:'usage-not-provided'};
   const result=transaction(()=>{const old=db.prepare('SELECT * FROM receipts WHERE job_id=? AND receipt_id=?').get(jobId,receiptId),revision=value.usageRevision??(old?.revision??0)+1;
    if(!safe(revision))throw Error('CG usage revision 无效');const fingerprint=digest({total,provider:value.provider??null,sourceId:value.sourceId??null});
    if(old){if(revision<old.revision)return {accepted:true,duplicate:true,ignoredRevision:true};if(fingerprint===old.fingerprint){if(revision>old.revision&&value.usageRevision!=null)db.prepare('UPDATE receipts SET revision=? WHERE job_id=? AND receipt_id=?').run(revision,jobId,receiptId);return {accepted:true,duplicate:true};}if(revision===old.revision)throw Error('CG usage revision 修订内容冲突');}
    db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(job_id,receipt_id) DO UPDATE SET revision=excluded.revision,total=excluded.total,fingerprint=excluded.fingerprint,provider=excluded.provider,source_id=excluded.source_id,occurred_at=excluded.occurred_at').run(jobId,receiptId,revision,total,fingerprint,value.provider??null,value.sourceId??null,value.timestamp??null);
    return project(jobRow(jobId));
   });await drain();return result;
  },
  pending,drain,
  inspect(jobId){const row=jobRow(id(jobId));return row?{id:row.id,historical:!!row.historical,scope:parse(row.scope),status:row.status,revision:row.revision,completedImageIds:parse(row.completed),receipts:db.prepare('SELECT receipt_id AS id,revision,total FROM receipts WHERE job_id=?').all(jobId)}:null;},
  status(){return {pending:pending().length,lastError};},
  async close(){if(closed)return;if(closing){await draining;return;}closing=true;await draining;db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();closed=true;}
 };
}
