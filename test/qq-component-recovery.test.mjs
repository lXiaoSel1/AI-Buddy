import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat,lstat,readdir,realpath,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {createQqComponent} from '../src/qq-component.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const markerName='.buddy-prepare.json';
function tinyZip(){
 const name=Buffer.from('entry.txt'),data=Buffer.from('fixed component fixture'),packed=deflateRawSync(data),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
 local.writeUInt32LE(0x04034b50);local.writeUInt16LE(8,8);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
 central.writeUInt32LE(0x02014b50);central.writeUInt16LE(8,10);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);
 const body=Buffer.concat([local,name,packed]),directory=Buffer.concat([central,name]);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(body.length,16);
 const bytes=Buffer.concat([body,directory,end]);return {bytes,data,descriptor:{version:'4.18.41',bytes:bytes.length,expandedBytes:data.length,sha256:hash(bytes),url:'https://github.com/fixture/component.zip',files:[{path:'entry.txt',bytes:data.length,sha256:hash(data)}]}};
}
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'qq-transaction-')),directory=join(root,'components');await mkdir(directory);t.after(()=>rm(root,{recursive:true,force:true}));return {root,directory,...tinyZip()};}
async function recoveryRecord(f,patch={}){
 const transactionId=randomUUID(),directory=await realpath(f.directory),info=await lstat(directory,{bigint:true});
 return {schemaVersion:1,kind:'ai-buddy-qq-component-preparation',transactionId,directory,directoryIdentity:{dev:String(info.dev),ino:String(info.ino)},version:f.descriptor.version,sha256:f.descriptor.sha256,archiveBytes:f.descriptor.bytes,expandedBytes:f.descriptor.expandedBytes,partial:'napcat-4.18.41.part',stage:'stage-'+transactionId,phase:'interrupted',owner:{pid:2147483647,birth:'fixture-exited-owner'},createdAt:'2026-10-27T00:00:00.000Z',...patch};
}
async function seedRecovery(f,patch={}){const record=await recoveryRecord(f,patch);await writeFile(join(f.directory,markerName),JSON.stringify(record));return record;}
async function installed(f){const target=join(f.directory,'napcat-4.18.41');await mkdir(target);await writeFile(join(target,'entry.txt'),f.data);await writeFile(join(target,'buddy-component.json'),JSON.stringify({version:f.descriptor.version,sha256:f.descriptor.sha256}));return target;}
const windows={skip:process.platform!=='win32'||process.arch!=='x64'};

test('QQ interrupted extraction recovers only the recorded stage and promotes the verified partial',windows,async t=>{
 const f=await fixture(t),record=await seedRecovery(f);await mkdir(join(f.directory,record.stage));await writeFile(join(f.directory,record.stage,'entry.txt'),'unfinished');await writeFile(join(f.directory,record.partial),f.bytes);
 let requests=0;const component=createQqComponent({...f,fetchDownload:async()=>{requests++;throw Error('a complete verified partial needs no download');}});
 const target=await component.ensure();assert.equal(await readFile(join(target,'entry.txt'),'utf8'),f.data.toString());assert.equal(requests,0);
 await assert.rejects(stat(join(f.directory,record.stage)),{code:'ENOENT'});await assert.rejects(stat(join(f.directory,record.partial)),{code:'ENOENT'});await assert.rejects(stat(join(f.directory,markerName)),{code:'ENOENT'});
});

test('QQ completion interrupted after rename reconciles its stage and download on the next fast path',windows,async t=>{
 const f=await fixture(t),target=await installed(f),record=await seedRecovery(f,{phase:'committed'});await mkdir(join(f.directory,record.stage));await writeFile(join(f.directory,record.stage,'entry.txt'),'stale');await writeFile(join(f.directory,record.partial),f.bytes);
 const component=createQqComponent({...f,fetchDownload:async()=>{throw Error('installed component must not download');}});assert.equal(await component.ensure(),target);
 assert.deepEqual((await readdir(f.directory)).sort(),['napcat-4.18.41']);assert.equal(await readFile(join(target,'entry.txt'),'utf8'),f.data.toString());
});

test('QQ preparation publishes ownership before downloading and keeps one bounded resume record on interruption',windows,async t=>{
 const f=await fixture(t);let observed;
 const component=createQqComponent({...f,fetchDownload:async()=>{observed=JSON.parse(await readFile(join(f.directory,markerName),'utf8'));throw Object.assign(Error('controlled interruption'),{code:'TEST_INTERRUPTED'});}});
 await assert.rejects(component.ensure(),{code:'TEST_INTERRUPTED'});assert.equal(observed.kind,'ai-buddy-qq-component-preparation');assert.equal(observed.sha256,f.descriptor.sha256);assert.equal(observed.directory,await realpath(f.directory));assert.equal(observed.partial,'napcat-4.18.41.part');
 const saved=JSON.parse(await readFile(join(f.directory,markerName),'utf8'));assert.equal(saved.phase,'interrupted');assert.equal(saved.transactionId,observed.transactionId);
 assert.equal((await readdir(f.directory)).filter(name=>name.startsWith('stage-')).length,0);
});

test('QQ recovery refuses an unowned stage and does not erase unrelated account-shaped files',windows,async t=>{
 const f=await fixture(t),stage=join(f.directory,'stage-'+randomUUID());await mkdir(stage);await writeFile(join(stage,'account.sqlite'),'never a cache');let requests=0;
 const component=createQqComponent({...f,fetchDownload:async()=>{requests++;return new Response(f.bytes);}});await assert.rejects(component.ensure(),{code:'QQ_COMPONENT_RECOVERY_REQUIRED'});assert.equal(requests,0);assert.equal(await readFile(join(stage,'account.sqlite'),'utf8'),'never a cache');
});

test('QQ recovery verifies container identity and cannot consume another task transaction',windows,async t=>{
 const f=await fixture(t),record=await seedRecovery(f,{directoryIdentity:{dev:'0',ino:'0'}});await mkdir(join(f.directory,record.stage));await writeFile(join(f.directory,record.stage,'keep'),'original');
 const component=createQqComponent({...f,fetchDownload:async()=>new Response(f.bytes)});await assert.rejects(component.ensure(),{code:'QQ_COMPONENT_RECOVERY_REQUIRED'});assert.equal(await readFile(join(f.directory,record.stage,'keep'),'utf8'),'original');
});

test('QQ recovery rejects path-redirection before touching an outside directory',windows,async t=>{
 const f=await fixture(t),record=await seedRecovery(f),outside=join(f.root,'account-home');await mkdir(outside);await writeFile(join(outside,'account.sqlite'),'preserve');await symlink(outside,join(f.directory,record.stage),'junction');
 const component=createQqComponent({...f,fetchDownload:async()=>new Response(f.bytes)});await assert.rejects(component.ensure(),error=>['QQ_COMPONENT_LINK_DENIED','QQ_COMPONENT_RECOVERY_REQUIRED'].includes(error.code));assert.equal(await readFile(join(outside,'account.sqlite'),'utf8'),'preserve');
});

