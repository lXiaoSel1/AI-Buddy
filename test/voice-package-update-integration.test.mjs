import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildPluginArchive} from '../src/plugin-archive.mjs';
import {createPluginManager} from '../src/plugin-manager.mjs';
import {canonicalPluginJson} from '../src/plugin-manifest.mjs';
import {LEGACY_SOURCE_ID, pluginSourceFingerprint} from '../src/plugin-sources.mjs';
import {createVoicePackageAuthority} from '../src/voice/package-authority.mjs';

const breeze = 'ai-buddy.voice-breeze', gpt = 'ai-buddy.voice-gpt-sovits', shared = 'ai-buddy.voice-shared-runtime';
const origin = 'https://voice-update.fixture.test';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const field = value => {
  const bytes = Buffer.from(value), size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  return Buffer.concat([size, bytes]);
};

function archive(id, version = '1.0.0', appRange = '^2.0.0') {
  const runtime = id === shared, engine = id === breeze ? 'breeze' : 'gpt-sovits';
  const files = new Map([['assets.json', Buffer.from('{}')], ...(runtime ?
    [['asr_worker.py', Buffer.from('# ASR fixture')]] :
    [['entry.mjs', Buffer.from('export function activate() {}')], [engine === 'breeze' ? 'breeze_worker.py' : 'gpt_worker.py', Buffer.from('# TTS fixture')]])]);
  const manifest = {schemaVersion: 1, id, name: id, description: 'Voice update fixture', version,
    kind: runtime ? 'runtime' : 'plugin', appRange, apiRange: '^1.0.0', platform: 'win32', arch: 'x64',
    entry: runtime ? 'asr_worker.py' : 'entry.mjs', activationEvents: runtime ? [] : [`onCommand:voice.${engine}`],
    capabilities: runtime ? [] : ['commands.register'], dependencies: runtime ? {} : {[shared]: version},
    files: [...files].map(([path, bytes]) => ({path, bytes: bytes.length, sha256: hash(bytes)}))};
  const bytes = buildPluginArchive(manifest, files);
  return {bytes, item: {manifest, archive: {url: `${origin}/${id}/${version}.zip`, bytes: bytes.length, sha256: hash(bytes)}, publishedAt: '2026-11-07T00:00:00Z'}};
}

