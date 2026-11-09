import test from 'node:test';import assert from 'node:assert/strict';
import {createAppReleaseClient} from '../src/update-release-proof.mjs';import {releaseFixture} from './fixtures/app-update-r4.mjs';
test('rate-limited update discovery accepts an independently verified static proof and rejects tampering',async()=>{
 const fixture=releaseFixture(),urls=[];
 const client=createAppReleaseClient({verifySignature:fixture.verifySignature,fetch:async url=>{urls.push(url);return url.startsWith('https://api.github.com/')?new Response('{}',{status:403,headers:{'x-ratelimit-remaining':'0'}}):new Response(JSON.stringify({schemaVersion:1,release:fixture.release}));}});
 assert.equal((await client.check('2.0.7')).installerSha256,fixture.release.installerSha256);assert.ok(urls.some(url=>url.includes('/releases/latest/download/app-release-proof.json')));
 const bad=createAppReleaseClient({verifySignature:fixture.verifySignature,fetch:async url=>url.startsWith('https://api.github.com/')?new Response('{}',{status:429}):new Response(JSON.stringify({schemaVersion:1,release:{...fixture.release,installerSha256:'a'.repeat(64)}}))});
 await assert.rejects(bad.check('2.0.7'),{code:'APP_UPDATE_VERIFICATION_FAILED'});
});
