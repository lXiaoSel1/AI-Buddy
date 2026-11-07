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

const breeze = 'ai-buddy.voice-breeze', gpt = 'ai-buddy.voice-gpt-sovits', shared = 'ai-buddy.voice-shared-runtime';
const origin = 'https://voice-update.fixture.test';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const field = value => {
  const bytes = Buffer.from(value), size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  return Buffer.concat([size, bytes]);
};

function archive(id, version = '1.0.0') {
  const runtime = id === shared, engine = id === breeze ? 'breeze' : 'gpt-sovits';
  const files = new Map([['assets.json', Buffer.from('{}')], ...(runtime ?
    [['asr_worker.py', Buffer.from('# ASR fixture')]] :
    [['entry.mjs', Buffer.from('export function activate() {}')], [engine === 'breeze' ? 'breeze_worker.py' : 'gpt_worker.py', Buffer.from('# TTS fixture')]])]);
  const manifest = {schemaVersion: 1, id, name: id, description: 'Voice update fixture', version,
    kind: runtime ? 'runtime' : 'plugin', appRange: '^2.0.0', apiRange: '^1.0.0', platform: 'win32', arch: 'x64',
    entry: runtime ? 'asr_worker.py' : 'entry.mjs', activationEvents: runtime ? [] : [`onCommand:voice.${engine}`],
    capabilities: runtime ? [] : ['commands.register'], dependencies: runtime ? {} : {[shared]: '1.0.0'},
    files: [...files].map(([path, bytes]) => ({path, bytes: bytes.length, sha256: hash(bytes)}))};
  const bytes = buildPluginArchive(manifest, files);
  return {bytes, item: {manifest, archive: {url: `${origin}/${id}/${version}.zip`, bytes: bytes.length, sha256: hash(bytes)}, publishedAt: '2026-11-07T00:00:00Z'}};
}

async function setup(t, quiesce) {
  const root = await mkdtemp(join(tmpdir(), 'buddy-voice-update-')), dataRoot = join(root, 'profile');
  await mkdir(dataRoot);
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  const ssh = 'ssh-ed25519 ' + Buffer.concat([field('ssh-ed25519'), field(publicKey.export({type: 'spki', format: 'der'}).subarray(-32))]).toString('base64');
  const voiceTestFingerprint = pluginSourceFingerprint(ssh);
  const packages = [archive(breeze), archive(gpt), archive(shared), archive(breeze, '1.0.1')];
  const payload = {schemaVersion: 1, id: 'voice-update-fixture', generatedAt: '2026-11-07T00:00:00Z', packages: packages.map(row => row.item)};
  const descriptor = {schemaVersion: 1, id: payload.id, name: 'Voice update fixture', catalogUrl: `${origin}/catalog.json`, publicKey: ssh, keyId: 'voice-update-test'};
  const envelope = {payload, signature: {keyId: descriptor.keyId, algorithm: 'ed25519', value: sign(null, Buffer.from(canonicalPluginJson(payload)), privateKey).toString('base64')}};
  const manager = await createPluginManager({root, dataRoot, appVersion: '2.0.8', voiceTestFingerprint, fetchImpl: async url => {
    if (url === `${origin}/source.json`) return Response.json(descriptor);
    if (url === descriptor.catalogUrl) return Response.json(envelope);
    const row = packages.find(row => row.item.archive.url === url);
    return row ? new Response(row.bytes) : new Response('', {status: 404});
  }});
  const authority = createVoicePackageAuthority({manager, voiceTestFingerprint, quiesce});
  t.after(async () => { await authority.close(); await manager.close(); await rm(root, {recursive: true, force: true}); });
  const preview = await authority.action({action: 'sources-preview', url: `${origin}/source.json`});
  await authority.action({action: 'sources-add', previewId: preview.previewId, keyFingerprint: preview.source.keyFingerprint});
  const sourceId = preview.source.sourceId;
  for (const id of [breeze, gpt]) {
    const plan = await authority.action({action: 'plan', sourceId, requests: [{id, version: '1.0.0'}]});
    await authority.action({action: 'install', planId: plan.planId});
    await authority.action({action: 'enable', sourceId, id});
  }
  return authority;
}

test('reviewed engine updates drain and fence only the changed engine before installing', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let armed = false;
  const authority = await setup(t, async target => {
    if (!armed || target.id !== breeze) return;
    entered.resolve();
    await release.promise;
  });
  const old = await authority.resolveVoicePackage(breeze), other = await authority.resolveVoicePackage(gpt);
  const {updates} = await authority.action({action: 'update-candidates'});
  const row = updates.find(row => row.id === breeze);
  assert.ok(row);
  // The public update plan has dependencyChanges rather than a packages array.
  const {id, packageKey, sourceId, from, to, digest} = row;
  const plan = await authority.action({action: 'plan-update', id, packageKey, sourceId, from, to, digest, mode: 'review'});
  old.assertCurrent();
  other.assertCurrent();
  armed = true;
  const installing = authority.action({action: 'install-update', planId: plan.planId, packageKey, digest});
  try {
    const first = await Promise.race([entered.promise.then(() => 'draining'), installing.then(() => 'installed')]);
    assert.equal(first, 'draining', 'the update must drain active speech before replacing its package');
    assert.throws(old.assertCurrent, {code: 'VOICE_PACKAGE_CHANGED'});
    await assert.rejects(authority.resolveVoicePackage(breeze), {code: 'VOICE_PACKAGE_CHANGED'});
    other.assertCurrent();
    assert.equal(authority.status().find(row => row.id === breeze).version, '1.0.0');
  } finally {
    release.resolve();
    await installing;
    armed = false;
  }
  assert.throws(old.assertCurrent, {code: 'VOICE_PACKAGE_CHANGED'});
  assert.equal((await authority.resolveVoicePackage(breeze)).version, '1.0.1');
  other.assertCurrent();
});
