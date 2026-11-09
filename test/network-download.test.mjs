import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';import http from 'node:http';
import {downloadPinnedFile} from '../src/network-download.mjs';
import {downloadRequestPlan} from '../src/network-settings.mjs';
test('a failed body preserves its prefix; retry sends Range and only promotes a verified file',async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-network-'));t.after(()=>rm(root,{recursive:true,force:true}));const bytes=Buffer.from('signed-download-fixture'),ranges=[];let calls=0;
 const server=http.createServer((req,res)=>{ranges.push(req.headers.range??null);const start=req.headers.range?Number(req.headers.range.match(/\d+/)[0]):0;calls++;res.writeHead(start?206:200,{'content-length':bytes.length-start,...(start?{'content-range':`bytes ${start}-${bytes.length-1}/${bytes.length}`}:{})});if(calls===1){res.write(bytes.subarray(0,7));setTimeout(()=>res.destroy(),20);}else res.end(bytes.subarray(start));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.closeAllConnections());t.after(()=>server.close());
 const item={url:'http://127.0.0.1:'+server.address().port+'/file',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},target=join(root,'file');
 await assert.rejects(downloadPinnedFile(item,target,{retries:0}));assert.deepEqual(await readFile(target+'.partial'),bytes.subarray(0,7));
 await downloadPinnedFile(item,target,{retries:0});assert.deepEqual(await readFile(target),bytes);assert.deepEqual(ranges,[null,'bytes=7-']);
 await writeFile(target,Buffer.from('corrupt'));await downloadPinnedFile(item,target,{retries:0});assert.deepEqual(await readFile(target),bytes);
});
test('a corrupt mirror is rejected and one official retry uses the original URL and digest',async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-mirror-'));t.after(()=>rm(root,{recursive:true,force:true}));const bytes=Buffer.from('signed fixture'),urls=[],item={url:'https://github.com/o/r/releases/download/v1/a.zip',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},target=join(root,'asset');
 const options={planDownload:(url,settings)=>downloadRequestPlan(url,{githubMirror:'https://mirror.example'},settings),fetchImpl:async url=>{urls.push(url);return new Response(url.startsWith('https://mirror.example/')?Buffer.alloc(bytes.length):bytes);}};
 await assert.rejects(downloadPinnedFile(item,target,options),error=>error.code==='NETWORK_MIRROR_MISMATCH'&&error.retryOfficial===true);
 await downloadPinnedFile(item,target,{...options,official:true});assert.deepEqual(await readFile(target),bytes);assert.deepEqual(urls,['https://mirror.example/o/r/releases/download/v1/a.zip',item.url]);
});
test('active data resets idle timeout while total transfer may exceed the connect deadline',async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-idle-'));t.after(()=>rm(root,{recursive:true,force:true}));const bytes=Buffer.from('abcd'),item={url:'https://github.com/o/r/a',bytes:4,sha256:createHash('sha256').update(bytes).digest('hex')};let at=0;
 await downloadPinnedFile(item,join(root,'asset'),{connectMs:10,idleMs:100,retries:0,fetchImpl:async()=>new Response(new ReadableStream({async pull(stream){await new Promise(resolve=>setTimeout(resolve,20));if(at===bytes.length)stream.close();else stream.enqueue(bytes.subarray(at,++at));}}))});
 assert.deepEqual(await readFile(join(root,'asset')),bytes);
});
for(const mode of ['short','long'])test('known mirror '+mode+' body offers one clean official retry with its technical cause',async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-mirror-size-'));t.after(()=>rm(root,{recursive:true,force:true}));const bytes=Buffer.from('signed complete payload'),bad=mode==='short'?bytes.subarray(0,5):Buffer.concat([bytes,Buffer.from('extra')]),item={url:'https://github.com/o/r/a.zip',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},urls=[];
 const settings={githubMirror:'https://mirror.example'},options={retries:0,planDownload:(url,mode)=>downloadRequestPlan(url,settings,mode),fetchImpl:async url=>{urls.push(url);const body=new URL(url).hostname==='mirror.example'?bad:bytes;return new Response(body,{headers:{'content-length':String(body.length)}});}},target=join(root,'asset');
 await assert.rejects(downloadPinnedFile(item,target,options),error=>error.code==='NETWORK_MIRROR_MISMATCH'&&error.retryOfficial===true&&error.technicalCode===(mode==='short'?'NETWORK_DOWNLOAD_INCOMPLETE':'NETWORK_DOWNLOAD_SIZE'));
 await downloadPinnedFile(item,target,{...options,official:true});assert.deepEqual(await readFile(target),bytes);assert.deepEqual(urls,['https://mirror.example/o/r/a.zip',item.url]);assert.equal(settings.githubMirror,'https://mirror.example');
 await assert.rejects(downloadPinnedFile(item,join(root,'official-invalid'),{...options,official:true,fetchImpl:async()=>new Response(bad,{headers:{'content-length':String(bad.length)}})}),error=>error.retryOfficial!==true&&error.code===(mode==='short'?'NETWORK_DOWNLOAD_INCOMPLETE':'NETWORK_DOWNLOAD_SIZE'));
});
