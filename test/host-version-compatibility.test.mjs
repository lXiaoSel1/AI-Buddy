import test from 'node:test';
import assert from 'node:assert/strict';
import {pluginCompatibility, satisfiesVersionRange} from '../src/plugin-manifest.mjs';
import {catalog, setupCommunity} from './support/community-fixtures.mjs';

const manifest = changes => ({schemaVersion: 1, id: 'test.host-range', name: 'Test', description: '', version: '1.0.0', kind: 'asset', appRange: '>=2.0.11', apiRange: '^1.0.0', platform: 'win32', arch: 'x64', files: [{path: 'asset.json', bytes: 0, sha256: '0'.repeat(64)}], ...changes});

test('legacy installation admits later host prereleases only for a single lower bound', () => {
  for (const appVersion of ['2.0.11', '2.0.12-rc.1', '3.0.0-rc.1']) assert.equal(pluginCompatibility(manifest(), {appVersion}).compatible, true, appVersion);
  for (const appVersion of ['2.0.10', '2.0.11-rc.1']) assert.equal(pluginCompatibility(manifest(), {appVersion}).compatible, false, appVersion);
  assert.equal(pluginCompatibility(manifest({appRange: '>=2.0.11-rc.3'}), {appVersion: '2.0.12-rc.1'}).compatible, true);
  assert.equal(pluginCompatibility(manifest({appRange: '>=2.0.11-rc.3'}), {appVersion: '2.0.11-rc.2'}).compatible, false);
  for (const appRange of ['^2.0.11', '>=2.0.11 <3.0.0']) assert.equal(pluginCompatibility(manifest({appRange}), {appVersion: '2.0.12-rc.1'}).compatible, false);
  assert.equal(pluginCompatibility(manifest(), {appVersion: '3.0.0', apiVersion: '2.0.0-rc.1'}).compatible, false);
  assert.equal(satisfiesVersionRange('2.0.12-rc.1', '>=2.0.11'), false, 'generic dependency admission stays unchanged');
  for (const range of ['^1.3.0', '^1.0.0']) assert.equal(satisfiesVersionRange('2.0.0-rc.1', range), false);
  assert.equal(satisfiesVersionRange('1.3.1-rc.1', '^1.3.0'), false);
  assert.equal(satisfiesVersionRange('1.3.0-rc.4', '^1.3.0-rc.3'), true);
});

test('community installation plans accept host and DSH later prereleases while preserving bridge admission', async t => {
  const f = await setupCommunity(t);
  f.legacy.snapshot = () => ({appVersion: '2.0.12-rc.1'});
  let runtime = '0.2.1-rc.3';
  f.backend.probe = async () => ({ready: true, version: runtime});
  const payload = catalog(f.pub);
  payload.works[0].releases[0].package.compatibility = {app: '>=2.0.11', dsh: '>=0.2.1-rc.3', bridge: '^1.3.0'};
  await f.load(payload);
  for (runtime of ['0.2.1-rc.3', '0.2.1-rc.4', '0.2.2-rc.1', '0.3.0-rc.1', '0.3.0', '1.0.0']) {
    const plan = await f.service.action({action: 'dsh-plan', sourceId: f.pub.source.sourceId, id: 'test.tools'});
    assert.equal(plan.packageRef.compatibility.dsh, '>=0.2.1-rc.3', runtime);
  }
  for (runtime of ['0.2.0', '0.2.1-rc.2']) await assert.rejects(f.service.action({action: 'dsh-plan', sourceId: f.pub.source.sourceId, id: 'test.tools'}), {code: 'PLUGIN_INCOMPATIBLE'});
});
