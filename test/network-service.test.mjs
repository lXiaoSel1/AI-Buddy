import test from 'node:test';import assert from 'node:assert/strict';
import {execFile,execFileSync} from 'node:child_process';import {promisify} from 'node:util';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createNetworkService} from '../src/network-service.mjs';
test('fixed catalog test uses a real local HTTPS mirror and rejects HTML without claiming a signature check',async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-catalog-tls-'));t.after(()=>rm(root,{recursive:true,force:true}));const key=join(root,'key.pem'),cert=join(root,'cert.pem');
 const openssl=process.env.AUDIT214_OPENSSL??(process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl');
 execFileSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','2','-subj','/CN=AI Buddy catalog test only','-addext','basicConstraints=critical,CA:TRUE','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore',windowsHide:true});
 const code=`
  import assert from 'node:assert/strict';import https from 'node:https';import {readFile} from 'node:fs/promises';
  const {createNetworkService}=await import(process.env.CATALOG_SERVICE_MODULE);let html=false;const requested=[];
  const server=https.createServer({key:await readFile(process.env.CATALOG_TEST_KEY),cert:await readFile(process.env.NODE_EXTRA_CA_CERTS)},(req,res)=>{
   requested.push(req.url);res.setHeader('content-type',html?'text/html':'application/json');res.end(html?'<html>blocked</html>':JSON.stringify({payload:{schemaVersion:1,packages:[]},signature:{value:'synthetic-only'}}));
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let service;
  try{
   service=await createNetworkService();await service.save({mode:'direct',githubMirror:'https://127.0.0.1:'+server.address().port});
   const result=await service.test('https://renderer-controlled.invalid');assert.equal(result.ok,true);assert.equal(result.signatureVerified,false);
   assert.deepEqual(requested,['/lXiaoSel1/AI-Buddy-Extensions/main/catalog.json']);html=true;await assert.rejects(service.test(),{code:'NETWORK_CATALOG_INVALID'});
  }finally{await service?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 `;
 await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{env:{...process.env,NODE_EXTRA_CA_CERTS:cert,CATALOG_TEST_KEY:key,CATALOG_SERVICE_MODULE:new URL('../src/network-service.mjs',import.meta.url).href},windowsHide:true,timeout:15000});
});
test('a captured system plan still resolves system PAC after the active setting becomes manual',async()=>{
 const sessions=[];const service=await createNetworkService({session:{fromPartition:name=>{const ses={name,mode:null,setProxy:async config=>{ses.mode=config.mode;},resolveProxy:async()=>ses.mode==='system'?'PROXY system.example:8080':'PROXY changed.example:8080',fetch:async()=>new Response('{}'),closeAllConnections:async()=>{}};sessions.push(ses);return ses;}}});
 const captured=service.capture();await service.save({mode:'manual',proxyUrl:'http://manual.example:8080'});
 assert.equal((await captured.resolveRoutes('https://first.example'))[0].url,'http://system.example:8080');
 assert.equal((await service.resolveRoutes('https://second.example'))[0].url,'http://manual.example:8080');await service.close();
});
test('official retry scope excludes mirrors without changing saved settings or another operation',async()=>{
 const ses={setProxy:async()=>{},fetch:async()=>new Response('{}'),closeAllConnections:async()=>{}};const service=await createNetworkService({electronSession:ses});await service.save({mode:'direct',githubMirror:'https://mirror.example'});
 const normal=service.capture(),official=service.capture({official:true}),url='https://github.com/o/r/a.zip';
 assert.equal(normal.planDownload(url).requestUrl,'https://mirror.example/o/r/a.zip');assert.equal(official.planDownload(url).requestUrl,url);assert.equal(official.snapshot().githubMirror,'');assert.equal(service.snapshot().githubMirror,'https://mirror.example');await service.close();
});
