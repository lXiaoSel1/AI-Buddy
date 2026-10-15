import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

// One monitor owns this connection. Raw facts stay on disk; only bounded writes
// and the existing session/status summaries may remain in JavaScript.
export class UsageRepository {
 constructor(path){
  mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);this.path=path;this.buffer=new Map();this.bufferBytes=0;
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS facts(kind TEXT NOT NULL,key TEXT NOT NULL,grp TEXT NOT NULL,time REAL NOT NULL,seq INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT NOT NULL,UNIQUE(kind,key));
   CREATE INDEX IF NOT EXISTS facts_group ON facts(kind,grp,time,seq);
   CREATE TABLE IF NOT EXISTS pending(kind TEXT NOT NULL,key TEXT NOT NULL,grp TEXT NOT NULL,time REAL NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,key));
   CREATE TABLE IF NOT EXISTS changes(kind TEXT NOT NULL,grp TEXT NOT NULL,PRIMARY KEY(kind,grp));`);
  const schema=this.meta('schemaVersion');if(schema!==undefined&&schema!==2){this.db.close();throw Error('Unsupported usage database version: '+schema);}this.meta('schemaVersion',2);
  // Unpublished rows have no committed file cursor. Replay from the last cursor.
  this.db.exec('DELETE FROM pending');
  this.db.function('buddy_locale_compare',{deterministic:true},(a,b)=>String(a).localeCompare(String(b)));
  this.statements={get:this.db.prepare('SELECT value FROM pending WHERE kind=? AND key=? UNION ALL SELECT value FROM facts WHERE kind=? AND key=? LIMIT 1'),put:this.db.prepare('INSERT INTO pending VALUES(?,?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET grp=excluded.grp,time=excluded.time,value=excluded.value')};
 }
 meta(key,value){if(arguments.length===2){this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));return value;}const r=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);return r?JSON.parse(r.value):undefined;}
 transaction(fn){this.db.exec('SAVEPOINT buddy_write');try{const r=fn();this.db.exec('RELEASE buddy_write');return r;}catch(e){this.db.exec('ROLLBACK TO buddy_write; RELEASE buddy_write');throw e;}}
 put(kind,key,value){const text=JSON.stringify(value),id=kind+'\0'+key,old=this.buffer.get(id);this.bufferBytes-=old?.text.length||0;this.buffer.set(id,{kind,key,text,grp:value.session??(value.tool+':'+value.sessionId),time:Date.parse(value.timestamp)||0});this.bufferBytes+=text.length;if(this.buffer.size>=500||this.bufferBytes>=2*1024*1024)this.flush();}
 get(kind,key){const b=this.buffer.get(kind+'\0'+key);if(b)return JSON.parse(b.text);const r=this.statements.get.get(kind,key,kind,key);return r?JSON.parse(r.value):undefined;}
 flush(){if(!this.buffer.size)return;this.transaction(()=>{for(const r of this.buffer.values())this.statements.put.run(r.kind,r.key,r.grp,r.time,r.text);});this.buffer.clear();this.bufferBytes=0;}
 publish(metadata={},changedGroups=[]){this.flush();this.transaction(()=>{this.db.exec(`
  INSERT OR IGNORE INTO changes SELECT f.kind,f.grp FROM facts f JOIN pending p ON p.kind=f.kind AND p.key=f.key WHERE f.kind IN ('codex','claude','generic');
  INSERT OR IGNORE INTO changes SELECT kind,grp FROM pending WHERE kind IN ('codex','claude','generic');
  INSERT INTO facts(kind,key,grp,time,value) SELECT kind,key,grp,time,value FROM pending WHERE true ON CONFLICT(kind,key) DO UPDATE SET grp=excluded.grp,time=excluded.time,value=excluded.value; DELETE FROM pending;`);for(const grp of changedGroups)this.db.prepare("INSERT OR IGNORE INTO changes VALUES('session',?)").run(grp);for(const[k,v]of Object.entries(metadata))this.meta(k,v);});}
 *changedGroups(){for(const row of this.db.prepare('SELECT DISTINCT grp FROM changes ORDER BY rowid').iterate())yield row.grp;}
 acknowledgeChanges(){this.db.exec('DELETE FROM changes');}
 discardPending(){this.buffer.clear();this.bufferBytes=0;this.db.exec('DELETE FROM pending');}
 *entries(kind,{group,ordered=false,tieRequest=false}={}){
  this.flush();const where=group===undefined?'kind=?':'kind=? AND grp=?',args=group===undefined?[kind]:[kind,group];
  const rows=`SELECT f.key,f.value,f.grp,f.time,f.seq FROM facts f WHERE ${where} AND NOT EXISTS(SELECT 1 FROM pending p WHERE p.kind=f.kind AND p.key=f.key) UNION ALL SELECT key,value,grp,time,COALESCE((SELECT seq FROM facts f2 WHERE f2.kind=pending.kind AND f2.key=pending.key),4611686018427387904+pending.rowid) FROM pending WHERE ${where}`;
  // Preserve the old Intl ordering for cumulative records sharing a timestamp.
  // Ranking lives in SQLite, so even a large tie does not retain a JS array.
  const sql=ordered&&tieRequest?`WITH rows AS MATERIALIZED (${rows}), ranked AS (SELECT *,COUNT(*) OVER(PARTITION BY grp,time) AS ties FROM rows) SELECT r.key,r.value FROM ranked r ORDER BY r.grp,r.time,CASE WHEN ties>1 THEN (SELECT COUNT(*) FROM rows t WHERE t.grp=r.grp AND t.time=r.time AND buddy_locale_compare(json_extract(t.value,'$.requestId'),json_extract(r.value,'$.requestId'))<0) ELSE 0 END,r.seq`:`SELECT key,value FROM (${rows}) ${ordered?'ORDER BY grp,time,seq':'ORDER BY seq,key'}`;
  for(const r of this.db.prepare(sql).iterate(...args,...args))yield [r.key,JSON.parse(r.value)];
 }
 *groups(kinds){this.flush();const rank='CASE kind '+kinds.map((_,i)=>`WHEN ? THEN ${i}`).join(' ')+' END';for(const r of this.db.prepare(`SELECT grp FROM (SELECT grp,seq,${rank} AS rank FROM facts WHERE kind IN (${kinds.map(()=>'?')}) UNION ALL SELECT grp,9223372036854775807,${rank} FROM pending WHERE kind IN (${kinds.map(()=>'?')})) GROUP BY grp ORDER BY MIN(rank),MIN(seq),grp`).iterate(...kinds,...kinds,...kinds,...kinds))yield r.grp;}
 map(kind){const repo=this;return {get:k=>repo.get(kind,k),has:k=>repo.get(kind,k)!==undefined,set(k,v){repo.put(kind,k,v);return this;},*entries(){yield*repo.entries(kind);},*[Symbol.iterator](){yield*repo.entries(kind);},*values(){for(const[,v]of repo.entries(kind))yield v;},*keys(){for(const[k]of repo.entries(kind))yield k;},get size(){repo.flush();return repo.db.prepare('SELECT COUNT(*) AS n FROM (SELECT key FROM facts WHERE kind=? UNION SELECT key FROM pending WHERE kind=?)').get(kind,kind).n;}};}
 close(){if(this.closed)return;this.flush();this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');this.db.close();this.closed=true;}
}
