import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, createHash, sign, randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonicalPluginJson} from '../src/plugin-manifest.mjs';
import {buildPluginArchive, extractPluginArchive, inspectPluginArchive} from '../src/plugin-archive.mjs';
import {createPluginManager} from '../src/plugin-manager.mjs';

test('AF1 legacy rollback validates installed reverse dependencies before changing the pointer',async t=>{
 const {manager,root}=await setup(t),v1=packageFixture('1.0.0','official.runtime'),v2=packageFixture('2.0.0','official.runtime'),engine=packageFixture('1.0.0','official.engine',{'official.runtime':'>=2.0.0'});
 await offlineInstall(manager,[v1],{id:'official.runtime',version:'1.0.0'});await offlineInstall(manager,[v2,engine],{id:'official.engine',version:'1.0.0'});
 const before=manager.snapshot();await assert.rejects(manager.rollback('official.runtime'),{code:'PLUGIN_DEPENDENCY_ERROR'});assert.deepEqual(manager.snapshot().installed,before.installed);assert.equal((await manager.resolveInstalled('official.engine',{requireEnabled:false})).version,'1.0.0');
});

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const {publicKey, privateKey} = generateKeyPairSync('ed25519');
function packageFixture(version = '1.0.0', id = 'official.fixture', dependencies = {}) {
  const content = Buffer.from('export async function activate(){}\n// ' + version);
  const manifest = {schemaVersion: 1, id, name: 'Fixture', description: 'No model calls', version, kind: 'plugin', appRange: '>=1.9.2 <2.0.0', apiRange: '^1.0.0', platform: 'win32', arch: 'x64', entry: 'dist/entry.mjs', activationEvents: ['onCommand:demo'], capabilities: ['storage'], dependencies, files: [{path: 'dist/entry.mjs', bytes: content.length, sha256: sha(content)}]};
  const bytes = buildPluginArchive(manifest, new Map([['dist/entry.mjs', content]]));
  return {item: {manifest, archive: {url: `https://packages.example.test/${id}/${version}/package.zip`, sha256: sha(bytes), bytes: bytes.length}, publishedAt: '2026-10-23T00:00:00Z'}, bytes};
}
function envelope(items) { const payload = {schemaVersion: 1, id: 'official-fixture', generatedAt: '2026-10-23T00:01:00Z', packages: items.map(row => row.item)}; return {payload, signature: {keyId: 'injected-test', algorithm: 'ed25519', value: sign(null, Buffer.from(canonicalPluginJson(payload)), privateKey).toString('base64')}}; }
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ai-buddy-plugin-test-')), root = join(directory, 'app'), dataRoot = join(directory, 'profile');
  await mkdir(root); await mkdir(dataRoot);
  t.after(async () => { await rm(directory, {recursive: true, force: true}); });
  const config = {root, dataRoot, appVersion: '1.9.2', trustedKeys: {'injected-test': publicKey}, ...options};
  const manager = await createPluginManager(config); t.after(() => manager.close()); return {directory, root, dataRoot, manager, config};
}
async function offlineInstall(manager, packages, request = {id: 'official.fixture', version: packages[0].item.manifest.version}) {
  return manager.importOffline({envelope: envelope(packages), requests: [request], archives: Object.fromEntries(packages.map(row => [row.item.manifest.id + '@' + row.item.manifest.version, row.bytes]))});
}

test('prebuilt package roundtrips through real ZIP decoding, hashes, staging and signed offline install', async t => {
  const {manager, root} = await setup(t), v1 = packageFixture();
  const state = await offlineInstall(manager, [v1]);
  assert.equal(state.installed['official.fixture'].current, '1.0.0'); assert.equal(state.installed['official.fixture'].enabled, false);
  const saved = state.installed['official.fixture'].versions['1.0.0'];
  assert.match(saved.catalogSha256, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(join(root, 'local/plugins', saved.directory, 'dist/entry.mjs'), 'utf8'), 'export async function activate(){}\n// 1.0.0');
  await assert.rejects(manager.activate('official.fixture', 'onCommand:demo'), /disabled/);
});

