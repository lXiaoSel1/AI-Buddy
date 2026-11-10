import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPluginManager} from '../src/plugin-manager.mjs';
import {createCommunityService} from '../src/community/service.mjs';
import {OFFICIAL_SOURCE_CATALOG_URL, OFFICIAL_SOURCE_DESCRIPTOR_URL} from '../src/plugin-sources.mjs';
import {catalog, setupCommunity} from './support/community-fixtures.mjs';

const fixture = new URL('./fixtures/official-registration/', import.meta.url);
const breeze = 'ai-buddy.voice-breeze';
async function officialSetup(t, {appVersion = '2.0.14', cached = true, fetchFailure} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'community-install-compatibility-')), dataRoot = join(root, 'data');
  await mkdir(dataRoot);
  const envelope = JSON.parse(await readFile(new URL('catalog.json', fixture), 'utf8'));
  const descriptor = JSON.parse(await readFile(new URL('./fixtures/public-community/source.json', import.meta.url), 'utf8'));
  const fetches = [];
  const managerOptions = {root, dataRoot, appVersion, fetchImpl: async url => {
    fetches.push(url);
    if (fetchFailure) throw fetchFailure;
    if (url === OFFICIAL_SOURCE_DESCRIPTOR_URL) return Response.json(descriptor);
    if (url === OFFICIAL_SOURCE_CATALOG_URL) return Response.json(envelope);
    throw Error('Unexpected package download: ' + url);
  }};
  let manager = await createPluginManager(managerOptions);
  if (cached) await manager.loadCatalog(envelope);
  let service = await createCommunityService({root, dataRoot, legacyManager: manager, voiceEnabled: true, pollMs: 0});
  t.after(async () => { await service.close(); await rm(root, {recursive: true, force: true}); });
  await service.action({action: 'community-load-catalog', sourceId: 'official', envelope: JSON.parse(await readFile(new URL('community-catalog.json', fixture), 'utf8'))});
  const plan = version => service.action({action: 'dsh-plan', sourceId: 'official', id: breeze, ...(version ? {version} : {})});
  return {get service() {return service;}, get manager() {return manager;}, fetches, plan,
    async restartWithCache(change) {
      await service.close();
      await change(join(root, 'local/plugins/sources/official/catalog.json'));
      manager = await createPluginManager(managerOptions);
      service = await createCommunityService({root, dataRoot, legacyManager: manager, voiceEnabled: true, pollMs: 0});
    }};
}

for (const [appVersion, expected] of [['2.0.12', '1.0.2'], ['2.0.14', '1.0.3']]) test(`discover installs the latest supported voice release on AI Buddy ${appVersion}`, async t => {
  const f = await officialSetup(t, {appVersion});
  const plan = await f.plan();
  assert.equal(plan.packages.find(item => item.manifest.id === breeze).manifest.version, expected);
  assert.equal(f.fetches.length, 0, 'a verified cached catalog needs no automatic refresh');
  assert.equal((await f.plan('1.0.1')).packages.find(item => item.manifest.id === breeze).manifest.version, '1.0.1');
  if (appVersion === '2.0.12') await assert.rejects(f.plan('1.0.3'), {code: 'PLUGIN_INCOMPATIBLE'});
});

test('discover explains that an app update is needed when no voice release is compatible', async t => {
  const f = await officialSetup(t, {appVersion: '2.0.8'});
  await assert.rejects(f.plan(), {code: 'COMMUNITY_NO_COMPATIBLE_RELEASE', message: '这个插件的最新版需要更新的 AI 酱。先更新 AI 酱，或者在「版本」里选一个能用的旧版。'});
});

test('a fresh discovery install refreshes the official catalog once and returns its voice plan', async t => {
  const f = await officialSetup(t, {cached: false});
  assert.equal((await f.plan()).packages.find(item => item.manifest.id === breeze).manifest.version, '1.0.3');
  assert.equal(f.fetches.filter(url => url === OFFICIAL_SOURCE_CATALOG_URL).length, 1);
  await f.plan('1.0.2');
  assert.equal(f.fetches.filter(url => url === OFFICIAL_SOURCE_CATALOG_URL).length, 1, 'the verified cache is reused');
});

