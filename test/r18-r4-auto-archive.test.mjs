import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createCompanionAutoArchivePublisher} from '../src/companion-storage-worker-client.mjs';
import {hasArchivedAutoAuthorization} from '../src/evidence-archive.mjs';

test('the unmodified r4 evidence archive reads and writes an r18 WAL archive',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ai-buddy-r18-r4-auto-'));
 const archivePath=join(root,'galgame','auto-evidence.sqlite');
 const publisher=createCompanionAutoArchivePublisher(join(root,'galgame','companion.sqlite'));
 t.after(async()=>{try{await publisher.stop();}finally{await rm(root,{recursive:true,force:true});}});
 // The base64 fixture preserves the exact original source, including line endings.
 const source=(await readFile(new URL('./fixtures/r4-evidence-archive.base64',import.meta.url),'utf8')).trim();
 const sha=createHash('sha256').update(Buffer.from(source,'base64')).digest('hex');
 assert.equal(sha,'541723bf79bced0370336641394ae53c346d8ffbbc4be35c7de629e29fbe699f','r4 d968c17:src/evidence-archive.mjs');
 const {createEvidenceArchive}=await import('data:text/javascript;base64,'+source);
 const namespace='auto-authorizations:group',authorization={id:'seed',requestedAt:100};
 assert.equal(await publisher.publish({rows:[
  {namespace,id:authorization.id,value:authorization},
  {namespace:'auto-completed:session',id:'line-01',value:{text:'original'}},
  {namespace:'auto-completed:session',id:'line-02',value:{text:'latest'}}
 ]},{}),true);
 await publisher.stop();
 const reader=new DatabaseSync(archivePath,{readOnly:true});
 try{assert.equal(reader.prepare('PRAGMA journal_mode').get().journal_mode,'wal');}finally{reader.close();}

 const r4=createEvidenceArchive(archivePath);
 // This is the same namespace lookup that r4 uses to reject reused authorizations.
 assert.deepEqual(r4.get(namespace,authorization.id),authorization);
 assert.equal(r4.get('auto-authorizations:other',authorization.id),null);
 assert.deepEqual(r4.lastByPrefix('auto-completed:session','line-'),{text:'latest'});
 r4.putMany([
  {namespace,id:authorization.id,value:{id:'replacement'}},
  {namespace,id:'created-in-r4',value:{id:'created-in-r4',requestedAt:200}}
 ]);
 assert.deepEqual(r4.get(namespace,authorization.id),authorization);
 assert.equal(hasArchivedAutoAuthorization(archivePath,'group','created-in-r4'),true);
 assert.equal(hasArchivedAutoAuthorization(archivePath,'other','created-in-r4'),false);
});
