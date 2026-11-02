import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {catalog, setupCommunity, signed, publisher, githubIssue, simulatedBackend} from './support/community-fixtures.mjs';

test('simulation: actual native event phases remain observable while a plan inspection is pending',async t=>{
  let emit,release,started;const observed=new Promise(resolve=>started=resolve),waiting=new Promise(resolve=>release=resolve),backend=simulatedBackend([]),original=backend.planInstall;
  backend.on=(_name,listener)=>{emit=listener;return()=>{emit=null;};};backend.planInstall=async request=>{emit({kind:'runtime-verification',phase:'verifying-component'});started();await waiting;emit({kind:'tools-changed'});return original(request);};
  const f=await setupCommunity(t,{dshBackend:backend});await f.load();const pending=f.service.action({action:'dsh-plan',sourceId:f.pub.source.sourceId,id:'test.tools'});await observed;
  assert.equal(f.service.snapshot().dsh.state.phase,'verifying-component');assert.equal(f.service.snapshot().dsh.state.ready,true);
  release();await pending;assert.equal(f.service.snapshot().dsh.state.phase,'inspection-finished');
  emit({kind:'platform-progress',phase:'applying'});assert.equal(f.service.snapshot().dsh.state.phase,'applying');
});
import {createCapabilityGrantRegistry} from '../src/buddy-plugin-services/capability-grants.mjs';
import {reviewFromGitHubIssue} from '../src/community/reviews.mjs';

