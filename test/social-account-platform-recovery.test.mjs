import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createPluginPlatform} from '../src/plugin-platform.mjs';
import {communityPackageKey} from '../src/community/catalog.mjs';
import {defaultPluginSource} from '../src/plugin-sources.mjs';
import {sha} from './support/community-fixtures.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'buddy-social-recovery-'));
  const dataRoot = join(root, 'local', 'data-v003');
  const directory = join(dataRoot, 'social-core');
  const path = join(directory, 'accounts-v1.sqlite');
  const source = defaultPluginSource();
  await mkdir(directory, {recursive: true});

  const platforms = [];
  t.after(async () => {
    try {
      for (const platform of platforms.reverse()) await platform.close();
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  async function start() {
    const platform = await createPluginPlatform({
      root, build: join(root, 'build'), dataRoot,
      legacyManager: {
        snapshot: () => ({appVersion: '2.0.17', service: {state: 'ready', usable: true}, installed: {}, packages: []}),
        action: async () => ({}),
        resolveTrustedSource: async () => ({...source}),
        close: async () => {},
      },
      BrowserWindow: class { constructor() { throw new Error('Unexpected browser'); } },
      session: {fromPartition() { throw new Error('Unexpected browser session'); }},
      getGame: () => null,
      getProvider: () => null,
      ...options,
    });
    platforms.push(platform);
    return platform;
  }

  async function seedInstalledQq() {
    const packageRef = {
      backend: 'dsh', sourceId: 'official', packageName: '@ai-buddy/qq-connect', exactVersion: '2.0.6',
      sourceDigest: sha('cold native fixture'),
      spec: {kind: 'tarball', value: 'https://github.com/test/native/releases/download/v2.0.6/native.tgz'},
      compatibility: {app: '^2.0.17', dsh: '^1.0.0', bridge: '^1.0.0'},
      capabilities: [], dataSchemaVersion: 1,
    };
    const packageKey = communityPackageKey(packageRef);
    const profileId = 'buddy-community-v1';
    const record = {
      ...packageRef, packageKey, pluginId: 'dsh.cold-fixture', declaredCapabilities: [], grantedCapabilities: [],
      generation: 1, profileId, enabled: true,
      backendPlan: {schemaVersion: 1, packageRef, profileId, planDigest: sha('cold plan fixture')},
      sourceProof: {sourceFingerprint: source.keyFingerprint, catalogDigest: sha('cold catalog fixture')},
    };
    const registry = join(root, 'local', 'community');
    await mkdir(registry, {recursive: true});
    await writeFile(join(registry, 'dsh-registry-v1.json'), JSON.stringify({
      schemaVersion: 1, packages: {[packageKey]: record}, generations: {[packageKey]: 1}, releaseDigests: {},
    }));
    return packageKey;
  }

  return {directory, path, start, seedInstalledQq};
}

test('an unreadable account database pauses social activity while the plugin platform starts and closes', async t => {
  const calls = [];
  const auditRows = [];
  const voiceRuntime = {state: 'idle'};
  const f = await fixture(t, {
    audit: row => { auditRows.push(row); throw new Error('Audit disk is unavailable'); },
    getSocialHost: () => { calls.push('social context'); throw new Error('Unexpected social context'); },
    voice: {snapshot: () => voiceRuntime},
    network: {fetch: async () => { calls.push('fetch'); throw new Error('Unexpected network request'); }},
    BrowserWindow: class { constructor() { calls.push('window'); throw new Error('Unexpected browser'); } },
    qqLoginFactory: () => { calls.push('qq'); throw new Error('Unexpected QQ initialization'); },
  });
  const invalid = Buffer.from('This is not a SQLite database.');
  await writeFile(f.path, invalid);

  const platform = await f.start();
  const diagnostic = platform.snapshot().socialStorage;
  assert.equal(diagnostic.state, 'unavailable');
  assert.equal(diagnostic.code, 'SOCIAL_STORAGE_UNAVAILABLE');
  assert.equal(diagnostic.diagnostic.sqliteCode, 26);
  assert.ok(auditRows.some(row => row.type === 'social-storage-unavailable'));
  const status = await platform.action({action: 'social-login-status'});
  assert.deepEqual(status.socialStorage, diagnostic, 'A failed audit write should leave the diagnostic available');
  assert.equal((await platform.action({action: 'community-status'})).service.usable, true);
  assert.deepEqual(platform.snapshot().voiceRuntime, voiceRuntime);
  assert.equal(platform.busy(), false);

  for (const request of [
    {action: 'social-accounts-list'},
    {action: 'social-accounts-save', account: {}},
    {action: 'social-accounts-check', account: {}},
    {action: 'social-login-start', platform: 'qq'},
    {action: 'social-login-start', platform: 'bilibili'},
    {action: 'social-login-refresh', platform: 'qq'},
    {action: 'social-login-check', ref: 'existing'},
    {action: 'social-login-disconnect', ref: 'existing'},
    {action: 'social-account-remove', ref: 'existing'},
  ]) {
    await assert.rejects(platform.action(request), {code: 'SOCIAL_STORAGE_UNAVAILABLE'});
  }
  await assert.rejects(platform.issueSocialContext({pluginId: 'fixture-social-plugin'}), {code: 'SOCIAL_STORAGE_UNAVAILABLE'});

  await platform.close();
  assert.deepEqual(calls, []);
  assert.deepEqual(await readdir(f.directory), ['accounts-v1.sqlite']);
  assert.deepEqual(await readFile(f.path), invalid);
});

test('a database owned by a future version stays intact and existing accounts return after restart', async t => {
  const f = await fixture(t);
  const initial = await f.start();
  const {account} = await initial.action({action: 'social-accounts-save', account: {
    pluginId: '@ai-buddy/bilibili-companion', accountId: 'fixture-account', label: 'Fixture account',
  }});
  await initial.close();

  function changeVersion(version) {
    const db = new DatabaseSync(f.path);
    try {
      db.exec(`PRAGMA user_version=${version}`);
    } finally {
      db.close();
    }
  }

  changeVersion(2);
  const before = await readFile(f.path);
  const paused = await f.start();
  assert.equal(paused.snapshot().socialStorage.state, 'unavailable');
  await paused.close();
  assert.deepEqual(await readFile(f.path), before);

  changeVersion(0);
  const restored = await f.start();
  assert.deepEqual((await restored.action({action: 'social-accounts-list'})).accounts, [account]);
});

test('an installed QQ plugin remains listed but cannot activate or open while account storage is unavailable', async t => {
  let workerStarts = 0;
  const f = await fixture(t, {
    componentWorkerFactory: () => {
      workerStarts++;
      throw new Error('Unexpected component worker');
    },
  });
  await writeFile(f.path, 'This is not a SQLite database.');
  const packageKey = await f.seedInstalledQq();
  const platform = await f.start();

  const status = await platform.action({action: 'community-status'});
  const installed = status.dsh.installed.find(record => record.packageKey === packageKey);
  assert.equal(installed?.packageName, '@ai-buddy/qq-connect');
  assert.equal(installed.enabled, true);
  const failure = {code: 'SOCIAL_STORAGE_UNAVAILABLE'};
  const surface = () => { throw new Error('Unexpected embedded browser'); };
  const results = await Promise.allSettled([
    platform.action({action: 'dsh-open-client', packageKey}),
    platform.activateInstalled(packageKey),
    platform.openClientEmbedded({packageKey, surface}),
  ]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, failure.code);
  }
  assert.equal(workerStarts, 0);
});
