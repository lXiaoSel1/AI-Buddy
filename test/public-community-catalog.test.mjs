import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPluginManager} from '../src/plugin-manager.mjs';
import {defaultPluginSource, OFFICIAL_SOURCE_DESCRIPTOR_URL, OFFICIAL_SOURCE_CATALOG_URL} from '../src/plugin-sources.mjs';
import {createCommunityService} from '../src/community/service.mjs';
import {communityDigest, verifyCommunityCatalog} from '../src/community/catalog.mjs';
import {OFFICIAL_COMMUNITY_CATALOG_URL, OFFICIAL_COMMUNITY_FINGERPRINT, isOfficialCommunitySource, normalizeCommunitySource} from '../src/community/official-source.mjs';
import {catalog, publisher, signed, simulatedBackend, setupCommunity} from './support/community-fixtures.mjs';

const legacyDescriptor = JSON.parse(await readFile(new URL('./fixtures/public-community/source.json', import.meta.url), 'utf8'));
const legacyCatalog = JSON.parse(await readFile(new URL('./fixtures/public-community/catalog.json', import.meta.url), 'utf8'));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
async function officialFixture(t, metadata = async () => new Response('offline', {status: 503})) {
  const root = await mkdtemp(join(tmpdir(), 'buddy-public-community-')), dataRoot = join(root, 'data'), calls = [], nativeCalls = [], backend = simulatedBackend(nativeCalls);
  backend.probe = async () => ({ready: true, version: '0.2.1-rc.3'});
  const fetchImpl = async (url, options) => { calls.push({url, options}); if (url === OFFICIAL_SOURCE_DESCRIPTOR_URL) return Response.json(legacyDescriptor); if (url === OFFICIAL_SOURCE_CATALOG_URL) return Response.json(legacyCatalog); if (url === OFFICIAL_COMMUNITY_CATALOG_URL) return metadata(url, options); throw Error('Unexpected metadata URL: ' + url); };
  let manager, service;
  const start = async () => { manager = await createPluginManager({root, dataRoot, appVersion: '2.0.2', fetchImpl}); service = await createCommunityService({root, dataRoot, legacyManager: manager, dshBackend: backend, fetchImpl, pollMs: 0}); };
  await start(); t.after(async () => { await service.close(); await rm(root, {recursive: true, force: true}); });
  return {root, dataRoot, calls, nativeCalls, get manager() { return manager; }, get service() { return service; }, setMetadata(value) { metadata = value; }, async restart() { await service.close(); await start(); }, async addOfficial() { const preview = await service.action({action: 'sources-preview', url: OFFICIAL_SOURCE_DESCRIPTOR_URL}); assert.equal(preview.source.descriptorId, 'ai-buddy-official'); await service.action({action: 'sources-add', previewId: preview.previewId, keyFingerprint: preview.source.keyFingerprint}); }};
}

test('community canonical alias requires every fixed official identity field and retains disabled/removed intent', () => {
  const source = defaultPluginSource(), alias = {...source, descriptorId: 'ai-buddy-official', enabled: false, removed: true, generation: 17};
  assert.equal(source.keyFingerprint, OFFICIAL_COMMUNITY_FINGERPRINT); assert.equal(isOfficialCommunitySource(source), true); assert.equal(isOfficialCommunitySource(alias), true);
  assert.deepEqual(normalizeCommunitySource(alias), {...alias, descriptorId: 'ai-buddy.extensions'}); assert.equal(alias.descriptorId, 'ai-buddy-official');
  const other = publisher();
  for (const patch of [{sourceId: other.source.sourceId}, {descriptorId: 'unrelated.alias'}, {url: source.url + '?mirror=1'}, {url: source.url.replace('/main/', '/other/')}, {catalogUrl: OFFICIAL_COMMUNITY_CATALOG_URL}, {catalogUrl: 'https://third.example/catalog.json'}, {keyId: 'another-key'}, {publicKey: other.source.publicKey, keyFingerprint: other.source.keyFingerprint}, {publicKey: other.source.publicKey}, {keyFingerprint: other.source.keyFingerprint}]) {
    const candidate = {...alias, ...patch}; assert.equal(isOfficialCommunitySource(candidate), false, JSON.stringify(patch)); assert.equal(normalizeCommunitySource(candidate), candidate);
  }
});

