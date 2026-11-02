import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile, readdir, mkdir, symlink} from 'node:fs/promises';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {catalog, signed, publisher, sha, simulatedBackend} from './support/community-fixtures.mjs';
import {createCommunityService} from '../src/community/service.mjs';
import {buildOfflinePluginBundle, readOfflinePluginFile} from '../src/community/offline-bundle.mjs';
import {parseCommunityCatalog} from '../src/community/catalog.mjs';
import {buildBundleFile} from '../scripts/community/build-offline-bundle.mjs';

const base = () => process.env.AI_BUDDY_TEST_TEMP_BASE || tmpdir();
// A real npm-pack shaped tarball: ustar entries under package/, gzip-compressed.
function tarEntry(name, data, type = '0') {
  const header = Buffer.alloc(512), put = (text, offset, length) => header.write(text, offset, length, 'utf8');
  put(name, 0, 100); put('0000644\0', 100, 8); put('0000000\0', 108, 8); put('0000000\0', 116, 8); put(data.length.toString(8).padStart(11, '0') + '\0', 124, 12); put('00000000000\0', 136, 12); put('        ', 148, 8); put(type, 156, 1); put('ustar\0', 257, 6); put('00', 263, 2);
  let sum = 0; for (const byte of header) sum += byte; put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
const npmPack = (name, version) => gzipSync(Buffer.concat([tarEntry('package/package.json', Buffer.from(JSON.stringify({name, version}))), tarEntry('package/index.js', Buffer.from('export default 1;\n')), Buffer.alloc(1024)]));

async function setup(t, {sources = true, backend, delay = () => 0, options = {}} = {}) {
  const root = await mkdtemp(join(base(), 'buddy-offline-')), dataRoot = join(root, 'data'), pub = publisher(), calls = [], other = publisher();
  const legacy = {snapshot: () => ({appVersion: '1.9.2', service: {state: 'ready', usable: true}, installed: {}, packages: [], ...(sources ? {sources: [{sourceId: pub.source.sourceId, name: 'Test source'}, {sourceId: 'legacy', name: 'legacy'}]} : {})}), action: async request => request.action === 'status' ? legacy.snapshot() : {legacy: true}, resolveTrustedSource: async id => { const wait = delay(); if (wait) await new Promise(done => setTimeout(done, wait)); if (id !== pub.source.sourceId) throw Error('Unknown source'); return {...pub.source}; }, close: async () => {}, prepareOffline: async () => ({}), resolveInstalled: async () => ({})};
  const config = {root, dataRoot, legacyManager: legacy, dshBackend: backend ?? simulatedBackend(calls), pollMs: 0, ...(typeof options === 'function' ? options(pub) : options)};
  let service = await createCommunityService(config);
  t.after(async () => { await service.close(); await rm(root, {recursive: true, force: true}); });
  const importFile = async path => { const preview = await service.prepareDshOffline(path); return {preview, result: await service.action({action: 'community-offline-confirm', importId: preview.importId})}; };
  const tgz = npmPack('@community-test/test-tools', '1.0.0'), value = catalog(pub);
  value.works[0].releases[0].package.sourceDigest = sha(tgz);
  const file = async (name, bytes) => { const path = join(root, name); await writeFile(path, bytes); return path; };
  return {root, pub, other, calls, get service() { return service; }, legacy, tgz, value, file, importFile, config, async restart() { await service.close(); service = await createCommunityService(config); return service; }};
}

test('offline bundle: a signed catalog plus its tarball opens the normal plan, from the local file, with nothing extra granted', async t => {
  const f = await setup(t), bundle = buildOfflinePluginBundle({envelope: signed(f.value, f.pub), packages: [f.tgz]});
  const path = await f.file('plugins.aibuddy-plugins', bundle), preview = await f.service.prepareDshOffline(path);
  // nothing is stored before the confirmation, which shows the signed catalog date
  assert.equal(preview.generatedAt, f.value.generatedAt); assert.equal(preview.replaceCatalog, true); assert.equal(preview.activeGeneratedAt, null); assert.equal(f.service.snapshot().community.configured, false);
  const result = await f.service.action({action: 'community-offline-confirm', importId: preview.importId});
  await assert.rejects(f.service.action({action: 'community-offline-confirm', importId: preview.importId}), {code: 'COMMUNITY_OFFLINE_EXPIRED'});
  assert.equal(result.sourceId, f.pub.source.sourceId); assert.deepEqual(result.works, [{sourceId: f.pub.source.sourceId, id: 'test.tools', packageName: '@community-test/test-tools', version: '1.0.0'}]);
  // the imported catalog is the same verified, persisted catalog an online load would give
  assert.equal(f.service.snapshot().community.configured, true); assert.equal((await f.service.action({action: 'community-search'})).total, 1);
  const plan = await f.service.action({action: 'dsh-plan', sourceId: f.pub.source.sourceId, id: 'test.tools'});
  const request = f.calls.find(call => call[0] === 'plan')[1];
  assert.match(request.spec, /offline[\\/][0-9a-f]{64}\.tgz$/); assert.equal(request.packageRef.spec.kind, 'tarball'); assert.equal(request.packageRef.sourceDigest, sha(f.tgz));
  assert.deepEqual(await readFile(request.spec), f.tgz); assert.equal(plan.offline, true); assert.equal(plan.packageBytes, f.tgz.length);
  // still the same explicit grant and queue path as online
  await assert.rejects(f.service.action({action: 'dsh-install', planId: plan.planId, grantedCapabilities: ['tools.invoke']}), {code: 'COMMUNITY_CAPABILITY_INVALID'});
  await f.service.action({action: 'dsh-install', planId: plan.planId, grantedCapabilities: []}); await f.service.drainMaintenance();
  const record = f.service.snapshot().dsh.installed[0]; assert.equal(record.enabled, false); assert.deepEqual(record.grantedCapabilities, []);
});

test('offline bare tarball installs only when an already verified catalog lists its digest', async t => {
  const f = await setup(t), path = await f.file('test-tools-1.0.0.tgz', f.tgz);
  await assert.rejects(f.service.prepareDshOffline(path), {code: 'COMMUNITY_OFFLINE_UNSIGNED'});
  await f.service.action({action: 'community-load-catalog', sourceId: f.pub.source.sourceId, envelope: signed(f.value, f.pub)});
  const {result} = await f.importFile(path); assert.equal(result.sourceId, null); assert.equal(result.works[0].id, 'test.tools');
  await f.service.action({action: 'dsh-plan', sourceId: f.pub.source.sourceId, id: 'test.tools'}); assert.match(f.calls.find(call => call[0] === 'plan')[1].spec, /\.tgz$/);
});

test('offline import refuses unsigned, foreign-key, altered and non-tarball files and never adds a key', async t => {
  const f = await setup(t);
  // signed by a key nobody trusts
  await assert.rejects(f.service.prepareDshOffline(await f.file('a.aibuddy-plugins', buildOfflinePluginBundle({envelope: signed({...f.value, source: {descriptorId: f.other.source.descriptorId, keyFingerprint: f.other.source.keyFingerprint}}, f.other), packages: [f.tgz]}))), {code: 'COMMUNITY_OFFLINE_UNTRUSTED'});
  // a trusted fingerprint claimed, but signed with another key
  await assert.rejects(f.service.prepareDshOffline(await f.file('b.aibuddy-plugins', buildOfflinePluginBundle({envelope: signed(f.value, f.other), packages: [f.tgz]}))), {code: 'PLUGIN_SIGNATURE_INVALID'});
  assert.equal(f.service.snapshot().community.configured, false);
  // a tarball the catalog does not list
  const extra = npmPack('@community-test/test-tools', '9.9.9');
  await assert.rejects(f.service.prepareDshOffline(await f.file('c.aibuddy-plugins', buildOfflinePluginBundle({envelope: signed(f.value, f.pub), packages: [f.tgz, extra]}))), {code: 'COMMUNITY_OFFLINE_UNSIGNED'});
  // a registry-published release cannot be satisfied from a file
  const registry = structuredClone(f.value); registry.works[0].releases[0].package.spec = {kind: 'registry', value: '@community-test/test-tools@1.0.0'};
  await assert.rejects(f.service.prepareDshOffline(await f.file('d.aibuddy-plugins', buildOfflinePluginBundle({envelope: signed(registry, f.pub), packages: [f.tgz]}))), {code: 'COMMUNITY_OFFLINE_SOURCE_KIND'});
  // nothing was loaded, staged or installed
  assert.equal(f.service.snapshot().community.configured, false); assert.equal(f.service.snapshot().dsh.installed.length, 0);
  const staged = await readdir(join(f.root, 'local/community/offline')).catch(() => []); assert.deepEqual(staged, []);
});

test('offline import keeps the online replay rule: an older catalog cannot replace a newer verified one', async t => {
  const f = await setup(t), newer = structuredClone(f.value); newer.generatedAt = '2026-10-25T22:00:00Z';
  await f.service.action({action: 'community-load-catalog', sourceId: f.pub.source.sourceId, envelope: signed(newer, f.pub)});
  // an older file never replaces the catalog in use; its packages are matched against the catalog in use (review 中-1, 低-1)
  const {preview, result} = await f.importFile(await f.file('old.aibuddy-plugins', buildOfflinePluginBundle({envelope: signed(f.value, f.pub), packages: [f.tgz]})));
  assert.equal(preview.replaceCatalog, false); assert.equal(preview.keptReason, 'COMMUNITY_CATALOG_REPLAY'); assert.equal(preview.generatedAt, f.value.generatedAt); assert.equal(preview.activeGeneratedAt, newer.generatedAt); assert.equal(result.works[0].id, 'test.tools');
  const watermark = () => JSON.parse(fs.readFileSync(join(f.root, 'local/community/catalog-cache-v1.json'), 'utf8')).sources[f.pub.source.sourceId].watermark.generatedAt;
  assert.equal(watermark(), newer.generatedAt);
  // an older file with no packages is refused, and the refusal does not mark the valid catalog stale
  await assert.rejects(f.importFile(await f.file('old-empty.aibuddy-plugins', buildOfflinePluginBundle({envelope: signed(f.value, f.pub)}))), {code: 'COMMUNITY_CATALOG_REPLAY'});
  assert.equal((await f.service.action({action: 'community-search'})).items[0].stale, false); assert.equal(watermark(), newer.generatedAt);
});

test('offline file reader is strict about shape and names, and the builder output round-trips', async t => {
  const f = await setup(t), envelope = signed(f.value, f.pub), bundle = buildOfflinePluginBundle({envelope, packages: [f.tgz, f.tgz]});
  const read = readOfflinePluginFile(bundle); assert.equal(read.packages.length, 1); assert.equal(read.packages[0].sha256, sha(f.tgz)); assert.deepEqual(read.envelope, envelope);
  assert.deepEqual(readOfflinePluginFile(gzipSync(bundle)).packages[0].bytes, f.tgz);
  assert.equal(readOfflinePluginFile(f.tgz).envelope, null);
  const renamed = Buffer.from(bundle); const at = renamed.indexOf('packages/'); renamed.write('0'.repeat(64), at + 9, 'utf8');
  assert.throws(() => readOfflinePluginFile(renamed), {code: 'COMMUNITY_OFFLINE_INVALID'});
  const stray = Buffer.concat([tarEntry('notes.txt', Buffer.from('hi')), bundle]); assert.throws(() => readOfflinePluginFile(stray), {code: 'COMMUNITY_OFFLINE_INVALID'});
  assert.throws(() => readOfflinePluginFile(Buffer.concat([tarEntry('packages/' + sha(f.tgz) + '.tgz', f.tgz), Buffer.alloc(1024)])), /no signed catalog/);
  // release tooling script: refuses a tarball the envelope does not list
  const envelopePath = await f.file('envelope.json', JSON.stringify(envelope)), good = await f.file('good.tgz', f.tgz), bad = await f.file('bad.tgz', npmPack('x', '1.0.0'));
  const key = f.pub.source.publicKey, out = name => join(f.root, name);
  const built = await buildBundleFile({envelope: envelopePath, publicKey: key, packages: [good], out: out('out.aibuddy-plugins')}); assert.deepEqual(built.packages, [sha(f.tgz)]); assert.equal(built.generatedAt, f.value.generatedAt);
  await assert.rejects(buildBundleFile({envelope: envelopePath, publicKey: key, packages: [bad], out: out('x.aibuddy-plugins')}), {code: 'COMMUNITY_OFFLINE_UNSIGNED'});
  // review 低-10: wrong key, registry release, a PAX header and a mislabelled package are refused by the tool already
  await assert.rejects(buildBundleFile({envelope: envelopePath, publicKey: f.other.source.publicKey, packages: [good], out: out('y.aibuddy-plugins')}), {code: 'PLUGIN_SIGNATURE_INVALID'});
  await assert.rejects(buildBundleFile({envelope: envelopePath, packages: [good], out: out('y.aibuddy-plugins')}), {code: 'COMMUNITY_OFFLINE_KEY_REQUIRED'});
  const registry = structuredClone(f.value); registry.works[0].releases[0].package.spec = {kind: 'registry', value: '@community-test/test-tools@1.0.0'};
  await assert.rejects(buildBundleFile({envelope: await f.file('registry.json', JSON.stringify(signed(registry, f.pub))), publicKey: key, packages: [good], out: out('z.aibuddy-plugins')}), {code: 'COMMUNITY_OFFLINE_SOURCE_KIND'});
  const pax = gzipSync(Buffer.concat([tarEntry('pax_global_header', Buffer.from('52 comment=x\n'), 'g'), tarEntry('package/package.json', Buffer.from(JSON.stringify({name: '@community-test/test-tools', version: '1.0.0'}))), Buffer.alloc(1024)])), paxValue = structuredClone(f.value); paxValue.works[0].releases[0].package.sourceDigest = sha(pax);
  await assert.rejects(buildBundleFile({envelope: await f.file('pax.json', JSON.stringify(signed(paxValue, f.pub))), publicKey: key, packages: [await f.file('pax.tgz', pax)], out: out('p.aibuddy-plugins')}), {code: 'COMMUNITY_OFFLINE_INVALID'});
  const wrong = npmPack('@community-test/other', '1.0.0'), wrongValue = structuredClone(f.value); wrongValue.works[0].releases[0].package.sourceDigest = sha(wrong);
  await assert.rejects(buildBundleFile({envelope: await f.file('wrong.json', JSON.stringify(signed(wrongValue, f.pub))), publicKey: key, packages: [await f.file('wrong.tgz', wrong)], out: out('w.aibuddy-plugins')}), {code: 'COMMUNITY_OFFLINE_IDENTITY'});
});

test('catalog accepts optional English names, descriptions and release notes, and rejects unknown translation fields', () => {
  const pub = publisher(), value = catalog(pub); value.works[0].locales = {en: {name: 'Tools', description: 'Test tools'}}; value.works[0].releases[0].locales = {en: {notes: 'First release'}};
  assert.equal(parseCommunityCatalog(value).works[0].locales.en.name, 'Tools');
  value.works[0].locales.en.script = 'x'; assert.throws(() => parseCommunityCatalog(value), {code: 'COMMUNITY_CATALOG_INVALID'});
  delete value.works[0].locales.en.script; value.works[0].locales.fr = {name: 'x'}; assert.throws(() => parseCommunityCatalog(value), {code: 'COMMUNITY_CATALOG_INVALID'});
});

// ---- review fixes (REVIEW-ext-center.md) ----
const later = (value, generatedAt, extra = {}) => ({...structuredClone(value), generatedAt, ...extra});
const watermark = f => JSON.parse(fs.readFileSync(join(f.root, 'local/community/catalog-cache-v1.json'), 'utf8')).sources[f.pub.source.sourceId]?.watermark?.generatedAt;

test('中-1: a signed catalog older than the build minimum is refused online and offline; an old file is flagged in the confirmation', async t => {
  let clock = Date.parse('2026-10-26T00:00:00Z');
  const f = await setup(t, {options: pub => ({minimumWatermarks: {[pub.source.keyFingerprint]: '2026-10-25T00:00:00Z'}, now: () => clock})});
  await assert.rejects(f.service.action({action: 'community-load-catalog', sourceId: f.pub.source.sourceId, envelope: signed(f.value, f.pub)}), {code: 'COMMUNITY_CATALOG_TOO_OLD'});
  await assert.rejects(f.service.prepareDshOffline(await f.file('old.aibuddy-plugins', buildOfflinePluginBundle({envelope: signed(f.value, f.pub), packages: [f.tgz]}))), {code: 'COMMUNITY_CATALOG_TOO_OLD'});
  assert.equal(f.service.snapshot().community.configured, false);
  const fresh = later(f.value, '2026-10-25T12:00:00Z'); clock = Date.parse('2026-12-30T00:00:00Z');
  const preview = await f.service.prepareDshOffline(await f.file('fresh.aibuddy-plugins', buildOfflinePluginBundle({envelope: signed(fresh, f.pub), packages: [f.tgz]})));
  assert.equal(preview.generatedAt, '2026-10-25T12:00:00Z'); assert.equal(preview.ageDays, 65); assert.equal(preview.warnOld, true);
});

test('@ai-buddy/ names are reserved for the official source key, online and offline', async t => {
  const f = await setup(t), value = structuredClone(f.value); value.works[0].packageName = value.works[0].releases[0].package.packageName = '@ai-buddy/qq-connect';
  await assert.rejects(f.service.action({action: 'community-load-catalog', sourceId: f.pub.source.sourceId, envelope: signed(value, f.pub)}), {code: 'COMMUNITY_RESERVED_NAME'});
  await assert.rejects(f.service.prepareDshOffline(await f.file('fake.aibuddy-plugins', buildOfflinePluginBundle({envelope: signed(value, f.pub)}))), {code: 'COMMUNITY_RESERVED_NAME'});
  const allowed = await setup(t, {options: pub => ({officialFingerprints: new Set([pub.source.keyFingerprint])})});
  const named = structuredClone(allowed.value); named.works[0].packageName = named.works[0].releases[0].package.packageName = '@ai-buddy/qq-connect';
  await allowed.service.action({action: 'community-load-catalog', sourceId: allowed.pub.source.sourceId, envelope: signed(named, allowed.pub)});
  assert.equal(allowed.service.snapshot().community.sources[0].officialScope, true);
});

test('中-2: concurrent loads of one source commit one at a time, so the older signed catalog can never land last', async t => {
  let slow = 0; const f = await setup(t, {delay: () => slow});
  const base = later(f.value, '2026-10-20T22:00:00Z'); base.works[0].releases[0].publishedAt = '2026-10-20T21:00:00Z';
  await f.service.action({action: 'community-load-catalog', sourceId: f.pub.source.sourceId, envelope: signed(base, f.pub)});
  const older = later(f.value, '2026-10-24T22:00:00Z'), newer = later(f.value, '2026-10-28T22:00:00Z');
  slow = 30;
  // the reviewer's race: an import of the older file starts first, the newer online catalog 10 ms later
  const a = f.importFile(await f.file('older.aibuddy-plugins', buildOfflinePluginBundle({envelope: signed(older, f.pub), packages: [f.tgz]})));
  await new Promise(done => setTimeout(done, 10));
  const b = f.service.action({action: 'community-load-catalog', sourceId: f.pub.source.sourceId, envelope: signed(newer, f.pub)});
  const outcome = await Promise.allSettled([a, b]); slow = 0;
  assert.equal(outcome[1].status, 'fulfilled'); assert.equal(watermark(f), newer.generatedAt);
  // two online loads: the older one, started first and slowed, either lands first or is refused; it never wins
  const middle = later(f.value, '2026-10-29T22:00:00Z'), newest = later(f.value, '2026-10-30T22:00:00Z'); slow = 30;
  const c = f.service.action({action: 'community-load-catalog', sourceId: f.pub.source.sourceId, envelope: signed(middle, f.pub)}); await new Promise(done => setTimeout(done, 5)); slow = 0;
  const d = f.service.action({action: 'community-load-catalog', sourceId: f.pub.source.sourceId, envelope: signed(newest, f.pub)});
  await Promise.allSettled([c, d]); assert.equal(watermark(f), newest.generatedAt);
  assert.equal(f.service.snapshot().community.sources[0].generatedAt, newest.generatedAt);
});

test('中-5: after an offline import that drops a reviewed version, the source still loads after a restart', async t => {
  const {reviewFromGitHubIssue} = await import('../src/community/reviews.mjs'), {githubIssue} = await import('./support/community-fixtures.mjs');
  const f = await setup(t), review = reviewFromGitHubIssue(githubIssue(), {repository: 'test/native', validWorkIds: ['test.tools']});
  const index = {schemaVersion: 1, type: 'ai-buddy-community-reviews', catalogId: f.value.id, generatedAt: '2026-10-24T22:00:00Z', repository: 'test/native', reviews: [review], deletedIssueIds: [], evidence: {provider: 'github-api', fetchedAt: '2026-10-24T22:00:00Z', complete: true, pages: 1}};
  await f.service.action({action: 'community-load-catalog', sourceId: f.pub.source.sourceId, envelope: signed(f.value, f.pub), reviewEnvelope: signed(index, f.pub)});
  const v2 = later(f.value, '2026-10-26T22:00:00Z'), tgz2 = npmPack('@community-test/test-tools', '2.0.0');
  v2.works[0].releases = [{version: '2.0.0', publishedAt: '2026-10-26T21:00:00Z', package: {...f.value.works[0].releases[0].package, exactVersion: '2.0.0', sourceDigest: sha(tgz2)}}];
  await f.importFile(await f.file('v2.aibuddy-plugins', buildOfflinePluginBundle({envelope: signed(v2, f.pub), packages: [tgz2]})));
  assert.equal((await f.service.action({action: 'community-details', sourceId: f.pub.source.sourceId, id: 'test.tools'})).reviews.count, 0);
  await f.restart();
  assert.equal(f.service.snapshot().community.configured, true); assert.equal(f.service.snapshot().community.works, 1);
  assert.equal(JSON.parse(fs.readFileSync(join(f.root, 'local/community/catalog-cache-v1.json'), 'utf8')).sources[f.pub.source.sourceId].reviewEnvelope, null);
});

test('低-1/低-2/低-9: a failed write leaves the catalog unchanged, the staged copy goes after install, a junctioned folder is fine', async t => {
  const f = await setup(t), bundle = buildOfflinePluginBundle({envelope: signed(f.value, f.pub), packages: [f.tgz]});
  await mkdir(join(f.root, 'local/community'), {recursive: true}); await writeFile(join(f.root, 'local/community/offline'), 'not a folder');
  const preview = await f.service.prepareDshOffline(await f.file('a.aibuddy-plugins', bundle));
  await assert.rejects(f.service.action({action: 'community-offline-confirm', importId: preview.importId}));
  assert.equal(f.service.snapshot().community.configured, false);
  await rm(join(f.root, 'local/community/offline'), {force: true});
  // the file is reached through a directory junction (common for a Downloads folder on another drive)
  await mkdir(join(f.root, 'real')); await writeFile(join(f.root, 'real', 'b.aibuddy-plugins'), bundle); await symlink(join(f.root, 'real'), join(f.root, 'linked'), 'junction');
  await f.importFile(join(f.root, 'linked', 'b.aibuddy-plugins'));
  assert.deepEqual(await readdir(join(f.root, 'local/community/offline')), [sha(f.tgz) + '.tgz']);
  const plan = await f.service.action({action: 'dsh-plan', sourceId: f.pub.source.sourceId, id: 'test.tools'}); await f.service.action({action: 'dsh-install', planId: plan.planId, grantedCapabilities: []}); await f.service.drainMaintenance();
  assert.deepEqual(await readdir(join(f.root, 'local/community/offline')), []);
});

test('低-8: favourites import caps the merged total and only takes source:id keys', async t => {
  const f = await setup(t), keys = (prefix, n) => Array.from({length: n}, (_, i) => f.pub.source.sourceId + ':' + prefix + i);
  await assert.rejects(f.service.action({action: 'community-import-preferences', value: {schemaVersion: 1, favorites: ['no-colon'], follows: []}}), {code: 'COMMUNITY_REQUEST_INVALID'});
  await f.service.action({action: 'community-import-preferences', value: {schemaVersion: 1, favorites: keys('a', 15000), follows: []}});
  await assert.rejects(f.service.action({action: 'community-import-preferences', value: {schemaVersion: 1, favorites: keys('b', 6000), follows: []}}), {code: 'COMMUNITY_REQUEST_INVALID'});
  assert.equal(f.service.snapshot().community.favorites.length, 15000);
});

test('低-2: a gzip bomb is refused at the size bound instead of holding the main process', async () => {
  const {createGzip} = await import('node:zlib'), gzip = createGzip({level: 9}), parts = [], zero = Buffer.alloc(1024 * 1024);
  const done = new Promise(resolve => gzip.on('end', resolve)); gzip.on('data', chunk => parts.push(chunk));
  for (let i = 0; i < 170; i++) gzip.write(zero); gzip.end(); await done;
  const bomb = Buffer.concat(parts), started = performance.now();
  assert.ok(bomb.length < 1024 * 1024);
  assert.throws(() => readOfflinePluginFile(bomb), {code: 'COMMUNITY_OFFLINE_INVALID'});
  assert.ok(performance.now() - started < 5000, 'took ' + Math.round(performance.now() - started) + ' ms');
});
