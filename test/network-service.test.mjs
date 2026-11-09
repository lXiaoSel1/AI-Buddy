import test from 'node:test';import assert from 'node:assert/strict';
import {createNetworkService} from '../src/network-service.mjs';
test('fixed catalog test uses the configured mirror and rejects HTML without claiming a signature check',async()=>{
 const requested=[];let html=false;
 const ses={setProxy:async()=>{},closeAllConnections:async()=>{},fetch:async url=>{requested.push(url);if(new URL(url).hostname!=='mirror.example')throw Error('raw blocked');return html?new Response('<html>blocked</html>',{headers:{'content-type':'text/html'}}):new Response(JSON.stringify({payload:{schemaVersion:1,packages:[]},signature:{algorithm:'ed25519',keyId:'fixture',value:'fixture'}}));}};
 const service=await createNetworkService({electronSession:ses});await service.save({mode:'system',githubMirror:'https://mirror.example'});
 const result=await service.test('https://renderer-controlled.invalid');assert.equal(result.ok,true);assert.equal(result.signatureVerified,false);
 assert.deepEqual(requested,['https://mirror.example/lXiaoSel1/AI-Buddy-Extensions/main/catalog.json']);
 html=true;await assert.rejects(service.test(),{code:'NETWORK_CATALOG_INVALID'});await service.close();
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
