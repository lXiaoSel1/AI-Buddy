import {compareVersions, parsePluginVersion, satisfiesVersionRange} from '../plugin-manifest.mjs';
import {selectStableUpdate, stablePatchUpdate} from '../plugin-update-policy.mjs';

const DAY = 24 * 60 * 60 * 1000;
const copy = value => structuredClone(value);
const updateIdentity = (key, version, digest) => key + '@' + version + ':' + digest;
const fail = (message, code) => { throw Object.assign(Error(message), {code}); };

export function createPluginUpdateCoordinator({
  legacyManager, preferences, writePreferences, getRecords, getWorks, getJobs,
  sourceFingerprint, sourceError, runtimeVersion, bridgeCompatibilityVersion, refreshCatalogs,
  planInstall, queueInstall, maintenanceAdmission, automaticWorkAllowed,
  assertAdmission, now, isClosed, publicFailure, update,
}) {
  let pluginUpdates = {updates: [], checkedAt: null, errors: []}, automaticCandidates = [];
  let updateCheck = null, updateSerial = Promise.resolve(), updateTimer, activeUpdates = 0, retryLegacyAt = Infinity;
  const failures = preferences.failedPluginUpdates;
  const failedPluginUpdates = failures && typeof failures === 'object' && !Array.isArray(failures) ? failures : {};
  function updateJobs(jobs) {
    const matching = new Map();
    for (const job of jobs) {
      if (job.operation !== 'install') continue;
      const ref = job.intent?.packageRef;
      if (!ref?.sourceDigest) continue;
      matching.set(updateIdentity(job.packageKey, ref.exactVersion, ref.sourceDigest), job);
    }
    return matching;
  }
  function dshUpdateRows(automatic = false) {
    const appVersion = legacyManager.snapshot().appVersion, dshVersion = runtimeVersion(), works = getWorks(), output = [];
    const jobs = updateJobs(getJobs());
    for (const record of Object.values(getRecords())) {
      const work = works.find(value => value.sourceId === record.sourceId && value.packageName === record.packageName && value.backend === 'dsh');
      if (!work || (work.status ?? 'published') !== 'published') continue;
      const releases = automatic ? work.releases.filter(({version, package: ref}) =>
        stablePatchUpdate(record.exactVersion, version) && ref.dataSchemaVersion === record.dataSchemaVersion &&
        ref.capabilities.every(capability => record.grantedCapabilities.includes(capability))) : work.releases;
      const selected = selectStableUpdate(releases, record.exactVersion, ({package: ref}) =>
        !!appVersion && satisfiesVersionRange(appVersion, ref.compatibility.app) &&
        satisfiesVersionRange(bridgeCompatibilityVersion, ref.compatibility.bridge) &&
        (!dshVersion || satisfiesVersionRange(dshVersion, ref.compatibility.dsh)));
      if (!selected) continue;
      const {target: release, compatible} = selected, requested = release.package;
      const addedCapabilities = requested.capabilities.filter(capability => !record.grantedCapabilities.includes(capability));
      const incompatibleData = requested.dataSchemaVersion !== record.dataSchemaVersion;
      const policy = preferences.updatePolicies[record.packageKey] ?? 'manual';
      const changes = work.releases.filter(value => compareVersions(value.version, record.exactVersion) > 0 && compareVersions(value.version, release.version) <= 0 && !parsePluginVersion(value.version).pre.length).sort((a, b) => -compareVersions(a.version, b.version)).map(value => ({version: value.version, notes: value.notes ?? null, ...(value.locales ? {locales: copy(value.locales)} : {})}));
      const matching = jobs.get(updateIdentity(record.packageKey, release.version, requested.sourceDigest));
      const sourceChanged = record.sourceProof?.sourceFingerprint !== sourceFingerprint(work.sourceId);
      const unavailable = !compatible || sourceChanged || !!sourceError(work.sourceId);
      const state = unavailable ? 'unavailable' : addedCapabilities.length || incompatibleData ? 'needs-user' : 'available';
      const error = sourceChanged ? {code: 'PLUGIN_SOURCE_CHANGED', message: 'Installed publisher identity differs from the current source'} :
        !compatible ? {code: 'PLUGIN_INCOMPATIBLE', message: 'Update requires a compatible AI Buddy or DSH version'} : sourceError(work.sourceId);
      const priorFailure = failedPluginUpdates[record.packageKey], sameFailure = priorFailure?.digest === requested.sourceDigest && priorFailure.to === release.version && priorFailure.from === record.exactVersion;
      const knownState = ['queued', 'running', 'failed', 'interrupted-needs-user', 'needs-user', 'cancelled'].includes(matching?.state) ? matching.state : sameFailure ? 'failed' : null;
      const pinnedState = ['queued', 'running', 'interrupted-needs-user'].includes(knownState);
      output.push({backend: 'dsh', packageKey: record.packageKey, packageName: record.packageName, from: record.exactVersion, to: release.version, digest: requested.sourceDigest, policy, addedCapabilities, incompatibleData, state: pinnedState || state === 'available' ? knownState ?? state : state, workId: work.id, sourceId: work.sourceId, changes, ...(matching?.error || error || sameFailure ? {error: matching?.error ?? error ?? priorFailure.error} : {}), ...(matching?.waitingReason ? {waitingReason: matching.waitingReason} : {})});
    }
    return output;
  }
  async function checkUpdates({refresh = false} = {}) {
    if (updateCheck) return updateCheck;
    updateCheck = (async () => {
      const metadata = refresh && Object.keys(getRecords()).length ? await refreshCatalogs() : {results: []};
      const failures = metadata.results.filter(row => row.error).map(({sourceId, error}) => ({sourceId, error}));
      let legacy = {updates: [], errors: []};
      if (Object.keys(legacyManager.snapshot().installed ?? {}).length) {
        try { legacy = await legacyManager.action({action: 'update-candidates', refresh, includeAutomatic: true}); }
        catch (cause) { failures.push({sourceId: 'legacy', error: publicFailure(cause)}); }
      }
      const legacyRows = rows => (rows ?? []).map(row => {
        const failure = failedPluginUpdates[row.packageKey];
        return {...row, policy: preferences.updatePolicies[row.packageKey] ?? 'manual', ...(failure?.digest === row.digest && failure.to === row.to && failure.from === row.from && row.state === 'available' ? {state: 'failed', error: failure.error} : {})};
      });
      automaticCandidates = [...dshUpdateRows(true), ...legacyRows(legacy.automaticUpdates)];
      pluginUpdates = {updates: [...dshUpdateRows(), ...legacyRows(legacy.updates)], checkedAt: new Date(now()).toISOString(), errors: [...failures, ...(legacy.errors ?? [])]};
      update();
      return copy(pluginUpdates);
    })().finally(() => { updateCheck = null; });
    return updateCheck;
  }
  function updateRows(legacy = legacyManager.snapshot().installed ?? {}, jobs = getJobs()) {
    if (!pluginUpdates.updates.length) return pluginUpdates;
    const visible = [], matches = updateJobs(jobs);
    for (const row of pluginUpdates.updates) {
      if (row.backend === 'buddy-v1') {
        if (legacy[row.id]?.current === row.from && (legacy[row.id]?.sourceId ?? 'legacy') === row.sourceId) visible.push(row);
        continue;
      }
      if (getRecords()[row.packageKey]?.exactVersion !== row.from) continue;
      const job = matches.get(updateIdentity(row.packageKey, row.to, row.digest));
      visible.push(job ? {...row, state: job.state, waitingReason: job.waitingReason ?? null, error: job.error ? publicFailure(job.error) : null} : row);
    }
    return {...pluginUpdates, updates: visible};
  }
  function pinnedUpdate(request, backend) {
    const row = updateRows().updates.find(row => row.backend === backend && row.packageKey === request.packageKey && row.from === request.from && row.to === request.to && row.digest === request.digest);
    if (!row || ['unavailable', 'queued', 'running', 'interrupted-needs-user'].includes(row.state) || row.incompatibleData) fail('Plugin update changed; check updates again', 'PLUGIN_UPDATE_CHANGED');
    return row;
  }
  async function rememberUpdateFailure(row, cause) {
    if (!cause && !failedPluginUpdates[row.packageKey]) return;
    await writePreferences(() => {
      if (cause) failedPluginUpdates[row.packageKey] = {from: row.from, to: row.to, digest: row.digest, error: publicFailure(cause)};
      else delete failedPluginUpdates[row.packageKey];
      while (Object.keys(failedPluginUpdates).length > 1000) delete failedPluginUpdates[Object.keys(failedPluginUpdates)[0]];
      preferences.failedPluginUpdates = failedPluginUpdates;
    });
  }
  async function executeUpdate(row, mode) {
    if (isClosed() || !maintenanceAdmission()) return row;
    if (mode === 'auto' && (!automaticWorkAllowed() || preferences.updatePolicies[row.packageKey] !== 'auto')) return row;
    activeUpdates++;
    try {
      if (row.backend === 'buddy-v1') {
        const plan = await legacyManager.action({action: 'plan-update', ...row, mode});
        assertAdmission();
        if (plan.requiresReview) return {...row, state: 'needs-user', addedCapabilities: plan.addedCapabilities, dependencyChanges: plan.dependencyChanges};
        await legacyManager.action({action: 'install-update', planId: plan.planId, packageKey: row.packageKey, digest: row.digest});
        await rememberUpdateFailure(row, null);
        return {...row, state: 'completed'};
      }
      const plan = await planInstall({sourceId: row.sourceId, id: row.workId, version: row.to, profileId: getRecords()[row.packageKey]?.profileId, updateFrom: row.from, updateDigest: row.digest});
      assertAdmission();
      if (mode === 'auto' && (!automaticWorkAllowed() || preferences.updatePolicies[row.packageKey] !== 'auto')) return row;
      if (plan.addedCapabilities.length || plan.hostComponents?.some(component => !component.ready) || plan.priorDataSchemaVersion !== plan.packageRef.dataSchemaVersion)
        return {...row, state: 'needs-user', addedCapabilities: plan.addedCapabilities, hostComponents: plan.hostComponents};
      const result = await queueInstall({planId: plan.planId, grantedCapabilities: plan.priorGrantedCapabilities.filter(capability => plan.declaredCapabilities.includes(capability))}, mode);
      return {...row, state: result.job.state, jobId: result.job.id};
    } catch (cause) {
      if (['PLUGIN_BUSY', 'PLUGIN_MAINTENANCE_RESERVED', 'PLUGIN_AUTO_UPDATE_DISABLED'].includes(cause.code)) {
        if (mode === 'auto' && row.backend === 'buddy-v1' && cause.code !== 'PLUGIN_AUTO_UPDATE_DISABLED') retryLegacyAt = Math.min(retryLegacyAt, now() + 15_000);
        return {...row, state: 'available', waitingReason: 'active-work', error: publicFailure(cause)};
      }
      if (['HOST_DEPENDENCY_PLAN_CHANGED', 'PLUGIN_DEPENDENCY_ERROR', 'PLUGIN_SOURCE_CHANGED', 'PLUGIN_UPDATE_CHANGED', 'PLUGIN_INCOMPATIBLE', 'DSH_RUNTIME_NOT_READY'].includes(cause.code))
        return {...row, state: 'needs-user', error: publicFailure(cause)};
      await rememberUpdateFailure(row, cause);
      return {...row, state: 'failed', error: publicFailure(cause)};
    } finally { activeUpdates--; }
  }
  function runUpdates(mode, {refresh = false} = {}) {
    const result = updateSerial.then(async () => {
      const checked = await checkUpdates({refresh}), scan = pluginUpdates, output = [];
      if (!maintenanceAdmission() || mode === 'auto' && !automaticWorkAllowed()) return checked;
      for (const row of mode === 'auto' ? automaticCandidates : checked.updates) {
        const eligible = row.state === 'available' && (mode !== 'auto' || row.policy === 'auto' && stablePatchUpdate(row.from, row.to));
        output.push(eligible ? await executeUpdate(row, mode) : row);
      }
      if (pluginUpdates === scan) {
        const results = new Map(output.map(row => [updateIdentity(row.packageKey, row.to, row.digest), row]));
        pluginUpdates = {...scan, updates: scan.updates.map(row => {
          const result = results.get(updateIdentity(row.packageKey, row.to, row.digest));
          return result?.from === row.from ? {...result, policy: row.policy} : row;
        })};
      }
      update();
      return {...checked, updates: copy(output)};
    });
    updateSerial = result.catch(() => {});
    return result;
  }
  const runAutomaticUpdates = options => runUpdates('auto', options);
  function scheduleUpdateCheck(delay) {
    updateTimer = setTimeout(async () => {
      if (isClosed()) return;
      if (!maintenanceAdmission() || !automaticWorkAllowed()) { scheduleUpdateCheck(60_000); return; }
      if (Object.keys(getRecords()).length || Object.keys(legacyManager.snapshot().installed ?? {}).length) {
        try {
          await writePreferences(() => { preferences.lastPluginUpdateCheckAt = now(); });
          await runAutomaticUpdates({refresh: true});
        } catch {}
      }
      if (!isClosed()) scheduleUpdateCheck(DAY);
    }, delay);
    updateTimer.unref?.();
  }
  return {
    check: checkUpdates,
    summary: updateRows,
    pinned: pinnedUpdate,
    rememberFailure: rememberUpdateFailure,
    run: runUpdates,
    automatic: runAutomaticUpdates,
    setPolicy(packageKey, policy) {
      pluginUpdates.updates = pluginUpdates.updates.map(row => row.packageKey === packageKey ? {...row, policy} : row);
    },
    start() {
      scheduleUpdateCheck(Math.max(45_000, Math.min(DAY, Number(preferences.lastPluginUpdateCheckAt ?? 0) + DAY - now())));
    },
    retryDeferred() {
      if (!maintenanceAdmission() || retryLegacyAt > now()) return;
      retryLegacyAt = Infinity;
      void runAutomaticUpdates({refresh: false}).catch(() => {});
    },
    busy: () => activeUpdates > 0,
    async close() {
      clearTimeout(updateTimer);
      await updateSerial;
      await Promise.allSettled([updateCheck]);
    },
  };
}