test('simulation: empty startup and browsing do not spawn DSH or invoke a model', async t => {
  const f = await setupCommunity(t); assert.deepEqual(f.calls, []); assert.equal(f.service.snapshot().community.configured, false);
  await f.load(); assert.equal((await f.service.action({action: 'community-search'})).total, 1); assert.deepEqual(f.calls, []);
  assert.deepEqual((await f.service.action({action: 'search'})).legacy, true); assert.equal((await f.service.action({action: 'status'})).service.usable, true);
});
test('simulation: installation requires a host-created plan and declared grant subset', async t => {
  const f = await setupCommunity(t); await f.load(); await assert.rejects(f.service.action({action: 'dsh-install', planId: 'invented', grantedCapabilities: []}), {code: 'COMMUNITY_PLAN_NOT_FOUND'});
  const plan = await f.service.action({action: 'dsh-plan', sourceId: f.pub.source.sourceId, id: 'test.tools'});
  await assert.rejects(f.service.action({action: 'dsh-install', planId: plan.planId, grantedCapabilities: ['models.all-secrets']}), {code: 'COMMUNITY_CAPABILITY_INVALID'});
  await f.service.action({action: 'dsh-install', planId: plan.planId, grantedCapabilities: plan.declaredCapabilities}); await f.service.drainMaintenance();
  const record = f.service.snapshot().dsh.installed[0]; assert.equal(record.enabled, false); assert.deepEqual(record.grantedCapabilities, ['characters.getContext']); assert.equal(f.calls.find(call => call[0] === 'install')[2].enabled, false); assert.equal(f.grants.at(-1).enabled, false);
});
test('simulation: enable state is confirmed by backend and authURL never reaches renderer result', async t => {
  const f = await setupCommunity(t); await f.load(); await f.install(); const key = f.service.snapshot().dsh.installed[0].packageKey;
  await assert.rejects(f.service.action({action: 'dsh-open-client', packageKey: key}), {code: 'PLUGIN_DISABLED'});
  await f.service.action({action: 'dsh-enable', packageKey: key}); await f.service.drainMaintenance(); assert.equal(f.grants.at(-1).enabled, true);
  const result = await f.service.action({action: 'dsh-open-client', packageKey: key, external: true}); assert.equal(result.profileId, 'buddy-community-v1'); assert.equal(JSON.stringify(result).includes('DO-NOT-EXPOSE'), false); assert.equal(JSON.stringify(f.service.snapshot()).includes('DO-NOT-EXPOSE'), false); assert.equal(f.opened[0].intent.external, true); assert.match(f.opened[0].descriptor.authURL, /DO-NOT-EXPOSE/);
});
test('simulation: stale queued install never applies after pinned source changes', async t => {
  let busy = true; const f = await setupCommunity(t, {busy: async () => busy}); await f.load(); await f.install(); assert.equal(f.calls.some(call => call[0] === 'install'), false);
  f.pub.source.generation++; busy = false; await f.service.drainMaintenance(); assert.equal(f.service.snapshot().maintenance.jobs[0].state, 'needs-user'); assert.equal(f.calls.some(call => call[0] === 'install'), false);
});
test('simulation: restarted installed records do not grant capabilities before runtime verification', async t => {
  const f = await setupCommunity(t); await f.load(); await f.install(); const key = f.service.snapshot().dsh.installed[0].packageKey; await f.service.action({action: 'dsh-enable', packageKey: key}); await f.service.drainMaintenance();
  const priorCalls = f.calls.length; await f.restart(); assert.equal(f.calls.slice(priorCalls).some(call => call[0] !== 'close'), false); assert.equal(f.grants.at(-1).enabled, false); assert.equal(f.grants.at(-1).phase, 'runtime-not-verified');
  const pending = f.service.snapshot().dsh.installed[0]; assert.equal(pending.enabledIntent, true); assert.equal(pending.runtimeState, 'pending-load'); assert.equal(pending.phase, 'pending-load'); assert.equal(pending.runtimeVerified, false);
});
test('simulation: favorites, follows, manual update default and export/import survive restart', async t => {
  const f = await setupCommunity(t); await f.load(); const key = f.pub.source.sourceId + ':test.tools'; await f.service.action({action: 'community-favorite', key, enabled: true}); await f.service.action({action: 'community-follow', key: f.pub.source.sourceId + ':author.test', enabled: true});
  const exported = await f.service.action({action: 'community-export-preferences'}); assert.deepEqual(exported.favorites, [key]); await f.restart(); assert.equal((await f.service.action({action: 'community-search', favoritesOnly: true})).total, 1); assert.equal((await f.service.action({action: 'community-details', sourceId: f.pub.source.sourceId, id: 'test.tools'})).updatePolicy, 'manual');
  await f.service.action({action: 'community-import-preferences', value: exported}); assert.equal(f.service.snapshot().community.favorites.length, 1);
});
test('simulation: automatic updates cannot silently add permissions or migrate data', async t => {
  const f = await setupCommunity(t); await f.load(); await f.install(); const record = f.service.snapshot().dsh.installed[0]; await f.service.action({action: 'community-set-update-policy', packageKey: record.packageKey, policy: 'auto'});
  const updated = catalog(f.pub, {generatedAt: '2026-10-24T23:00:00Z'}), release = structuredClone(updated.works[0].releases[0]); release.version = release.package.exactVersion = '1.1.0'; release.package.capabilities.push('models.request'); updated.works[0].releases.push(release);
  await f.load(updated); const result = await f.service.action({action: 'community-check-updates'}); assert.equal(result.updates[0].state, 'needs-user'); assert.deepEqual(result.updates[0].addedCapabilities, ['models.request']); assert.equal(f.calls.filter(call => call[0] === 'install').length, 1);
});
test('simulation: opening review form remains pending and missing statistics stay unknown', async t => {
  const f = await setupCommunity(t); await f.load(); const draft = await f.service.action({action: 'community-review-draft', sourceId: f.pub.source.sourceId, id: 'test.tools', stars: 5, text: '好用'});
  assert.equal(draft.status, 'pending-sync'); assert.equal(f.service.snapshot().community.pendingReviews[0].status, 'pending-sync'); const row = (await f.service.action({action: 'community-search'})).items[0]; assert.equal(row.rating.mean, null); assert.equal(row.recommendation.components.downloads, null);
});
test('simulation: bad catalog signature/replay retains the verified cached catalog', async t => {
  const f = await setupCommunity(t); await f.load(); const bad = signed(catalog(f.pub), f.pub); bad.payload.works[0].name = 'tampered'; await assert.rejects(f.service.action({action: 'community-load-catalog', sourceId: f.pub.source.sourceId, envelope: bad}), /verification/);
  assert.equal((await f.service.action({action: 'community-search'})).items[0].stale, true); await assert.rejects(f.load(catalog(f.pub, {generatedAt: '2026-10-24T21:30:00Z'})), {code: 'COMMUNITY_CATALOG_REPLAY'});
});
test('simulation: removing a plugin retains its data directory and lifecycle revokes grants', async t => {
  const f = await setupCommunity(t); await f.load(); await f.install(); const key = f.service.snapshot().dsh.installed[0].packageKey, marker = join(f.dataRoot, 'community', 'data-marker.json'); await writeFile(marker, 'preserved');
  await f.service.action({action: 'dsh-uninstall', packageKey: key}); await f.service.drainMaintenance(); assert.equal(f.service.snapshot().dsh.installed.length, 0); assert.equal(await readFile(marker, 'utf8'), 'preserved'); assert.equal(f.grants.at(-1).phase, 'uninstalled');
});
test('simulation: actual host grant generations increase across disable, uninstall, reinstall and restart', async t => {
  const grants = createCapabilityGrantRegistry(), f = await setupCommunity(t, {onPackageState: async record => grants.set({pluginId: record.pluginId, declared: record.declaredCapabilities, granted: record.grantedCapabilities, enabled: record.enabled, generation: record.generation})});
  await f.load(); await f.install(); const initial = f.service.snapshot().dsh.installed[0], key = initial.packageKey;
  await f.service.action({action: 'dsh-enable', packageKey: key}); await f.service.drainMaintenance(); const enabled = grants.get(initial.pluginId).generation;
  await f.service.action({action: 'dsh-uninstall', packageKey: key}); await f.service.drainMaintenance(); assert.equal(grants.get(initial.pluginId).enabled, false);
  await f.install(); assert.ok(grants.get(initial.pluginId).generation > enabled); await f.restart(); assert.equal(grants.get(initial.pluginId).enabled, false);
  await f.service.action({action: 'dsh-enable', packageKey: key}); await f.service.drainMaintenance(); assert.equal(grants.get(initial.pluginId).enabled, true);
});
test('simulation: a failed native enable can be explicitly retried after component repair', async t => {
  const f = await setupCommunity(t); await f.load(); await f.install(); const key = f.service.snapshot().dsh.installed[0].packageKey, normalEnable = f.backend.enable; let failOnce = true;
  f.backend.enable = async ref => { if (failOnce) { failOnce = false; throw Object.assign(Error('component missing'), {code: 'DSH_RUNTIME_NOT_READY'}); } return normalEnable(ref); };
  await f.service.action({action: 'dsh-enable', packageKey: key}); await f.service.drainMaintenance(); assert.equal(f.service.snapshot().maintenance.jobs.at(-1).state, 'failed');
  assert.equal(f.service.snapshot().dsh.installed[0].runtimeState, 'failed'); assert.equal(f.service.snapshot().dsh.installed[0].runtimeVerified, false); assert.equal(f.grants.at(-1).enabled, false);
  await f.service.action({action: 'dsh-enable', packageKey: key}); await f.service.drainMaintenance(); assert.equal(f.service.snapshot().maintenance.jobs.at(-1).state, 'completed'); assert.equal(f.service.snapshot().dsh.installed[0].enabled, true);
  assert.equal(f.service.snapshot().dsh.installed[0].runtimeState, 'loaded'); assert.equal(f.service.snapshot().dsh.installed[0].phase, 'loaded'); assert.equal(f.service.snapshot().dsh.installed[0].runtimeFailure, undefined);
});
test('simulation: incompatible app/bridge/runtime releases fail before native installation', async t => {
  const f = await setupCommunity(t), payload = catalog(f.pub); payload.works[0].releases[0].package.compatibility.app = '^9.0.0'; await f.load(payload);
  await assert.rejects(f.service.action({action: 'dsh-plan', sourceId: f.pub.source.sourceId, id: 'test.tools'}), {code: 'PLUGIN_INCOMPATIBLE'}); assert.equal(f.calls.some(call => call[0] === 'install' || call[0] === 'plan'), false);
});
test('simulation: a safe automatic update restores the prior enabled intent through real lifecycle confirmation', async t => {
  const f = await setupCommunity(t); await f.load(); await f.install(); const key = f.service.snapshot().dsh.installed[0].packageKey; await f.service.action({action: 'dsh-enable', packageKey: key}); await f.service.drainMaintenance(); await f.service.action({action: 'community-set-update-policy', packageKey: key, policy: 'auto'});
  const updated = catalog(f.pub, {generatedAt: '2026-10-24T23:00:00Z'}), release = structuredClone(updated.works[0].releases[0]); release.version = release.package.exactVersion = '1.1.0'; updated.works[0].releases.push(release); await f.load(updated); await f.service.action({action: 'community-check-updates'}); await f.service.drainMaintenance();
  const installed = f.service.snapshot().dsh.installed[0]; assert.equal(installed.exactVersion, '1.1.0'); assert.equal(installed.enabled, true); assert.equal(installed.runtimeVerified, true); assert.equal(f.calls.filter(call => call[0] === 'install').length, 2); assert.equal(f.calls.filter(call => call[0] === 'enable').length, 2);
});
test('simulation: immutable release bytes and different-source package names cannot overwrite an installation', async t => {
  const f = await setupCommunity(t); await f.load(); await f.install(); const replaced = catalog(f.pub, {generatedAt: '2026-10-24T23:00:00Z'}); replaced.works[0].releases[0].package.sourceDigest = 'f'.repeat(64); await assert.rejects(f.load(replaced), {code: 'COMMUNITY_RELEASE_CHANGED'});
  const other = publisher(); other.source.sourceId = '22222222-2222-2222-2222-222222222222'; other.source.descriptorId = 'other.community'; const originalResolve = f.legacy.resolveTrustedSource; f.legacy.resolveTrustedSource = async id => id === other.source.sourceId ? {...other.source} : originalResolve(id); await f.service.action({action: 'community-load-catalog', sourceId: other.source.sourceId, envelope: signed(catalog(other), other)});
  await assert.rejects(f.service.action({action: 'dsh-plan', sourceId: other.source.sourceId, id: 'test.tools'}), {code: 'PLUGIN_SOURCE_CONFLICT'}); assert.equal(f.service.snapshot().dsh.installed[0].sourceId, f.pub.source.sourceId);
});
test('simulation: unknown bridge capabilities fail before executing plugin installation code', async t => {
  const f = await setupCommunity(t), payload = catalog(f.pub); payload.works[0].releases[0].package.capabilities.push('unknown.superPower'); await f.load(payload); await assert.rejects(f.service.action({action: 'dsh-plan', sourceId: f.pub.source.sourceId, id: 'test.tools'}), {code: 'PLUGIN_CAPABILITY_UNSUPPORTED'}); assert.equal(f.calls.some(call => call[0] === 'plan' || call[0] === 'install'), false);
});

