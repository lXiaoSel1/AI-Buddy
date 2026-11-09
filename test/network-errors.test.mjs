import test from 'node:test';import assert from 'node:assert/strict';
import {networkFailure,networkErrorMessage} from '../src/network-errors.mjs';
test('network explanations distinguish native Electron certificates, numeric timeout codes and GitHub limits',()=>{
 assert.equal(networkFailure(Error('net::ERR_CERT_AUTHORITY_INVALID'),'https://github.com/a').code,'NETWORK_CERTIFICATE');
 assert.equal(networkFailure(new DOMException('expired','TimeoutError'),'https://github.com/a').code,'NETWORK_TIMEOUT');
 assert.equal(networkFailure(null,'https://api.github.com/a',{response:new Response('{}',{status:403,headers:{'x-ratelimit-remaining':'0'}})}).code,'NETWORK_RATE_LIMITED');
 const failure=networkFailure(Object.assign(Error('getaddrinfo failed'),{code:'ENOTFOUND'}),'https://catalog.example/a');assert.equal(failure.host,'catalog.example');assert.match(failure.message,/catalog.example/);assert.doesNotMatch(failure.message,/fetch failed/);assert.match(networkErrorMessage(failure.code,{host:failure.host,language:'en'}),/General settings/);
});
