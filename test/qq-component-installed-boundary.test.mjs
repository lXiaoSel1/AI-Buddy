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

test('QQ existing installation with a missing pinned file requires repair before any download',windows,async t=>{
 const f=await fixture(t),target=await installed(f);await rm(join(target,'entry.txt'));let requests=0;
 const component=createQqComponent({...f,fetchDownload:async()=>{requests++;return new Response(f.bytes);}});
 await assert.rejects(component.ensure(),{code:'QQ_COMPONENT_REPAIR_REQUIRED'});assert.equal(requests,0);
 assert.equal(JSON.parse(await readFile(join(target,'buddy-component.json'),'utf8')).sha256,f.descriptor.sha256);
 await assert.rejects(stat(join(f.directory,markerName)),{code:'ENOENT'});
});

test('QQ valid installation retires only its exact legacy partial after a fresh ownership record',windows,async t=>{
 const f=await fixture(t),target=await installed(f),partial=join(f.directory,'napcat-4.18.41.part');await writeFile(partial,f.bytes);
 const component=createQqComponent({...f,fetchDownload:async()=>{throw Error('installed component must not download');}});assert.equal(await component.ensure(),target);
 assert.deepEqual((await readdir(f.directory)).sort(),['napcat-4.18.41']);assert.equal(await readFile(join(target,'entry.txt'),'utf8'),f.data.toString());
});
