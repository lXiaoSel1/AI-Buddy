import test from 'node:test';
import assert from 'node:assert/strict';
import {proxyRoutes} from '../src/network-settings.mjs';
import {networkErrorMessage} from '../src/network-errors.mjs';
import {createNetworkService} from '../src/network-service.mjs';

const http={kind:'http',url:'http://127.0.0.1:7897'},direct={kind:'direct'};
for(const [pac,expected] of [
  ['PROXY 127.0.0.1:7897; SOCKS5 127.0.0.1:7897; DIRECT;',[http,direct]],
  ['SOCKS5 127.0.0.1:1080; DIRECT',[direct]],
  ['SOCKS 127.0.0.1:1080; PROXY 127.0.0.1:7897',[http]],
  ['QUIC localhost:443; HTTPS localhost:8443; SOCKS4 localhost:1080; DIRECT',[{kind:'https',url:'https://localhost:8443'},direct]],
  ['DIRECT; UNKNOWN localhost:9999; PROXY 127.0.0.1:7897; DIRECT',[direct,http,direct]],
  ['  ; SOCKS5 localhost:1080;  ',null],
])test('G2 PAC uses supported routes in order: '+pac,()=>{
  if(expected)assert.deepEqual(proxyRoutes(pac),expected);
  else assert.throws(()=>proxyRoutes(pac),{code:'NETWORK_PROXY_UNSUPPORTED'});
});
test('G2 all unsupported system routes retain a specific bilingual explanation through production network service',async()=>{
  const service=await createNetworkService({resolveSystemProxy:async()=> 'SOCKS5 127.0.0.1:1080; QUIC localhost:443'});
  try{await assert.rejects(service.fetch('https://model.example/v1',{redirect:'manual'}),error=>{
    assert.equal(error.code,'NETWORK_PROXY_UNSUPPORTED');
    assert.equal(error.technical.code,'NETWORK_PROXY_UNSUPPORTED');
    assert.equal(error.message,'系统代理用的是 SOCKS，AI 酱还不支持。到 通用设置 → 网络 把代理改成「手动」并填 HTTP 代理地址，或者改成「不使用」。');
    assert.equal(networkErrorMessage(error.code,{language:'en'}),'The system proxy uses SOCKS, which AI Buddy does not support yet. In General settings → Network, set Proxy to Manual and enter an HTTP proxy address, or choose Do not use.');return true;
  });}finally{await service.close();}
});
