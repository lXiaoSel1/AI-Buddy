import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

// Immutable evidence is kept outside frequently copied state. Connections are
// short-lived; eviction is rare and never silently discards a failed write.
export function createEvidenceArchive(path){
 function withDb(work){mkdirSync(dirname(path),{recursive:true});const db=new DatabaseSync(path);try{db.exec('CREATE TABLE IF NOT EXISTS records(namespace TEXT,id TEXT,value TEXT NOT NULL,PRIMARY KEY(namespace,id))');return work(db);}finally{db.close();}}
 return {
  putMany(rows){if(!rows.length)return;withDb(db=>{db.exec('BEGIN IMMEDIATE');try{const insert=db.prepare('INSERT OR IGNORE INTO records VALUES(?,?,?)');for(const row of rows)insert.run(row.namespace,row.id,JSON.stringify(row.value));db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}});},
  get(namespace,id){return withDb(db=>{const row=db.prepare('SELECT value FROM records WHERE namespace=? AND id=?').get(namespace,id);return row?JSON.parse(row.value):null;});},
 };
}