test('official discovery is lazy, single-flight and absent from repeated status/search/maintenance', async t => {
  const started = gate(), release = gate(), f = await officialFixture(t, async () => { started.resolve(); await release.promise; return new Response('offline', {status: 503}); });
  for (let index = 0; index < 12; index++) { await f.service.action({action: 'status'}); await f.service.action({action: 'community-status'}); await f.service.action({action: 'community-search'}); await f.service.drainMaintenance(); }
  assert.equal(f.calls.length, 0); assert.equal(f.nativeCalls.length, 0);
  const opening = Promise.all([f.service.action({action: 'community-open'}), f.service.action({action: 'community-open'}), f.service.action({action: 'community-refresh'})]);
  await started.promise; assert.deepEqual(f.calls.map(row => row.url), [OFFICIAL_COMMUNITY_CATALOG_URL]); release.resolve();
  for (const value of await opening) assert.equal(value.results[0].error.code, 'PLUGIN_SOURCE_FETCH_FAILED');
  for (let index = 0; index < 8; index++) { await f.service.action({action: 'community-open'}); await f.service.action({action: 'community-status'}); }
  assert.equal(f.calls.length, 1); await f.service.action({action: 'community-refresh'}); assert.equal(f.calls.length, 2);
});

test('default official -> actual public descriptor add -> restart keeps canonical community identity without rewriting legacy trust', async t => {
  const f = await officialFixture(t); await f.service.action({action: 'community-open'}); await f.addOfficial();
  assert.equal(f.manager.resolveTrustedSource('official').descriptorId, 'ai-buddy-official'); assert.equal((await f.service.resolveTrustedSource('official')).descriptorId, 'ai-buddy.extensions');
  const sourcesFile = join(f.root, 'local/plugins/sources.json'), saved = await readFile(sourcesFile, 'utf8'); assert.equal(JSON.parse(saved).sources.official.descriptorId, 'ai-buddy-official');
  await f.service.action({action: 'community-open'}); const before = f.calls.length; await f.restart(); assert.equal(f.calls.length, before); assert.equal(await readFile(sourcesFile, 'utf8'), saved);
  assert.equal((await f.service.resolveTrustedSource('official')).descriptorId, 'ai-buddy.extensions'); await f.service.action({action: 'community-open'}); assert.equal(f.calls.at(-1).url, OFFICIAL_COMMUNITY_CATALOG_URL);
});

for (const operation of ['sources-disable', 'sources-remove']) test('lazy discovery never re-enables the ' + operation + ' official source across restart', async t => {
  const f = await officialFixture(t); await f.addOfficial(); await f.service.action({action: operation, sourceId: 'official', ...(operation === 'sources-disable' ? {disabled: true} : {})});
  const before = f.calls.length;
  for (let index = 0; index < 3; index++) { const value = await f.service.action({action: 'community-refresh'}); assert.equal(value.results[0].error.code, 'COMMUNITY_SOURCE_UNAVAILABLE'); await f.service.action({action: 'community-open'}); }
  await f.restart(); await f.service.action({action: 'community-open'}); assert.equal(f.calls.length, before); const source = f.manager.resolveTrustedSource('official'); assert.equal(source.enabled, false); if (operation === 'sources-remove') assert.equal(source.removed, true);
});

test('a source with an official-looking id but another signer/address receives no default endpoint', async t => {
  let requests = 0; const f = await setupCommunity(t, {fetchImpl: async () => { requests++; return new Response('unexpected', {status: 500}); }});
  Object.assign(f.pub.source, {sourceId: 'official', descriptorId: 'ai-buddy-official', url: OFFICIAL_SOURCE_DESCRIPTOR_URL, catalogUrl: OFFICIAL_SOURCE_CATALOG_URL});
  assert.deepEqual((await f.service.action({action: 'community-open'})).results, []);
  assert.equal((await f.service.action({action: 'community-refresh', sourceId: 'official'})).results[0].error.code, 'COMMUNITY_REMOTE_NOT_CONFIGURED'); assert.equal(requests, 0);
  assert.equal((await f.service.resolveTrustedSource('official')).descriptorId, 'ai-buddy-official');
});