test('update and code rollback preserve independent plugin data; uninstall retains it', async t => {
  const {manager, dataRoot} = await setup(t), v1 = packageFixture(), v2 = packageFixture('1.1.0');
  await offlineInstall(manager, [v1]); await manager.enable('official.fixture');
  await mkdir(join(dataRoot, 'plugins', 'official.fixture'), {recursive: true}); await writeFile(join(dataRoot, 'plugins', 'official.fixture', 'user.json'), '{"keep":42}');
  await offlineInstall(manager, [v1, v2], {id: 'official.fixture', version: '1.1.0'});
  assert.equal(manager.snapshot().installed['official.fixture'].previous, '1.0.0');
  await manager.rollback('official.fixture'); assert.equal(manager.snapshot().installed['official.fixture'].current, '1.0.0');
  await manager.uninstall('official.fixture'); assert.deepEqual(manager.snapshot().installed, {});
  assert.equal(await readFile(join(dataRoot, 'plugins', 'official.fixture', 'user.json'), 'utf8'), '{"keep":42}');
});

test('damaged archive fails before registry commit and leaves the old version usable', async t => {
  const {manager} = await setup(t), v1 = packageFixture(), bad = packageFixture('1.1.0');
  await offlineInstall(manager, [v1]); bad.bytes[40] ^= 1; bad.item.archive.sha256 = sha(bad.bytes);
  await assert.rejects(offlineInstall(manager, [v1, bad], {id: 'official.fixture', version: '1.1.0'}));
  assert.equal(manager.snapshot().installed['official.fixture'].current, '1.0.0'); await manager.enable('official.fixture');
});

test('a signed manifest cannot overwrite the application or profile through ZIP paths', async t => {
  const sample = packageFixture(), bytes = Buffer.from(sample.bytes), marker = Buffer.from('dist/entry.mjs');
  for (let at = 0; at < bytes.length;) { at = bytes.indexOf(marker, at); if (at < 0) break; bytes.write('../x/entry.mjs', at); at += marker.length; }
  assert.throws(() => inspectPluginArchive(bytes, sample.item.manifest), /Unsafe/);
});

test('ZIP checker rejects appended content, CRC errors and Unix symlink metadata', () => {
  const sample = packageFixture();
  assert.throws(() => inspectPluginArchive(Buffer.concat([sample.bytes, Buffer.from('extra')]), sample.item.manifest));
  const linked = Buffer.from(sample.bytes), central = linked.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); linked.writeUInt32LE(0xa1ff0000, central + 38);
  assert.throws(() => inspectPluginArchive(linked, sample.item.manifest), /links/);
});

test('resumable download validates content range and stores only verified cache content', async t => {
  const sample = packageFixture(), calls = [];
  const {manager, root} = await setup(t, {fetchImpl: async (url, options) => { calls.push(options.headers.Range); const start = Number(/^bytes=(\d+)-$/.exec(options.headers.Range ?? '')?.[1] ?? 0); return new Response(sample.bytes.subarray(start), {status: start ? 206 : 200, headers: start ? {'content-range': `bytes ${start}-${sample.bytes.length - 1}/${sample.bytes.length}`} : {}}); }});
  const cache = join(root, 'local/plugins/cache', sample.item.archive.sha256 + '.zip'); await mkdir(join(root, 'local/plugins/cache'), {recursive: true}); await writeFile(cache + '.partial', sample.bytes.subarray(0, 17));
  await manager.loadCatalog(envelope([sample])); const plan = await manager.plan(['official.fixture']); await manager.install({planId: plan.planId});
  assert.deepEqual(calls, ['bytes=17-']); assert.equal(sha(await readFile(cache)), sample.item.archive.sha256);
  assert.equal((await readdir(join(root, 'local/plugins/staging'))).length, 0);
});

test('invalid signed size/hash, incomplete offline dependencies and disk space cannot commit', async t => {
  const {manager} = await setup(t, {availableBytes: async () => 0}), sample = packageFixture();
  await assert.rejects(offlineInstall(manager, [sample]), /space/); assert.deepEqual(manager.snapshot().installed, {});
  const fresh = await setup(t), child = packageFixture('1.0.0', 'official.child'), parent = packageFixture('1.0.0', 'official.fixture', {'official.child': '^1.0.0'});
  await assert.rejects(fresh.manager.importOffline({envelope: envelope([parent, child]), requests: ['official.fixture'], archives: {'official.fixture': parent.bytes}}), /missing dependency/);
  assert.deepEqual(fresh.manager.snapshot().installed, {});
});

test('active tasks prevent code switching and dependents prevent runtime uninstall', async t => {
  let taskActive = false;
  const {manager} = await setup(t, {busy: async () => taskActive}), child = packageFixture('1.0.0', 'official.child'), parent = packageFixture('1.0.0', 'official.fixture', {'official.child': '^1.0.0'}), v2 = packageFixture('1.1.0', 'official.fixture', {'official.child': '^1.0.0'});
  await offlineInstall(manager, [parent, child]);
  await assert.rejects(manager.uninstall('official.child'), /depends/);
  taskActive = true;
  await assert.rejects(offlineInstall(manager, [parent, v2, child], {id: 'official.fixture', version: '1.1.0'}), /in use/);
  assert.equal(manager.snapshot().installed['official.fixture'].current, '1.0.0'); taskActive = false;
});

