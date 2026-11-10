import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ApiTransport} from '../src/api-transport.mjs';
import {createNodeNetworkFetch} from '../src/network-node.mjs';
import {networkErrorMessage,networkFailure} from '../src/network-errors.mjs';
import {downloadPinnedFile} from '../src/network-download.mjs';
import {retryPluginDownload} from '../src/plugin-download-integrity.mjs';

async function listen(t,server,protocol){
  const sockets=new Set();server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  return protocol+'://127.0.0.1:'+server.address().port;
}
async function request(baseUrl,fetchImpl){
  const api=new ApiTransport({fetchImpl});
  for await(const ignored of api.stream({id:'local-synthetic',kind:'custom',protocol:'chat-completions',baseUrl,model:'stub',key:''},{messages:[{role:'user',content:'hello'}],purpose:'galgame'})){}
}
test('G1 ApiTransport reports a stalled TLS connection as connect failure and keeps the timeout cause', {timeout:5000},async t=>{
  const url=await listen(t,net.createServer(),'https');
  await assert.rejects(request(url,createNodeNetworkFetch({connectTimeoutMs:60,headersTimeoutMs:300})),error=>{
    assert.equal(error.code,'NETWORK_CONNECT_FAILED');
    assert.equal(error.cause.code,'ETIMEDOUT');
    assert.equal(error.technical.code,'ETIMEDOUT');
    assert.equal(error.message,'连不上 127.0.0.1。检查网络，或者到 通用设置 → 网络 设置代理。');
    assert.doesNotMatch(error.message,/下载/);return true;
  });
});
test('G1 ApiTransport reports an origin that accepts the request but sends no headers as response timeout', {timeout:5000},async t=>{
  let requests=0;const url=await listen(t,http.createServer((_req,_res)=>requests++),'http');
  await assert.rejects(request(url,createNodeNetworkFetch({connectTimeoutMs:300,headersTimeoutMs:60})),error=>{
    assert.equal(error.code,'NETWORK_RESPONSE_TIMEOUT');
    assert.equal(error.cause.code,'UND_ERR_HEADERS_TIMEOUT');
    assert.equal(error.message,'127.0.0.1 一直没有回应。过一会儿再试。');
    assert.equal(networkErrorMessage(error.code,{host:error.host,language:'en'}),'127.0.0.1 did not respond. Try again later.');return true;
  });assert.equal(requests,1);
});
test('G1 ApiTransport gives connection guidance for the unreachable documentation address', {timeout:5000},async()=>{
  await assert.rejects(request('https://192.0.2.1/v1',createNodeNetworkFetch({connectTimeoutMs:80,headersTimeoutMs:300})),error=>{
    assert.equal(error.code,'NETWORK_CONNECT_FAILED');
    assert.equal(error.message,'连不上 192.0.2.1。检查网络，或者到 通用设置 → 网络 设置代理。');
    assert.doesNotMatch(error.message,/下载/);return true;
  });
});
test('G1 generic transport timeouts do not claim a resumable download',()=>{
  assert.equal(networkFailure(new DOMException('expired','TimeoutError'),'https://service.example').code,'NETWORK_RESPONSE_TIMEOUT');
  assert.equal(networkErrorMessage('NETWORK_TIMEOUT'),'下载超时。已经下好的部分保留着，再点一次会接着下。');
});
test('G1 download headers timeout remains retryable through the real pinned download', {timeout:5000},async t=>{
  const bytes=Buffer.from('verified retry fixture');let requests=0;
  const url=await listen(t,http.createServer((_req,res)=>{if(++requests>1)res.end(bytes);}),'http');
  const root=await mkdtemp(join(tmpdir(),'round2-download-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const target=join(root,'file.bin');
  await downloadPinnedFile({url,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},target,{fetchImpl:createNodeNetworkFetch({connectTimeoutMs:300,headersTimeoutMs:50}),connectMs:1000,retries:1});
  assert.deepEqual(await readFile(target),bytes);assert.equal(requests,2);
});
test('G1 plugin metadata download retries the same response timeout kind',async()=>{
  let requests=0;const result=await retryPluginDownload(async()=>{if(++requests===1)throw networkFailure(Object.assign(Error('headers timed out'),{code:'UND_ERR_HEADERS_TIMEOUT',phase:'headers'}),'https://plugins.example');return 'verified';});
  assert.equal(result,'verified');assert.equal(requests,2);
});
