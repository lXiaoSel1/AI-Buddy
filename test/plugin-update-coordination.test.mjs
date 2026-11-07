import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog, setupCommunity, sha} from './support/community-fixtures.mjs';

function nextCatalog(pub, specs) {
  const value = catalog(pub, {generatedAt: '2026-10-24T23:00:00Z'});
  const work = value.works[0];
  for (const [version, changes] of specs) {
    const release = structuredClone(work.releases[0]);
    release.version = release.package.exactVersion = version;
    release.package.sourceDigest = sha(version);
    Object.assign(release.package, changes);
    work.releases.push(release);
  }
  return value;
}

test('checking is read-only and automatic updates only apply a compatible stable patch', async t => {
  const f = await setupCommunity(t);
  await f.load();
  await f.install();
  const [before] = f.service.snapshot().dsh.installed;
  await f.service.action({action: 'community-set-update-policy', packageKey: before.packageKey, policy: 'auto'});
  await f.load(nextCatalog(f.pub, [
    ['1.0.9', {}], ['1.0.10', {}],
    ['1.0.11-beta.1', {}],
    ['1.1.0', {compatibility: {app: '^2.0.0', dsh: '^1.0.0', bridge: '^1.0.0'}}],
  ]));
  const state = await f.service.action({action: 'community-check-updates'});
  assert.equal(state.updates[0].to, '1.0.10');
  assert.equal(state.updates[0].state, 'available');
  assert.equal(f.service.snapshot().maintenance.jobs.length, 1);
  await f.service.runAutomaticUpdates({refresh: false});
  await f.service.drainMaintenance();
  assert.equal(f.service.snapshot().dsh.installed[0].exactVersion, '1.0.10');
  assert.equal(f.service.snapshot().dsh.installed[0].enabled, false);
});

test('a queued automatic update is not applied after opting out while busy', async t => {
  let busy = false;
  const f = await setupCommunity(t, {busy: async () => busy});
  await f.load();
  await f.install();
  const [{packageKey}] = f.service.snapshot().dsh.installed;
  await f.service.action({action: 'community-set-update-policy', packageKey, policy: 'auto'});
  await f.load(nextCatalog(f.pub, [['1.0.1', {}]]));
  busy = true;
  await f.service.runAutomaticUpdates({refresh: false});
  await f.service.drainMaintenance();
  assert.equal(f.service.snapshot().maintenance.jobs.at(-1).state, 'queued');
  await f.service.action({action: 'community-set-update-policy', packageKey, policy: 'manual'});
  busy = false;
  await f.service.drainMaintenance();
  assert.equal(f.service.snapshot().dsh.installed[0].exactVersion, '1.0.0');
  assert.equal(f.service.snapshot().maintenance.jobs.at(-1).state, 'needs-user');
});

test('automatic and update-all share one job and honor a maintenance reservation', async t => {
  let allowed = true, busy = false;
  const f = await setupCommunity(t, {maintenanceAdmission: () => allowed, busy: async () => busy});
  await f.load();
  await f.install();
  const [{packageKey}] = f.service.snapshot().dsh.installed;
  await f.service.action({action: 'community-set-update-policy', packageKey, policy: 'auto'});
  await f.load(nextCatalog(f.pub, [['1.0.1', {}]]));
  busy = true;
  await Promise.all([f.service.runAutomaticUpdates({refresh: false}), f.service.action({action: 'community-update-all'})]);
  assert.equal(f.service.snapshot().maintenance.jobs.length, 2);
  allowed = false; busy = false;
  await f.service.drainMaintenance();
  assert.equal(f.service.snapshot().maintenance.jobs.at(-1).state, 'queued');
  assert.equal(f.service.maintenanceBusy(), false);
  allowed = true;
  await f.service.drainMaintenance();
  assert.equal(f.service.snapshot().dsh.installed[0].exactVersion, '1.0.1');
});

test('a failed updated runtime restores the exact enabled previous release and blocks automatic retries', async t => {
  const f = await setupCommunity(t);
  await f.load();
  await f.install();
  const [{packageKey}] = f.service.snapshot().dsh.installed;
  await f.service.action({action: 'dsh-enable', packageKey});
  await f.service.drainMaintenance();
  const enable = f.backend.enable;
  f.backend.enable = async ref => ref.exactVersion === '1.0.1' ? {enabled: false} : enable(ref);
  await f.service.action({action: 'community-set-update-policy', packageKey, policy: 'auto'});
  await f.load(nextCatalog(f.pub, [['1.0.1', {}]]));
  await f.service.runAutomaticUpdates({refresh: false});
  await f.service.drainMaintenance();
  const [record] = f.service.snapshot().dsh.installed;
  assert.equal(record.exactVersion, '1.0.0');
  assert.equal(record.runtimeVerified, true);
  assert.equal(record.enabled, true);
  assert.equal(f.calls.filter(([operation]) => operation === 'rollback').length, 1);
  assert.equal(f.service.snapshot().maintenance.jobs.at(-1).state, 'failed');
  await f.restart();
  const count = f.service.snapshot().maintenance.jobs.length;
  await f.service.runAutomaticUpdates({refresh: false});
  assert.equal(f.service.snapshot().maintenance.jobs.length, count);
});

