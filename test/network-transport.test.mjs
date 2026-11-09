import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {createNodeNetworkFetch} from '../src/network-node.mjs';
import {gzipSync} from 'node:zlib';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
test('each destination and redirect resolves its own proxy without mutating global fetch',async t=>{
  const hits=[],resolved=[],original=globalThis.fetch;
  const origin=http.createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{location:'/ok'});res.end();}else{res.setHeader('content-type','text/plain');res.end('origin:'+req.method);}});
  const url=await listen(origin);t.after(()=>origin.closeAllConnections());t.after(()=>origin.close());
  const proxy=http.createServer((req,res)=>{hits.push(req.url);const next=http.request(req.url,{method:req.method,headers:req.headers},up=>{res.writeHead(up.statusCode,up.headers);up.pipe(res);});req.pipe(next);});
  const proxyUrl=await listen(proxy);t.after(()=>proxy.closeAllConnections());t.after(()=>proxy.close());
  const fetchImpl=createNodeNetworkFetch({resolveRoute:async value=>{resolved.push(value);return value.endsWith('/redirect')?[{kind:'http',url:proxyUrl}]:[{kind:'direct'}];}});
  const response=await fetchImpl(url+'/redirect');assert.equal(await response.text(),'origin:GET');
  assert.deepEqual(resolved,[url+'/redirect',url+'/ok']);assert.equal(hits.length,1);assert.equal(globalThis.fetch,original);
  await assert.rejects(fetchImpl(url+'/redirect',{redirect:'error'}),/redirect/i);
});
test('Node adapter decodes compressed model responses like fetch',async t=>{
 const server=http.createServer((_,res)=>{res.writeHead(200,{'content-encoding':'gzip','content-type':'text/plain'});res.end(gzipSync('compressed model reply'));});const url=await listen(server);t.after(()=>server.closeAllConnections());t.after(()=>server.close());
 assert.equal(await (await createNodeNetworkFetch()(url)).text(),'compressed model reply');
});
