import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPluginManager} from '../src/plugin-manager.mjs';
import {verifyPluginCatalog} from '../src/plugin-catalog.mjs';
import {createVoicePackageAuthority} from '../src/voice/package-authority.mjs';

const breeze = 'ai-buddy.voice-breeze', gpt = 'ai-buddy.voice-gpt-sovits', shared = 'ai-buddy.voice-shared-runtime';
const envelope = JSON.parse(await readFile(new URL('./fixtures/official-registration/catalog.json', import.meta.url), 'utf8'));
const catalog = verifyPluginCatalog(envelope);
// Optional, explicit local inputs: {"1.0.1":"/original/artifacts", ...}.
// The signed catalog fixes every byte count and SHA-256; no network fallback or test signing key is used.
const originalPackages = process.env.AI_BUDDY_VOICE_OFFICIAL_PACKAGES ? JSON.parse(process.env.AI_BUDDY_VOICE_OFFICIAL_PACKAGES) : null;

test('official voice catalog signatures reject changed 1.x manifests', async t => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-official-voice-signature-')), dataRoot = join(root, 'profile');
  await mkdir(dataRoot);
  const manager = await createPluginManager({root, dataRoot, appVersion: '2.0.14', fetchImpl: async () => {throw Error('No network permitted');}});
  t.after(async () => {await manager.close(); await rm(root, {recursive: true, force: true});});
  const changed = structuredClone(envelope);
  changed.payload.packages.find(item => item.manifest.id === breeze && item.manifest.version === '1.0.3').manifest.description += ' changed';
  await assert.rejects(manager.loadCatalog(changed), {code: 'PLUGIN_SIGNATURE_INVALID'});
});

for (const version of ['1.0.1', '1.0.2', '1.0.3']) {
  test(`package authority leases both original official ${version} engines and exact shared runtime`, {
    skip: !originalPackages && 'Set AI_BUDDY_VOICE_OFFICIAL_PACKAGES to local original published archive directories',
  }, async t => {
    assert.equal(typeof originalPackages[version], 'string', 'an explicit original package directory is required for each generation');
    const root = await mkdtemp(join(tmpdir(), 'buddy-official-voice-authority-')), dataRoot = join(root, 'profile');
    await mkdir(dataRoot);
    const packages = catalog.packages.filter(item => [breeze, gpt, shared].includes(item.manifest.id) && item.manifest.version === version);
    assert.equal(packages.length, 3);
    const archives = new Map();
    for (const item of packages) {
      const directory = item.manifest.id.slice('ai-buddy.'.length);
      const bytes = await readFile(join(originalPackages[version], directory, `${item.manifest.id}-${version}.zip`));
      assert.equal(bytes.length, item.archive.bytes, item.manifest.id + ' original byte count');
      assert.equal(createHash('sha256').update(bytes).digest('hex'), item.archive.sha256, item.manifest.id + ' original published SHA-256');
      archives.set(item.archive.url, bytes);
    }
    const manager = await createPluginManager({root, dataRoot, appVersion: '2.0.14', fetchImpl: async url => {
      assert.ok(archives.has(url), 'only the explicitly supplied original archives may be fetched');
      return new Response(archives.get(url));
    }});
    const authority = createVoicePackageAuthority({manager});
    t.after(async () => {await authority.close(); await manager.close(); await rm(root, {recursive: true, force: true});});
    await manager.loadCatalog(envelope);
    const plan = await authority.action({action: 'plan', sourceId: 'official', requests: [breeze, gpt].map(id => ({id, version}))});
    await authority.action({action: 'install', planId: plan.planId});
    for (const id of [breeze, gpt]) {
      await authority.action({action: 'enable', sourceId: 'official', id});
      const lease = await authority.resolveVoicePackage(id);
      assert.equal(lease.sourceId, 'official');
      assert.equal(lease.version, version);
      assert.equal(lease.shared.version, version);
      assert.equal(lease.shared.sourceId, 'official');
      lease.assertCurrent();
      assert.equal(authority.status().find(row => row.id === id).state, 'ready');
    }
    t.diagnostic(JSON.stringify({version, catalogSha256: catalog.verified.payloadSha256, packages: packages.map(item => ({id: item.manifest.id, bytes: item.archive.bytes, sha256: item.archive.sha256}))}));
  });
}
