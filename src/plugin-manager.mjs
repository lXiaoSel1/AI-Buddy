import {randomUUID, createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, rm, stat, statfs, open, readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve, join, relative, isAbsolute, sep} from 'node:path';
import {writeAtomic} from './atomic-write.mjs';
import {canonicalPluginJson, PLUGIN_API_VERSION, pluginId, parsePluginVersion, satisfiesVersionRange} from './plugin-manifest.mjs';
import {verifyPluginCatalog, resolvePluginInstallPlan, catalogPackages} from './plugin-catalog.mjs';
import {assertPluginTreeNoLinks, extractPluginArchive, inspectPluginArchive, verifyInstalledPlugin} from './plugin-archive.mjs';
import {PLUGIN_SOURCE_BACKEND, createPluginSourceManager} from './plugin-source-manager.mjs';
import {renamePluginPath as rename} from './plugin-files.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (message, code = 'PLUGIN_OPERATION_FAILED') => { throw Object.assign(Error(message), {code}); };
const json = async (file, fallback) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function fileHash(file) { const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('hex'); }

/** Official trusted packages only. No public catalog URL is assumed before publication. */
async function createLegacyPluginManager({root, dataRoot, appVersion, apiVersion = PLUGIN_API_VERSION, fetchImpl = globalThis.fetch,
  trustedKeys, catalogUrl = null, host = null, busy = async () => false, onUpdate = () => {}, withMaintenanceLock = null,
  startupRetryMs = null, startupRetryLimitMs = 120000,
  availableBytes = async path => { const s = await statfs(path); return Number(s.bavail) * Number(s.bsize); }} = {}) {
  root = resolve(root); dataRoot = resolve(dataRoot); parsePluginVersion(appVersion);
  const control = join(root, 'local', 'plugins'), dataDirectory = join(dataRoot, 'plugins');
  await assertPluginTreeNoLinks(control); await assertPluginTreeNoLinks(dataDirectory);
  const registryFile = join(control, 'registry.json'), catalogFile = join(control, 'catalog.json');
  let registry = await json(registryFile, {schemaVersion: 1, packages: {}}), catalog = null, catalogError = null, active = null, serial = Promise.resolve();
  if (registry.schemaVersion !== 1 || !registry.packages || Array.isArray(registry.packages)) fail('Extension registry is damaged; existing data is retained');
  let closing = false, closePromise = null, recoveryTimer = null, recoveryPromise = null, recoveryStarted = 0, packageGuard = async () => {};
  let service = {state: 'initializing', usable: false, retryable: false, lastError: null, attempt: 0, waitingSince: null};
  const catalogRequests = new Set();
  const plans = new Map(), offlineSelections = new Map();
  function under(path) { const target = resolve(control, path), rel = relative(control, target); if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) fail('Extension path escapes its root'); return target; }
  function snapshot() {
    return {schemaVersion: 1, appVersion, apiVersion, service: structuredClone(service), catalogAvailable: !!catalog, catalogGeneratedAt: catalog?.generatedAt ?? null, catalogError, operation: active ? {id: active.id, phase: active.phase, packageId: active.packageId, downloadedBytes: active.downloadedBytes, totalBytes: active.totalBytes} : null,
      packages: catalog ? catalogPackages(catalog, {appVersion, apiVersion}).map(item => ({...item, installed: !!registry.packages[item.manifest.id]?.versions[item.manifest.version], current: registry.packages[item.manifest.id]?.current === item.manifest.version, enabled: registry.packages[item.manifest.id]?.enabled ?? false})) : [],
      installed: structuredClone(registry.packages)};
  }
  function update() { try { onUpdate(snapshot()); } catch {} }
  function setService(state, values = {}) { service = {...service, state, usable: state === 'ready', retryable: state === 'waiting-installation' || state === 'failed', ...values}; update(); }
  function assertReady() { if (closing) fail('扩展服务已关闭', 'PLUGIN_CLOSED'); if (!service.usable) fail('扩展服务尚未就绪', 'PLUGIN_SERVICE_NOT_READY'); }
  async function persist(next) { await assertPluginTreeNoLinks(control); writeAtomic(registryFile, JSON.stringify(next)); registry = next; update(); }
  async function setCatalog(envelope, {persist: save = true} = {}) {
    const parsed = verifyPluginCatalog(envelope, {trustedKeys});
    if (catalog && Date.parse(parsed.generatedAt) < Date.parse(catalog.generatedAt)) fail('An older catalog cannot replace the verified cache', 'PLUGIN_CATALOG_ROLLBACK');
    if (save) {
      const encoded = typeof envelope === 'string' ? envelope : JSON.stringify(envelope);
      writeAtomic(join(control, 'catalogs', parsed.verified.payloadSha256 + '.json'), encoded);
      writeAtomic(catalogFile, encoded);
    }
    catalog = parsed; catalogError = null; plans.clear(); update(); return snapshot();
  }
  async function readState() {
    registry = await json(registryFile, {schemaVersion: 1, packages: {}});
    if (registry.schemaVersion !== 1 || !registry.packages || Array.isArray(registry.packages)) fail('Extension registry is damaged; existing data is retained');
    try { await setCatalog(await readFile(catalogFile, 'utf8'), {persist: false}); } catch (error) { if (error.code !== 'ENOENT') { catalog = null; catalogError = error.message; } }
  }
  async function loadCatalog(envelope) { assertReady(); return mutation(() => setCatalog(envelope)); }
  try { await setCatalog(await readFile(catalogFile, 'utf8'), {persist: false}); } catch (error) { if (error.code !== 'ENOENT') catalogError = error.message; }
  async function refreshCatalog() {
    assertReady();
    if (!catalogUrl) { catalogError = '官方扩展目录尚未配置；可导入已签名的离线包'; update(); return snapshot(); }
    if (new URL(catalogUrl).protocol !== 'https:') fail('Catalog requires HTTPS');
    const controller = new AbortController(); catalogRequests.add(controller);
    try {
      const response = await fetchImpl(catalogUrl, {signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])});
      if (!response.ok) fail('Catalog request failed: ' + response.status);
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 17 * 1024 * 1024) fail('Catalog exceeds size limit'); chunks.push(Buffer.from(chunk)); }
      return await loadCatalog(Buffer.concat(chunks).toString('utf8'));
    } catch (error) { if (!closing) { catalogError = error.message; update(); } return snapshot(); }
    finally { catalogRequests.delete(controller); }
  }
  async function plan(requests) {
    assertReady();
    if (!catalog) fail('No verified catalog is available');
    const installed = [];
    for (const [id, row] of Object.entries(registry.packages)) for (const [version, item] of Object.entries(row.versions)) try { await verifySaved(item); installed.push({id, version, sha256: item.archive.sha256}); } catch {}
    const value = resolvePluginInstallPlan(catalog, requests, {appVersion, apiVersion, installed}); await packageGuard(value.packages); plans.set(value.planId, value); return value;
  }
  async function lock(run) {
    const ownFile = join(control, 'mutation.lock');
    let own, shared;
    try {
      // Existing installer/DataImport use FileShare.None on this same file. An open
      // read/write handle participates in that Windows exclusion in both directions.
      await mkdir(join(root, 'local', 'installer'), {recursive: true});
      await assertPluginTreeNoLinks(join(root, 'local', 'installer'));
      shared = await open(join(root, 'local', 'installer', 'install.lock'), 'a+');
      const guarded = async () => {
        if (closing) fail('扩展服务已关闭', 'PLUGIN_CLOSED');
        await assertPluginTreeNoLinks(control); await assertPluginTreeNoLinks(dataDirectory);
        for (const part of ['', 'cache', 'staging', 'packages', 'transactions', 'catalogs']) await mkdir(join(control, part), {recursive: true});
        try { const old = await json(ownFile); if (!Number.isInteger(old.pid) || alive(old.pid)) fail('Another extension operation is active', 'PLUGIN_BUSY'); await rm(ownFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        own = await open(ownFile, 'wx'); await own.writeFile(JSON.stringify({pid: process.pid, at: Date.now()}));
        await readState();
        return run();
      };
      return await (withMaintenanceLock ? withMaintenanceLock(guarded) : guarded());
    } finally { try { if (own) { await own.close(); await rm(ownFile, {force: true}); } } finally { await shared?.close(); } }
  }
  function mutation(run, {recovery = false} = {}) { if (!recovery) assertReady(); const result = serial.then(() => { if (!recovery) assertReady(); return lock(run); }); serial = result.catch(() => {}); return result; }
  function checkAbort(signal) { if (signal.aborted) throw signal.reason ?? Object.assign(Error('Extension operation cancelled'), {name: 'AbortError'}); }
  function checkDependencies(manifest, state = registry) {
    for (const [id, range] of Object.entries(manifest.dependencies)) { const dependency = state.packages[id]; if (!dependency || !satisfiesVersionRange(dependency.current, range)) fail('Installed dependency is missing or incompatible: ' + id, 'PLUGIN_DEPENDENCY_ERROR'); }
  }
  async function verifySaved(item) {
    if (!/^[a-f0-9]{64}$/.test(item.catalogSha256 ?? '')) fail('Installed extension has no signed publication proof');
    const proof = verifyPluginCatalog(await readFile(join(control, 'catalogs', item.catalogSha256 + '.json'), 'utf8'), {trustedKeys});
    if (proof.verified.payloadSha256 !== item.catalogSha256 || !proof.packages.some(row => canonicalPluginJson(row.manifest) === canonicalPluginJson(item.manifest) && canonicalPluginJson(row.archive) === canonicalPluginJson(item.archive))) fail('Installed extension does not match its signed publication proof');
    return verifyInstalledPlugin(under(item.directory), item.manifest);
  }
  async function inUse(id) {
    function depends(candidate, target, seen = new Set()) {
      if (candidate === target) return true; if (seen.has(candidate)) return false; seen.add(candidate);
      const row = registry.packages[candidate], saved = row?.versions[row.current];
      return !!saved && Object.keys(saved.manifest.dependencies).some(dependency => depends(dependency, target, seen));
    }
    for (const candidate of Object.keys(registry.packages)) if (depends(candidate, id) && (await busy(candidate) || host?.isActive?.(candidate))) return true;
    return false;
  }
  async function download(item, signal) {
    const complete = join(control, 'cache', item.archive.sha256 + '.zip'), partial = complete + '.partial';
    try { if ((await stat(complete)).size === item.archive.bytes && await fileHash(complete) === item.archive.sha256) return complete; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let offset = 0; try { offset = (await stat(partial)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (offset > item.archive.bytes) { await rm(partial); offset = 0; }
    if (offset === item.archive.bytes) { if (await fileHash(partial) === item.archive.sha256) { await rename(partial, complete); return complete; } await rm(partial); offset = 0; }
    const response = await fetchImpl(item.archive.url, {headers: offset ? {Range: `bytes=${offset}-`} : {}, signal});
    if (response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      if (!range || Number(range[1]) !== offset || Number(range[2]) !== item.archive.bytes - 1 || Number(range[3]) !== item.archive.bytes) fail('Invalid download resume range');
    } else if (response.status === 200) offset = 0; else fail('Extension download failed: ' + response.status);
    const file = await open(partial, offset ? 'a' : 'w'); let count = offset;
    try {
      for await (const chunk of response.body) { checkAbort(signal); const bytes = Buffer.from(chunk); count += bytes.length; if (count > item.archive.bytes) fail('Download exceeds signed size'); await file.write(bytes); active.downloadedBytes = count; update(); }
      await file.sync();
    } finally { await file.close(); }
    if (count !== item.archive.bytes || await fileHash(partial) !== item.archive.sha256) { if (count === item.archive.bytes) await rm(partial, {force: true}); fail('Downloaded extension size or hash differs from signed metadata'); }
    await rename(partial, complete); return complete;
  }
  async function install({planId, offlineArchives = {}} = {}) {
    const selected = plans.get(planId); if (!selected) fail('Installation plan is missing or expired');
    return mutation(async () => {
      await packageGuard(selected.packages);
      const controller = new AbortController(), id = randomUUID(), stage = join(control, 'staging', id), journal = join(control, 'transactions', id + '.json');
      active = {id, phase: 'preparing', controller}; update();
      const next = structuredClone(registry), prepared = [];
      try {
        const required = selected.downloadBytes + selected.unpackedBytes + 16 * 1024 * 1024;
        if (await availableBytes(control) < required) fail('Insufficient space for extension installation', 'PLUGIN_DISK_SPACE');
        await mkdir(stage, {recursive: true}); writeAtomic(journal, JSON.stringify({id, phase: 'preparing', stage: relative(control, stage), planId}));
        for (const item of selected.packages) {
          checkAbort(controller.signal); active.packageId = item.manifest.id; active.totalBytes = item.archive.bytes;
          const previous = next.packages[item.manifest.id], saved = previous?.versions[item.manifest.version];
          const schema = await json(join(dataDirectory, item.manifest.id, '.schema.json'), null);
          if (schema && (schema.schemaVersion !== 1 || !Number.isSafeInteger(schema.dataSchemaVersion))) fail('Plugin data schema record is invalid; data was retained');
          const dataSchemaVersion = schema?.dataSchemaVersion ?? previous?.dataSchemaVersion ?? item.manifest.dataSchemaVersion;
          if (item.manifest.dataSchemaVersion !== dataSchemaVersion || !item.manifest.compatibleDataVersions.includes(dataSchemaVersion)) fail('Extension data requires an explicit migration; code was not switched', 'PLUGIN_DATA_MIGRATION_REQUIRED');
          if (saved && saved.archive.sha256 !== item.archive.sha256) fail('A published package version cannot be replaced by different content');
          if (item.reuse && saved) { await verifySaved(saved); prepared.push({item, saved}); continue; }
          active.phase = 'downloading'; update();
          const source = offlineArchives[item.manifest.id + '@' + item.manifest.version] ?? offlineArchives[item.manifest.id];
          const bytes = source ? Buffer.isBuffer(source) ? source : await readFile(source) : await readFile(await download(item, controller.signal));
          if (bytes.length !== item.archive.bytes || digest(bytes) !== item.archive.sha256) fail('Offline extension hash or size differs from signed metadata');
          const inspected = inspectPluginArchive(bytes, item.manifest);
          if (await availableBytes(control) < inspected.unpackedBytes + 4 * 1024 * 1024) fail('Insufficient space to extract extension', 'PLUGIN_DISK_SPACE');
          active.phase = 'extracting'; update();
          const staged = join(stage, item.manifest.id); await extractPluginArchive(bytes, staged, item.manifest, {signal: controller.signal});
          const directory = `packages/${item.manifest.id}/${item.manifest.version}-${item.archive.sha256.slice(0, 16)}`;
          prepared.push({item, staged, saved: {manifest: item.manifest, archive: item.archive, directory, catalogSha256: selected.catalogSha256, installedAt: new Date().toISOString()}});
        }
        for (const {item} of prepared) if (registry.packages[item.manifest.id]?.current !== item.manifest.version && await inUse(item.manifest.id)) fail('Extension is in use; stop its task before updating', 'PLUGIN_BUSY');
        await packageGuard(prepared.map(row => row.item)); checkAbort(controller.signal); active.phase = 'committing'; update();
        writeAtomic(journal, JSON.stringify({id, phase: 'prepared', stage: relative(control, stage), packages: prepared.map(({saved}) => saved.directory), planId}));
        for (const {item, staged, saved} of prepared) {
          const target = under(saved.directory);
          if (staged) { await mkdir(resolve(target, '..'), {recursive: true}); await assertPluginTreeNoLinks(target); try { await stat(target); await verifyInstalledPlugin(target, item.manifest); } catch (error) { if (error.code !== 'ENOENT') throw error; await rename(staged, target); } }
          const prior = next.packages[item.manifest.id];
          next.packages[item.manifest.id] = {versions: {...prior?.versions, [item.manifest.version]: saved}, current: item.manifest.version, previous: prior?.current && prior.current !== item.manifest.version ? prior.current : prior?.previous ?? null, enabled: prior?.enabled ?? false, dataSchemaVersion: prior?.dataSchemaVersion ?? item.manifest.dataSchemaVersion};
        }
        for (const row of Object.values(next.packages)) checkDependencies(row.versions[row.current].manifest, next);
        for (const {item} of prepared) { const location = join(dataDirectory, item.manifest.id); await assertPluginTreeNoLinks(location); await mkdir(location, {recursive: true}); const schemaFile = join(location, '.schema.json'); if (!await json(schemaFile, null)) writeAtomic(schemaFile, JSON.stringify({schemaVersion: 1, dataSchemaVersion: next.packages[item.manifest.id].dataSchemaVersion})); }
        await persist(next); plans.delete(planId);
        await rm(journal, {force: true}); return snapshot();
      } catch (error) { writeAtomic(journal, JSON.stringify({id, phase: 'failed', stage: relative(control, stage), planId, error: error.message})); throw error; }
      finally { await assertPluginTreeNoLinks(stage); await rm(stage, {recursive: true, force: true}); active = null; update(); }
    });
  }
  function recordFor(id) { pluginId(id); const row = registry.packages[id], saved = row?.versions[row.current]; if (!saved) fail('Extension is not installed'); return {row, saved}; }
  async function resolveInstalled(id, {requireEnabled = true} = {}) {
    assertReady();
    const {row, saved} = recordFor(id);
    if (requireEnabled && !row.enabled) fail('Extension is not enabled', 'PLUGIN_DISABLED');
    checkDependencies(saved.manifest); await verifySaved(saved);
    const schema = await json(join(dataDirectory, id, '.schema.json'), null);
    if (schema && !saved.manifest.compatibleDataVersions.includes(schema.dataSchemaVersion)) fail('Extension cannot read this profile data', 'PLUGIN_DATA_MIGRATION_REQUIRED');
    assertReady(); return {manifest: saved.manifest, directory: under(saved.directory), dataDirectory: join(dataDirectory, id), version: saved.manifest.version, archiveSha256: saved.archive.sha256};
  }
  async function enable(id) { return mutation(async () => { const {saved} = recordFor(id); checkDependencies(saved.manifest); await verifySaved(saved); const next = structuredClone(registry); next.packages[id].enabled = true; await persist(next); return snapshot(); }); }
  async function disable(id) { return mutation(async () => { recordFor(id); if (await busy(id)) fail('Stop the extension task before disabling', 'PLUGIN_BUSY'); await host?.stop?.(id); const next = structuredClone(registry); next.packages[id].enabled = false; await persist(next); return snapshot(); }); }
  async function activate(id, event, context = {}) { assertReady(); const {row, saved} = recordFor(id); if (!row.enabled) fail('Extension is disabled'); if (saved.manifest.kind !== 'plugin') return {assetOnly: true}; if (!host) fail('Extension host is unavailable'); checkDependencies(saved.manifest); await verifySaved(saved); for (const dependency of Object.keys(saved.manifest.dependencies)) { const dep = recordFor(dependency); await verifySaved(dep.saved); } assertReady(); await mkdir(join(dataDirectory, id), {recursive: true}); return host.activate({manifest: saved.manifest, directory: under(saved.directory), dataDirectory: join(dataDirectory, id), event, context}); }
  async function rollback(id) { return mutation(async () => { const {row} = recordFor(id); if (!row.previous || !row.versions[row.previous]) fail('No compatible previous extension version'); if (await inUse(id)) fail('Extension is in use', 'PLUGIN_BUSY'); const prior = row.versions[row.previous]; await verifySaved(prior); checkDependencies(prior.manifest); if (!prior.manifest.compatibleDataVersions.includes(row.dataSchemaVersion ?? 1)) fail('Previous extension cannot read the current data; personal data was retained', 'PLUGIN_DATA_MIGRATION_REQUIRED'); if (!catalogPackages({schemaVersion: 1, id: 'local-registry', generatedAt: new Date().toISOString(), packages: [{...prior, publishedAt: prior.installedAt}].map(({manifest, archive, publishedAt}) => ({manifest, archive, publishedAt}))}, {appVersion, apiVersion})[0].compatible) fail('Previous extension is incompatible'); const next = structuredClone(registry); next.packages[id].previous = row.current; next.packages[id].current = row.previous; for (const selected of Object.values(next.packages)) checkDependencies(selected.versions[selected.current].manifest, next); await persist(next); return snapshot(); }); }
  async function uninstall(id) { return mutation(async () => { const {row} = recordFor(id); for (const [other, value] of Object.entries(registry.packages)) if (other !== id && Object.hasOwn(value.versions[value.current].manifest.dependencies, id)) fail('Another installed package depends on this extension', 'PLUGIN_DEPENDENCY_ERROR'); if (await busy(id)) fail('Stop extension tasks before uninstalling', 'PLUGIN_BUSY'); await host?.stop?.(id); const next = structuredClone(registry); delete next.packages[id]; await persist(next); for (const saved of Object.values(row.versions)) { const path = under(saved.directory); await assertPluginTreeNoLinks(path); await rm(path, {recursive: true, force: true}); } return snapshot(); }); }
  async function importOffline({envelope, archives, requests}) { await loadCatalog(envelope); const selected = await plan(requests); for (const item of selected.packages) if (!item.reuse && !archives?.[item.manifest.id] && !archives?.[item.manifest.id + '@' + item.manifest.version]) fail('Offline bundle is missing dependency: ' + item.manifest.id); return install({planId: selected.planId, offlineArchives: archives}); }
  async function prepareOffline(directory, requests) {
    assertReady();
    directory = resolve(directory); await assertPluginTreeNoLinks(directory);
    await loadCatalog(await readFile(join(directory, 'catalog.json'), 'utf8'));
    const selected = await plan(requests ?? catalog.packages.filter(row => row.manifest.kind === 'plugin').map(row => ({id: row.manifest.id, version: row.manifest.version})));
    const archives = {};
    for (const item of selected.packages) if (!item.reuse) { const file = join(directory, 'packages', item.archive.sha256 + '.zip'); await assertPluginTreeNoLinks(file); if ((await stat(file)).size !== item.archive.bytes) fail('Offline dependency size differs: ' + item.manifest.id); archives[item.manifest.id + '@' + item.manifest.version] = file; }
    const selectionId = randomUUID(); offlineSelections.set(selectionId, {planId: selected.planId, archives}); return {selectionId, plan: selected};
  }
  async function installOffline({selectionId, planId}) { const selected = offlineSelections.get(selectionId); if (!selected || selected.planId !== planId) fail('Offline selection is missing or expired'); const result = await install({planId, offlineArchives: selected.archives}); offlineSelections.delete(selectionId); return result; }
  function cancel() { if (active?.phase === 'committing') return false; active?.controller.abort(Object.assign(Error('Extension operation cancelled'), {name: 'AbortError'})); return !!active; }
  function close() {
    if (closePromise) return closePromise;
    closing = true; clearTimeout(recoveryTimer); recoveryTimer = null; setService('closing'); cancel();
    for (const controller of catalogRequests) controller.abort(Object.assign(Error('扩展服务已关闭'), {code: 'PLUGIN_CLOSED'}));
    closePromise = (async () => { await serial; await host?.stopAll?.(); setService('closed'); })();
    return closePromise;
  }
  async function action(request = {}) {
    const {action: type, id} = request;
    if (type === 'status') return snapshot(); if (type === 'retry') { if (closing) fail('扩展服务已关闭', 'PLUGIN_CLOSED'); if (service.usable) return snapshot(); if (!recoveryPromise) { clearTimeout(recoveryTimer); recoveryTimer = null; recoveryStarted = Date.now(); service = {...service, attempt: 0, waitingSince: null}; await startRecovery(); } return snapshot(); } if (type === 'refresh') return refreshCatalog(); if (type === 'plan') return plan(request.requests);
    if (type === 'install') return install({planId: request.planId}); if (type === 'enable') return enable(id); if (type === 'disable') return disable(id);
    if (type === 'install-offline') return installOffline(request);
    if (type === 'rollback') return rollback(id); if (type === 'uninstall') return uninstall(id); if (type === 'cancel') return cancel();
    fail('Unsupported extension action');
  }
  async function recoverableTransactions() {
    let names; try { names = await readdir(join(control, 'transactions')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const found = [];
    for (const name of names) if (/^[a-f0-9-]{36}\.json$/.test(name)) {
      const file = join(control, 'transactions', name), tx = await json(file);
      if (tx.recovery || tx.stage !== 'staging/' + name.slice(0, -5) && tx.stage !== join('staging', name.slice(0, -5))) continue;
      const stage = under(tx.stage); await assertPluginTreeNoLinks(stage);
      try { const info = await stat(stage); if (!info.isDirectory()) fail('Extension recovery staging is not a directory'); found.push({file, tx, stage}); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return found;
  }
  function installationLocked(error) { return ['EBUSY', 'EACCES'].includes(error?.code) && /(?:^|[\\/])install\.lock$/i.test(error.path ?? ''); }
  function startRecovery() {
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () => {
      if (closing) return;
      try {
        if (!(await recoverableTransactions()).length) { if (!closing) setService('ready', {lastError: null, waitingSince: null}); return; }
        if (closing) return;
        service = {...service, attempt: service.attempt + 1};
        await mutation(async () => {
          if (closing) return;
          const controller = new AbortController(); active = {id: 'startup-recovery', phase: 'recovering', controller}; setService('recovering');
          try {
            // Rescan after the lock and reload, rather than trusting stale pre-lock paths.
            for (const {file, tx, stage} of await recoverableTransactions()) {
              checkAbort(controller.signal); await assertPluginTreeNoLinks(stage); await rm(stage, {recursive: true, force: true});
              writeAtomic(file, JSON.stringify({...tx, recovery: {state: 'complete', at: new Date().toISOString()}}));
            }
          } finally { active = null; }
        }, {recovery: true});
        if (!closing) setService('ready', {lastError: null, waitingSince: null});
      } catch (error) {
        if (closing) return;
        const lastError = {code: error.code ?? 'PLUGIN_STARTUP_FAILED', message: String(error.message).slice(0, 2000)};
        if (installationLocked(error) && Date.now() - recoveryStarted < startupRetryLimitMs) {
          const delay = startupRetryMs ?? [250, 500, 1000, 2000][Math.min(service.attempt - 1, 3)];
          setService('waiting-installation', {lastError, waitingSince: service.waitingSince ?? new Date(recoveryStarted).toISOString()});
          recoveryTimer = setTimeout(() => { recoveryTimer = null; void startRecovery(); }, Math.max(1, Math.min(delay, startupRetryLimitMs - (Date.now() - recoveryStarted))));
          recoveryTimer.unref?.();
        } else setService('failed', {lastError: installationLocked(error) ? {code: 'PLUGIN_INSTALLATION_WAIT_TIMEOUT', message: '安装仍未结束，请稍后重试扩展服务。'} : lastError});
      }
    })().finally(() => { recoveryPromise = null; });
    return recoveryPromise;
  }
  // Read-only startup is never blocked by the installer. Only interrupted,
  // transaction-owned staging recovery needs the shared installation lock.
  recoveryStarted = Date.now(); await startRecovery();
  return {snapshot, loadCatalog, refreshCatalog, plan, install, enable, disable, activate, resolveInstalled, rollback, uninstall, importOffline, prepareOffline, installOffline, cancel, close, action,
    [PLUGIN_SOURCE_BACKEND]: {mutation, fetchImpl, availableBytes, busy, host, setPackageGuard: value => { packageGuard = value; }}};
}

/** The legacy registry remains byte-compatible. New source trust and packages
 * share its proven transaction queue and installation lock, in separate files. */
export async function createPluginManager(options = {}) {
  let manager;
  const legacy = await createLegacyPluginManager({...options, onUpdate: value => {
    // Source proof validation can still be initializing after the legacy core
    // is ready. Do not advertise a ready service that cannot accept actions yet.
    if (!manager && value.service?.state === 'ready') return;
    try { options.onUpdate?.(manager ? manager.snapshot() : value); } catch {}
  }});
  try { manager = await createPluginSourceManager({legacy, root: resolve(options.root), dataRoot: resolve(options.dataRoot), appVersion: options.appVersion,
    apiVersion: options.apiVersion ?? PLUGIN_API_VERSION, onUpdate: options.onUpdate, now: options.now ?? Date.now}); }
  catch (error) { await legacy.close(); throw error; }
  try { options.onUpdate?.(manager.snapshot()); } catch {}
  return manager;
}
