import {randomUUID} from 'node:crypto';
import {lstat, mkdir, readFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {writeAtomic} from '../atomic-write.mjs';
import {assertPluginTreeNoLinks} from '../plugin-archive.mjs';
import {canonicalPluginJson, compareVersions, satisfiesHostVersionRange, satisfiesVersionRange} from '../plugin-manifest.mjs';
import {stablePatchUpdate, legacyUpdateKey} from '../plugin-update-policy.mjs';
import {fetchPluginJson, isVoiceSourceAuthorized} from '../plugin-sources.mjs';
import {isVoiceCommunityWork} from '../voice/package-contract.mjs';
import {createPluginBackendRegistry} from '../plugin-backends.mjs';
import {BUDDY_PLUGIN_CAPABILITIES} from '../buddy-plugin-services/capability-grants.mjs';
import {BUDDY_BRIDGE_COMPATIBILITY_VERSION} from '../buddy-plugin-services/version.mjs';
import {communityDigest, communityHttps, communityPackageKey, parseDshPackageRef, rankCommunityWorks, verifyCommunityCatalog} from './catalog.mjs';
import {aggregateReviews, buildReviewFormUrl, reviewFromGitHubIssue, verifyReviewIndex} from './reviews.mjs';
import {createPluginUpdateCoordinator} from './plugin-updates.mjs';
import {createMaintenanceQueue} from './maintenance-queue.mjs';
import {OFFLINE_FILE_LIMIT, readOfflinePluginFile} from './offline-bundle.mjs';
import {OFFICIAL_COMMUNITY_CATALOG_URL, isOfficialCommunitySource, normalizeCommunitySource} from './official-source.mjs';
import {COMMUNITY_MINIMUM_WATERMARKS, OFFLINE_CATALOG_WARN_DAYS, RESERVED_PACKAGE_SCOPE, officialScopeFingerprints} from './catalog-policy.mjs';

const fail = (message, code = 'COMMUNITY_OPERATION_FAILED') => { throw Object.assign(Error(message), {code}); };
const json = async (path, fallback) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } };
const copy = value => structuredClone(value);
const omit = (value, fields) => Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
const redact = value => String(value).replace(/([?&]token=)[^\s&]+/gi, '$1[REDACTED]');
const publicFailure = cause => ({code: cause.code ?? 'COMMUNITY_OPERATION_FAILED', message: redact(cause.message).slice(0, 2000)});
const safeNativeResult = result => { const output = {}; for (const key of ['runtimeId', 'profileId', 'installed', 'loaded', 'enabled', 'clientState', 'state', 'phase', 'needsConfiguration', 'version', 'packageName', 'exactVersion', 'sourceDigest', 'dataSchemaVersion', 'actualVersion', 'ready', 'backend', 'code', 'message', 'sourceCommit', 'nodeVersion', 'pnpmVersion']) if (['string', 'boolean', 'number'].includes(typeof result?.[key])) output[key] = key === 'message' ? redact(result[key]) : result[key]; return output; };
// README links (B2): public web pages only, never credentials, loopback, link-local or private-network hosts.
export function publicWebUrl(value) {
  let url; try { url = new URL(String(value)); } catch { return null; }
  // trailing dots are the same host (review 低-3: `localhost.`)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !host.includes('.') && !host.includes(':') || /(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(host)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && /^(0|10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\./.test(host + '.')) return null;
  if (host.includes(':') && /^(::1?$|fe[89ab]|f[cd]|::ffff:)/.test(host)) return null;
  return url.href;
}
const pluginIdentity = ref => 'dsh.' + communityDigest({sourceId: ref.sourceId, packageName: ref.packageName}).slice(0, 32);
function publicInstallation(record, verified = false) { if (!record) return null; const value = copy(omit(record, ['sourceProof', 'backendPlan', 'previous'])); value.previous = record.previous ? {version: record.previous.packageRef.exactVersion} : null; value.runtimeVerified = verified; value.enabledIntent = record.enabled === true; value.runtimeState = record.runtimeFailure && !verified ? 'failed' : record.enabled ? verified ? 'loaded' : 'pending-load' : 'disabled'; value.phase = value.runtimeState; return value; }
const publicJob = job => Object.fromEntries(['id', 'packageKey', 'operation', 'state', 'createdAt', 'updatedAt'].map(key => [key, job[key]]));