test('DSH automatic updates use the newest eligible patch when a newer minor is offered', async t => {
  const f = await setupCommunity(t);
  await f.load();
  await f.install();
  const [{packageKey}] = f.service.snapshot().dsh.installed;
  await f.service.action({action: 'community-set-update-policy', packageKey, policy: 'auto'});
  await f.load(nextCatalog(f.pub, [
    ['1.0.1', {}], ['1.0.2', {}], ['1.0.3', {dataSchemaVersion: 2}], ['1.1.0', {}],
  ]));
  assert.equal((await f.service.action({action: 'community-check-updates'})).updates[0].to, '1.1.0');
  const {updates: [selected]} = await f.service.runAutomaticUpdates({refresh: false});
  assert.equal(selected.to, '1.0.2');
  assert.equal(selected.digest, sha('1.0.2'));
  await f.service.drainMaintenance();
  assert.equal(f.service.snapshot().dsh.installed[0].exactVersion, '1.0.2');
  assert.equal((await f.service.action({action: 'community-check-updates'})).updates[0].to, '1.1.0');
});

test('DSH explicitly reviewed permission additions preserve the enabled state', async t => {
  const f = await setupCommunity(t);
  await f.load();
  await f.install();
  const [{packageKey}] = f.service.snapshot().dsh.installed;
  await f.service.action({action: 'dsh-enable', packageKey});
  await f.service.drainMaintenance();
  await f.service.action({action: 'community-set-update-policy', packageKey, policy: 'auto'});
  const capabilities = ['characters.getContext', 'models.request'];
  await f.load(nextCatalog(f.pub, [['1.0.1', {capabilities}]]));
  const {updates: [row]} = await f.service.action({action: 'community-check-updates'});
  assert.equal(row.state, 'needs-user');
  assert.deepEqual(row.addedCapabilities, ['models.request']);
  await f.service.runAutomaticUpdates({refresh: false});
  await f.service.action({action: 'community-update-all'});
  await f.service.drainMaintenance();
  assert.equal(f.service.snapshot().dsh.installed[0].exactVersion, '1.0.0');
  const plan = await f.service.action({action: 'dsh-plan', sourceId: row.sourceId, id: row.workId, version: row.to, updateFrom: row.from, updateDigest: row.digest});
  await f.service.action({action: 'dsh-install', planId: plan.planId, grantedCapabilities: capabilities});
  await f.service.drainMaintenance();
  const [updated] = f.service.snapshot().dsh.installed;
  assert.equal(updated.exactVersion, '1.0.1');
  assert.equal(updated.enabled, true);
  assert.equal(updated.runtimeVerified, true);
  assert.deepEqual(updated.grantedCapabilities, capabilities);
});

test('an update finishing after a newer check cannot replace that check result', async t => {
  const f = await setupCommunity(t);
  await f.load();
  await f.install();
  const [{packageKey}] = f.service.snapshot().dsh.installed;
  await f.service.action({action: 'community-set-update-policy', packageKey, policy: 'auto'});
  await f.load(nextCatalog(f.pub, [['1.0.1', {}]]));
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const planInstall = f.backend.planInstall;
  f.backend.planInstall = async request => {
    entered.resolve();
    await release.promise;
    return planInstall(request);
  };
  const attempt = f.service.runAutomaticUpdates({refresh: false});
  await entered.promise;
  try {
    const fresh = nextCatalog(f.pub, [['1.0.1', {}], ['1.1.0', {}]]);
    fresh.generatedAt = '2026-10-25T00:00:00Z';
    await f.load(fresh);
    assert.equal((await f.service.action({action: 'community-check-updates'})).updates[0].to, '1.1.0');
  } finally { release.resolve(); }
  await attempt;
  const {updates: [latest]} = await f.service.action({action: 'community-update-summary'});
  assert.equal(latest.to, '1.1.0');
  assert.equal(latest.state, 'available');
  assert.equal(f.service.snapshot().dsh.installed[0].exactVersion, '1.0.0');
});