test('restart verifies saved signature proof rather than trusting an edited registry', async t => {
  const {manager, config, root} = await setup(t), sample = packageFixture(); await offlineInstall(manager, [sample]);
  const file = join(root, 'local/plugins/registry.json'), registry = JSON.parse(await readFile(file, 'utf8'));
  registry.packages['official.fixture'].versions['1.0.0'].manifest.description = 'Modified after publication'; await writeFile(file, JSON.stringify(registry));
  const restarted = await createPluginManager(config); t.after(() => restarted.close());
  await assert.rejects(restarted.enable('official.fixture'), /signed publication proof/);
});

test('startup recovers only its recorded staging transaction and retains diagnostics', async t => {
  const {root, config} = await setup(t), id = randomUUID(), control = join(root, 'local/plugins'), stage = join(control, 'staging', id);
  await mkdir(stage, {recursive: true}); await mkdir(join(control, 'transactions')); await writeFile(join(stage, 'partial'), 'temporary'); await writeFile(join(control, 'transactions', id + '.json'), JSON.stringify({id, phase: 'prepared', stage: 'staging/' + id}));
  const restarted = await createPluginManager(config); t.after(() => restarted.close());
  await assert.rejects(stat(stage), {code: 'ENOENT'}); assert.ok((await stat(join(control, 'transactions', id + '.json'))).isFile());
});

test('offline preview binds a user-selected directory to plan and install token', async t => {
  const {manager, directory} = await setup(t), sample = packageFixture(), bundle = join(directory, 'offline');
  await mkdir(join(bundle, 'packages'), {recursive: true}); await writeFile(join(bundle, 'catalog.json'), JSON.stringify(envelope([sample]))); await writeFile(join(bundle, 'packages', sample.item.archive.sha256 + '.zip'), sample.bytes);
  const selected = await manager.prepareOffline(bundle); assert.equal(selected.plan.packages.length, 1); assert.deepEqual(manager.snapshot().installed, {});
  await assert.rejects(manager.installOffline({selectionId: selected.selectionId, planId: 'other'}), /expired/);
  await manager.installOffline({selectionId: selected.selectionId, planId: selected.plan.planId}); assert.ok(manager.snapshot().installed['official.fixture']);
});

test('missing official endpoint and a network failure keep verified cached browsing available', async t => {
  const {manager, config} = await setup(t), sample = packageFixture(); await manager.loadCatalog(envelope([sample]));
  assert.equal((await manager.refreshCatalog()).catalogAvailable, true);
  const restarted = await createPluginManager({...config, catalogUrl: 'https://catalog.example.test/catalog.json', fetchImpl: async () => { throw Error('offline'); }}); t.after(() => restarted.close());
  const state = await restarted.refreshCatalog(); assert.equal(state.catalogAvailable, true); assert.equal(state.packages.length, 1); assert.equal(state.catalogError, 'offline');
});

test('incompatible plugin data blocks update and survives uninstall and reinstall attempts', async t => {
  const {manager, dataRoot} = await setup(t), v1 = packageFixture(), v2 = packageFixture('1.1.0');
  await offlineInstall(manager, [v1]);
  v2.item.manifest.dataSchemaVersion = 2; v2.item.manifest.compatibleDataVersions = [2];
  const content = Buffer.from('export async function activate(){}\n// 1.1.0');
  v2.bytes = buildPluginArchive(v2.item.manifest, new Map([['dist/entry.mjs', content]])); v2.item.archive.bytes = v2.bytes.length; v2.item.archive.sha256 = sha(v2.bytes);
  await assert.rejects(offlineInstall(manager, [v1, v2], {id: 'official.fixture', version: '1.1.0'}), {code: 'PLUGIN_DATA_MIGRATION_REQUIRED'});
  assert.equal(manager.snapshot().installed['official.fixture'].current, '1.0.0');
  const file = join(dataRoot, 'plugins/official.fixture/user.json'); await writeFile(file, '{"important":"keep"}');
  await manager.uninstall('official.fixture');
  await assert.rejects(offlineInstall(manager, [v2], {id: 'official.fixture', version: '1.1.0'}), {code: 'PLUGIN_DATA_MIGRATION_REQUIRED'});
  assert.equal(await readFile(file, 'utf8'), '{"important":"keep"}');
});