test('offline refresh retains the verified signed cache and disabled source performs no fetch', async t => {
  const requests = [], f = await setupCommunity(t, {fetchImpl: async url => { requests.push(url); throw Error('offline'); }}), envelope = signed(catalog(f.pub), f.pub);
  await f.service.action({action: 'community-load-catalog', sourceId: f.pub.source.sourceId, url: 'https://third.example/community.json', envelope});
  const cacheFile = join(f.root, 'local/community/catalog-cache-v1.json'), before = await readFile(cacheFile, 'utf8'); await f.restart(); assert.equal(requests.length, 0);
  const value = await f.service.action({action: 'community-refresh'}); assert(value.results[0].error); assert.equal((await f.service.action({action: 'community-search'})).total, 1); assert.equal(await readFile(cacheFile, 'utf8'), before);
  const stored = JSON.parse(before).sources[f.pub.source.sourceId]; assert.deepEqual(stored.envelope, envelope); assert.equal(stored.watermark.digest, communityDigest(envelope.payload));
  f.pub.source.enabled = false; f.pub.source.generation++; await f.service.action({action: 'community-open'}); await f.service.action({action: 'community-refresh'}); assert.equal(requests.length, 1); assert.equal((await f.service.action({action: 'community-search'})).total, 0); assert.equal(await readFile(cacheFile, 'utf8'), before);
});

test('source generation changes reject stale metadata without committing its signed payload', async t => {
  const started = gate(), release = gate(), f = await setupCommunity(t, {fetchImpl: async () => { started.resolve(); await release.promise; return Response.json(signed(catalog(f.pub, {generatedAt: '2026-10-24T23:00:00Z'}), f.pub)); }});
  await f.service.action({action: 'community-load-catalog', sourceId: f.pub.source.sourceId, url: 'https://third.example/community.json', envelope: signed(catalog(f.pub), f.pub)});
  const cacheFile = join(f.root, 'local/community/catalog-cache-v1.json'), before = await readFile(cacheFile, 'utf8'), refreshing = f.service.action({action: 'community-refresh'}); await started.promise;
  f.pub.source.generation++; await f.service.action({action: 'community-status'}); release.resolve(); assert.equal((await refreshing).results[0].error.code, 'COMMUNITY_SOURCE_CHANGED'); assert.equal(await readFile(cacheFile, 'utf8'), before);
});

test('closing cancels an initial official fetch and settles its result without an unhandled rejection', async t => {
  const started = gate(), f = await officialFixture(t, async (_url, {signal}) => new Promise((_resolve, reject) => { started.resolve(); signal.addEventListener('abort', () => reject(signal.reason), {once: true}); }));
  const opening = f.service.action({action: 'community-open'}); await started.promise; await f.service.close(); assert.equal((await opening).results[0].error.code, 'COMMUNITY_CLOSED'); assert.equal(f.service.snapshot().community.works, 0);
});

for (const operation of ['sources-disable', 'sources-remove']) test(operation + ' aborts an initial official metadata request before cache commit', async t => {
  const started = gate(), f = await officialFixture(t, async (_url, {signal}) => new Promise((_resolve, reject) => { started.resolve(); signal.addEventListener('abort', () => reject(signal.reason), {once: true}); }));
  const opening = f.service.action({action: 'community-open'}); await started.promise;
  await f.service.action({action: operation, sourceId: 'official', ...(operation === 'sources-disable' ? {disabled: true} : {})});
  assert.equal((await opening).results[0].error.code, 'COMMUNITY_SOURCE_CHANGED'); assert.equal(f.service.snapshot().community.works, 0); assert.equal(f.manager.resolveTrustedSource('official').enabled, false);
  await assert.rejects(readFile(join(f.root, 'local/community/catalog-cache-v1.json')), {code: 'ENOENT'});
});