async function setup(t, quiesce, {legacy = false, installed = [breeze, gpt], disabled = [], missingSibling = false, exactAppRanges = false} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'buddy-voice-update-')), dataRoot = join(root, 'profile');
  await mkdir(dataRoot);
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  const ssh = 'ssh-ed25519 ' + Buffer.concat([field('ssh-ed25519'), field(publicKey.export({type: 'spki', format: 'der'}).subarray(-32))]).toString('base64');
  const voiceTestFingerprint = pluginSourceFingerprint(ssh);
  const makeArchive = (id, version = '1.0.0') => archive(id, version, exactAppRanges ? version === '1.0.0' ? '2.0.8' : '^2.0.9' : '^2.0.0');
  const packages = [makeArchive(breeze), makeArchive(gpt), makeArchive(shared), makeArchive(breeze, '1.0.1'), ...(!missingSibling ? [makeArchive(gpt, '1.0.1')] : []), makeArchive(shared, '1.0.1')];
  const payload = {schemaVersion: 1, id: 'voice-update-fixture', generatedAt: '2026-11-07T00:00:00Z', packages: packages.map(row => row.item)};
  const descriptor = {schemaVersion: 1, id: payload.id, name: 'Voice update fixture', catalogUrl: `${origin}/catalog.json`, publicKey: ssh, keyId: 'voice-update-test'};
  const envelope = {payload, signature: {keyId: descriptor.keyId, algorithm: 'ed25519', value: sign(null, Buffer.from(canonicalPluginJson(payload)), privateKey).toString('base64')}};
  let servedEnvelope = envelope;
  const config = {root, dataRoot, appVersion: '2.0.8', voiceTestFingerprint, trustedKeys: {'voice-update-test': publicKey}, fetchImpl: async url => {
    if (url === `${origin}/source.json`) return Response.json(descriptor);
    if (url === descriptor.catalogUrl) return Response.json(servedEnvelope);
    const row = packages.find(row => row.item.archive.url === url);
    return row ? new Response(row.bytes) : new Response('', {status: 404});
  }};
  let manager = await createPluginManager(config), authority = createVoicePackageAuthority({manager, voiceTestFingerprint, quiesce});
  t.after(async () => { await authority.close(); await manager.close(); await rm(root, {recursive: true, force: true}); });
  let sourceId = LEGACY_SOURCE_ID;
  if (legacy) await manager.loadCatalog(envelope);
  else {
    const preview = await authority.action({action: 'sources-preview', url: `${origin}/source.json`});
    await authority.action({action: 'sources-add', previewId: preview.previewId, keyFingerprint: preview.source.keyFingerprint});
    sourceId = preview.source.sourceId;
  }
  for (const id of installed) {
    const plan = await authority.action({action: 'plan', sourceId, requests: [{id, version: '1.0.0'}]});
    await authority.action({action: 'install', planId: plan.planId});
    if (!disabled.includes(id)) await authority.action({action: 'enable', sourceId, id});
  }
  const corruptCatalog = async () => {
    servedEnvelope = structuredClone(envelope);
    servedEnvelope.signature.value = Buffer.alloc(64).toString('base64');
    if (legacy) return manager.loadCatalog(servedEnvelope);
    return authority.action({action: 'sources-preview', url: `${origin}/source.json`});
  };
  const restartHost = async appVersion => {
    await authority.close();
    await manager.close();
    manager = await createPluginManager({...config, appVersion});
    authority = createVoicePackageAuthority({manager, voiceTestFingerprint, quiesce});
    return {authority, manager};
  };
  return {authority, manager, sourceId, corruptCatalog, restartHost};
}
test('reviewed shared generation updates atomically update and fence both installed engines', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let armed = false;
  const {authority} = await setup(t, async target => {
    if (!armed || target.id !== breeze) return;
    entered.resolve();
    await release.promise;
  });
  const old = await authority.resolveVoicePackage(breeze), other = await authority.resolveVoicePackage(gpt);
  const {updates} = await authority.action({action: 'update-candidates'});
  const row = updates.find(row => row.id === breeze);
  assert.ok(row);
  // The reviewed plan contains a shared dependency change, so both engines must drain.
  const {id, packageKey, sourceId, from, to, digest} = row;
  const plan = await authority.action({action: 'plan-update', id, packageKey, sourceId, from, to, digest, mode: 'review'});
  assert.equal(plan.requiresReview, true);
  old.assertCurrent();
  other.assertCurrent();
  armed = true;
  const installing = authority.action({action: 'install-update', planId: plan.planId, packageKey, digest});
  try {
    const first = await Promise.race([entered.promise.then(() => 'draining'), installing.then(() => 'installed', () => 'rejected')]);
    assert.equal(first, 'draining', 'the update must drain active speech before replacing its package');
    assert.throws(old.assertCurrent, {code: 'VOICE_PACKAGE_CHANGED'});
    await assert.rejects(authority.resolveVoicePackage(breeze), {code: 'VOICE_PACKAGE_CHANGED'});
    assert.throws(other.assertCurrent, {code: 'VOICE_PACKAGE_CHANGED'});
    assert.equal(authority.status().find(row => row.id === breeze).version, '1.0.0');
  } finally {
    release.resolve();
    await installing;
    armed = false;
  }
  assert.throws(old.assertCurrent, {code: 'VOICE_PACKAGE_CHANGED'});
  for (const id of [breeze, gpt]) {
    const current = await authority.resolveVoicePackage(id);
    assert.equal(current.version, '1.0.1');
    assert.equal(current.shared.version, '1.0.1');
    assert.equal(authority.status().find(row => row.id === id).state, 'ready');
  }
  assert.throws(other.assertCurrent, {code: 'VOICE_PACKAGE_CHANGED'});
});

const updateRequest = async (authority, mode = 'review') => {
  const {updates} = await authority.action({action: 'update-candidates'});
  const row = updates.find(row => row.id === breeze);
  assert.ok(row);
  return {row, plan: await authority.action({action: 'plan-update', ...row, mode})};
};

