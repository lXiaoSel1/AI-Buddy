import test from 'node:test';import assert from 'node:assert/strict';
import {apiBaseUrl,localEndpoint} from '../src/model-presets.mjs';
import http from 'node:http';import {ApiTransport} from '../src/api-transport.mjs';
test('private model endpoints accept HTTP and normalize pasted operation suffixes',()=>{
 assert.equal(apiBaseUrl('http://192.168.1.20:8000/v1/chat/completions'),'http://192.168.1.20:8000/v1');
 assert.equal(apiBaseUrl('https://service.example/v1/models'),'https://service.example/v1');
 for(const host of ['10.0.0.8','172.16.1.8','172.31.255.8','192.168.9.8','model.local'])assert.equal(localEndpoint('http://'+host),true);
 for(const host of ['172.15.1.8','172.32.1.8','192.169.1.8','10.evil.example','model.local.evil'])assert.throws(()=>apiBaseUrl('http://'+host));
});
test('model lists follow same-host redirects and explain cross-host destinations',async t=>{
 const server=http.createServer((req,res)=>{if(req.url==='/v1/models'){res.writeHead(308,{location:'/new/models'});res.end();}else if(req.url==='/cross/models'){res.writeHead(301,{location:'https://other.example/v1/models'});res.end();}else{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture-model'}]}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.closeAllConnections());t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port,transport=new ApiTransport();
 assert.equal((await transport.listModels({protocol:'chat-completions',baseUrl:base+'/v1',key:''}))[0].id,'fixture-model');
 await assert.rejects(transport.listModels({protocol:'chat-completions',baseUrl:base+'/cross',key:''}),/服务地址跳转到了 https:\/\/other.example\/v1\/models，请直接填它/);
});
