import {assertR95DatabaseCompatible} from './r95-data-compatibility.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

// One monitor owns this connection. Raw facts stay on disk; only bounded writes
// and the existing session/status summaries may remain in JavaScript.
export class UsageRepository {
 constructor(path){
  assertR95DatabaseCompatible(path,{versions:[2,3],writer:'r95-usage-v3'});mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);this.path=path;this.buffer=new Map();this.bufferBytes=0;this.commitGeneration=0;this.hintFloor=0;this.commitHints=[];this.groupCache=new Map();
  // Reject newer writers before any journal/schema changes or pending-row cleanup.
  if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()){
   const raw=this.db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get();
   if(raw){const version=JSON.parse(raw.value);if(![2,3].includes(version)){this.db.close();throw Error('Unsupported usage database version: '+version);}}
  }
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS facts(kind TEXT NOT NULL,key TEXT NOT NULL,grp TEXT NOT NULL,time REAL NOT NULL,seq INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT NOT NULL,UNIQUE(kind,key));
   CREATE INDEX IF NOT EXISTS facts_group ON facts(kind,grp,time,seq);
   CREATE TABLE IF NOT EXISTS pending(kind TEXT NOT NULL,key TEXT NOT NULL,grp TEXT NOT NULL,time REAL NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,key));
   CREATE TABLE IF NOT EXISTS changes(kind TEXT NOT NULL,grp TEXT NOT NULL,PRIMARY KEY(kind,grp));`);
  const schema=this.meta('schemaVersion');if(schema!==undefined&&![2,3].includes(schema)){this.db.close();throw Error('Unsupported usage database version: '+schema);}this.meta('schemaVersion',3);this.meta('minimumWriter','r95-usage-v3');
  if(schema===2)this.meta('r95Migration',{from:2,to:3,at:Date.now(),historicalRewards:'baseline-only'});
  // Unpublished rows have no committed file cursor. Replay from the last cursor.
  this.db.exec('DELETE FROM pending');
  this.db.function('buddy_locale_compare',{deterministic:true},(a,b)=>String(a).localeCompare(String(b)));
  this.statements={get:this.db.prepare('SELECT value FROM pending WHERE kind=? AND key=? UNION ALL SELECT value FROM facts WHERE kind=? AND key=? LIMIT 1'),put:this.db.prepare('INSERT INTO pending VALUES(?,?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET grp=excluded.grp,time=excluded.time,value=excluded.value')};
 }
 meta(key,value){if(arguments.length===2){this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));return value;}const r=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);return r?JSON.parse(r.value):undefined;}
 transaction(fn){this.db.exec('SAVEPOINT buddy_write');try{const r=fn();this.db.exec('RELEASE buddy_write');return r;}catch(e){try{this.db.exec('ROLLBACK TO buddy_write; RELEASE buddy_write');}finally{this.groupCache.clear();this.commitHints=[];this.hintFloor=++this.commitGeneration;}throw e;}}
 invalidateGroupCache(kind,key,group,oldGroup){
  const affected=[...this.groupCache.keys()].filter(cacheKey=>JSON.parse(cacheKey).includes(kind));if(!affected.length)return;
  if(arguments.length<4)oldGroup=this.buffer.get(kind+'\0'+key)?.grp??this.db.prepare('SELECT grp FROM pending WHERE kind=? AND key=? UNION ALL SELECT grp FROM facts WHERE kind=? AND key=? LIMIT 1').get(kind,key,kind,key)?.grp;
  if(oldGroup===group)return;
  // Appending to an existing kind/group cannot change its earliest seq or rank.
  // A move or the first row of a kind/group can, including multi-kind listings.
  if(oldGroup==null&&this.db.prepare('SELECT 1 FROM facts WHERE kind=? AND grp=? LIMIT 1').get(kind,group))return;
  for(const cacheKey of affected)this.groupCache.delete(cacheKey);
 }
 put(kind,key,value){const group=value.session??(value.tool+':'+value.sessionId);this.invalidateGroupCache(kind,key,group);const text=JSON.stringify(value),id=kind+'\0'+key,old=this.buffer.get(id);this.bufferBytes-=old?.text.length||0;this.buffer.set(id,{kind,key,text,grp:group,time:Date.parse(value.timestamp)||0});this.bufferBytes+=text.length;if(this.buffer.size>=500||this.bufferBytes>=2*1024*1024)this.flush();}
 get(kind,key){const b=this.buffer.get(kind+'\0'+key);if(b)return JSON.parse(b.text);const r=this.statements.get.get(kind,key,kind,key);return r?JSON.parse(r.value):undefined;}
 flush(){if(!this.buffer.size)return;this.transaction(()=>{for(const r of this.buffer.values())this.statements.put.run(r.kind,r.key,r.grp,r.time,r.text);});this.buffer.clear();this.bufferBytes=0;}
 publish(metadata={},changedGroups=[]){this.flush();let hints=[];this.transaction(()=>{hints=this.db.prepare('SELECT p.kind,p.key,p.grp,p.time,p.value,f.grp AS oldGroup,f.value AS oldValue FROM pending p LEFT JOIN facts f ON f.kind=p.kind AND f.key=p.key LIMIT 513').all();if(hints.length>512)this.groupCache.clear();else for(const row of hints)this.invalidateGroupCache(row.kind,row.key,row.grp,row.oldGroup);this.db.exec(`
  INSERT OR IGNORE INTO changes SELECT f.kind,f.grp FROM facts f JOIN pending p ON p.kind=f.kind AND p.key=f.key WHERE f.kind IN ('codex','claude','generic');
  INSERT OR IGNORE INTO changes SELECT kind,grp FROM pending WHERE kind IN ('codex','claude','generic');
  INSERT INTO facts(kind,key,grp,time,value) SELECT kind,key,grp,time,value FROM pending WHERE true ON CONFLICT(kind,key) DO UPDATE SET grp=excluded.grp,time=excluded.time,value=excluded.value; DELETE FROM pending;`);for(const grp of changedGroups)this.db.prepare("INSERT OR IGNORE INTO changes VALUES('session',?)").run(grp);for(const[k,v]of Object.entries(metadata))this.meta(k,v);if(hints.length<=512){const committed=this.db.prepare('SELECT seq FROM facts WHERE kind=? AND key=?');for(const row of hints)row.seq=committed.get(row.kind,row.key)?.seq;}});
  const generation=++this.commitGeneration;
  // Hints never cross an external transaction, restart, or bounded-history gap.
  if(this.db.isTransaction||hints.length>512||hints.reduce((n,r)=>n+r.value.length+(r.oldValue?.length??0),0)>2*1024*1024){this.commitHints=[];this.hintFloor=generation;return;}
  this.commitHints.push({generation,rows:hints});
  while(this.commitHints.length>32||this.commitHints.reduce((n,h)=>n+h.rows.length,0)>512||this.commitHints.reduce((n,h)=>n+h.rows.reduce((bytes,r)=>bytes+r.value.length+(r.oldValue?.length??0),0),0)>2*1024*1024){const removed=this.commitHints.shift();this.hintFloor=removed.generation;}
 }
 mutationSummary(kind,group,since){
  if(!Number.isSafeInteger(since)||since<=this.hintFloor||this.buffer.size||this.db.prepare('SELECT 1 FROM pending WHERE kind=? LIMIT 1').get(kind))return null;
  const rows=[];for(const hint of this.commitHints)if(hint.generation>since)for(const row of hint.rows)if(row.kind===kind&&(row.grp===group||row.oldGroup===group)){if(row.oldValue!==null)return null;rows.push([row.key,JSON.parse(row.value),row.seq]);}
  return rows;
 }

 *changedGroups(){for(const row of this.db.prepare('SELECT DISTINCT grp FROM changes ORDER BY rowid').iterate())yield row.grp;}
 acknowledgeChanges(){this.db.exec('DELETE FROM changes');}
 discardPending(){this.groupCache.clear();this.commitHints=[];this.hintFloor=++this.commitGeneration;this.buffer.clear();this.bufferBytes=0;this.db.exec('DELETE FROM pending');}
 *entries(kind,{group,ordered=false,tieRequest=false}={}){
  this.flush();const where=group===undefined?'kind=?':'kind=? AND grp=?',args=group===undefined?[kind]:[kind,group];
  // A move out of this group still shadows its committed fact: inspect the whole kind.
  if(!this.db.prepare('SELECT 1 FROM pending WHERE kind=? LIMIT 1').get(kind)){
   const sql=`SELECT key,value,grp,time,seq${ordered&&tieRequest?",json_extract(value,'$.requestId') AS requestId":''} FROM facts WHERE ${where} ORDER BY ${ordered?(group===undefined?'grp,time,seq':'time,seq'):'seq,key'}`;
   if(!ordered||!tieRequest){for(const r of this.db.prepare(sql).iterate(...args))yield [r.key,JSON.parse(r.value)];return;}
   let run=[],last;const drain=function*(){run.sort((a,b)=>String(a.requestId).localeCompare(String(b.requestId))||a.seq-b.seq);for(const r of run)yield [r.key,JSON.parse(r.value)];};
   for(const r of this.db.prepare(sql).iterate(...args)){if(last&&(last.grp!==r.grp||last.time!==r.time)){yield*drain();run=[];}run.push(r);last=r;}yield*drain();return;
  }
  const rows=`SELECT f.key,f.value,f.grp,f.time,f.seq FROM facts f WHERE ${where} AND NOT EXISTS(SELECT 1 FROM pending p WHERE p.kind=f.kind AND p.key=f.key) UNION ALL SELECT key,value,grp,time,COALESCE((SELECT seq FROM facts f2 WHERE f2.kind=pending.kind AND f2.key=pending.key),4611686018427387904+pending.rowid) FROM pending WHERE ${where}`;
  // Preserve the old Intl ordering for cumulative records sharing a timestamp.
  // Ranking lives in SQLite, so even a large tie does not retain a JS array.
  const sql=ordered&&tieRequest?`WITH rows AS MATERIALIZED (${rows}), ranked AS (SELECT *,COUNT(*) OVER(PARTITION BY grp,time) AS ties FROM rows) SELECT r.key,r.value FROM ranked r ORDER BY r.grp,r.time,CASE WHEN ties>1 THEN (SELECT COUNT(*) FROM rows t WHERE t.grp=r.grp AND t.time=r.time AND buddy_locale_compare(json_extract(t.value,'$.requestId'),json_extract(r.value,'$.requestId'))<0) ELSE 0 END,r.seq`:`SELECT key,value FROM (${rows}) ${ordered?'ORDER BY grp,time,seq':'ORDER BY seq,key'}`;
  for(const r of this.db.prepare(sql).iterate(...args,...args))yield [r.key,JSON.parse(r.value)];
 }
 *groups(kinds){this.flush();const cacheKey=JSON.stringify(kinds),cacheable=!this.db.isTransaction;if(cacheable&&this.groupCache.has(cacheKey)){yield*this.groupCache.get(cacheKey);return;}const groups=[];const rank='CASE kind '+kinds.map((_,i)=>`WHEN ? THEN ${i}`).join(' ')+' END';for(const r of this.db.prepare(`SELECT grp FROM (SELECT grp,seq,${rank} AS rank FROM facts WHERE kind IN (${kinds.map(()=>'?')}) UNION ALL SELECT grp,9223372036854775807,${rank} FROM pending WHERE kind IN (${kinds.map(()=>'?')})) GROUP BY grp ORDER BY MIN(rank),MIN(seq),grp`).iterate(...kinds,...kinds,...kinds,...kinds))groups.push(r.grp);if(cacheable)this.groupCache.set(cacheKey,groups);yield*groups;}
 map(kind){const repo=this;return {get:k=>repo.get(kind,k),has:k=>repo.get(kind,k)!==undefined,set(k,v){repo.put(kind,k,v);return this;},*entries(){yield*repo.entries(kind);},*[Symbol.iterator](){yield*repo.entries(kind);},*values(){for(const[,v]of repo.entries(kind))yield v;},*keys(){for(const[k]of repo.entries(kind))yield k;},get size(){repo.flush();return repo.db.prepare('SELECT COUNT(*) AS n FROM (SELECT key FROM facts WHERE kind=? UNION SELECT key FROM pending WHERE kind=?)').get(kind,kind).n;}};}
 close(){if(this.closed)return;this.flush();this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');this.db.close();this.closed=true;}
}