test('a failed first catalog refresh returns the network failure without an install-plan retry loop', async t => {
  const f = await officialSetup(t, {cached: false, fetchFailure: Object.assign(Error('Fixture DNS lookup failed'), {code: 'ENOTFOUND'})});
  await assert.rejects(f.plan(), {code: 'NETWORK_CONNECT_FAILED', message: '连不上 raw.githubusercontent.com。检查网络，或者到 通用设置 → 网络 设置代理。也可以用离线导入。'});
  assert.equal(f.fetches.length, 1);
});

const unavailableCache = {
  missing: path => rm(path),
  'invalid-signature': async path => {
    const envelope = JSON.parse(await readFile(path, 'utf8'));
    envelope.signature.value = 'invalid-cache-signature';
    await writeFile(path, JSON.stringify(envelope));
  },
};
for (const [state, change] of Object.entries(unavailableCache)) {
  test(`review N1: ${state} cache after restart refreshes once despite a persisted cachedAt`, async t => {
    const f = await officialSetup(t);
    await f.restartWithCache(change);
    assert.ok(f.manager.snapshot().sources.find(source => source.sourceId === 'official').cachedAt);
    await assert.rejects(f.manager.action({action: 'details', sourceId: 'official', id: breeze, version: '1.0.3'}), {code: 'PLUGIN_NOT_FOUND'}, 'unverified/missing cache is not accepted');
    const plan = await f.plan();
    assert.equal(plan.packages.find(item => item.manifest.id === breeze).manifest.version, '1.0.3');
    assert.equal(f.fetches.filter(url => url === OFFICIAL_SOURCE_CATALOG_URL).length, 1);
    assert.equal(f.manager.snapshot().sources.find(source => source.sourceId === 'official').catalogAvailable, true);
  });
  test(`review N1: ${state} cache refresh failure returns its network error after restart`, async t => {
    const f = await officialSetup(t, {fetchFailure: Object.assign(Error('Fixture DNS lookup failed'), {code: 'ENOTFOUND'})});
    await f.restartWithCache(change);
    await assert.rejects(f.plan(), {code: 'NETWORK_CONNECT_FAILED', message: '连不上 raw.githubusercontent.com。检查网络，或者到 通用设置 → 网络 设置代理。也可以用离线导入。'});
    assert.equal(f.fetches.length, 1);
    assert.equal(f.manager.snapshot().sources.find(source => source.sourceId === 'official').catalogAvailable, false);
  });
}

test('discovery and version details expose the selected release and each voice host requirement', async t => {
  const f = await officialSetup(t, {appVersion: '2.0.12'});
  const detail = await f.service.action({action: 'community-details', sourceId: 'official', id: breeze});
  assert.equal(detail.work.installationVersion, '1.0.2');
  assert.equal(detail.work.releases.find(release => release.version === '1.0.3').compatibility.compatible, false);
  assert.equal(detail.work.releases.find(release => release.version === '1.0.3').compatibility.requiredAppRange, '>=2.0.13');
  const search = await f.service.action({action: 'community-search'});
  assert.equal(search.items.find(work => work.id === breeze).installationVersion, '1.0.2');
});

test('discover chooses the latest DSH release satisfying app, bridge and runtime ranges', async t => {
  const f = await setupCommunity(t), value = catalog(f.pub), base = value.works[0].releases[0];
  for (const [version, key] of [['1.0.1', 'app'], ['1.0.2', 'bridge'], ['1.0.3', 'dsh']]) {
    const release = structuredClone(base);
    release.version = release.package.exactVersion = version;
    release.package.compatibility[key] = '^99.0.0';
    value.works[0].releases.push(release);
  }
  await f.load(value);
  const plan = await f.service.action({action: 'dsh-plan', sourceId: f.pub.source.sourceId, id: 'test.tools'});
  assert.equal(plan.packageRef.exactVersion, '1.0.0');
  await assert.rejects(f.service.action({action: 'dsh-plan', sourceId: f.pub.source.sourceId, id: 'test.tools', version: '1.0.2'}), {code: 'PLUGIN_INCOMPATIBLE'});
});
