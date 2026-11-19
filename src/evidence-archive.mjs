import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,statSync} from 'node:fs';
import {dirname} from 'node:path';

function withRead(path,work){
 try{statSync(path);}
 catch(error){if(error.code==='ENOENT')return null;throw error;}
 const db=new DatabaseSync(path,{readOnly:true,timeout:0});
 try{return work(db);}
 finally{db.close();}
}

export function hasArchivedAutoAuthorization(path,groupId,id){
 return !!withRead(path,db=>db.prepare('SELECT 1 FROM records WHERE namespace=? AND id=?').get('auto-authorizations:'+groupId,id));
}

// No database is created for a miss. The companion's worker owns its WAL
// writer; synchronous clients of other evidence archives keep their own mode.
export function createEvidenceArchive(path,{readOnly=false,wal=false,persistent=false}={}){
 let writer;
 function openWriter(){
  mkdirSync(dirname(path),{recursive:true});
  const db=new DatabaseSync(path,{timeout:wal?1000:0});
  try{
   if(wal){
    if(db.prepare('PRAGMA journal_mode=WAL').get().journal_mode!=='wal')throw Error('Evidence archive WAL is unavailable');
    // An Auto receipt must survive a power loss before the primary deletion.
    db.exec('PRAGMA synchronous=FULL');
   }
   db.exec('CREATE TABLE IF NOT EXISTS records(namespace TEXT,id TEXT,value TEXT NOT NULL,PRIMARY KEY(namespace,id))');
   return db;
  }catch(error){db.close();throw error;}
 }
 function write(rows){
  if(readOnly)throw Error('This evidence archive is read-only');
  if(!rows.length)return;
  const db=persistent?(writer??=openWriter()):openWriter();
  try{
   db.exec('BEGIN IMMEDIATE');
   try{
    const insert=db.prepare('INSERT OR IGNORE INTO records VALUES(?,?,?)');
    for(const row of rows)insert.run(row.namespace,row.id,JSON.stringify(row.value));
    db.exec('COMMIT');
   }catch(error){db.exec('ROLLBACK');throw error;}
  }finally{if(!persistent)db.close();}
 }
 const read=work=>writer?work(writer):withRead(path,work);
 return {
  putMany:write,
  get(namespace,id){return read(db=>{const row=db.prepare('SELECT value FROM records WHERE namespace=? AND id=?').get(namespace,id);return row?JSON.parse(row.value):null;});},
  lastByPrefix(namespace,prefix){return read(db=>{const row=db.prepare('SELECT value FROM records WHERE namespace=? AND id>=? AND id<? ORDER BY id DESC LIMIT 1').get(namespace,prefix,prefix+'\uffff');return row?JSON.parse(row.value):null;});},
  close(){writer?.close();writer=undefined;}
 };
}