test('simulation: signed review refresh rejects unknown versions and equal-time equivocation while keeping verified cache', async t => {
  const f = await setupCommunity(t), payload = catalog(f.pub), row = reviewFromGitHubIssue(githubIssue(), {repository: 'test/native'});
  const index = {schemaVersion: 1, type: 'ai-buddy-community-reviews', catalogId: payload.id, generatedAt: '2026-10-24T22:00:00Z', repository: 'test/native', reviews: [row], deletedIssueIds: [], evidence: {provider: 'github-api', complete: true, fetchedAt: '2026-10-24T22:00:00Z', pages: 1}};
  const load = value => f.service.action({action: 'community-load-catalog', sourceId: f.pub.source.sourceId, envelope: signed(payload, f.pub), reviewEnvelope: signed(value, f.pub)});
  await load(index); const badVersion = structuredClone(index); badVersion.generatedAt = '2026-10-24T23:00:00Z'; badVersion.reviews[0].version = '9.0.0';
  await assert.rejects(load(badVersion), {code: 'COMMUNITY_REVIEW_VERSION_UNKNOWN'});
  const equivocation = structuredClone(index); equivocation.reviews[0].stars = 1; await assert.rejects(load(equivocation), {code: 'COMMUNITY_REVIEW_REPLAY'});
  assert.equal((await f.service.action({action: 'community-details', sourceId: f.pub.source.sourceId, id: 'test.tools'})).reviews.sum, 5);
  await f.restart(); assert.equal((await f.service.action({action: 'community-details', sourceId: f.pub.source.sourceId, id: 'test.tools'})).reviews.sum, 5);
});

