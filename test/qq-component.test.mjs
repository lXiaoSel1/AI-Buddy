import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {extractPinnedZip,componentChild,verifyComponent,createQqComponent} from '../src/qq-component.mjs';
import {qrImage,qqNetworkConfig} from '../src/qq-login-runtime.mjs';
const hash=data=>createHash('sha256').update(data).digest('hex');
function zip(name='hello.txt',text='hello',external=0){
 const data=Buffer.from(text),packed=deflateRawSync(data),filename=Buffer.from(name),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
 local.writeUInt32LE(0x04034b50);local.writeUInt16LE(8,8);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(filename.length,26);
 central.writeUInt32LE(0x02014b50);central.writeUInt16LE(8,10);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(external,38);
 const before=Buffer.concat([local,filename,packed]),directory=Buffer.concat([central,filename]);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(before.length,16);
 const bytes=Buffer.concat([before,directory,end]);return {bytes,descriptor:{version:'4.18.41',bytes:bytes.length,expandedBytes:data.length,sha256:hash(bytes),url:'https://github.com/fixture',files:[{path:name,bytes:data.length,sha256:hash(data)}]}};
}
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'qq-component-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('pinned ZIP verifies archive plus every extracted file and rejects later tampering',async t=>{const root=await fixture(t),{bytes,descriptor}=zip(),archive=join(root,'source.zip'),out=join(root,'out');await writeFile(archive,bytes);await extractPinnedZip(archive,out,descriptor);assert.equal(await readFile(join(out,'hello.txt'),'utf8'),'hello');await verifyComponent(out,descriptor);await writeFile(join(out,'hello.txt'),'other');await assert.rejects(verifyComponent(out,descriptor),{code:'QQ_COMPONENT_FILE_HASH_MISMATCH'});});
test('traversal and links fail before any escaping file is written',async t=>{const root=await fixture(t);for(const [i,item]of [zip('../escape'),zip('link','x',0xa0000000)].entries()){const archive=join(root,'bad'+i+'.zip');await writeFile(archive,item.bytes);await assert.rejects(extractPinnedZip(archive,join(root,'out'+i),item.descriptor));}await assert.rejects(stat(join(root,'escape')),{code:'ENOENT'});});
test('bad archive hash and unlisted contents cannot be accepted',async t=>{const root=await fixture(t),{bytes,descriptor}=zip(),archive=join(root,'file.zip');await writeFile(archive,bytes);await assert.rejects(extractPinnedZip(archive,join(root,'out1'),{...descriptor,sha256:'0'.repeat(64)}),{code:'QQ_COMPONENT_HASH_MISMATCH'});await assert.rejects(extractPinnedZip(archive,join(root,'out2'),{...descriptor,files:[]}),{code:'QQ_COMPONENT_FILE_UNEXPECTED'});});
test('owned paths and QR payloads reject ambiguous or remote-credential destinations',()=>{for(const path of ['../x','x\\y','x:y','/a','a//b'])assert.throws(()=>componentChild('E:/owned',path));assert.match(qrImage('https://nt.qq.com/test'),/^data:image\/svg\+xml;base64,/);for(const url of ['http://qq.com/','https://qq.com.evil.test','https://x:y@qq.com'])assert.throws(()=>qrImage(url));});
test('OneBot binds only localhost with nonempty host-generated credentials and no push clients',()=>{const config=qqNetworkConfig(30000,30001,'random-token');assert.equal(config.network.httpServers[0].host,'127.0.0.1');assert.equal(config.network.httpServers[0].enableCors,false);assert.equal(config.network.websocketServers[0].token,'random-token');assert.deepEqual(config.network.httpClients,[]);assert.deepEqual(config.network.websocketClients,[]);});
test('single-flight component preparation verifies and removes resumable download',async t=>{const root=await fixture(t),{bytes,descriptor}=zip();let requests=0;const component=createQqComponent({directory:join(root,'components'),descriptor,fetchDownload:async()=>{requests++;return new Response(bytes);}});const first=component.ensure(),second=component.ensure();assert.equal(await first,await second);assert.equal(requests,1);await assert.rejects(stat(join(root,'components','napcat-4.18.41.part')),{code:'ENOENT'});await component.ensure();assert.equal(requests,1);});