function syntheticLocal(pub) {
  const value = catalog(pub, {id: 'ai-buddy.r95-local-candidate'}), template = value.works[0];
  value.works = [['@ai-buddy/bilibili-companion', '2.0.9'], ['@ai-buddy/qq-connect', '2.0.5'], ['@ai-buddy/work-collaboration', '2.0.9']].map(([packageName, version], index) => { const work = structuredClone(template); work.id = 'local.r95-package-' + index; work.packageName = work.releases[0].package.packageName = packageName; work.releases[0].version = work.releases[0].package.exactVersion = version; work.releases[0].package.spec.value = 'https://github.com/test/native/releases/download/v' + version + '/package-' + index + '.tgz'; return work; });
  return value;
}
test('synthetic signer: old local ids upgrade by immutable package identity to public patches and preserve Work/unknown data', async t => {
  const f = await setupCommunity(t); f.config.officialFingerprints = new Set([f.pub.source.keyFingerprint]); await f.restart(); const old = syntheticLocal(f.pub);
  await f.service.action({action: 'community-load-catalog', sourceId: f.pub.source.sourceId, url: 'https://127.0.0.1:4443/catalog.json', envelope: signed(old, f.pub)});
  for (const work of old.works) { const plan = await f.service.action({action: 'dsh-plan', sourceId: f.pub.source.sourceId, id: work.id}); await f.service.action({action: 'dsh-install', planId: plan.planId, grantedCapabilities: plan.declaredCapabilities}); await f.service.drainMaintenance(); const record = f.service.snapshot().dsh.installed.find(row => row.packageName === work.packageName); await f.service.action({action: 'dsh-enable', packageKey: record.packageKey}); await f.service.drainMaintenance(); }
  const marker = join(f.dataRoot, 'community', 'unknown-marker.json'); await writeFile(marker, '{"outcome":"unknown","replay":false}'); await f.service.close();
  const registryFile = join(f.root, 'local/community/dsh-registry-v1.json'), registry = JSON.parse(await readFile(registryFile, 'utf8')); registry.unknownReceipts = [{id: 'retained-unknown', outcome: 'unknown'}]; await writeFile(registryFile, JSON.stringify(registry)); await f.restart();
  const workBefore = f.service.snapshot().dsh.installed.find(row => row.packageName === '@ai-buddy/work-collaboration'), fresh = structuredClone(old); fresh.id = 'ai-buddy.public-extensions'; fresh.generatedAt = '2026-10-24T23:00:00Z'; fresh.works = fresh.works.slice(0, 2);
  for (const [index, work] of fresh.works.entries()) { work.id = index ? 'ai-buddy.qq-connect' : 'ai-buddy.bilibili-companion'; const release = structuredClone(work.releases[0]); release.version = release.package.exactVersion = index ? '2.0.6' : '2.0.11'; release.package.sourceDigest = (index ? 'e' : 'f').repeat(64); release.package.spec.value = 'https://github.com/test/native/releases/download/v' + release.version + '/public-' + index + '.tgz'; work.releases = [release]; }
  await f.service.action({action: 'community-load-catalog', sourceId: f.pub.source.sourceId, url: OFFICIAL_COMMUNITY_CATALOG_URL, envelope: signed(fresh, f.pub)});
  const {updates} = await f.service.action({action: 'community-check-updates'}); assert.deepEqual(updates.map(row => [row.workId, row.to]).sort(), [['ai-buddy.bilibili-companion', '2.0.11'], ['ai-buddy.qq-connect', '2.0.6']]);
  for (const row of updates) { const plan = await f.service.action({action: 'dsh-plan', sourceId: row.sourceId, id: row.workId}); assert.deepEqual(plan.addedCapabilities, []); await f.service.action({action: 'dsh-install', planId: plan.planId, grantedCapabilities: plan.priorGrantedCapabilities}); await f.service.drainMaintenance(); }
  const workAfter = f.service.snapshot().dsh.installed.find(row => row.packageName === '@ai-buddy/work-collaboration'); assert.deepEqual(workAfter, workBefore); assert.deepEqual(JSON.parse(await readFile(registryFile, 'utf8')).unknownReceipts, registry.unknownReceipts); assert.equal(await readFile(marker, 'utf8'), '{"outcome":"unknown","replay":false}');
  const altered = structuredClone(fresh); altered.generatedAt = '2026-10-25T00:00:00Z'; altered.works[0].releases[0].package.spec.value = 'https://github.com/test/native/releases/download/v2.0.11/other.tgz';
  await assert.rejects(f.service.action({action: 'community-load-catalog', sourceId: f.pub.source.sourceId, envelope: signed(altered, f.pub)}), {code: 'COMMUNITY_RELEASE_CHANGED'});
  await f.restart(); await assert.rejects(f.service.action({action: 'community-load-catalog', sourceId: f.pub.source.sourceId, envelope: signed(old, f.pub)}), {code: 'COMMUNITY_CATALOG_REPLAY'}); assert.equal(f.service.snapshot().dsh.installed.length, 3);
});