test('host-only installed lookup and isolated activation cannot claim a different lifecycle generation', async t => {
  const f = await setupCommunity(t); await f.load(); await f.install(); const key = f.service.snapshot().dsh.installed[0].packageKey; await f.service.action({action: 'dsh-enable', packageKey: key}); await f.service.drainMaintenance();
  const record = await f.service.resolveDshInstalled(key); assert.ok(record.backendPlan); record.enabled = false; assert.equal(f.service.snapshot().dsh.installed[0].enabled, true);
  const actual = await f.service.resolveDshInstalled(key); await assert.rejects(f.service.confirmNativeActivation({packageKey: key, generation: actual.generation + 1, sourceDigest: actual.sourceDigest}), {code: 'COMMUNITY_INSTALLATION_CHANGED'});
  await f.service.confirmNativeActivation({packageKey: key, generation: actual.generation, sourceDigest: actual.sourceDigest}); assert.equal(f.service.snapshot().dsh.installed[0].runtimeVerified, true);
  await f.service.invalidatePackageRuntime({packageKey: key, generation: actual.generation, phase: 'test-isolated-exit'}); assert.equal(f.service.snapshot().dsh.installed[0].runtimeVerified, false); assert.equal(f.grants.at(-1).enabled, false); assert.ok(f.service.snapshot().dsh.installed[0].generation > actual.generation);
});
