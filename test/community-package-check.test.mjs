import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {inspectDshDistribution} from '../scripts/community/check-package.mjs';

function archive(files, overrides = {}) { const parts = []; for (const [path, body] of Object.entries(files)) { const content = Buffer.from(body), header = Buffer.alloc(512); header.write(path); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116); header.write(content.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156); header[156] = overrides[path] ?? 48; header.write('ustar\0', 257); header.write('00', 263); header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148); parts.push(header, content, Buffer.alloc((512 - content.length % 512) % 512)); } return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)])); }
const fixture = () => ({'package/package.json': JSON.stringify({name: '@test/native', version: '1.0.0', type: 'module', main: './lib/index.js', engines: {dsh: '0.2.1-rc.3'}, dsh: {bundle: {patch: './cordis.patch.yml'}}}), 'package/lib/index.js': 'export function apply() {}', 'package/cordis.patch.yml': '- insert: []', 'package/LICENSE': 'Local test license'});
test('non-executing package check hashes exact final tarball and does not claim AI/native acceptance', () => {
  const result = inspectDshDistribution(archive(fixture())); assert.equal(result.packageName, '@test/native'); assert.equal(result.automaticCheck.status, 'passed'); assert.equal(result.aiReview.status, 'not-run'); assert.equal(result.nativeRuntimeValidation.status, 'not-run'); assert.equal(result.files.length, 4);
});
test('package checker rejects traversal, links, duplicate paths, missing compiled output and wrong hash', () => {
  assert.throws(() => inspectDshDistribution(archive({...fixture(), 'package/../escape': 'bad'})), /Unsafe|path/);
  assert.throws(() => inspectDshDistribution(archive(fixture(), {'package/lib/index.js': 50})), /links/);
  assert.throws(() => inspectDshDistribution(archive({...fixture(), 'package/LICENSE': 'one', 'package/license': 'two'})), /colliding/);
  const missing = fixture(); delete missing['package/lib/index.js']; assert.throws(() => inspectDshDistribution(archive(missing)), /compiled/);
  assert.throws(() => inspectDshDistribution(archive(fixture()), {expectedDigest: '0'.repeat(64)}), /SHA/);
  assert.throws(() => inspectDshDistribution(archive(fixture()), {expectedPackageName: '@test/other'}), /name/);
  assert.throws(() => inspectDshDistribution(archive(fixture()), {expectedVersion: '1.0.1'}), /version/);
});
test('lifecycle commands are reported as data for explicit approval and never executed', () => {
  const files = fixture(), value = JSON.parse(files['package/package.json']); value.scripts = {postinstall: 'node should-never-run.js'}; files['package/package.json'] = JSON.stringify(value);
  const result = inspectDshDistribution(archive(files)); assert.equal(result.buildScriptApprovalRequired, true); assert.equal(result.lifecycleScripts.postinstall, 'node should-never-run.js');
});