// Root supplies exact signed bytes after the separately authorized signing gate. No release key or private fixture is bundled.
const oldPath = process.env.AI_BUDDY_PUBLIC_COMMUNITY_OLD, nextPath = process.env.AI_BUDDY_PUBLIC_COMMUNITY_NEW;
test('release gate: exact official default -> public source add -> restart -> old-local/public-patch upgrade', {skip: !oldPath || !nextPath}, async t => {
  const readEnvelope = async path => { const value = JSON.parse(await readFile(path, 'utf8')); return value.sources?.official?.envelope ?? value; };
  const old = await readEnvelope(oldPath), next = await readEnvelope(nextPath), f = await officialFixture(t, async () => Response.json(old));
  assert.equal(f.calls.length, 0); assert.equal((await f.service.action({action: 'community-open'})).results[0].ok, true); assert.deepEqual(JSON.parse(await readFile(join(f.root, 'local/community/catalog-cache-v1.json'), 'utf8')).sources.official.envelope, old);
  for (const packageName of ['@ai-buddy/bilibili-companion', '@ai-buddy/qq-connect']) { const work = old.payload.works.find(row => row.packageName === packageName), plan = await f.service.action({action: 'dsh-plan', sourceId: 'official', id: work.id}); await f.service.action({action: 'dsh-install', planId: plan.planId, grantedCapabilities: plan.declaredCapabilities}); await f.service.drainMaintenance(); }
  await f.addOfficial(); assert.equal((await f.service.resolveTrustedSource('official')).descriptorId, 'ai-buddy.extensions'); assert.equal(verifyCommunityCatalog(old, f.manager.resolveTrustedSource('official')).verified.payloadSha256, communityDigest(old.payload));
  const before = f.calls.length; await f.restart(); assert.equal(f.calls.length, before); f.setMetadata(async () => Response.json(next)); assert.equal((await f.service.action({action: 'community-open'})).results[0].ok, true);
  const expected = [['ai-buddy.bilibili-companion', '2.0.11'], ['ai-buddy.qq-connect', '2.0.6']], {updates} = await f.service.action({action: 'community-check-updates'}); assert.deepEqual(updates.map(row => [row.workId, row.to]).sort(), expected);
  for (const row of updates) {
    const plan = await f.service.action({action: 'dsh-plan', sourceId: row.sourceId, id: row.workId, version: row.to});
    const retained = plan.priorGrantedCapabilities.filter(cap => plan.declaredCapabilities.includes(cap));
    assert.deepEqual([...plan.addedCapabilities].sort(), ['lifecycle.register', 'ui.registerPage']);
    assert.equal(retained.some(cap => plan.addedCapabilities.includes(cap)), false);
    await f.service.action({action: 'dsh-install', planId: plan.planId, grantedCapabilities: retained}); await f.service.drainMaintenance();
    const installed = f.service.snapshot().dsh.installed.find(value => value.packageName === plan.packageRef.packageName);
    assert.deepEqual([...installed.grantedCapabilities].sort(), [...retained].sort());
  }
  assert.deepEqual(f.service.snapshot().dsh.installed.map(row => [row.packageName, row.exactVersion]).sort(), [['@ai-buddy/bilibili-companion', '2.0.11'], ['@ai-buddy/qq-connect', '2.0.6']]);
  const accepted = await readFile(join(f.root, 'local/community/catalog-cache-v1.json'), 'utf8'); f.setMetadata(async () => { throw Error('offline'); }); assert((await f.service.action({action: 'community-refresh'})).results[0].error); assert.equal(await readFile(join(f.root, 'local/community/catalog-cache-v1.json'), 'utf8'), accepted);
});
