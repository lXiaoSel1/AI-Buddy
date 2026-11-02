import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {assertR95DatabaseCompatible} from '../src/r95-data-compatibility.mjs';
import {UsageRepository} from '../src/usage-repository.mjs';
import {openCompanionStore} from '../src/companion-store.mjs';
import {createSocialHost} from '../src/buddy-plugin-services/social-host.mjs';
import {createOwnerWorkAuthority} from '../src/buddy-plugin-services/owner-work.mjs';
import {createSnapshotStorage} from '../src/storage.mjs';
import {createIsolatedProfile,profileManifest,backupIsolatedProfile,verifyIsolatedBackup,restoreIsolatedBackup} from '../tools/r95-profile-compatibility.mjs';

function fixture(t){const root=mkdtempSync(join(tmpdir(),'r95-compat-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,...createIsolatedProfile(join(root,'profile'))};}
const stores=[
 {name:'usage',file:'usage-ledger-v2/generic.sqlite',schemaKey:'schemaVersion',version:3,writer:'r95-usage-v3',open:root=>new UsageRepository(join(root,'usage-ledger-v2/generic.sqlite'))},
 {name:'social',file:'social-core/events.sqlite',schemaKey:'schema',version:1,writer:'r95-social-events-v1',open:root=>createSocialHost({dataRoot:root,resolveLife:()=>({})})},
 {name:'owner',file:'social-core/owner.sqlite',schemaKey:'schemaVersion',version:1,writer:'r95-owner-work-v1',open:root=>createOwnerWorkAuthority({dataRoot:root})},
];
for(const spec of stores)for(const variant of ['future-schema','future-writer','future-user-version'])test('R95 '+spec.name+' '+variant+' refuses readonly without changing any profile bytes',t=>{
 const f=fixture(t),path=join(f.root,spec.file);mkdirSync(dirname(path),{recursive:true});const db=new DatabaseSync(path);db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE preserved(value BLOB)');db.prepare('INSERT INTO preserved VALUES(?)').run(Buffer.from('keep me exactly'));db.prepare('INSERT INTO meta VALUES(?,?)').run(spec.schemaKey,JSON.stringify(variant==='future-schema'?99:spec.version));db.prepare('INSERT INTO meta VALUES(?,?)').run('minimumWriter',JSON.stringify(variant==='future-writer'?'future-writer':spec.writer));if(variant==='future-user-version')db.exec('PRAGMA user_version=99');db.close();const before=profileManifest(f.root);
 assert.throws(()=>assertR95DatabaseCompatible(path,{schemaKey:spec.schemaKey,versions:[spec.version],writer:spec.writer}),/Unsupported/);assert.deepEqual(profileManifest(f.root),before);assert.throws(()=>spec.open(f.root),/Unsupported/);assert.deepEqual(profileManifest(f.root),before);
});
for(const patch of [{schema:99},{schema:2,minimumWriter:'future-companion-writer'},{schema:1,minimumWriter:'future-companion-writer'},{schema:2,requiredCapabilities:['future-unimplemented-capability']}])test('R95 companion refuses unsupported metadata before snapshot publication: '+JSON.stringify(patch),async t=>{
 const f=fixture(t),disk=createSnapshotStorage(join(f.root,'galgame/companion.json'));await disk.writeText(JSON.stringify({schema:2,minimumWriter:'r95-social-core-v1',requiredCapabilities:['social-core-state-v1'],preserved:{text:'untouched'},...patch}));const before=profileManifest(f.root);await assert.rejects(()=>openCompanionStore(f.root),/版本|写入程序|能力/);assert.deepEqual(profileManifest(f.root),before);
});
test('R95 readonly check of a missing database creates no path or metadata',t=>{
 const f=fixture(t),before=profileManifest(f.root);assert.deepEqual(assertR95DatabaseCompatible(join(f.root,'missing/sqlite.sqlite'),{versions:[1],writer:'r95'}),{exists:false});assert.deepEqual(profileManifest(f.root),before);
});
test('legacy usage v2 with a future writer refuses before deleting its unpublished pending rows',t=>{
 const f=fixture(t),path=join(f.root,'usage-ledger-v2/generic.sqlite');mkdirSync(dirname(path),{recursive:true});const db=new DatabaseSync(path);db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE pending(value TEXT)');db.prepare('INSERT INTO meta VALUES(?,?)').run('schemaVersion','2');db.prepare('INSERT INTO meta VALUES(?,?)').run('minimumWriter',JSON.stringify('future-usage-writer'));db.prepare('INSERT INTO pending VALUES(?)').run('original unpublished data');db.close();const before=profileManifest(f.root);assert.throws(()=>new UsageRepository(path),/minimum writer/);assert.deepEqual(profileManifest(f.root),before);
});
test('isolated backup verifies every byte including binary media and restores only to an independent new copy',t=>{
 const f=fixture(t);mkdirSync(join(f.root,'cg-assets/a'),{recursive:true});writeFileSync(join(f.root,'cg-assets/a/image.png'),Buffer.from([137,80,78,71,13,10,26,10,0,255,77]));writeFileSync(join(f.root,'arbitrary-note.bin'),Buffer.from([0,1,2,3]));const before=profileManifest(f.root),backup=backupIsolatedProfile({profileRoot:f.root,backupRoot:join(dirname(f.root),'backup'),ownerId:f.ownerId});assert.equal(backup.manifest.sha256,before.sha256);assert.equal(verifyIsolatedBackup({backupRoot:backup.backupRoot,expectedReceiptSha256:backup.receiptSha256}).verified,true);assert.deepEqual(profileManifest(f.root),before);const targetRoot=join(dirname(f.root),'restored');restoreIsolatedBackup({backupRoot:backup.backupRoot,expectedReceiptSha256:backup.receiptSha256,targetRoot,ownerId:f.ownerId});assert.deepEqual(profileManifest(targetRoot),before);writeFileSync(join(f.root,'new-after-backup.txt'),'new data');const current=profileManifest(f.root);assert.throws(()=>restoreIsolatedBackup({backupRoot:backup.backupRoot,expectedReceiptSha256:backup.receiptSha256,targetRoot:f.root,ownerId:f.ownerId}),/over current|existing/);assert.deepEqual(profileManifest(f.root),current);
});
test('isolated backup rejects a changed source and never commits an inconsistent backup',t=>{
 const f=fixture(t);writeFileSync(join(f.root,'changing.txt'),'before');let changed=false;const backupRoot=join(dirname(f.root),'changed-backup');assert.throws(()=>backupIsolatedProfile({profileRoot:f.root,backupRoot,ownerId:f.ownerId,onCopied:()=>{if(!changed){changed=true;writeFileSync(join(f.root,'changing.txt'),'changed during copy');}}}),error=>error.code==='R95_AUDIT_SOURCE_CHANGED');assert.throws(()=>readFileSync(join(backupRoot,'RECEIPT.json')));
});
test('backup corruption and receipt substitution fail verification, and an unowned directory is never accepted',t=>{
 const f=fixture(t),backup=backupIsolatedProfile({profileRoot:f.root,backupRoot:join(dirname(f.root),'backup'),ownerId:f.ownerId});writeFileSync(join(backup.backupRoot,'payload','extra.txt'),'tamper');assert.throws(()=>verifyIsolatedBackup({backupRoot:backup.backupRoot,expectedReceiptSha256:backup.receiptSha256}),/payload hash/);const other=join(dirname(f.root),'unowned');mkdirSync(other);writeFileSync(join(other,'data.json'),'{}');const before=profileManifest(other);assert.throws(()=>backupIsolatedProfile({profileRoot:other,backupRoot:join(dirname(f.root),'nope'),ownerId:f.ownerId}));assert.deepEqual(profileManifest(other),before);
});
for(const code of ['ENOSPC','AUDIT_COPY_INTERRUPTED'])test('isolated backup '+code+' leaves the source intact and never publishes a completed backup',t=>{
 const f=fixture(t);writeFileSync(join(f.root,'original.bin'),Buffer.from([0,255,3]));const before=profileManifest(f.root),backupRoot=join(dirname(f.root),'not-committed');assert.throws(()=>backupIsolatedProfile({profileRoot:f.root,backupRoot,ownerId:f.ownerId,onCopied:()=>{throw Object.assign(Error('simulated '+code),{code});}}),error=>error.code===code);assert.deepEqual(profileManifest(f.root),before);assert.throws(()=>readFileSync(join(backupRoot,'RECEIPT.json')));
});
