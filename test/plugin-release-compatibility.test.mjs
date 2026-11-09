import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertNewReleaseCompatibility, assertCatalogReleaseCompatibility} from '../scripts/lib/plugin-release-compatibility.mjs';

const voice = changes => ({id: 'ai-buddy.voice-breeze', version: '1.0.3', appRange: '>=2.0.11', apiRange: '^1.0.0', dependencies: {'ai-buddy.voice-shared-runtime': '1.0.3'}, ...changes});
const community = changes => ({packageName: '@ai-buddy/test', exactVersion: '1.0.1', compatibility: {app: '>=2.0.2', dsh: '>=0.2.1-rc.3', bridge: '^1.3.0'}, ...changes});

test('new release gate accepts only single host lower bounds and bounded interfaces', () => {
  assert.doesNotThrow(() => assertNewReleaseCompatibility(voice()));
  assert.doesNotThrow(() => assertNewReleaseCompatibility(community()));
  for (const appRange of ['2.0.11', '^2.0.11', '~2.0.11', '>=2.0.11 <3.0.0', '>= 2.0.11', '>=2.0.11 || >=3.0.0', '>=2.0.01']) assert.throws(() => assertNewReleaseCompatibility(voice({appRange})), /appRange/);
  for (const field of ['app', 'dsh']) for (const value of ['0.2.1-rc.3', '^0.2.1-rc.3', '>=0.2.1-rc.3 <0.3.0']) {
    const row = community(); row.compatibility[field] = value; assert.throws(() => assertNewReleaseCompatibility(row), new RegExp(field));
  }
  for (const apiRange of ['1.0.0', '>=1.0.0', '~1.0.0', '*', '^1.0.0 || >=2.0.0']) assert.throws(() => assertNewReleaseCompatibility(voice({apiRange})), /apiRange/);
  assert.doesNotThrow(() => assertNewReleaseCompatibility(voice({apiRange: '>=1.0.0 <2.0.0'})));
  assert.throws(() => assertNewReleaseCompatibility(community({compatibility: {app: '>=2.0.2', dsh: '>=0.2.1-rc.3', bridge: '>=1.3.0'}})), /bridge/);
});

test('exact dependency exception is restricted to coordinated voice engines and the same release version', () => {
  assert.throws(() => assertNewReleaseCompatibility(voice({id: 'other.engine'})), /dependency/);
  assert.throws(() => assertNewReleaseCompatibility(voice({dependencies: {'ai-buddy.voice-shared-runtime': '1.0.2'}})), /dependency/);
  assert.throws(() => assertNewReleaseCompatibility(voice({dependencies: {'other.shared': '1.0.3'}})), /dependency/);
  assert.throws(() => assertNewReleaseCompatibility(voice({dependencies: {'other.shared': '1.0.3 || ^1.0.4'}})), /dependency/);
  assert.doesNotThrow(() => assertNewReleaseCompatibility(voice({dependencies: {'other.shared': '^1.0.0'}})));
});

test('catalog publication gate admits unchanged historical ranges and validates only additions', () => {
  const oldVoice = {manifest: voice({version: '1.0.2', appRange: '^2.0.11', dependencies: {'ai-buddy.voice-shared-runtime': '1.0.2'}}), archive: {sha256: 'old'}};
  const oldPackage = community({exactVersion: '1.0.0', compatibility: {app: '^2.0.2', dsh: '0.2.1-rc.3', bridge: '^1.3.0'}});
  const baselineLegacy = {packages: [oldVoice]}, baselineCommunity = {works: [{id: 'test', backend: 'dsh', releases: [{version: '1.0.0', package: oldPackage}]}]};
  const legacy = structuredClone(baselineLegacy), next = structuredClone(baselineCommunity);
  next.works[0].releases.push({version: '1.0.1', package: community()});
  assert.equal(assertCatalogReleaseCompatibility({legacy, community: next, baselineLegacy, baselineCommunity}).addedCommunityReleases, 1);
  const changed = structuredClone(next); changed.works[0].releases[0].package.compatibility.dsh = '>=0.2.1-rc.3';
  assert.throws(() => assertCatalogReleaseCompatibility({legacy, community: changed, baselineLegacy, baselineCommunity}), /Historical/);
  assert.throws(() => assertCatalogReleaseCompatibility({legacy: {packages: []}, community: next, baselineLegacy, baselineCommunity}), /Historical/);
  const invalid = structuredClone(next); invalid.works[0].releases[1].package.compatibility.app = '^2.0.2';
  assert.throws(() => assertCatalogReleaseCompatibility({legacy, community: invalid, baselineLegacy, baselineCommunity}), /app/);
});

test('source manifest DSH range must match the release wrapper', () => {
  const release = community(), sourceManifest = {name: release.packageName, version: release.exactVersion, engines: {dsh: '0.2.1-rc.3'}, aiBuddy: {bridgeVersion: '1.3.0'}};
  assert.throws(() => assertNewReleaseCompatibility(release, {sourceManifest}), /engines.dsh/);
  sourceManifest.engines.dsh = '>=0.2.1-rc.3';
  assert.doesNotThrow(() => assertNewReleaseCompatibility(release, {sourceManifest}));
  assert.doesNotThrow(() => assertNewReleaseCompatibility({...release, compatibility: {...release.compatibility, bridge: '>=1.3.0 <2.0.0'}}, {sourceManifest}));
  sourceManifest.dependencies = {'other.runtime': '1.0.0'};
  assert.throws(() => assertNewReleaseCompatibility(release, {sourceManifest}), /dependency/);
});

test('public release gate command fails a historical bounded host range and accepts a future lower bound', async t => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-release-gate-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const file = join(root, 'manifest.json'), command = new URL('../scripts/check-plugin-release-compatibility.mjs', import.meta.url);
  const invoke = () => spawnSync(process.execPath, [fileURLToPath(command), '--manifest=' + file], {encoding: 'utf8', windowsHide: true});
  await writeFile(file, JSON.stringify(voice({appRange: '^2.0.11'})));
  const denied = invoke(); assert.equal(denied.status, 1); assert.match(denied.stderr, /appRange: use one >=X lower bound/);
  await writeFile(file, JSON.stringify(voice()));
  const allowed = invoke(); assert.equal(allowed.status, 0, allowed.stderr); assert.equal(JSON.parse(allowed.stdout).passed, true);
});
