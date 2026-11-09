import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildPluginArchive} from '../src/plugin-archive.mjs';
import {createPluginManager} from '../src/plugin-manager.mjs';
import {canonicalPluginJson} from '../src/plugin-manifest.mjs';
import {pluginSourceFingerprint} from '../src/plugin-sources.mjs';
import {createVoicePackageAuthority} from '../src/voice/package-authority.mjs';
import {supportsVoiceManifest} from '../src/voice/package-contract.mjs';

const breeze = 'ai-buddy.voice-breeze', gpt = 'ai-buddy.voice-gpt-sovits', shared = 'ai-buddy.voice-shared-runtime';

// These app-compatible fixtures isolate the code contract; original signed appRange values are enforced separately.
function manifest(id, version, dependency = version) {
  const engine = id === breeze ? 'breeze' : 'gpt-sovits';
  return {schemaVersion: 1, id, name: id, description: 'Voice generation compatibility', version,
    kind: 'plugin', appRange: '^2.0.9', apiRange: '^1.0.0', platform: 'win32', arch: 'x64', entry: 'entry.mjs',
    activationEvents: [`onCommand:voice.${engine}`], capabilities: ['commands.register'], dependencies: {[shared]: dependency},
    files: ['entry.mjs', 'assets.json', engine === 'breeze' ? 'breeze_worker.py' : 'gpt_worker.py'].map(path => ({path}))};
}

test('both 1.0.1 voice engines are supported with their exact 1.0.1 shared dependency', () => {
  for (const id of [breeze, gpt]) assert.equal(supportsVoiceManifest(manifest(id, '1.0.1')), true, id);
});

const origin = 'https://voice-generation.fixture.test';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const field = value => {
  const bytes = Buffer.from(value), size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  return Buffer.concat([size, bytes]);
};

function archive(id, version, dependency) {
  const runtime = id === shared;
  const spec = runtime ? {schemaVersion: 1, id, name: id, description: 'Voice shared generation', version,
    kind: 'runtime', appRange: '^2.0.9', apiRange: '^1.0.0', platform: 'win32', arch: 'x64', entry: 'asr_worker.py',
    activationEvents: [], capabilities: [], dependencies: {}, files: [{path: 'asr_worker.py'}, {path: 'assets.json'}]} : manifest(id, version, dependency);
  const files = new Map(spec.files.map(({path}) => [path, Buffer.from(path === 'assets.json' ? '{}' : '# Signed archive fixture')]));
  spec.files = [...files].map(([path, bytes]) => ({path, bytes: bytes.length, sha256: hash(bytes)}));
  const bytes = buildPluginArchive(spec, files);
  return {bytes, item: {manifest: spec, archive: {url: `${origin}/${id}/${version}.zip`, bytes: bytes.length, sha256: hash(bytes)}, publishedAt: '2026-11-08T00:00:00Z'}};
}

async function setup(t, {dependency = (id, version) => version} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'buddy-voice-generation-')), dataRoot = join(root, 'profile');
  await mkdir(dataRoot);
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  const ssh = 'ssh-ed25519 ' + Buffer.concat([field('ssh-ed25519'), field(publicKey.export({type: 'spki', format: 'der'}).subarray(-32))]).toString('base64');
  const voiceTestFingerprint = pluginSourceFingerprint(ssh);
  const packages = ['1.0.0', '1.0.1'].flatMap(version => [breeze, gpt, shared].map(id => archive(id, version, dependency(id, version))));
  const payload = {schemaVersion: 1, id: 'voice-generation-fixture', generatedAt: '2026-11-08T00:00:00Z', packages: packages.map(row => row.item)};
  const descriptor = {schemaVersion: 1, id: payload.id, name: 'Voice generation fixture', catalogUrl: `${origin}/catalog.json`, publicKey: ssh, keyId: 'voice-generation-test'};
  const envelope = {payload, signature: {keyId: descriptor.keyId, algorithm: 'ed25519', value: sign(null, Buffer.from(canonicalPluginJson(payload)), privateKey).toString('base64')}};
  const manager = await createPluginManager({root, dataRoot, appVersion: '2.0.9', voiceTestFingerprint, fetchImpl: async url => {
    if (url === `${origin}/source.json`) return Response.json(descriptor);
    if (url === descriptor.catalogUrl) return Response.json(envelope);
    const row = packages.find(row => row.item.archive.url === url);
    return row ? new Response(row.bytes) : new Response('', {status: 404});
  }});
  const authority = createVoicePackageAuthority({manager, voiceTestFingerprint});
  t.after(async () => { await authority.close(); await manager.close(); await rm(root, {recursive: true, force: true}); });
  const preview = await authority.action({action: 'sources-preview', url: `${origin}/source.json`});
  await authority.action({action: 'sources-add', previewId: preview.previewId, keyFingerprint: preview.source.keyFingerprint});
  const sourceId = preview.source.sourceId;
  const install = async (ids, version) => {
    const plan = await authority.action({action: 'plan', sourceId, requests: ids.map(id => ({id, version}))});
    return authority.action({action: 'install', planId: plan.planId});
  };
  return {authority, manager, sourceId, install};
}

test('both 1.0.0 voice engines remain supported with their exact 1.0.0 shared dependency', () => {
  for (const id of [breeze, gpt]) assert.equal(supportsVoiceManifest(manifest(id, '1.0.0')), true, id);
});

test('voice engine support rejects other generations and inexact or mismatched shared dependencies', () => {
  for (const id of [breeze, gpt]) {
    for (const [version, dependency] of [['1.0.0', '1.0.1'], ['1.0.1', '1.0.0'], ['1.0.0', '^1.0.0'], ['1.0.1', '^1.0.1'], ['1.0.2', '1.0.1'], ['1.0.2', '^1.0.2'], ['1.0.3', '1.0.3']]) {
      assert.equal(supportsVoiceManifest(manifest(id, version, dependency)), false, `${id}@${version} -> ${dependency}`);
    }
  }
});

test('both 1.0.2 voice engines are supported only with their exact 1.0.2 shared dependency', () => {
  for (const id of [breeze, gpt]) assert.equal(supportsVoiceManifest(manifest(id, '1.0.2')), true, id);
});

for (const version of ['1.0.0', '1.0.1']) test(`the host can enable and lease both ${version} engines with their ${version} shared runtime`, async t => {
  const {authority, sourceId, install} = await setup(t);
  await install([breeze, gpt], version);
  for (const id of [breeze, gpt]) await authority.action({action: 'enable', sourceId, id});
  for (const row of authority.status()) assert.equal(row.state, 'ready', row.id);
  const first = await authority.resolveVoicePackage(breeze), second = await authority.resolveVoicePackage(gpt);
  assert.equal(first.version, version);
  assert.equal(second.version, version);
  assert.equal(first.shared.version, version);
  assert.equal(second.shared.directory, first.shared.directory);
});

for (const [version, dependency] of [['1.0.0', '1.0.1'], ['1.0.1', '1.0.0']]) test(`the host rejects signed ${version} engines declaring shared ${dependency}`, async t => {
  for (const id of [breeze, gpt]) {
    const f = await setup(t, {dependency: (packageId, packageVersion) => packageId === id && packageVersion === version ? dependency : packageVersion});
    await f.install([id], version);
    await assert.rejects(f.authority.action({action: 'enable', sourceId: f.sourceId, id}), {code: 'PLUGIN_ACTIVATION_UNSUPPORTED'});
    assert.equal(f.manager.snapshot().installed[id].enabled, false);
  }
});