for (const legacy of [false, true]) {
  const backend = legacy ? 'legacy' : 'source-aware';
  test(`${backend} review groups only installed engines and preserves their data and enablement`, async t => {
    const {authority, manager} = await setup(t, undefined, {legacy, disabled: [gpt]});
    const profiles = [];
    for (const id of [breeze, gpt]) {
      const current = await manager.resolveInstalled(id, {requireEnabled: false});
      const file = join(current.dataDirectory, 'user-reference.json');
      await writeFile(file, JSON.stringify({id, keep: true}));
      profiles.push([file, await readFile(file, 'utf8')]);
    }
    const {row, plan} = await updateRequest(authority);
    assert.deepEqual(plan.dependencyChanges, [{id: shared, from: '1.0.0', to: '1.0.1'}, {id: gpt, from: '1.0.0', to: '1.0.1'}]);
    assert.equal(plan.requiresReview, true);
    assert.deepEqual(plan.addedCapabilities, []);
    await authority.action({action: 'install-update', planId: plan.planId, packageKey: row.packageKey, digest: row.digest});
    const snapshot = manager.snapshot();
    for (const id of [breeze, gpt, shared]) assert.equal(snapshot.installed[id].current, '1.0.1');
    assert.equal(snapshot.installed[breeze].enabled, true);
    assert.equal(snapshot.installed[gpt].enabled, false);
    for (const [file, text] of profiles) assert.equal(await readFile(file, 'utf8'), text);
  });

  test(`${backend} update does not install an absent sibling engine`, async t => {
    const {authority, manager} = await setup(t, undefined, {legacy, installed: [breeze]});
    const {plan} = await updateRequest(authority);
    assert.deepEqual(plan.dependencyChanges, [{id: shared, from: '1.0.0', to: '1.0.1'}]);
    await authority.action({action: 'install-update', planId: plan.planId});
    assert.deepEqual(Object.keys(manager.snapshot().installed).sort(), [breeze, shared].sort());
    assert.equal((await authority.resolveVoicePackage(breeze)).version, '1.0.1');
  });

  test(`${backend} group approval is invalid after sibling enablement changes`, async t => {
    const {authority, manager, sourceId} = await setup(t, undefined, {legacy});
    const {plan} = await updateRequest(authority);
    await authority.action({action: 'disable', sourceId, id: gpt});
    await assert.rejects(authority.action({action: 'install-update', planId: plan.planId}), {code: 'PLUGIN_UPDATE_CHANGED'});
    for (const id of [breeze, gpt, shared]) assert.equal(manager.snapshot().installed[id].current, '1.0.0');
  });

  test(`${backend} automatic linked updates require explicit review`, async t => {
    const {authority, manager} = await setup(t, undefined, {legacy});
    const {plan} = await updateRequest(authority, 'auto');
    assert.equal(plan.requiresReview, true);
    await assert.rejects(authority.action({action: 'install-update', planId: plan.planId}), {code: 'PLUGIN_UPDATE_REVIEW_REQUIRED'});
    for (const id of [breeze, gpt, shared]) assert.equal(manager.snapshot().installed[id].current, '1.0.0');
  });

  test(`${backend} missing signed sibling target blocks the group before installation`, async t => {
    const {authority, manager} = await setup(t, undefined, {legacy, missingSibling: true});
    await assert.rejects(updateRequest(authority), {code: 'PLUGIN_DEPENDENCY_ERROR'});
    for (const id of [breeze, gpt, shared]) assert.equal(manager.snapshot().installed[id].current, '1.0.0');
  });

  test(`${backend} invalid catalog signatures cannot supply a group update`, async t => {
    const {manager, corruptCatalog} = await setup(t, undefined, {legacy});
    await assert.rejects(corruptCatalog(), {code: 'PLUGIN_SIGNATURE_INVALID'});
    for (const id of [breeze, gpt, shared]) assert.equal(manager.snapshot().installed[id].current, '1.0.0');
  });
}

for (const legacy of [false, true]) test(`${legacy ? 'legacy' : 'source-aware'} host 2.0.9 refuses exact-2.0.8 old packages and upgrades the signed generation normally`, async t => {
  const f = await setup(t, undefined, {legacy, disabled: [gpt], exactAppRanges: true});
  const files = [];
  for (const id of [breeze, gpt]) {
    const current = await f.manager.resolveInstalled(id, {requireEnabled: false});
    const file = join(current.dataDirectory, 'user-reference.json'), text = JSON.stringify({id, original: true});
    await writeFile(file, text);
    files.push([file, text]);
  }
  const {authority, manager} = await f.restartHost('2.0.9');
  assert.equal(authority.status().find(row => row.id === breeze).state, 'incompatible');
  await assert.rejects(authority.resolveVoicePackage(breeze), {code: legacy ? 'VOICE_PACKAGE_CHANGED' : 'PLUGIN_INCOMPATIBLE'});
  const {plan} = await updateRequest(authority);
  await authority.action({action: 'install-update', planId: plan.planId});
  const current = await authority.resolveVoicePackage(breeze);
  assert.equal(current.version, '1.0.1');
  assert.equal(current.shared.version, '1.0.1');
  assert.equal(manager.snapshot().installed[gpt].enabled, false);
  for (const [file, text] of files) assert.equal(await readFile(file, 'utf8'), text);
});
