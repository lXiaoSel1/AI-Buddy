import test from 'node:test';
import assert from 'node:assert/strict';
import {qqNetworkConfig} from '../src/qq-login-runtime.mjs';

test('managed QQ keeps both transports in the pinned NapCat name-keyed registry', async()=>{
 const config=qqNetworkConfig(30001,30002,'test-secret');
 // NapCat 4.18.41 registers every transport in one Map keyed by adapter.name,
 // then opens that Map. HTTP and WebSocket do not have separate namespaces.
 const registry=new Map(),opened=[];
 for(const [kind,rows] of [['http',config.network.httpServers],['websocket',config.network.websocketServers]]){
  for(const row of rows)if(row.enable)registry.set(row.name,{open:async()=>opened.push({kind,port:row.port})});
 }
 await Promise.all([...registry.values()].map(adapter=>adapter.open()));
 assert.deepEqual(opened,[{kind:'http',port:30001},{kind:'websocket',port:30002}]);
});

test('managed QQ transport names are stable and retain loopback authentication restrictions',()=>{
 const first=qqNetworkConfig(30001,30002,'test-secret');
 const restarted=qqNetworkConfig(40001,40002,'replacement-secret');
 assert.equal(first.network.httpServers[0].name,restarted.network.httpServers[0].name);
 assert.equal(first.network.websocketServers[0].name,restarted.network.websocketServers[0].name);
 for(const server of [...first.network.httpServers,...first.network.websocketServers]){
  assert.equal(server.host,'127.0.0.1');assert.equal(server.token,'test-secret');assert.equal(server.enable,true);
 }
 assert.equal(first.network.httpServers[0].enableCors,false);
 assert.equal(first.network.websocketServers[0].reportSelfMessage,false);
 assert.equal(first.network.websocketServers[0].enableForcePushEvent,false);
 assert.deepEqual(first.network.httpClients,[]);assert.deepEqual(first.network.websocketClients,[]);
});
