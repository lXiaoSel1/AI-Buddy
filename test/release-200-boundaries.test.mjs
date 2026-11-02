import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkReleaseVersion} from '../scripts/check-release-version.mjs';
import {pluginCompatibility,satisfiesVersionRange} from '../src/plugin-manifest.mjs';
const root=new URL('../',import.meta.url);
test('public 2.0.2 source aligns installer/download identities and retains approved media base',()=>{
 const state=checkReleaseVersion(root.pathname.replace(/^\/([A-Za-z]:)/,'$1'));
 assert.equal(state.version,'2.0.2');assert.equal(state.stage,'published');assert.equal(state.publishedVersion,'2.0.2');assert.equal(state.resourceBaseVersion,'1.9.2');assert.equal(state.installerVersion,'2.0.2');
});
test('explicit cross-version plugin range allows only tested hosts and does not widen bridge version',()=>{
 for(const version of ['1.9.2','2.0.0'])assert(satisfiesVersionRange(version,'1.9.2 || 2.0.0'));
 for(const version of ['1.9.1','2.0.1','2.1.0','3.0.0'])assert(!satisfiesVersionRange(version,'1.9.2 || 2.0.0'));
});
test('deferred Kimi manifest stays unchanged and rejects 2.0 while permitting previous host',()=>{
 const manifest={...JSON.parse(readFileSync(new URL('../sdk/plugins/kimi-engine/manifest-template.json',import.meta.url),'utf8')),files:[{path:'dist/entry.mjs',bytes:1,sha256:'a'.repeat(64)}]};
 assert.equal(pluginCompatibility(manifest,{appVersion:'2.0.0'}).compatible,false);
 assert.equal(pluginCompatibility(manifest,{appVersion:'1.9.2'}).compatible,true);
});