export async function createCommunityService({root, dataRoot, legacyManager, dshBackend, voiceEnabled=false, voiceTestFingerprint, hostDependencies = null, bridgeCompatibilityVersion = BUDDY_BRIDGE_COMPATIBILITY_VERSION, busy = async () => false, onUpdate = () => {}, onPackageState = async () => {}, onOpenClient, onOpenExternal, fetchImpl = globalThis.fetch, now = Date.now, pollMs = 5000, automaticWorkAllowed = () => true, maintenanceAdmission = () => true, minimumWatermarks = COMMUNITY_MINIMUM_WATERMARKS, officialFingerprints = officialScopeFingerprints()} = {}) {
  if (!legacyManager?.action || !legacyManager?.snapshot) throw Error('Existing signed plugin manager is required');
  const control = join(resolve(root), 'local/community'), preferencesDirectory = join(resolve(dataRoot), 'community');
  await assertPluginTreeNoLinks(control); await assertPluginTreeNoLinks(preferencesDirectory); await mkdir(control, {recursive: true}); await mkdir(preferencesDirectory, {recursive: true});
  const registryFile = join(control, 'dsh-registry-v1.json'), cacheFile = join(control, 'catalog-cache-v1.json'), preferencesFile = join(preferencesDirectory, 'preferences-v1.json');
  let registry = await json(registryFile, {schemaVersion: 1, packages: {}, generations: {}, releaseDigests: {}}), cache = await json(cacheFile, {schemaVersion: 1, sources: {}}), preferences = await json(preferencesFile, {schemaVersion: 1, favorites: [], follows: [], updatePolicies: {}, pendingReviews: []});
  if (registry.schemaVersion !== 1 || !registry.packages || cache.schemaVersion !== 1 || !cache.sources || preferences.schemaVersion !== 1 || !Array.isArray(preferences.favorites) || !Array.isArray(preferences.follows) || !preferences.updatePolicies || !Array.isArray(preferences.pendingReviews)) fail('Community storage is invalid; existing files retained', 'COMMUNITY_STORAGE_INVALID');
  registry.generations ??= {};
  registry.releaseDigests ??= {};
  if (!registry.generations || typeof registry.generations !== 'object' || Array.isArray(registry.generations) || Object.values(registry.generations).some(value => !Number.isSafeInteger(value) || value < 1)) fail('Community generation ledger is invalid', 'COMMUNITY_STORAGE_INVALID');
  if (typeof registry.releaseDigests !== 'object' || Array.isArray(registry.releaseDigests) || Object.values(registry.releaseDigests).some(value => !/^[a-f0-9]{64}$/.test(value))) fail('Community immutable release ledger is invalid', 'COMMUNITY_STORAGE_INVALID');
  for (const [key, record] of Object.entries(registry.packages)) if (record.packageKey !== key || key !== communityPackageKey(record) || record.backend !== 'dsh' || !Array.isArray(record.grantedCapabilities) || !Array.isArray(record.declaredCapabilities) || record.grantedCapabilities.some(value => !record.declaredCapabilities.includes(value)) || !Number.isSafeInteger(record.generation)) fail('Installed DSH record is invalid; evidence retained', 'COMMUNITY_STORAGE_INVALID');
  const catalogs = new Map(), reviews = new Map(), errors = new Map(), plans = new Map(), sourceAvailability = new Map(), runtimeVerified = new Set(), backends = createPluginBackendRegistry();
  // Imported package bytes (B6), keyed by the signed sourceDigest they were checked against. Session-only: leftovers are cleared on start.
  const offlineDirectory = join(control, 'offline'), offlineArtifacts = new Map();
  await assertPluginTreeNoLinks(offlineDirectory); await rm(offlineDirectory, {recursive: true, force: true});
  backends.register('buddy-v1', legacyManager); if (dshBackend) backends.register('dsh', dshBackend);
  let closed = false, queue, timer, closePromise, nativeState = {state: dshBackend ? 'not-started' : 'unavailable'}, prefSerial = Promise.resolve();
  let legacyUpdateWrites = 0;
  const pluginUpdates = createPluginUpdateCoordinator({
    legacyManager, preferences, writePreferences: (...args) => writePreferences(...args),
    getRecords: () => registry.packages, getWorks: allWorks, getJobs: () => queue?.snapshot().jobs ?? [],
    sourceFingerprint: id => catalogs.get(id)?.verified.keyFingerprint, sourceError: id => errors.get(id),
    runtimeVersion: () => nativeState.version, bridgeCompatibilityVersion, refreshCatalogs, planInstall, queueInstall,
    maintenanceAdmission, automaticWorkAllowed, assertAdmission: () => assertAdmission(), now,
    isClosed: () => closed, publicFailure, update: () => update(),
  });
  const assertAdmission = () => { if (closed || !maintenanceAdmission()) fail('Maintenance is waiting for an application update', 'PLUGIN_MAINTENANCE_RESERVED'); };
  const persistRegistry = () => writeAtomic(registryFile, canonicalPluginJson(registry));
  const persistCache = () => writeAtomic(cacheFile, canonicalPluginJson(cache));
  const update = () => { if (!closed) try { onUpdate(snapshot()); } catch {} };
  const writePreferences = run => { const result = prefSerial.then(async () => { if (closed) fail('Community is closed', 'COMMUNITY_CLOSED'); const value = await run(); await assertPluginTreeNoLinks(preferencesFile); writeAtomic(preferencesFile, canonicalPluginJson(preferences)); update(); return value; }); prefSerial = result.catch(() => {}); return result; };
  async function trustedSource(sourceId) { if (typeof legacyManager.resolveTrustedSource !== 'function') fail('Pinned source lookup is unavailable', 'COMMUNITY_SOURCE_UNAVAILABLE'); return normalizeCommunitySource(await legacyManager.resolveTrustedSource(sourceId)); }
  async function availableSource(sourceId) { const source = await trustedSource(sourceId); const available = source.enabled !== false && source.removed !== true; sourceAvailability.set(sourceId, available); if (!available) fail('Community source is disabled or removed', 'COMMUNITY_SOURCE_UNAVAILABLE'); return source; }
  const metadataRequests = new Map(), refreshFlights = new Map(); let officialOpening = null;
  const sameSource = (left, right) => ['generation', 'keyFingerprint', 'keyId', 'publicKey', 'url', 'catalogUrl', 'descriptorId'].every(key => left[key] === right[key]);
  async function refreshSourceAvailability() { for (const sourceId of new Set([...catalogs.keys(), ...Object.keys(cache.sources), ...[...metadataRequests.values()].map(value => value.sourceId)])) { let current; try { current = await availableSource(sourceId); } catch { sourceAvailability.set(sourceId, false); } for (const [controller, pending] of metadataRequests) if (pending.sourceId === sourceId && (!current || !sameSource(current, pending.source))) controller.abort(Object.assign(Error('Community source changed during metadata loading'), {code: 'COMMUNITY_SOURCE_CHANGED'})); } }
  function allWorks() { return [...catalogs.entries()].filter(([sourceId]) => sourceAvailability.get(sourceId) !== false).flatMap(([sourceId, catalog]) => catalog.works.map(work => ({...work, sourceId, catalogId: catalog.id, catalogDigest: catalog.verified.payloadSha256, key: sourceId + ':' + work.id}))); }
  function workFor(sourceId, id) { const value = allWorks().find(work => work.sourceId === sourceId && work.id === id); if (!value) fail('Community work not found', 'COMMUNITY_WORK_NOT_FOUND'); return value; }
  function currentRelease(work, version) { const release = version ? work.releases.find(value => value.version === version) : [...work.releases].sort((a, b) => -compareVersions(a.version, b.version))[0]; if (!release) fail('Release not found', 'COMMUNITY_RELEASE_NOT_FOUND'); return release; }
  function sourceRows() { return [...new Set([...Object.keys(cache.sources), ...catalogs.keys(), ...errors.keys()])].map(sourceId => ({sourceId, cachedAt: cache.sources[sourceId]?.cachedAt ?? null, available: catalogs.has(sourceId) && sourceAvailability.get(sourceId) !== false, stale: errors.has(sourceId), lastError: errors.get(sourceId) ?? null, catalogId: catalogs.get(sourceId)?.id ?? null, generatedAt: catalogs.get(sourceId)?.generatedAt ?? null, officialScope: officialFingerprints.has(catalogs.get(sourceId)?.verified.keyFingerprint)})); }
  function snapshot() {
    const legacy = legacyManager.snapshot(), maintenance = queue?.snapshot() ?? {schemaVersion: 1, jobs: []};
    return {...legacy, community: {schemaVersion: 1, works: allWorks().length, sources: sourceRows(), favorites: copy(preferences.favorites), follows: copy(preferences.follows), updatePolicies: copy(preferences.updatePolicies), pluginUpdates: copy(pluginUpdates.summary(legacy.installed, maintenance.jobs)), pendingReviews: copy(preferences.pendingReviews), configured: catalogs.size > 0, backends: backends.describe(), categoryCapabilities: {function: {installable: backends.supports('dsh', 'planInstall')}, 'work-engine': {installable: true}, 'character-motion': {installable: false}, 'theme-scene': {installable: false}, voice: {installable: voiceEnabled}}}, dsh: {state: copy(nativeState), installed: Object.values(registry.packages).map(record => publicInstallation(record, runtimeVerified.has(record.packageKey)))}, maintenance: {schemaVersion: maintenance.schemaVersion, jobs: maintenance.jobs.map(job => ({id: job.id, packageKey: job.packageKey, operation: job.operation, state: job.state, createdAt: job.createdAt, updatedAt: job.updatedAt, ...(typeof job.intent?.packageRef?.exactVersion === 'string' ? {version: job.intent.packageRef.exactVersion} : {}), ...(job.waitingReason ? {waitingReason: job.waitingReason} : {}), ...(job.error ? {error: publicFailure(job.error)} : {}), ...(job.result ? {result: safeNativeResult(job.result)} : {})}))}};
  }
  // Review 中-2: one catalog commit at a time per source. The replay, freshness and same-version checks run synchronously
  // against the state that is about to be replaced, right before the commit, so an older signed catalog can never land last.
  const sourceLocks = new Map();
  function withSourceLock(sourceId, run) { const next = (sourceLocks.get(sourceId) ?? Promise.resolve()).then(run), tail = next.catch(() => {}); sourceLocks.set(sourceId, tail); void tail.then(() => { if (sourceLocks.get(sourceId) === tail) sourceLocks.delete(sourceId); }); return next; }
  const officialScope = source => officialFingerprints.has(source?.keyFingerprint);
  // Review 中-1 and the @ai-buddy/ reservation: rules that do not depend on what this machine has seen before.
  function assertCatalogAllowed(catalog, source) {
    const minimum = minimumWatermarks[source.keyFingerprint];
    if (minimum && Date.parse(catalog.generatedAt) < Date.parse(minimum)) fail('This signed catalog (' + catalog.generatedAt + ') is older than the one this version of AI Buddy shipped with (' + minimum + ')', 'COMMUNITY_CATALOG_TOO_OLD');
    if (!officialScope(source) && catalog.works.some(work => String(work.packageName).startsWith(RESERVED_PACKAGE_SCOPE))) fail('Package names under ' + RESERVED_PACKAGE_SCOPE + ' are reserved for the official AI Buddy source', 'COMMUNITY_RESERVED_NAME');
  }
  function assertCatalogCurrent(catalog, sourceId) {
    const watermark = cache.sources[sourceId]?.watermark;
    if (watermark && (Date.parse(catalog.generatedAt) < Date.parse(watermark.generatedAt) || catalog.generatedAt === watermark.generatedAt && catalog.verified.payloadSha256 !== watermark.digest)) fail('Community index replay or equivocation', 'COMMUNITY_CATALOG_REPLAY');
    const previousCatalog = catalogs.get(sourceId);
    for (const work of catalog.works.filter(value => value.backend === 'dsh')) for (const release of work.releases) {
      const previousRelease = previousCatalog?.works.find(value => value.backend === work.backend && value.packageName === work.packageName)?.releases.find(value => value.version === release.version);
      if (previousRelease && communityDigest(previousRelease.package) !== communityDigest(release.package)) fail('An existing source/package version cannot silently change its package', 'COMMUNITY_RELEASE_CHANGED');
      const savedDigest = registry.releaseDigests[communityPackageKey({backend: 'dsh', sourceId, packageName: work.packageName}) + '@' + release.version];
      if (savedDigest && savedDigest !== release.package.sourceDigest) fail('Installed release identity was republished with different bytes', 'COMMUNITY_RELEASE_CHANGED');
    }
  }
  function reviewsFor(envelope, source, catalog, sourceId, {replay = true} = {}) {
    const index = verifyReviewIndex(envelope, source, catalog.id);
    if (index.reviews.some(review => !catalog.works.find(work => work.id === review.workId)?.releases.some(release => release.version === review.version))) fail('Review index refers to an unpublished work/version', 'COMMUNITY_REVIEW_VERSION_UNKNOWN');
    const prior = replay ? reviews.get(sourceId) : null;
    if (prior && (Date.parse(index.generatedAt) < Date.parse(prior.generatedAt) || index.generatedAt === prior.generatedAt && index.verified.payloadSha256 !== prior.verified.payloadSha256)) fail('Review index replay or equivocation', 'COMMUNITY_REVIEW_REPLAY');
    return index;
  }
  // recordError: false for offline files, so a refused file does not mark the valid catalog as stale (review 低-1).
  // reviewsOptional: the startup cache load keeps the catalog even when its saved review index no longer fits it (中-5).
  function loadCatalog(request, options = {}) { return withSourceLock(request.sourceId, () => loadCatalogLocked(request, options)); }
  async function loadCatalogLocked({sourceId, url, envelope, reviewUrl, reviewEnvelope}, {persist = true, allowRemoved = false, recordError = true, reviewsOptional = false, expectedSource} = {}) {
    if (closed) fail('Community is closed', 'COMMUNITY_CLOSED');
    const source = allowRemoved ? await trustedSource(sourceId) : await availableSource(sourceId), verifiedSource = allowRemoved ? {...source, enabled: true, removed: false} : source, controller = new AbortController();
    if (expectedSource && !sameSource(source, expectedSource)) fail('Community source changed before metadata loading', 'COMMUNITY_SOURCE_CHANGED');
    metadataRequests.set(controller, {sourceId, source});
    const recheck = async () => { if (closed) fail('Community is closed', 'COMMUNITY_CLOSED'); const current = allowRemoved ? await trustedSource(sourceId) : await availableSource(sourceId); if (!sameSource(current, source)) fail('Community source changed during metadata loading', 'COMMUNITY_SOURCE_CHANGED'); };
    try {
      await recheck();
      const incoming = envelope ?? await fetchPluginJson(communityHttps(url), {fetchImpl, signal: controller.signal, maximum: 16 * 1024 * 1024 + 20000});
      await recheck();
      const catalog = verifyCommunityCatalog(incoming, verifiedSource), prior = cache.sources[sourceId];
      assertCatalogAllowed(catalog, verifiedSource);
      const receivedReviews = reviewEnvelope ?? (reviewUrl ? await fetchPluginJson(communityHttps(reviewUrl), {fetchImpl, signal: controller.signal, maximum: 16 * 1024 * 1024 + 20000}) : null);
      await recheck();
      // From here to the commit there is no await: these checks see exactly the state they replace.
      assertCatalogCurrent(catalog, sourceId);
      // Local maintenance catalogs must not replace public discovery or advance its replay watermark.
      // Startup may still read an older cached catalog without persisting it.
      if (persist && sourceId === 'official' && officialScope(verifiedSource) && catalog.works.some(work => work.releases.some(release => release.package?.spec?.kind === 'tarball' && !publicWebUrl(release.package.spec.value)?.startsWith('https://')))) fail('Official discovery catalogs require public HTTPS tarball URLs; use a custom source for local maintenance packages', 'COMMUNITY_OFFICIAL_LOCAL_CATALOG');
      let reviewIndex = null, reviewSaved = null;
      if (receivedReviews) { try { reviewIndex = reviewsFor(receivedReviews, verifiedSource, catalog, sourceId); reviewSaved = receivedReviews; } catch (cause) { if (!reviewsOptional) throw cause; } }
      else if (prior?.reviewEnvelope) { try { reviewIndex = reviewsFor(prior.reviewEnvelope, verifiedSource, catalog, sourceId, {replay: false}); reviewSaved = prior.reviewEnvelope; } catch {} }
      catalogs.set(sourceId, catalog); if (reviewIndex) reviews.set(sourceId, reviewIndex); else reviews.delete(sourceId); errors.delete(sourceId);
      if (persist) { cache.sources[sourceId] = {url: url ?? prior?.url ?? null, reviewUrl: reviewUrl ?? prior?.reviewUrl ?? null, envelope: incoming, reviewEnvelope: reviewSaved, cachedAt: new Date(now()).toISOString(), watermark: {generatedAt: catalog.generatedAt, digest: catalog.verified.payloadSha256}}; persistCache(); }
      update(); return snapshot();
    } catch (cause) { if (recordError && !(envelope && cause.code === 'COMMUNITY_OFFICIAL_LOCAL_CATALOG')) { errors.set(sourceId, publicFailure(cause)); update(); } throw cause; }
    finally { metadataRequests.delete(controller); }
  }
  // Opening the center discovers the fixed official endpoint once per source generation. Explicit refresh can retry.
  // Metadata is single-flight; status/search and the maintenance timer never enter this path.
  async function refreshCatalogSource(sourceId) {
    try {
      const source = await availableSource(sourceId), saved = cache.sources[sourceId], official = isOfficialCommunitySource(source), url = official ? OFFICIAL_COMMUNITY_CATALOG_URL : saved?.url, reviewUrl = official ? null : saved?.reviewUrl;
      if (!url) fail('No deployed community index URL is configured', 'COMMUNITY_REMOTE_NOT_CONFIGURED');
      const key = communityDigest({source, url, reviewUrl: reviewUrl ?? null}), prior = refreshFlights.get(sourceId);
      if (prior?.key === key) return prior.promise;
      const promise = loadCatalog({sourceId, url, reviewUrl}, {expectedSource: source}).then(() => ({sourceId, ok: true}), cause => ({sourceId, error: publicFailure(cause)})), flight = {key, promise};
      refreshFlights.set(sourceId, flight);
      try { return await promise; } finally { if (refreshFlights.get(sourceId) === flight) refreshFlights.delete(sourceId); }
    } catch (cause) { return {sourceId, error: publicFailure(cause)}; }
  }
  async function refreshCatalogs(request = {}) {
    const selected = new Set(request.sourceId ? [request.sourceId] : Object.keys(cache.sources));
    if (!request.sourceId) try { if (isOfficialCommunitySource(await trustedSource('official'))) selected.add('official'); } catch {}
    const results = await Promise.all([...selected].map(refreshCatalogSource)); return {results, snapshot: snapshot()};
  }
  async function openCatalogs() {
    let source; try { source = await trustedSource('official'); } catch { return {results: [], snapshot: snapshot()}; }
    if (!isOfficialCommunitySource(source)) return {results: [], snapshot: snapshot()};
    const key = communityDigest(source);
    if (officialOpening?.key === key && officialOpening.done) return {results: [], snapshot: snapshot()};
    if (officialOpening?.key !== key) officialOpening = {key, promise: refreshCatalogs({sourceId: 'official'}), done: false};
    const opening = officialOpening, result = await opening.promise; opening.done = true; return {...result, snapshot: snapshot()};
  }
  async function list(request) {
    const sourceId = request.sourceId, all = allWorks().filter(work => (!sourceId || work.sourceId === sourceId) && (!request.authorId || work.authorId === request.authorId));
    let ranked = all.flatMap(work => { const aggregate = aggregateReviews(reviews.get(work.sourceId), [work.id]); return rankCommunityWorks([work], {ratings: aggregate, now: now()}); });
    // Normalize downloads across the visible catalog rather than each card.
    const maxDownload = Math.max(1, ...all.map(work => work.statistics?.downloadCount90d ?? 0));
    ranked = ranked.map(work => { const component = work.recommendation.components; if (component.downloads !== null) component.downloads = Math.log1p(work.statistics.downloadCount90d) / Math.log1p(maxDownload); const weighted = Object.entries(component).filter(([, value]) => value !== null); const weights = {rating: .65, downloads: .25, recency: .10}; work.recommendation.score = weighted.reduce((sum, [key, value]) => sum + weights[key] * value, 0) / weighted.reduce((sum, [key]) => sum + weights[key], 0); return work; });
    const needle = String(request.query ?? '').trim().toLowerCase();
    ranked = ranked.filter(work => (!request.category || work.category === request.category) && (!needle || [work.name, work.description, work.packageName, ...(work.tags ?? [])].join(' ').toLowerCase().includes(needle)) && (!request.favoritesOnly || preferences.favorites.includes(work.key)));
    // 五星评价 (B1): the smoothed GitHub star rating, highest first; works nobody rated yet come last, never with an invented score.
    const stars = work => work.rating.smoothed ?? -1;
    ranked.sort(request.sort === 'new' ? (a, b) => Date.parse(currentRelease(b).publishedAt) - Date.parse(currentRelease(a).publishedAt) || a.key.localeCompare(b.key) : request.sort === 'stars' ? (a, b) => stars(b) - stars(a) || b.rating.count - a.rating.count || a.key.localeCompare(b.key) : (a, b) => b.recommendation.score - a.recommendation.score || a.key.localeCompare(b.key));
    const page = Math.max(1, Math.floor(Number(request.page) || 1)), pageSize = Math.max(1, Math.min(50, Math.floor(Number(request.pageSize) || 24)));
    return {items: ranked.slice((page - 1) * pageSize, page * pageSize).map(work => { const key = communityPackageKey({backend: work.backend, sourceId: work.sourceId, packageName: work.packageName}); const author = catalogs.get(work.sourceId)?.authors.find(value => value.id === work.authorId); return {...work, authorName: author?.name ?? null, authorLogin: author?.githubLogin ?? null, favorite: preferences.favorites.includes(work.key), ...(work.category === 'voice' ? {installable: voiceWorkSupported(work)} : {}), stale: errors.has(work.sourceId), installed: work.backend === 'dsh' ? publicInstallation(registry.packages[key], runtimeVerified.has(key)) : null}; }), total: ranked.length, page, pageSize, sources: sourceRows()};
  }
  function voiceWorkSupported(work) {
    return voiceEnabled && isVoiceCommunityWork(work) &&
      isVoiceSourceAuthorized(work.sourceId,catalogs.get(work.sourceId)?.verified.keyFingerprint,voiceTestFingerprint);
  }
  async function installationIntent(request) {
    const work = workFor(request.sourceId, request.id), release = currentRelease(work, request.version);
    if ((work.status ?? 'published') !== 'published' || !(['function', 'work-engine'].includes(work.category) || voiceWorkSupported(work))) fail('This work is withdrawn or its category has no install backend', 'COMMUNITY_INSTALL_UNAVAILABLE');
    if (work.backend === 'buddy-v1') return legacyManager.action({action: 'plan', sourceId: work.sourceId, requests: [{id: work.packageName, version: release.version}]});
    const parsedRef = parseDshPackageRef(release.package, {sourceId: work.sourceId}), packageRef = {...parsedRef, hostPluginId: pluginIdentity(parsedRef)}, packageKey = communityPackageKey(packageRef), installed = registry.packages[packageKey];
    if (request.updateFrom !== undefined && (installed?.exactVersion !== request.updateFrom || packageRef.sourceDigest !== request.updateDigest || compareVersions(packageRef.exactVersion, request.updateFrom) <= 0))
      fail('Plugin update changed; check updates again', 'PLUGIN_UPDATE_CHANGED');
    const unsupportedCapabilities = packageRef.capabilities.filter(capability => !BUDDY_PLUGIN_CAPABILITIES.includes(capability)); if (unsupportedCapabilities.length) fail('This Buddy bridge does not implement: ' + unsupportedCapabilities.join(', '), 'PLUGIN_CAPABILITY_UNSUPPORTED');
    if (Object.values(registry.packages).some(record => record.packageName === packageRef.packageName && record.sourceId !== packageRef.sourceId)) fail('This DSH package is already installed from another source; explicitly uninstall it first. Data is retained.', 'PLUGIN_SOURCE_CONFLICT');
    const savedDigest = registry.releaseDigests[packageKey + '@' + packageRef.exactVersion]; if (savedDigest && savedDigest !== packageRef.sourceDigest) fail('Same source/version cannot replace installed content', 'COMMUNITY_RELEASE_CHANGED');
    const source = await trustedSource(work.sourceId); if (!source.enabled || source.removed) fail('Source is disabled', 'PLUGIN_SOURCE_DISABLED');
    const appVersion = legacyManager.snapshot().appVersion;
    if (!appVersion || !satisfiesHostVersionRange(appVersion, packageRef.compatibility.app) || !satisfiesVersionRange(bridgeCompatibilityVersion, packageRef.compatibility.bridge)) fail('Plugin is incompatible with this app or Buddy bridge version', 'PLUGIN_INCOMPATIBLE');
    const value={schemaVersion:1,operation:'install',workId:work.id,packageKey,packageRef,catalogDigest:work.catalogDigest,sourceFingerprint:source.keyFingerprint,sourceGeneration:source.generation,declaredCapabilities:packageRef.capabilities,priorGrantedCapabilities:installed?.grantedCapabilities??[],priorEnabled:installed?.enabled===true,priorDataSchemaVersion:installed?.dataSchemaVersion??null,expectedInstalled:installed?communityDigest(installed):null,...(request.updateFrom!==undefined?{updateFrom:request.updateFrom}:{}),profileId:request.profileId??'buddy-community-v1',createdAt:new Date(now()).toISOString()};
    return value;
  }
  async function assertInstallationIntent(value){
    if(closed)fail('Community is closed','COMMUNITY_CLOSED');const source=await availableSource(value.packageRef.sourceId),installed=registry.packages[value.packageKey];
    if(source.keyFingerprint!==value.sourceFingerprint||source.generation!==value.sourceGeneration)fail('Pinned source changed; review the plan again','PLUGIN_SOURCE_CHANGED');
    if((installed?communityDigest(installed):null)!==value.expectedInstalled)fail('Installed package changed; review the plan again','COMMUNITY_INSTALLATION_CHANGED');
    const appVersion=legacyManager.snapshot().appVersion;if(!appVersion||!satisfiesHostVersionRange(appVersion,value.packageRef.compatibility.app)||!satisfiesVersionRange(bridgeCompatibilityVersion,value.packageRef.compatibility.bridge))fail('Plugin compatibility changed','PLUGIN_INCOMPATIBLE');
    if(value.operation==='install'){
      const work=workFor(value.packageRef.sourceId,value.workId),release=currentRelease(work,value.packageRef.exactVersion),ref=parseDshPackageRef(release.package,{sourceId:work.sourceId});
      if(work.catalogDigest!==value.catalogDigest||communityDigest({...ref,hostPluginId:pluginIdentity(ref)})!==communityDigest(value.packageRef)||(work.status??'published')!=='published')fail('Catalog or package changed; review the plan again','COMMUNITY_PLAN_CHANGED');
    }
  }
  function publicPlan(value){const offline=offlineArtifacts.get(value.packageRef.sourceDigest);return {...copy(omit(value,['backendPlan','hostDependencyToken'])),...(value.backendPlan?{backendPlan:safeNativeResult(value.backendPlan)}:{}),addedCapabilities:value.declaredCapabilities.filter(capability=>!value.priorGrantedCapabilities.includes(capability)),requiresExplicitEnable:true,packageBytes:[value.backendPlan?.sourceVerification?.bytes,offline?.bytes].find(bytes=>Number.isSafeInteger(bytes)&&bytes>0)??null,offline:!!offline};}
  async function nativeInstallPlan(value,{signal,check}={}){
    const checkpoint=async()=>{signal?.throwIfAborted();await assertInstallationIntent(value);if(check)await check();signal?.throwIfAborted();};
    await checkpoint();const runtime=await backends.invoke('dsh','probe');await checkpoint();nativeState=safeNativeResult(runtime);update();
    if(!runtime.ready)fail(runtime.message??'Prepare the verified DSH runtime component before installing this plugin',runtime.code??'DSH_RUNTIME_NOT_READY');
    if(!runtime.version||!satisfiesHostVersionRange(runtime.version,value.packageRef.compatibility.dsh))fail('Plugin is incompatible with this DSH runtime version','PLUGIN_INCOMPATIBLE');
    const offline=value.packageRef.spec.kind==='tarball'?offlineArtifacts.get(value.packageRef.sourceDigest):null;nativeState={...nativeState,phase:'checking-plugin'};update();let backendPlan;
    try{await checkpoint();backendPlan=await backends.invoke('dsh','planInstall',{packageRef:value.packageRef,profileId:value.profileId,...(signal?{signal}:{}),...(offline?{spec:offline.path}:{})});await checkpoint();}finally{nativeState={...nativeState,phase:'inspection-finished'};update();}
    await checkpoint();return {...value,backendPlan};
  }
  async function planInstall(request){
    let value=await installationIntent(request);if(!value?.packageRef)return value;
    if(hostDependencies&&value.packageRef.packageName==='@ai-buddy/bilibili-companion'){
      const prepared=await hostDependencies.plan(copy(value));await assertInstallationIntent(value);value={...value,hostPlanKind:'plugin-with-host-components',hostComponents:prepared.components,hostDependencyToken:prepared.token};
    }else value=await nativeInstallPlan(value);
    const planId=communityDigest(value);plans.set(planId,{...value,planId});while(plans.size>128)plans.delete(plans.keys().next().value);return publicPlan({...value,planId});
  }
  async function planEnable(request){
    const old=registry.packages[request.packageKey];if(!old||old.packageName!=='@ai-buddy/bilibili-companion'||!hostDependencies)fail('Host dependency plan is unavailable','PLUGIN_NOT_INSTALLED');
    const source=await availableSource(old.sourceId),value={schemaVersion:1,operation:'enable',packageKey:old.packageKey,packageRef:parseDshPackageRef(Object.fromEntries(Object.entries(old).filter(([key])=>['backend','packageName','exactVersion','sourceDigest','digestType','spec','compatibility','capabilities','dataSchemaVersion'].includes(key))),{sourceId:old.sourceId}),sourceFingerprint:source.keyFingerprint,sourceGeneration:source.generation,catalogDigest:old.sourceProof?.catalogDigest,expectedInstalled:communityDigest(old),expectedGeneration:old.generation,declaredCapabilities:old.declaredCapabilities,priorGrantedCapabilities:old.grantedCapabilities,priorEnabled:old.enabled===true,priorDataSchemaVersion:old.dataSchemaVersion,createdAt:new Date(now()).toISOString()};
    const prepared=await hostDependencies.plan(copy(value));await assertInstallationIntent(value);Object.assign(value,{hostPlanKind:'plugin-with-host-components',hostComponents:prepared.components,hostDependencyToken:prepared.token});const planId=communityDigest(value);plans.set(planId,{...value,planId});return publicPlan({...value,planId});
  }
  async function checkIntent(job) {
    const intent = job.intent, source = await trustedSource(intent.packageRef.sourceId);
    if (intent.updateMode === 'auto' && (preferences.updatePolicies[job.packageKey] !== 'auto' || !stablePatchUpdate(intent.updateFrom, intent.packageRef.exactVersion))) return {allowed: false, code: 'PLUGIN_AUTO_UPDATE_DISABLED', message: 'Automatic updates were turned off; review this update manually'};
    if (!['disable', 'uninstall'].includes(job.operation) && ((job.operation === 'install' || coldBiliActivation(job)) && (!source.enabled || source.removed) || source.keyFingerprint !== intent.sourceFingerprint || source.generation !== intent.sourceGeneration)) return {allowed: false, code: 'PLUGIN_SOURCE_CHANGED', message: 'Pinned source changed; review a new maintenance plan'};
    const current = catalogs.get(source.sourceId);
    if (job.operation === 'install' && current?.verified.payloadSha256 !== intent.catalogDigest) return {allowed: false, code: 'COMMUNITY_PLAN_CHANGED', message: 'Catalog changed; review a new installation plan'};
    if (intent.grantedCapabilities?.some(capability => !intent.packageRef.capabilities.includes(capability))) return {allowed: false, code: 'COMMUNITY_CAPABILITY_INVALID', message: 'Requested grant exceeds declaration'};
    const installed = registry.packages[job.packageKey];
    if(job.operation==='install'&&Object.hasOwn(intent,'expectedInstalled')&&(installed?communityDigest(installed):null)!==intent.expectedInstalled)return {allowed:false,code:'COMMUNITY_INSTALLATION_CHANGED',message:'Installed package changed; review a new plan'};
    if (job.operation !== 'install' && (!installed || installed.generation !== intent.expectedGeneration)) return {allowed: false, code: 'COMMUNITY_INSTALLATION_CHANGED', message: 'Installed package changed; retry the explicit action'};
    return true;
  }
  // One publication lane per plugin. Enabling waits for all older cleanup;
  // a failed cleanup stays a barrier until an explicit disabled-state retry.
  const packagePublications = new Map(), pendingPublications = new Set(), pendingInvalidations = new Set(); let runtimeInvalidationGeneration = 0;
  function throwCleanupFailures(results) { const failures = results.filter(row => row.status === 'rejected').map(row => row.reason); if (failures.length === 1) throw failures[0]; if (failures.length) throw Object.assign(new AggregateError(failures, 'Plugin runtime cleanup failed'), {code: 'COMMUNITY_RUNTIME_CLEANUP_FAILED'}); }
  function publishPackage(record) {
    const value = copy({...record, sourceProof: undefined, backendPlan: undefined}), key = value.pluginId ?? value.packageKey, previous = packagePublications.get(key);
    const publish = () => { if (value.enabled && (closed || registry.packages[value.packageKey]?.generation !== value.generation)) fail('Package changed before host activation', 'COMMUNITY_INSTALLATION_CHANGED'); return onPackageState(value); };
    let completion; if (previous) completion = (value.enabled ? previous : previous.catch(() => {})).then(publish); else try { completion = Promise.resolve(publish()); } catch (cause) { completion = Promise.reject(cause); }
    packagePublications.set(key, completion); pendingPublications.add(completion); const done = () => pendingPublications.delete(completion); completion.then(done, done); return completion;
  }
  function coldBiliActivation(job){
    const installed=registry.packages[job.packageKey],ref=job.intent.packageRef;
    return job.operation==='enable'&&installed?.enabled===true&&!runtimeVerified.has(job.packageKey)&&installed.packageName==='@ai-buddy/bilibili-companion'&&installed.sourceId==='official'&&officialFingerprints.has(job.intent.sourceFingerprint)&&installed.generation===job.intent.expectedGeneration&&installed.sourceDigest===ref.sourceDigest&&installed.exactVersion===ref.exactVersion&&installed.sourceProof?.sourceFingerprint===job.intent.sourceFingerprint;
  }
  async function restoreUpdate(job, old) {
    const source = await trustedSource(old.sourceId);
    if (source.removed || !source.enabled || source.keyFingerprint !== old.sourceProof?.sourceFingerprint || source.generation !== job.intent.sourceGeneration)
      fail('Cannot restore a changed publisher automatically', 'PLUGIN_SOURCE_CHANGED');
    const value = await backends.invoke('dsh', 'rollback', {...job.intent.packageRef, profileId: old.profileId}, {plan: old.backendPlan, enabled: false});
    requireNativeOutcome(value);
    if (old.enabled) {
      const enabled = await backends.invoke('dsh', 'enable', old);
      requireNativeOutcome(enabled);
      if (enabled?.enabled !== true) fail('Previous plugin could not be enabled', 'DSH_ENABLE_UNCONFIRMED');
    }
    const generation = Math.max(registry.generations[job.packageKey] ?? 0, old.generation) + 1;
    const restored = {...old, generation, phase: old.enabled ? 'loaded' : 'disabled'};
    delete restored.runtimeFailure;
    registry.generations[job.packageKey] = generation;
    registry.packages[job.packageKey] = restored;
    persistRegistry(); await publishPackage(restored);
    if (restored.enabled) runtimeVerified.add(job.packageKey); else runtimeVerified.delete(job.packageKey);
    update();
  }
  function requireNativeOutcome(result) {
    if (result?.ok === false || result?.success === false || ['failed', 'error'].includes(result?.state)) fail('DSH operation did not succeed: ' + (result?.error?.message ?? result?.state), 'DSH_OPERATION_FAILED');
  }
  async function executeOperation(job) {
    const intent = job.intent, key = job.packageKey, old = registry.packages[key];
    let result;
    const coordinated = job.operation === 'install' && !!old && !!intent.updateMode;
    const keepEnabled = coordinated && old.enabled && intent.priorDataSchemaVersion === intent.packageRef.dataSchemaVersion &&
      (intent.updateMode === 'review' || intent.grantedCapabilities.every(capability => intent.priorGrantedCapabilities.includes(capability)));
    if (coordinated && (!old.backendPlan || !backends.supports('dsh', 'rollback'))) fail('An exact verified previous version is needed for a safe update', 'DSH_ROLLBACK_PLAN_REQUIRED');
    if (job.operation === 'install') result = await backends.invoke('dsh', 'install', intent.backendPlan, {enabled: false, grantedCapabilities: intent.grantedCapabilities});
    else if (job.operation === 'rollback') { if (!old?.previous?.backendPlan) fail('No exact prior installation plan is available', 'DSH_ROLLBACK_PLAN_REQUIRED'); result = await backends.invoke('dsh', 'rollback', {...intent.packageRef, profileId: old.profileId}, {plan: old.previous.backendPlan, enabled: false}); }
    else result = await backends.invoke('dsh', job.operation, {...intent.packageRef, profileId: old?.profileId, generation: old?.generation});
    requireNativeOutcome(result);
    let finalCheck = await checkIntent(job);
    if (finalCheck === true && keepEnabled) {
      const generation = Math.max(registry.generations[key] ?? 0, old.generation) + 1;
      runtimeVerified.delete(key);
      await publishPackage({...old, enabled: false, generation, phase: 'updating'});
      finalCheck = await checkIntent(job);
      if (finalCheck === true) {
        const enabled = await backends.invoke('dsh', 'enable', intent.packageRef);
        requireNativeOutcome(enabled);
        if (enabled?.enabled !== true) fail('DSH did not confirm the updated plugin is enabled', 'DSH_ENABLE_UNCONFIRMED');
        result = {...result, enabled: true, loaded: enabled.loaded === true, phase: enabled.phase ?? 'loaded'};
        finalCheck = await checkIntent(job);
      }
    }
    if (finalCheck !== true) { if (old && !coordinated) { old.generation = Math.max(registry.generations[key] ?? 0, old.generation) + 1; registry.generations[key] = old.generation; runtimeVerified.delete(key); persistRegistry(); await publishPackage({...old, enabled: false, phase: 'source-changed'}); } fail('Source, policy or installation changed during native operation; inspect actual runtime', 'COMMUNITY_NATIVE_OUTCOME_REQUIRES_REVIEW'); }
    const generation = coldBiliActivation(job) ? old.generation : Math.max(old?.generation ?? 0, registry.generations[key] ?? 0) + 1; registry.generations[key] = generation;
    if (job.operation === 'uninstall') { runtimeVerified.delete(key); if (old) await publishPackage({...old, enabled: false, phase: 'uninstalled', generation}); delete registry.packages[key]; persistRegistry(); update(); return safeNativeResult(result); }
    const record = {...old, ...intent.packageRef, packageKey: key, pluginId: pluginIdentity(intent.packageRef), declaredCapabilities: intent.packageRef.capabilities, grantedCapabilities: intent.grantedCapabilities ?? old?.grantedCapabilities ?? [], generation, profileId: result?.profileId ?? old?.profileId ?? 'buddy-community-v1', enabled: job.operation === 'enable' ? result?.enabled === true : job.operation === 'install' ? keepEnabled : job.operation === 'disable' ? false : old?.enabled ?? false, phase: result?.phase ?? result?.state ?? (job.operation === 'install' ? 'installed' : job.operation === 'enable' ? 'enable-unconfirmed' : 'disabled'), nativeEvidence: safeNativeResult(result), updatedAt: new Date(now()).toISOString(), sourceProof: {catalogDigest: intent.catalogDigest ?? old?.sourceProof?.catalogDigest, sourceFingerprint: intent.sourceFingerprint}, backendPlan: intent.backendPlan ?? old?.backendPlan};
    if (job.operation === 'enable' && !record.enabled) fail('DSH did not confirm that the plugin is enabled', 'DSH_ENABLE_UNCONFIRMED');
    record.phase = record.enabled ? 'loaded' : job.operation === 'install' ? 'installed' : 'disabled'; delete record.runtimeFailure;
    if (job.operation === 'install') { record.previous = old ? {packageRef: omit(old, ['previous', 'backendPlan']), backendPlan: old.backendPlan, grantedCapabilities: old.grantedCapabilities} : null; record.grantedCapabilities = intent.grantedCapabilities; }
    if (job.operation === 'rollback' && old?.previous) { const target = old.previous; Object.assign(record, target.packageRef, {generation, backendPlan: target.backendPlan, previous: {packageRef: omit(old, ['previous', 'backendPlan']), backendPlan: old.backendPlan, grantedCapabilities: old.grantedCapabilities}, grantedCapabilities: target.grantedCapabilities, enabled: false}); }
    registry.packages[key] = record; registry.releaseDigests[key + '@' + record.exactVersion] = record.sourceDigest; persistRegistry(); await publishPackage(record); if (record.enabled) runtimeVerified.add(key); else runtimeVerified.delete(key); update();
    // The imported copy is only needed until its plan is installed (review 低-2); DSH keeps its own verified cache.
    if (job.operation === 'install' && offlineArtifacts.has(record.sourceDigest)) { const staged = offlineArtifacts.get(record.sourceDigest); offlineArtifacts.delete(record.sourceDigest); await rm(staged.path, {force: true}).catch(() => {}); }
    if (job.operation === 'install' && !coordinated && intent.priorEnabled && intent.priorDataSchemaVersion === record.dataSchemaVersion && record.grantedCapabilities.every(capability => intent.priorGrantedCapabilities.includes(capability))) await queueInstalled({packageKey: key, idempotencyKey: 'restore-enabled:' + job.id}, 'enable');
    return {...safeNativeResult(result), packageKey: key, generation};
  }
  async function execute(job) {
    // Queue admission can await a busy probe. Validate again before any native side effect.
    const decision = await checkIntent(job);
    if (closed) fail('Community is closed', 'COMMUNITY_CLOSED');
    if (decision !== true && decision?.allowed !== true) fail(decision?.message ?? 'Maintenance intent changed', decision?.code ?? 'MAINTENANCE_RECONFIRM_REQUIRED');
    const old = registry.packages[job.packageKey];
    try { return await executeOperation(job); }
    catch (cause) {
      if (cause.code === "DSH_ROLLBACK_PLAN_REQUIRED") throw cause;
      if (job.intent.updateMode && old?.backendPlan ) {
        let restored = false;
        try { await restoreUpdate(job, old); restored = true; }
        catch (rollbackCause) { cause = Object.assign(new AggregateError([cause, rollbackCause], 'Plugin update failed and the previous runtime could not be verified'), {code: 'PLUGIN_UPDATE_RECOVERY_REQUIRED'}); }
        if (restored) throw cause;
      }
      const record = job.intent.updateMode && old ? old : registry.packages[job.packageKey];
      if (record) { registry.packages[job.packageKey] = record; record.runtimeFailure = publicFailure(cause); record.phase = 'failed'; record.generation = Math.max(record.generation, registry.generations[job.packageKey] ?? 0) + 1; registry.generations[job.packageKey] = record.generation; runtimeVerified.delete(job.packageKey); persistRegistry(); await publishPackage({...record, enabled: false, phase: 'failed'}); update(); }
      throw cause;
    }
  }
  queue = await createMaintenanceQueue({directory: control, execute, revalidate: checkIntent, canStart: maintenanceAdmission, isBusy: async job => {
    if(closed||!maintenanceAdmission())return true;
    const cold=coldBiliActivation(job);
    if(cold){for(const prior of queue.snapshot().jobs){if(prior.id===job.id)break;if(prior.packageKey===job.packageKey&&['queued','running'].includes(prior.state))return true;}}
    return busy(job.packageKey,job.intent.packageRef,cold?registry.packages[job.packageKey].pluginId:null);
  }, now, onChange: update});
  async function queueInstall(request, updateMode) {
    const plan=plans.get(request.planId);if(!plan)fail('Installation plan is missing; prepare it again','COMMUNITY_PLAN_NOT_FOUND');
    const grantedCapabilities=request.grantedCapabilities??[];
    if(!Array.isArray(grantedCapabilities)||new Set(grantedCapabilities).size!==grantedCapabilities.length||grantedCapabilities.some(value=>!plan.declaredCapabilities.includes(value))||plan.operation==='enable'&&communityDigest([...grantedCapabilities].sort())!==communityDigest([...plan.priorGrantedCapabilities].sort()))fail('Capabilities must be an explicit subset of the displayed plan','COMMUNITY_CAPABILITY_INVALID');
    const enqueue = async actual => {
      await assertInstallationIntent(plan);
      const existing = queue.snapshot().jobs.find(job => job.operation === 'install' && job.packageKey === plan.packageKey && job.intent.packageRef.exactVersion === plan.packageRef.exactVersion && job.intent.packageRef.sourceDigest === plan.packageRef.sourceDigest && ['queued', 'running'].includes(job.state));
      if (updateMode && existing) return {job: publicJob(existing), snapshot: snapshot()};
      const job = await queue.enqueue({operation: plan.operation ?? 'install', packageKey: plan.packageKey, intent: {...actual, grantedCapabilities, ...(updateMode ? {updateMode} : {}), ...(plan.operation === 'enable' ? {expectedGeneration: plan.expectedGeneration} : {})}, idempotencyKey: plan.hostDependencyToken ? 'install:' + request.planId : request.idempotencyKey ?? 'install:' + request.planId});
      void queue.drain().catch(() => {});
      return {job: publicJob(job), snapshot: snapshot()};
    };
    if(plan.hostDependencyToken)return hostDependencies.run({token:plan.hostDependencyToken,planId:plan.planId,confirmation:communityDigest([...grantedCapabilities].sort()),assertCurrent:()=>assertInstallationIntent(plan),materialize:options=>plan.operation==='enable'?Promise.resolve(plan):nativeInstallPlan(plan,options),enqueue,cancelJob:async id=>publicJob(await queue.cancel(id))});
    return enqueue(plan);
  }
  async function queueInstalled(request, operation) {
    const old = registry.packages[request.packageKey]; if (!old) fail('DSH package is not installed', 'PLUGIN_NOT_INSTALLED');
    const source = await trustedSource(old.sourceId);
    const intent = {packageRef: parseDshPackageRef(Object.fromEntries(Object.entries(old).filter(([key]) => ['backend', 'packageName', 'exactVersion', 'sourceDigest', 'digestType', 'spec', 'compatibility', 'capabilities', 'dataSchemaVersion'].includes(key))), {sourceId: old.sourceId}), sourceFingerprint: source.keyFingerprint, sourceGeneration: source.generation, expectedGeneration: old.generation, grantedCapabilities: old.grantedCapabilities, catalogDigest: old.sourceProof?.catalogDigest};
    const existing = request.idempotencyKey ? null : queue.snapshot().jobs.find(job => job.operation === operation && job.packageKey === old.packageKey && job.intent.expectedGeneration === old.generation && ['queued', 'running'].includes(job.state));
    const job = existing ?? await queue.enqueue({operation, packageKey: old.packageKey, intent, idempotencyKey: request.idempotencyKey ?? operation + ':' + old.packageKey + ':' + old.generation + ':' + randomUUID()}); void queue.drain().catch(() => {}); return {job: publicJob(job), snapshot: snapshot()};
  }
  async function openClient(request) {
    const installed = registry.packages[request.packageKey]; if (!installed?.enabled) fail('Enable this plugin before opening its page', 'PLUGIN_DISABLED');
    if (typeof request.external !== 'undefined' && typeof request.external !== 'boolean') fail('Browser selection must be explicit', 'COMMUNITY_REQUEST_INVALID');
    if (typeof onOpenClient !== 'function') fail('Native client page host is unavailable', 'DSH_CLIENT_UNAVAILABLE');
    await activateInstalled(request.packageKey);
    const descriptor = await backends.invoke('dsh', 'openClient', installed); await onOpenClient(descriptor, {external: request.external === true});
    // authURL, management origin and tokens deliberately never cross renderer IPC.
    return {runtimeId: descriptor.runtimeId ?? null, profileId: descriptor.profileId ?? installed.profileId, state: descriptor.clientState ?? descriptor.state ?? 'opened'};
  }
  async function activateInstalled(packageKey) {
    const record = registry.packages[packageKey]; if (!record?.enabled) fail('Plugin is absent or disabled', 'PLUGIN_DISABLED');
    if (!runtimeVerified.has(packageKey)) { const pending = await queueInstalled({packageKey}, 'enable'); await queue.drain(); const job = queue.snapshot().jobs.find(value => value.id === pending.job.id); if (job?.state !== 'completed' || !runtimeVerified.has(packageKey)) fail(job?.error?.message ?? 'Plugin activation is queued behind active work', job?.error?.code ?? 'PLUGIN_BUSY'); }
    return publicInstallation(registry.packages[packageKey], true);
  }
  async function resolveDshInstalled(packageKey) {
    const record = registry.packages[packageKey]; if (!record) fail('DSH package is not installed', 'PLUGIN_NOT_INSTALLED');
    const source = await trustedSource(record.sourceId); if (source.keyFingerprint !== record.sourceProof?.sourceFingerprint) fail('Installed package source identity changed', 'PLUGIN_SOURCE_CHANGED');
    return copy(record);
  }
  async function confirmNativeActivation({packageKey, generation, sourceDigest}) {
    const record = registry.packages[packageKey]; if (!record?.enabled || record.generation !== generation || record.sourceDigest !== sourceDigest) fail('Installed package changed before isolated activation', 'COMMUNITY_INSTALLATION_CHANGED');
    delete record.runtimeFailure; record.phase = 'loaded'; runtimeVerified.add(packageKey); persistRegistry(); await publishPackage(record); update(); return publicInstallation(record, true);
  }
  async function invalidatePackageRuntime({packageKey, generation, phase = 'runtime-not-verified'}) {
    const record = registry.packages[packageKey]; if (!record || generation != null && record.generation !== generation) return;
    runtimeVerified.delete(packageKey); record.generation = Math.max(record.generation, registry.generations[packageKey] ?? 0) + 1; registry.generations[packageKey] = record.generation; persistRegistry(); await publishPackage({...record, enabled: false, phase}); update();
  }
  // Offline import (B6), in two steps (review 中-1): prepareDshOffline reads and verifies the file and returns what it holds and
  // the date of its signed catalog; nothing is stored until community-offline-confirm. Trust is the online one: the envelope must
  // be signed by a source that is already trusted (a file can never add or change a key) and pass the same freshness, reserved-name,
  // replay and same-version checks; every tarball must equal a signed release digest. A file whose catalog is not newer than the
  // one in use does not replace it: its packages are matched against the catalog in use instead.
  let pendingImport = null;
  async function trustedSourceFor(envelope) {
    const wanted = envelope?.payload?.source, ids = [...new Set([...(legacyManager.snapshot().sources ?? []).map(row => row?.sourceId), ...catalogs.keys(), ...Object.keys(cache.sources)])].filter(id => typeof id === 'string' && id !== 'legacy');
    for (const sourceId of ids) { let source; try { source = await trustedSource(sourceId); } catch { continue; } if (typeof wanted?.keyFingerprint === 'string' && source.keyFingerprint === wanted.keyFingerprint && source.descriptorId === wanted.descriptorId) return sourceId; }
    fail('This file is not signed by a source you trust', 'COMMUNITY_OFFLINE_UNTRUSTED');
  }
  function matchPackages(packages, works) {
    const releases = works.filter(work => work.backend === 'dsh').flatMap(work => work.releases.map(release => ({work, release}))), matched = [];
    for (const item of packages) {
      const found = releases.filter(({release}) => release.package.sourceDigest === item.sha256);
      if (!found.length) fail('A package in this file is not listed by a signed catalog', 'COMMUNITY_OFFLINE_UNSIGNED');
      if (found.some(({release}) => release.package.spec.kind !== 'tarball')) fail('Offline files are supported for signed tarball releases only', 'COMMUNITY_OFFLINE_SOURCE_KIND');
      matched.push(...found.map(value => ({...value, item})));
    }
    return matched;
  }
  // Synchronous on purpose: called inside the source lock right before anything is written.
  function offlineDecision(bundle, sourceId, source, verified) {
    const active = sourceId ? catalogs.get(sourceId) : null;
    let replace = false, kept = null;
    if (verified) {
      try { assertCatalogAllowed(verified, source); assertCatalogCurrent(verified, sourceId); replace = active?.verified.payloadSha256 !== verified.verified.payloadSha256; }
      catch (cause) { if (!active || !['COMMUNITY_CATALOG_REPLAY', 'COMMUNITY_CATALOG_TOO_OLD'].includes(cause.code)) throw cause; kept = cause.code; }
      if (!replace && !bundle.packages.length) fail('The catalog in this file is not newer than the one in use and it holds no packages', kept ?? 'COMMUNITY_CATALOG_REPLAY');
    }
    const works = replace ? verified.works.map(work => ({...work, sourceId, key: sourceId + ':' + work.id})) : sourceId ? allWorks().filter(work => work.sourceId === sourceId) : allWorks();
    return {replace, kept, matched: matchPackages(bundle.packages, works)};
  }
  const offlineWorks = matched => [...new Map(matched.map(({work, release}) => [work.key + '@' + release.version, {sourceId: work.sourceId, id: work.id, packageName: work.packageName, version: release.version}])).values()];
  async function importOfflineFile(file) {
    if (closed) fail('Community is closed', 'COMMUNITY_CLOSED');
    const path = resolve(String(file ?? '')), info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > OFFLINE_FILE_LIMIT) fail('Offline file size is invalid', 'COMMUNITY_OFFLINE_INVALID');
    const bundle = readOfflinePluginFile(await readFile(path)), sourceId = bundle.envelope ? await trustedSourceFor(bundle.envelope) : null;
    const source = sourceId ? await availableSource(sourceId) : null, verified = source ? verifyCommunityCatalog(bundle.envelope, source) : null, decision = offlineDecision(bundle, sourceId, source, verified);
    const generatedAt = verified?.generatedAt ?? null, activeGeneratedAt = sourceId ? catalogs.get(sourceId)?.generatedAt ?? null : null, ageDays = generatedAt ? Math.floor((now() - Date.parse(generatedAt)) / 86400000) : null;
    pendingImport = {id: randomUUID(), bundle, sourceId, verified, generation: source?.generation, keyFingerprint: source?.keyFingerprint, expiresAt: now() + 10 * 60000};
    return {importId: pendingImport.id, sourceId, generatedAt, activeGeneratedAt, ageDays, warnOld: ageDays != null && ageDays > OFFLINE_CATALOG_WARN_DAYS, replaceCatalog: decision.replace, keptReason: decision.kept, works: offlineWorks(decision.matched).map(work => ({...work, catalogGeneratedAt: decision.replace ? generatedAt : catalogs.get(work.sourceId)?.generatedAt ?? null}))};
  }
  async function confirmOfflineImport(request) {
    const pending = pendingImport; pendingImport = null;
    if (!pending || pending.id !== request.importId || pending.expiresAt < now()) fail('This import expired; choose the file again', 'COMMUNITY_OFFLINE_EXPIRED');
    const commit = async () => {
      const source = pending.sourceId ? await availableSource(pending.sourceId) : null;
      if (source && (source.generation !== pending.generation || source.keyFingerprint !== pending.keyFingerprint)) fail('Community source changed during the import', 'COMMUNITY_SOURCE_CHANGED');
      const decision = offlineDecision(pending.bundle, pending.sourceId, source, pending.verified), written = [];
      // Packages first, under content-addressed names, then the catalog: a failure removes what this import wrote (review 低-1).
      try {
        await mkdir(offlineDirectory, {recursive: true}); await assertPluginTreeNoLinks(offlineDirectory);
        for (const {item} of decision.matched) if (!offlineArtifacts.has(item.sha256) && !written.some(row => row.sha256 === item.sha256)) { const target = join(offlineDirectory, item.sha256 + '.tgz'); writeAtomic(target, item.bytes); written.push({sha256: item.sha256, target, bytes: item.bytes.length}); }
        if (decision.replace) await loadCatalogLocked({sourceId: pending.sourceId, envelope: pending.bundle.envelope}, {recordError: false});
      } catch (cause) { for (const row of written) await rm(row.target, {force: true}); throw cause; }
      for (const row of written) offlineArtifacts.set(row.sha256, {path: row.target, bytes: row.bytes});
      update();
      return {sourceId: pending.sourceId, catalogLoaded: decision.replace, works: offlineWorks(decision.matched), snapshot: snapshot()};
    };
    return pending.sourceId ? withSourceLock(pending.sourceId, commit) : commit();
  }
  async function findReview(request) {
    const draft = preferences.pendingReviews.find(value => value.id === request.draftId); if (!draft) fail('Review draft not found', 'COMMUNITY_REVIEW_NOT_FOUND');
    const work = allWorks().find(value => value.key === draft.key); if (!work?.reviewsRepository) fail('This work has no deployed review submission repository', 'COMMUNITY_REVIEW_NOT_CONFIGURED');
    // The draft id is in the prefilled issue title; identity, stars and text still come only from the GitHub API issue, as for a pasted link.
    const since = new Date(Date.parse(draft.createdAt) - 600000).toISOString(), marker = '#' + draft.id.slice(0, 8);
    const issues = await fetchPluginJson('https://api.github.com/repos/' + work.reviewsRepository + '/issues?labels=community-review&state=all&sort=created&direction=desc&per_page=100&since=' + encodeURIComponent(since), {fetchImpl, maximum: 8 * 1024 * 1024});
    const found = (Array.isArray(issues) ? issues : []).filter(issue => typeof issue?.title === 'string' && issue.title.trim().endsWith(marker) && Date.parse(issue.created_at) >= Date.parse(since)).map(issue => reviewFromGitHubIssue(issue, {repository: work.reviewsRepository, validWorkIds: [work.id]})).filter(Boolean);
    // Review 低-11: when several issues carry the tag, the user picks one; each is then checked like a pasted link.
    if (found.length !== 1) return found.length ? {status: 'ambiguous', candidates: found.slice(0, 10).map(review => ({url: review.url, githubLogin: review.githubLogin, stars: review.stars, createdAt: review.createdAt}))} : {status: 'not-found'};
    const review = found[0], shared = aggregateReviews(reviews.get(work.sourceId), [work.id])[work.id]?.reviews.some(value => value.issueId === review.issueId && value.updatedAt === review.updatedAt);
    return {status: shared ? 'indexed' : 'submitted-pending-sync', review};
  }
  async function action(request = {}) {
    if (closed) fail('Community is closed', 'COMMUNITY_CLOSED');
    if (request.action === 'community-update-summary') return copy(pluginUpdates.summary());
    await refreshSourceAvailability();
    if (closed) fail('Community is closed', 'COMMUNITY_CLOSED');
    const type = request.action;
    if (type === 'status') return snapshot();
    if (!String(type).startsWith('community-') && !String(type).startsWith('dsh-')) { const result = await legacyManager.action(request); if (String(type).startsWith('sources-')) { await refreshSourceAvailability(); update(); } return result?.service && result?.installed ? snapshot() : result; }
    switch (type) {
      case 'community-status': return snapshot();
      case 'community-load-catalog': return loadCatalog(request);
      case 'community-open': return openCatalogs();
      case 'community-refresh': return refreshCatalogs(request);
      case 'community-search': return list(request);
      case 'community-details': { const work = workFor(request.sourceId, request.id), catalog = catalogs.get(work.sourceId); return {work:work.category==='voice'?{...work,installable:voiceWorkSupported(work)}:work, author: catalog.authors.find(author => author.id === work.authorId), authorWorks: catalog.works.filter(value => value.authorId === work.authorId && (value.status ?? 'published') !== 'withdrawn').length, followed: preferences.follows.includes(work.sourceId + ':' + work.authorId), reviews: aggregateReviews(reviews.get(work.sourceId), [work.id])[work.id] ?? {count: 0, sum: 0, reviews: []}, updatePolicy: preferences.updatePolicies[communityPackageKey({backend: work.backend, sourceId: work.sourceId, packageName: work.packageName})] ?? 'manual'}; }
      case 'community-author': { await availableSource(request.sourceId); const catalog = catalogs.get(request.sourceId), author = catalog?.authors.find(value => value.id === request.id); if (!author) fail('Author not found', 'COMMUNITY_AUTHOR_NOT_FOUND'); return {author, followed: preferences.follows.includes(request.sourceId + ':' + author.id), works: (await list({sourceId: request.sourceId, authorId: author.id})).items}; }
      case 'community-favorite': case 'community-follow': return writePreferences(() => { const key = String(request.key), valid = type === 'community-favorite' ? allWorks().some(work => work.key === key) : [...catalogs].some(([sourceId, catalog]) => catalog.authors.some(author => sourceId + ':' + author.id === key)); if (!valid || typeof request.enabled !== 'boolean') fail('Invalid favorite/follow selection', 'COMMUNITY_REQUEST_INVALID'); const field = type === 'community-favorite' ? 'favorites' : 'follows'; preferences[field] = request.enabled ? [...new Set([...preferences[field], key])] : preferences[field].filter(value => value !== key); return {enabled: request.enabled}; });
      case 'community-export-preferences': return {schemaVersion: 1, favorites: copy(preferences.favorites), follows: copy(preferences.follows)};
      case 'community-import-preferences': return writePreferences(() => { const value = request.value; if (value?.schemaVersion !== 1 || !Array.isArray(value.favorites) || !Array.isArray(value.follows) || [...value.favorites, ...value.follows].some(key => typeof key !== 'string' || key.length > 800 || !/^[^\s:]{1,200}:\S{1,500}$/.test(key)) || value.favorites.length + value.follows.length > 20000) fail('Invalid preference import', 'COMMUNITY_REQUEST_INVALID'); const favorites = [...new Set([...preferences.favorites, ...value.favorites])], follows = [...new Set([...preferences.follows, ...value.follows])]; if (favorites.length + follows.length > 20000) fail('Favourites and follows would exceed 20000 entries', 'COMMUNITY_REQUEST_INVALID'); preferences.favorites = favorites; preferences.follows = follows; return {imported: true}; });
      case 'community-set-update-policy': return writePreferences(() => {
        const installed = Object.entries(legacyManager.snapshot().installed ?? {}).some(([id, row]) => legacyUpdateKey(row.sourceId ?? 'legacy', id) === request.packageKey);
        if (!['manual', 'auto'].includes(request.policy) || (!registry.packages[request.packageKey] && !installed)) fail('Invalid update policy', 'COMMUNITY_REQUEST_INVALID');
        preferences.updatePolicies[request.packageKey] = request.policy;
        pluginUpdates.setPolicy(request.packageKey, request.policy);
        return {policy: request.policy};
      });
      case 'community-check-updates': return pluginUpdates.check({refresh: request.refresh === true});
      case 'community-update-all': return pluginUpdates.run('manual');
      case 'community-plan-update': {
        assertAdmission();
        const row = pluginUpdates.pinned(request, 'buddy-v1');
        return legacyManager.action({action: 'plan-update', ...row, mode: 'review'});
      }
      case 'community-install-update': {
        assertAdmission();
        const row = pluginUpdates.pinned(request, 'buddy-v1');
        legacyUpdateWrites++;
        try {
          const result = await legacyManager.action({action: 'install-update', planId: request.planId, packageKey: row.packageKey, digest: row.digest});
          await pluginUpdates.rememberFailure(row, null);
          return result;
        } catch (cause) {
          if (cause.code !== 'PLUGIN_BUSY') await pluginUpdates.rememberFailure(row, cause);
          throw cause;
        } finally { legacyUpdateWrites--; }
      }
      case 'community-find-review': return findReview(request);
      case 'community-offline-confirm': return confirmOfflineImport(request);
      case 'community-offline-cancel': if (pendingImport?.id === request.importId) pendingImport = null; return {cancelled: true};
      case 'community-run-maintenance': await queue.drain(); return snapshot().maintenance;
      case 'community-cancel-maintenance': return publicJob(await queue.cancel(request.id));
      case 'community-review-draft': return writePreferences(() => { const work = workFor(request.sourceId, request.id), release = currentRelease(work, request.version); if (!work.reviewsRepository) fail('This work has no deployed review submission repository', 'COMMUNITY_REVIEW_NOT_CONFIGURED'); const id = randomUUID(), url = buildReviewFormUrl({repository: work.reviewsRepository, workId: work.id, version: release.version, stars: request.stars, text: request.text ?? '', marker: id.slice(0, 8)}), draft = {id, key: work.key, version: release.version, stars: request.stars, url, status: 'pending-sync', createdAt: new Date(now()).toISOString()}; preferences.pendingReviews.push(draft); return {draft, url, status: 'pending-sync'}; });
      case 'community-open-link': { const work = workFor(request.sourceId, request.id), author = catalogs.get(work.sourceId).authors.find(value => value.id === work.authorId), url = request.kind === 'discussion' ? work.discussionUrl : request.kind === 'repository' ? work.repositoryUrl : request.kind === 'author' ? author?.url : null; if (!url) fail('This work has no link for that action', 'COMMUNITY_LINK_UNAVAILABLE'); if (typeof onOpenExternal !== 'function') fail('Browser link host is unavailable', 'COMMUNITY_BROWSER_UNAVAILABLE'); await onOpenExternal(communityHttps(url)); return {opened: true}; }
      case 'community-open-readme-link': { const work = workFor(request.sourceId, request.id), raw = String(request.url ?? ''), text = [work.readme, work.locales?.en?.readme, work.description, work.locales?.en?.description].filter(Boolean).join('\n'), url = publicWebUrl(raw); if (!url || !raw || raw.length > 2048 || !text.includes(raw)) fail('This link is not part of the signed work page', 'COMMUNITY_LINK_UNAVAILABLE'); if (typeof onOpenExternal !== 'function') fail('Browser link host is unavailable', 'COMMUNITY_BROWSER_UNAVAILABLE'); await onOpenExternal(url); return {opened: true}; }
      case 'community-open-review': { const draft = preferences.pendingReviews.find(value => value.id === request.draftId); if (!draft?.url) fail('Review draft not found', 'COMMUNITY_REVIEW_NOT_FOUND'); const parsed = new URL(communityHttps(draft.url)); if (parsed.origin !== 'https://github.com' || !parsed.pathname.endsWith('/issues/new')) fail('Review draft URL is invalid', 'COMMUNITY_REVIEW_INVALID'); if (typeof onOpenExternal !== 'function') fail('Browser link host is unavailable', 'COMMUNITY_BROWSER_UNAVAILABLE'); await onOpenExternal(parsed.href); return {opened: true, status: 'pending-sync'}; }
      case 'community-check-review': { const work = workFor(request.sourceId, request.id), url = new URL(communityHttps(request.url)); if (url.origin !== 'https://github.com' || !new RegExp('^/' + work.reviewsRepository?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/issues/[1-9][0-9]*$').test(url.pathname)) fail('Review link belongs to another repository', 'COMMUNITY_REVIEW_INVALID'); const issue = await fetchPluginJson('https://api.github.com/repos/' + work.reviewsRepository + '/issues/' + url.pathname.split('/').at(-1), {fetchImpl}); const review = reviewFromGitHubIssue(issue, {repository: work.reviewsRepository, validWorkIds: [work.id]}); if (!review) fail('GitHub API did not confirm a valid rating', 'COMMUNITY_REVIEW_INVALID'); const shared = aggregateReviews(reviews.get(work.sourceId), [work.id])[work.id]?.reviews.some(value => value.issueId === review.issueId && value.updatedAt === review.updatedAt); return {status: shared ? 'indexed' : 'submitted-pending-sync', review}; }
      case 'dsh-probe': nativeState = safeNativeResult(await backends.invoke('dsh', 'probe')); update(); return copy(nativeState);
      case 'dsh-plan': return planInstall(request);
      case 'dsh-plan-enable': return planEnable(request);
      case 'dsh-install': {
        const plan = plans.get(request.planId);
        return queueInstall(request, plan?.updateFrom !== undefined ? 'review' : undefined);
      }
      case 'dsh-enable': {const old=registry.packages[request.packageKey];if(hostDependencies&&old?.packageName==='@ai-buddy/bilibili-companion'){const plan=await planEnable(request);if(plan.hostComponents.some(value=>!value.ready))return {dependencyPlan:plan};return queueInstall({planId:plan.planId,grantedCapabilities:plan.priorGrantedCapabilities});}return queueInstalled(request,'enable');}
      case 'dsh-disable': case 'dsh-rollback': case 'dsh-uninstall': return queueInstalled(request,type.slice(4));
      case 'dsh-open-client': return openClient(request);
      default: fail('Unknown community operation', 'COMMUNITY_UNKNOWN_ACTION');
    }
  }
  // Cache reading verifies signatures and pinned source identity; it does not spawn DSH.
  for (const [sourceId, saved] of Object.entries(cache.sources)) try { await loadCatalog({sourceId, envelope: saved.envelope, reviewEnvelope: saved.reviewEnvelope ?? undefined}, {persist: false, reviewsOptional: true}); } catch {}
  for (const record of Object.values(registry.packages)) { record.generation = Math.max(record.generation, registry.generations[record.packageKey] ?? 0) + 1; registry.generations[record.packageKey] = record.generation; await publishPackage({...record, enabled: false, phase: 'runtime-not-verified'}); }
  if (Object.keys(registry.packages).length) persistRegistry();
  function invalidateRuntime({phase = 'runtime-not-verified'} = {}) {
    const generation = ++runtimeInvalidationGeneration, cleanup = []; nativeState = {phase, state: 'not-running'}; runtimeVerified.clear();
    for (const record of Object.values(registry.packages)) { record.generation = Math.max(record.generation, registry.generations[record.packageKey] ?? 0) + 1; registry.generations[record.packageKey] = record.generation; cleanup.push(publishPackage({...record, enabled: false, phase})); }
    try { persistRegistry(); update(); } catch (cause) { cleanup.push(Promise.reject(cause)); }
    const completion = (async () => { try { throwCleanupFailures(await Promise.allSettled(cleanup)); } catch (cause) { if (generation === runtimeInvalidationGeneration) { nativeState = {phase: 'runtime-cleanup-failed', state: 'failed', error: publicFailure(cause)}; update(); } throw cause; } })();
    pendingInvalidations.add(completion); const done = () => pendingInvalidations.delete(completion); completion.then(done, done); return completion;
  }
  const offNativeEvents = dshBackend?.on?.('event', event => {
    if (closed) return;
    if (['runtime-exit', 'runtime-failed'].includes(event.kind)) return invalidateRuntime({phase: event.kind});
    if (event.kind === 'runtime-verification' || event.kind === 'install-state' || event.kind === 'platform-progress') { if (typeof event.phase === 'string' && nativeState.phase !== event.phase) { nativeState = {...nativeState, phase: event.phase}; update(); } }
    else if (event.kind === 'tools-changed' && nativeState.phase === 'verifying-component') { nativeState = {...nativeState, phase: 'checking-plugin'}; update(); }
  });
  if (pollMs > 0) {
    pluginUpdates.start();
    timer = setInterval(() => {
      if (!automaticWorkAllowed()) return;
      void queue.drain().catch(() => {});
      pluginUpdates.retryDeferred();
    }, pollMs);
    timer.unref?.();
  }
  function close() {
    if (closePromise) return closePromise; closed = true; clearInterval(timer); offNativeEvents?.(); for (const controller of metadataRequests.keys()) controller.abort(Object.assign(Error('Community is closed'), {code: 'COMMUNITY_CLOSED'}));
    closePromise = (async () => {
      await Promise.allSettled([...sourceLocks.values()]); await queue.close(); await pluginUpdates.close(); await prefSerial; await Promise.allSettled([...pendingInvalidations, ...pendingPublications]);
      const cleanup = []; for (const record of Object.values(registry.packages)) { record.generation = Math.max(record.generation, registry.generations[record.packageKey] ?? 0) + 1; registry.generations[record.packageKey] = record.generation; cleanup.push(publishPackage({...record, enabled: false, phase: 'closed'})); }
      try { if (Object.keys(registry.packages).length) persistRegistry(); } catch (cause) { cleanup.push(Promise.reject(cause)); }
      const results = await Promise.allSettled(cleanup), owned = []; if (backends.supports('dsh', 'close')) owned.push(Promise.resolve().then(() => backends.invoke('dsh', 'close'))); if (legacyManager.close) owned.push(Promise.resolve().then(() => legacyManager.close())); throwCleanupFailures([...results, ...await Promise.allSettled(owned)]);
    })(); return closePromise;
  }
  return {action, snapshot, close, activateInstalled, invalidateRuntime, resolveDshInstalled, confirmNativeActivation, invalidatePackageRuntime, drainMaintenance: queue.drain, runAutomaticUpdates: pluginUpdates.automatic, maintenanceBusy: () => legacyUpdateWrites > 0 || pluginUpdates.busy() || queue.isExecuting(), prepareDshOffline: importOfflineFile, prepareOffline: (...args) => legacyManager.prepareOffline(...args), resolveInstalled: (...args) => legacyManager.resolveInstalled(...args), resolveTrustedSource: trustedSource};
}
