import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {downloadDshComponent,DSH_PUBLIC_COMPONENT,assertDshComponentDownloadUrl} from '../src/dsh-platform/component-download.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex'),asset='https://release-assets.githubusercontent.com/component/asset?sig=DO-NOT-LOG',object='https://objects.githubusercontent.com/component/asset?sig=DO-NOT-LOG';
// Actual local HTTP responses, including redirect headers and interrupted bodies.
// Only the injected transport maps validated official URLs to this loopback fixture.
async function httpFixture(t,handler){
  const requests=[],server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const origin='http://127.0.0.1:'+server.address().port,fetchImpl=(url,options)=>{requests.push({url,...options});const parsed=new URL(url),path=parsed.hostname==='github.com'?'/start':parsed.hostname==='release-assets.githubusercontent.com'?'/asset':'/object';return fetch(origin+path,options);};return {fetchImpl,requests};
}
const item=bytes=>({...DSH_PUBLIC_COMPONENT,bytes:bytes.length,sha256:digest(bytes)});
test('public component follows bounded official HTTPS redirects through real HTTP fixtures',async t=>{
  const bytes=Buffer.from('pinned component bytes'),fixture=await httpFixture(t,(request,response)=>{if(request.url==='/start')response.writeHead(302,{location:asset}).end();else if(request.url==='/asset')response.writeHead(307,{location:object}).end();else response.writeHead(200,{'content-length':bytes.length}).end(bytes);});
  assert.deepEqual(await downloadDshComponent(item(bytes),fixture),bytes);assert.equal(fixture.requests.length,3);for(const row of fixture.requests){assert.equal(row.redirect,'manual');assert.equal(row.credentials,'omit');}
});
test('production component origins reject caller URLs, credentials, private hosts and downgrades before fetch',async t=>{
  for(const value of ['http://github.com/a','https://localhost/a','https://127.0.0.1/a','https://example.com/a',DSH_PUBLIC_COMPONENT.url+'?replace=1',DSH_PUBLIC_COMPONENT.url+'#fragment','https://user:pass@github.com/lXiaoSel1/a'])assert.throws(()=>assertDshComponentDownloadUrl(value,{initial:true}),{code:'DSH_COMPONENT_DOWNLOAD_ORIGIN'});
  for(const location of ['http://release-assets.githubusercontent.com/a','https://user:pass@release-assets.githubusercontent.com/a','https://release-assets.githubusercontent.com:8443/a','https://127.0.0.1/a','https://localhost/a','https://evil.example/a','https://release-assets.githubusercontent.com.evil.example/a']){
    await t.test(location,async t=>{const fixture=await httpFixture(t,(_,response)=>response.writeHead(302,{location}).end());await assert.rejects(downloadDshComponent(item(Buffer.from('x')),fixture),{code:'DSH_COMPONENT_DOWNLOAD_ORIGIN'});assert.equal(fixture.requests.length,1);});
  }
});
test('redirect count is bounded and errors do not expose signed CDN queries',async t=>{
  const fixture=await httpFixture(t,(request,response)=>response.writeHead(302,{location:request.url==='/asset'?object:asset}).end());
  await assert.rejects(downloadDshComponent(item(Buffer.from('x')),fixture),error=>error.code==='DSH_COMPONENT_DOWNLOAD_REDIRECTS'&&!error.message.includes('DO-NOT-LOG'));assert.equal(fixture.requests.length,4);
});
test('wrong declared size, overflow, hash and a partial response cannot pass download verification',async t=>{
  for(const mode of ['length','overflow','hash','partial'])await t.test(mode,async t=>{
    const bytes=Buffer.from('component'),fixture=await httpFixture(t,(_,response)=>{if(mode==='partial'){response.writeHead(200,{'content-length':bytes.length});response.write(bytes.subarray(0,2));setImmediate(()=>response.destroy());}else if(mode==='overflow'){response.writeHead(200);response.end(Buffer.concat([bytes,Buffer.from('extra')]));}else response.writeHead(200,{'content-length':mode==='length'?bytes.length+1:bytes.length}).end(mode==='hash'?Buffer.alloc(bytes.length,120):bytes);});
    await assert.rejects(downloadDshComponent(item(bytes),fixture),error=>['DSH_COMPONENT_INVALID','DSH_COMPONENT_DOWNLOAD_FAILED'].includes(error.code)&&!error.message.includes('DO-NOT-LOG'));
  });
});
test('cancel and download timeout abort their exact request without returning partial data',async t=>{
  for(const timeout of [false,true])await t.test(timeout?'timeout':'cancel',async t=>{const controller=new AbortController(),fixture=await httpFixture(t,(_,response)=>{response.writeHead(200);response.write('c');if(!timeout)setImmediate(()=>controller.abort());});await assert.rejects(downloadDshComponent(item(Buffer.from('component')),{...fixture,signal:controller.signal,timeoutMs:timeout?40:5000}),{code:timeout?'DSH_COMPONENT_DOWNLOAD_TIMEOUT':'ABORT_ERR'});});
});
