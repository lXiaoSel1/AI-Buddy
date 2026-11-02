import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createIsolatedProfile,backupIsolatedProfile,verifyIsolatedBackup,profileManifest} from '../tools/r95-profile-compatibility.mjs';
const fault=code=>Object.assign(Error('synthetic '+code),{code});
function fixture(t){const directory=mkdtempSync(join(tmpdir(),'backup-sharing-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const profile=createIsolatedProfile(join(directory,'profile'));writeFileSync(join(profile.root,'source.bin'),Buffer.from([0,255,7]));return {directory,profile,args:{profileRoot:profile.root,backupRoot:join(directory,'backup'),ownerId:profile.ownerId}};}

test('isolated backup retries only the verified stage commit after one Windows EPERM',t=>{const f=fixture(t),calls=[],waits=[],before=profileManifest(f.profile.root);const backup=backupIsolatedProfile({...f.args,platform:'win32',wait:ms=>waits.push(ms),rename:(a,b)=>{calls.push([a,b]);if(calls.length===1)throw fault('EPERM');renameSync(a,b);}});assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);assert.deepEqual(waits,[20]);assert.deepEqual(profileManifest(f.profile.root),before);assert.equal(verifyIsolatedBackup({backupRoot:backup.backupRoot,expectedReceiptSha256:backup.receiptSha256}).verified,true);});

test('permanent backup sharing failure retains its owned verified stage and original source',t=>{const f=fixture(t),before=profileManifest(f.profile.root);let calls=0,stage;assert.throws(()=>backupIsolatedProfile({...f.args,platform:'win32',wait:()=>{},rename:a=>{stage=a;calls++;throw fault('EACCES');}}),{code:'EACCES'});assert.equal(calls,7);assert.equal(existsSync(f.args.backupRoot),false);assert.ok(existsSync(join(stage,'RECEIPT.json')));assert.deepEqual(profileManifest(join(stage,'payload')),before);assert.deepEqual(profileManifest(f.profile.root),before);});

test('backup retry never overwrites a newly occupied target',t=>{const f=fixture(t);let calls=0;assert.throws(()=>backupIsolatedProfile({...f.args,platform:'win32',wait:()=>{mkdirSync(f.args.backupRoot);writeFileSync(join(f.args.backupRoot,'owner.txt'),'preserved');},rename:()=>{calls++;throw fault('EBUSY');}}),{code:'R95_AUDIT_REFUSE_OVERWRITE'});assert.equal(calls,1);assert.equal(readFileSync(join(f.args.backupRoot,'owner.txt'),'utf8'),'preserved');});

test('backup retry rejects changed stage ownership and preserves foreign replacement evidence',t=>{const f=fixture(t);let calls=0,stage;assert.throws(()=>backupIsolatedProfile({...f.args,platform:'win32',rename:a=>{stage=a;calls++;throw fault('EPERM');},wait:()=>{renameSync(stage,stage+'.retained');writeFileSync(stage,'foreign replacement');}}),{code:'R95_AUDIT_LINK'});assert.equal(calls,1);assert.equal(readFileSync(stage,'utf8'),'foreign replacement');assert.ok(existsSync(join(stage+'.retained','RECEIPT.json')));});

for(const [platform,code]of [['win32','ENOSPC'],['linux','EPERM']])test('isolated backup never retries '+platform+' '+code,t=>{const f=fixture(t);let calls=0;assert.throws(()=>backupIsolatedProfile({...f.args,platform,rename:()=>{calls++;throw fault(code);},wait:()=>assert.fail('no wait')}),{code});assert.equal(calls,1);});
