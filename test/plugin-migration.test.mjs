import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePluginManifest} from '../src/plugin-manifest.mjs';

test('plugin data schema is explicit and its own version must be readable', () => {
  const manifest = {schemaVersion: 1, id: 'official.schema', name: 'Schema', description: '', version: '1.0.0', kind: 'asset', appRange: '*', apiRange: '^1.0.0', platform: 'win32', arch: 'x64', files: [{path: 'asset.bin', bytes: 0, sha256: '0'.repeat(64)}]};
  assert.equal(parsePluginManifest(manifest).dataSchemaVersion, 1);
  assert.deepEqual(parsePluginManifest({...manifest, dataSchemaVersion: 2, compatibleDataVersions: [1, 2]}).compatibleDataVersions, [1, 2]);
  assert.throws(() => parsePluginManifest({...manifest, dataSchemaVersion: 2, compatibleDataVersions: [1]}), /data compatibility/);
  assert.throws(() => parsePluginManifest({...manifest, dataSchemaVersion: 0}), /data compatibility/);
});
