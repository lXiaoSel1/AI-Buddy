import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {requestLocalControl} from '../src/local-control.mjs';

export const OFFICIAL_TARGETS = Object.freeze([
  {target: 'bilibili', id: 'ai-buddy.bilibili-companion', packageName: '@ai-buddy/bilibili-companion', version: '2.0.16', digest: '9d585ffc887f9a274cb7f321b514fb0b60b400a38665d5563d216f67fdc73336'},
  {target: 'qq', id: 'ai-buddy.qq-connect', packageName: '@ai-buddy/qq-connect', version: '2.0.10', digest: 'c58110307866f15a309bbb9ad2839e521ea61caf897bc7666e0353f582545a6d'},
  {target: 'card-games', id: 'ai-buddy.card-games', packageName: '@ai-buddy/card-games', version: '1.1.5', digest: '7f2c6dcfff0bd3a2e0ad602fea03c1361490914e4764821b374bdd59f7eb086d'},
].map(Object.freeze));
export const OFFICIAL_VOICE_TARGET = Object.freeze({id:'ai-buddy.voice-breeze',version:'1.0.3',digest:'f976545531cd72ac72dd58a7364c61dcb2e0cd4a52321dad8ebde91032f377d3',sharedId:'ai-buddy.voice-shared-runtime',sharedDigest:'2a649fc210a00f20b5000d82ac56ba8a6e383c71947bc899880a9307ac90c06e'});
export function requireVoicePlan(plan){
  const target=OFFICIAL_VOICE_TARGET,packages=plan?.packages;
  assert.ok(plan?.sourceId==='official'&&plan.planId&&hex(plan.catalogSha256)&&plan.keyFingerprint&&Array.isArray(packages),'Production voice catalog/plan identity is missing');
  const engine=packages.filter(row=>row.manifest?.id===target.id),shared=packages.filter(row=>row.manifest?.id===target.sharedId);
  assert.equal(engine.length,1,'Latest official Breeze package is missing');assert.equal(shared.length,1,'Exact shared voice package is missing');
  assert.equal(engine[0].manifest.version,target.version,'Voice plan did not select the latest supported version');
  assert.equal(engine[0].manifest.dependencies?.[target.sharedId],target.version,'Shared voice dependency is not exact');
  assert.equal(engine[0].archive.sha256,target.digest,'Voice archive differs from the public pin');
  assert.equal(shared[0].manifest.version,target.version);assert.equal(shared[0].archive.sha256,target.sharedDigest,'Shared voice archive differs from the public pin');
}
export function requireVoiceInstall(plan,installed){
  requireVoicePlan(plan);const target=OFFICIAL_VOICE_TARGET;
  assert.ok(installed?.installed===true&&installed.enabled===true&&installed.usable===true&&installed.state==='ready','Breeze was not installed and enabled through the production authority');
  assert.equal(installed.sourceId,'official');assert.equal(installed.id,target.id);assert.equal(installed.version,target.version);assert.equal(installed.archiveSha256,target.digest);
}
const CODE_FILES = ['package.json', 'main.cjs', 'preload.cjs', 'plugin-client-preload.cjs', 'dsh-network-bootstrap.mjs', 'dsh-platform/native-bridge-host.mjs', 'dsh-platform/inert-bootstrap.mjs', 'dsh-component-worker.mjs', 'ffmpeg-component-worker.mjs', 'work-archive-cursor-worker.mjs', 'voice-assets-worker.cjs', 'bili-full-media-worker.mjs', 'monitor-worker.cjs', 'plugin-maintenance.cjs', 'index.html'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const pipeName = value => String(value).replace(/^\\\\\.\\pipe\\/i, '');
const within = (root, path) => {const rel = relative(resolve(root), resolve(path)); return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);};
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const stableVersion = value => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value ?? '');
const compare = (a, b) => {const aa = a.split('.').map(Number), bb = b.split('.').map(Number); for (let n = 0; n < 3; n++) if (aa[n] !== bb[n]) return aa[n] > bb[n] ? 1 : -1; return 0;};
const dailyPath = path => /(?:^|[\\/])tools[\\/]whale-companion(?:[\\/]|$)/i.test(path);
async function projectedRealpath(path) {
  try {return await realpath(path);} catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path); assert.notEqual(parent, path, 'Cannot resolve isolated boundary');
    return join(await projectedRealpath(parent), path.slice(parent.length).replace(/^[\\/]+/, ''));
  }
}
async function isolatedPath(options, path, label) {
  assert.ok(typeof options.allowedRoot === 'string' && options.allowedRoot && dirname(options.allowedRoot) !== options.allowedRoot, 'An explicit non-volume --allowed-root is required');
  assert.ok(within(options.allowedRoot, path) && !dailyPath(path), label + ' leaves the allowed isolated root or is a daily installation');
  const allowed = await realpath(options.allowedRoot), actual = await projectedRealpath(resolve(path));
  assert.ok(within(allowed, actual) && !dailyPath(actual), label + ' escapes the allowed isolated root through a link');
  return actual;
}

export function parseGateArgs(argv) {
  const values = {}, allowed = new Set(['allowed-root', 'install-root', 'pipe', 'out', 'expected-version', 'cdp-port', 'expected-main-sha256', 'expected-data-root', 'mode', 'update-target', 'from-version', 'from-digest', 'timeout-ms', 'require-components-ready']);
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    assert.ok(match && allowed.has(match[1]), 'Unknown gate argument: ' + arg);
    assert.ok(!Object.hasOwn(values, match[1]), 'Duplicate gate argument: ' + match[1]);
    values[match[1]] = match[2] ?? 'true';
  }
  for (const key of ['allowed-root', 'install-root', 'pipe', 'out', 'expected-version', 'cdp-port', 'expected-main-sha256']) assert.ok(values[key] && values[key] !== 'true', 'Missing --' + key);
  assert.ok(stableVersion(values['expected-version']), 'Invalid --expected-version');
  assert.ok(hex(values['expected-main-sha256']), 'Invalid --expected-main-sha256');
  const port = Number(values['cdp-port']), timeoutMs = Number(values['timeout-ms'] ?? 600000);
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535, 'Invalid --cdp-port');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 1800000, 'Invalid --timeout-ms');
  assert.ok(/^[a-zA-Z0-9._-]{1,120}$/.test(pipeName(values.pipe)) && pipeName(values.pipe) !== 'whale-companion-v001', 'Use an explicit isolated --pipe');
  const mode = values.mode ?? 'install';
  assert.ok(['install', 'upgrade-plugin'].includes(mode), 'Unknown --mode');
  if (values['require-components-ready'] !== undefined) assert.ok(['true', 'false'].includes(values['require-components-ready']), 'Invalid --require-components-ready');
  if (mode === 'upgrade-plugin') {
    assert.ok(OFFICIAL_TARGETS.some(target => target.target === values['update-target']), 'Set an official --update-target');
    assert.ok(stableVersion(values['from-version']) && hex(values['from-digest']), 'Set independent --from-version and --from-digest');
  } else assert.ok(!values['update-target'] && !values['from-version'] && !values['from-digest'], 'Upgrade arguments require --mode=upgrade-plugin');
  const allowedRoot = resolve(values['allowed-root']), installRoot = resolve(values['install-root']), out = resolve(values.out);
  assert.ok(dirname(allowedRoot) !== allowedRoot && within(allowedRoot, installRoot) && within(allowedRoot, out), 'Install/evidence paths must stay within a non-volume --allowed-root');
  assert.ok(!dailyPath(installRoot) && !dailyPath(out), 'Daily installation paths are not validation fixtures');
  assert.ok(!within(installRoot, out), 'Evidence --out must be outside the installation');
  return {allowedRoot, installRoot, pipe: pipeName(values.pipe), out, expectedVersion: values['expected-version'], cdpPort: port, expectedMainSha256: values['expected-main-sha256'], expectedDataRoot: values['expected-data-root'] ? resolve(values['expected-data-root']) : null, mode, updateTarget: values['update-target'], fromVersion: values['from-version'], fromDigest: values['from-digest'], timeoutMs, requireComponentsReady: values['require-components-ready'] === 'true'};
}

export async function inspectCandidateIdentity(options, status) {
  await isolatedPath(options, options.installRoot, 'Installation');
  assert.ok(typeof status?.dataRoot === 'string' && status.dataRoot, 'Running data root identity is missing');
  await isolatedPath(options, status.dataRoot, 'Data directory');
  assert.equal(resolve(status?.root ?? ''), options.installRoot, 'Running installation root differs');
  assert.equal(status.version, options.expectedVersion, 'Running candidate version differs');
  assert.ok(Number.isSafeInteger(status.processId) && status.processId > 0, 'Running candidate process identity is missing');
  assert.ok(status.ready === true && status.onboarding === false && status.safeMode === false && status.startupFailure === null, 'Candidate startup is not ready');
  const recordPath = join(options.installRoot, 'local', 'installation.json'), recordBytes = await readFile(recordPath), record = JSON.parse(recordBytes);
  assert.equal(record.version, options.expectedVersion, 'Installed record version differs');
  assert.ok(typeof record.build === 'string' && !isAbsolute(record.build) && record.build.replaceAll('\\', '/').startsWith('builds/'), 'Missing installed build directory identity');
  const build = resolve(options.installRoot, record.build);
  assert.ok(within(options.installRoot, build) && resolve(status.build ?? '') === build, 'Running build differs from installed build');
  assert.equal(pipeName(record.pipe), pipeName(options.pipe), 'Installation pipe differs');
  assert.ok(hex(record.manifestSha256), 'Installed manifest SHA-256 identity is missing');
  const appHash = record.packageHashes?.['app-' + record.edition];
  assert.ok(hex(appHash), 'Installed application package SHA-256 identity is missing');
  const rootReal = await realpath(options.installRoot), buildReal = await realpath(build);
  assert.ok(within(rootReal, buildReal), 'Installed build resolves outside the installation');
  if (options.expectedDataRoot) assert.equal(resolve(status.dataRoot), options.expectedDataRoot, 'Running data root differs');
  else assert.ok(within(join(options.installRoot, 'local'), status.dataRoot ?? ''), 'Use --expected-data-root for explicitly isolated external data');
  const pkg = await json(join(build, 'package.json'));
  assert.equal(pkg.version, options.expectedVersion, 'Built package version differs');
  assert.equal(pkg.main, 'main.cjs', 'Candidate is not the built CJS application');
  const codeFiles = [];
  for (const name of CODE_FILES) {
    const file = join(build, name), info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink(), 'Missing independent built file: ' + name);
    const bytes = await readFile(file);
    codeFiles.push({path: name, bytes: bytes.length, sha256: sha(bytes)});
  }
  const mainSha256 = codeFiles.find(file => file.path === 'main.cjs').sha256;
  assert.equal(mainSha256, options.expectedMainSha256, 'Candidate main.cjs SHA-256 differs from independent pin');
  return {root: options.installRoot, build, dataRoot: resolve(status.dataRoot), version: status.version, processId: status.processId, installationRecordSha256: sha(recordBytes), manifestSha256: record.manifestSha256, appPackageSha256: appHash, packageHashes: record.packageHashes, mainSha256, codeFiles, codeDirectorySha256: sha(JSON.stringify(codeFiles))};
}

export function requireProcessBinding(result, processId) {
  assert.ok(result?.processInfo?.some(row => row.type === 'browser' && row.id === processId), 'CDP browser process differs from the named-pipe application process');
}
export function requirePluginPlan(plan, target, {requireComponentsReady = false} = {}) {
  const ref = plan?.packageRef;
  assert.equal(ref?.sourceId, 'official', 'Plugin plan lacks official source identity');
  assert.equal(ref.packageName, target.packageName, 'Plugin package name differs');
  assert.equal(ref.exactVersion, target.version, 'Plugin package version differs');
  assert.equal(ref.sourceDigest, target.digest, 'Plugin package digest differs from public pin');
  assert.equal(plan.packageKey, 'dsh:official:' + target.packageName, 'Plugin package key differs');
  assert.ok(typeof plan.planId === 'string' && plan.planId && typeof plan.sourceFingerprint === 'string' && plan.sourceFingerprint && hex(plan.catalogDigest), 'Signed catalog/plan identity is missing');
  assert.ok(Array.isArray(plan.declaredCapabilities), 'Plugin capability plan is missing');
  // Successful native plans already require DSH readiness; Bilibili adds its
  // own component plan while QQ and Card Games do not expose that field.
  if (requireComponentsReady && (target.target === 'bilibili' || plan.hostComponents !== undefined)) assert.ok(Array.isArray(plan.hostComponents) && plan.hostComponents.every(row => row.ready === true && row.downloadBytes === 0), 'Host component download required; preflight forbids downloads');
}
export function requireOldPlugin(record, target, {fromVersion, fromDigest}) {
  assert.ok(stableVersion(fromVersion) && compare(fromVersion, target.version) < 0, 'Upgrade requires a genuinely older version, not a same-version reinstall');
  assert.ok(record && record.sourceId === 'official' && record.packageName === target.packageName && record.exactVersion === fromVersion, 'Installed starting plugin version differs');
  assert.ok(hex(fromDigest) && record.sourceDigest === fromDigest, 'Installed starting plugin digest differs');
}
export function requireDocumentHandshake(document, target, previous) {
  assert.ok(document && typeof document.targetId === 'string' && document.targetId && Number.isFinite(document.timeOrigin), 'Actual plugin document identity/handshake is missing');
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(document.origin ?? '') && document.readyState === 'complete', 'Plugin document is not ready on its private origin');
  assert.ok(document.embedded === '1' && document.panel === target.packageName && document.openPlugin === target.packageName, 'Requested plugin panel document handshake is missing');
  if (previous) assert.ok(document.targetId !== previous.targetId || document.timeOrigin !== previous.timeOrigin, 'Restart must acknowledge a fresh plugin document');
}

async function cdp(url, method, params = {}, timeoutMs = 30000) {
  const endpoint = new URL(url);
  assert.ok(endpoint.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'CDP must be local');
  const socket = new WebSocket(url);
  try {
    return await new Promise((yes, no) => {
      let settled = false;
      const finish = (error, value) => {if (settled) return; settled = true; clearTimeout(timer); error ? no(error) : yes(value);};
      const timer = setTimeout(() => finish(Error('CDP deadline: ' + method)), timeoutMs);
      socket.onopen = () => socket.send(JSON.stringify({id: 1, method, params}));
      socket.onerror = () => finish(Error('CDP transport failed'));
      socket.onclose = () => finish(Error('CDP target closed'));
      socket.onmessage = event => {
        try {
          const row = JSON.parse(event.data); if (row.id !== 1) return;
          if (row.error || row.result?.exceptionDetails) finish(Error('CDP evaluation failed: ' + JSON.stringify(row.error ?? row.result.exceptionDetails)));
          else finish(null, row.result);
        } catch (error) {finish(error);}
      };
    });
  } finally {socket.close();}
}
const evaluate = async (page, expression, timeoutMs) => (await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, timeoutMs)).result?.value;

export async function validateInstalledPluginRuntime(options) {
  await isolatedPath(options, options.installRoot, 'Installation');
  await isolatedPath(options, options.out, 'Evidence output');
  await mkdir(dirname(options.out), {recursive: true});
  await mkdir(options.out);
  const evidence = {schemaVersion: 1, kind: 'installed-plugin-runtime-release-gate', scope: 'synthetic isolated validation only', passed: false, mode: options.mode, startedAt: new Date().toISOString(), allowedRoot: options.allowedRoot, installRoot: options.installRoot, expectedVersion: options.expectedVersion, pipe: options.pipe, cdpPort: options.cdpPort, requireComponentsReady: options.requireComponentsReady, appLifecycleOwner: 'caller', startsApplication: false, requestsModel: false, requestsAccountLogin: false, rows: [], events: []};
  const save = () => writeFile(join(options.out, 'RESULT.json'), JSON.stringify(evidence, null, 2) + '\n');
  const event = async (phase, detail = {}) => {evidence.events.push({at: new Date().toISOString(), phase, ...detail}); await save();};
  const call = (command, args = {}) => requestLocalControl('\\\\.\\pipe\\' + options.pipe, {command, ...args}, {timeoutMs: 30000});
  const localJson = async path => {const response = await fetch('http://127.0.0.1:' + options.cdpPort + path, {signal: AbortSignal.timeout(10000)}); assert.ok(response.ok, 'CDP endpoint is unavailable'); return response.json();};
  let action, embed, activeRow;
  try {
    evidence.identityBefore = await inspectCandidateIdentity(options, await call('installation-status'));
    const browser = await localJson('/json/version');
    evidence.cdpProcess = await cdp(browser.webSocketDebuggerUrl, 'SystemInfo.getProcessInfo');
    requireProcessBinding(evidence.cdpProcess, evidence.identityBefore.processId);
    const pages = await localJson('/json/list');
    const panel = pages.find(page => {try {const url = new URL(page.url); return page.type === 'page' && url.protocol === 'file:' && resolve(fileURLToPath(url)) === join(evidence.identityBefore.build, 'index.html');} catch {return false;}});
    assert.ok(panel, 'Existing candidate renderer is missing; caller must open it before running the gate');
    const renderer = await evaluate(panel, '(async()=>{const s=await whale.settings();return {version:s.version,build:s.build,dataRoot:s.dataRoot,plugins:typeof whale.plugins?.action,embed:typeof whale.plugins?.embed};})()', 30000);
    assert.equal(renderer?.version, options.expectedVersion, 'Renderer candidate version differs');
    assert.equal(renderer.build, evidence.identityBefore.build.split(/[\\/]/).at(-1), 'Renderer build differs');
    assert.equal(resolve(renderer.dataRoot), evidence.identityBefore.dataRoot, 'Renderer data root differs');
    assert.ok(renderer.plugins === 'function' && renderer.embed === 'function', 'Production plugin renderer IPC is unavailable');
    evidence.renderer = {targetId: panel.id, ...renderer};
    const invoke = async (method, request) => {
      const value = await evaluate(panel, 'whale.plugins.' + method + '(' + JSON.stringify(request) + ')', options.timeoutMs);
      if (value?.error) throw Error('Production plugin IPC failed: ' + JSON.stringify(value.error));
      return value;
    };
    action = request => invoke('action', request); embed = request => invoke('embed', request);
    const status = () => action({action: 'community-status'});
    const record = (state, target) => state?.dsh?.installed?.find(row => row.packageName === target.packageName);
    async function job(queued) {
      assert.ok(queued?.job?.id, 'Production maintenance job identity is missing');
      const deadline = Date.now() + options.timeoutMs;
      while (Date.now() < deadline) {
        const state = await status(), found = state.maintenance?.jobs?.find(row => row.id === queued.job.id);
        assert.ok(found, 'Production maintenance job disappeared');
        if (found.state === 'completed') return {job: found, state};
        assert.ok(['queued', 'running'].includes(found.state), 'Production maintenance did not complete: ' + JSON.stringify(found));
        await sleep(250);
      }
      throw Error('Production maintenance deadline: ' + queued.job.id);
    }
    async function pageHandshake(target, previous) {
      await embed({op: 'dock', target: target.target});
      const deadline = Date.now() + Math.min(options.timeoutMs, 120000);
      while (Date.now() < deadline) {
        const states = await embed({op: 'state'}), state = states.find(row => row.target === target.target);
        assert.notEqual(state?.state, 'err', 'Production embed failed: ' + JSON.stringify(state));
        if (state?.state === 'run') {
          for (const page of (await localJson('/json/list')).filter(page => /^http:\/\/127\.0\.0\.1:\d+/.test(page.url))) {
            let doc;
            try {doc = await evaluate(page, '({readyState:document.readyState,origin:location.origin,embedded:document.documentElement.dataset.buddyEmbedded,panel:document.documentElement.dataset.buddyPanel,openPlugin:document.documentElement.dataset.buddyOpenPlugin,timeOrigin:performance.timeOrigin})', 5000);} catch {continue;}
            if (doc?.panel !== target.packageName) continue;
            doc.targetId = page.id;
            try {requireDocumentHandshake(doc, target, previous); return {embed: state, document: doc};} catch { /* wait for this specific document */ }
          }
        }
        await sleep(250);
      }
      throw Error('Actual requested plugin document handshake deadline: ' + target.packageName);
    }
    async function disable(target, packageKey) {
      const done = await job(await action({action: 'dsh-disable', packageKey}));
      assert.equal(record(done.state, target)?.enabled, false, 'Native plugin did not stop');
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const states = await embed({op: 'state'});
        if (!states.some(row => row.target === target.target && ['run', 'start'].includes(row.state))) return {job: done.job, embed: states};
        await sleep(100);
      }
      throw Error('Disabled plugin page did not retire');
    }
    const selected = options.mode === 'upgrade-plugin' ? OFFICIAL_TARGETS.filter(target => target.target === options.updateTarget) : OFFICIAL_TARGETS;
    assert.ok(selected.length, 'No requested official target');
    await action({action: 'community-open'});
    for (const target of selected) {
      const row = {target: target.target, packageName: target.packageName, version: target.version, sourceDigest: target.digest}; evidence.rows.push(row); activeRow = row;
      row.before = record(await status(), target) ?? null;
      if (options.mode === 'upgrade-plugin') {
        requireOldPlugin(row.before, target, options);
        const checked = await action({action: 'community-check-updates', refresh: true});
        row.update = checked.updates?.find(update => update.backend === 'dsh' && update.packageKey === row.before.packageKey && update.from === options.fromVersion && update.to === target.version && update.digest === target.digest);
        assert.ok(row.update && row.update.state === 'available', 'Exact official update is not available');
      }
      row.plan = await action({action: 'dsh-plan', sourceId: 'official', id: target.id, version: target.version, ...(options.mode === 'upgrade-plugin' ? {updateFrom: options.fromVersion, updateDigest: target.digest} : {})});
      requirePluginPlan(row.plan, target, options);
      if (options.mode === 'upgrade-plugin') assert.equal(row.plan.updateFrom, options.fromVersion, 'Production plan did not bind the old plugin version');
      row.packageKey = row.plan.packageKey;
      await event('installing', {target: target.target, from: row.before?.exactVersion ?? null, to: target.version});
      row.install = (await job(await action({action: 'dsh-install', planId: row.plan.planId, grantedCapabilities: row.plan.declaredCapabilities}))).job;
      const enabled = await job(await action({action: 'dsh-enable', packageKey: row.packageKey}));
      row.enable = enabled.job; row.installed = record(enabled.state, target);
      assert.ok(row.installed?.enabled === true && row.installed.runtimeVerified === true, 'Native plugin activation was not verified');
      assert.equal(row.installed.exactVersion, target.version); assert.equal(row.installed.sourceDigest, target.digest);
      const archive = join(evidence.identityBefore.dataRoot, 'plugin-platform', 'dsh', 'verified-packages', target.digest + '.tgz'), bytes = await readFile(archive);
      assert.equal(sha(bytes), target.digest, 'Actual installed plugin archive SHA-256 differs');
      assert.ok(/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.installed.profileId ?? ''), 'Installed native profile identity is missing');
      const directory = await realpath(join(evidence.identityBefore.dataRoot, 'plugin-runtimes', 'dsh', 'profiles', row.installed.profileId, 'node_modules', target.packageName));
      assert.ok(within(evidence.identityBefore.dataRoot, directory), 'Installed plugin directory leaves isolated data');
      const packageBytes = await readFile(join(directory, 'package.json')), packageJson = JSON.parse(packageBytes);
      assert.equal(packageJson.name, target.packageName); assert.equal(packageJson.version, target.version);
      row.artifact = {archive, bytes: bytes.length, sha256: target.digest, directory, packageJsonSha256: sha(packageBytes)};
      row.first = await pageHandshake(target);
      row.stop = await disable(target, row.packageKey);
      const restarted = await job(await action({action: 'dsh-enable', packageKey: row.packageKey}));
      assert.ok(record(restarted.state, target)?.runtimeVerified === true, 'Restarted native plugin was not verified');
      row.restart = restarted.job; row.second = await pageHandshake(target, row.first.document);
      row.finalStop = await disable(target, row.packageKey); row.passed = true; activeRow = null;
      await event('plugin-completed', {target: target.target, document: row.second.document.targetId});
    }
    if(options.mode==='install'){
      // Same Discover intent/legacy install as the UI, intentionally no explicit version and no asset/model preparation.
      const voice=evidence.voice={passed:false,id:OFFICIAL_VOICE_TARGET.id};
      voice.plan=await action({action:'dsh-plan',sourceId:'official',id:'ai-buddy.voice-breeze'});
      requireVoicePlan(voice.plan);
      await action({action:'install',planId:voice.plan.planId});
      const installed=await status();voice.installedBeforeEnable=installed.voicePackages?.find(row=>row.id===voice.id);
      assert.equal(voice.installedBeforeEnable?.installed,true,'Official Breeze installation did not register');
      await action({action:'enable',sourceId:'official',id:voice.id});
      voice.installed=(await status()).voicePackages?.find(row=>row.id===voice.id);
      requireVoiceInstall(voice.plan,voice.installed);voice.passed=true;
      await event('voice-installed-enabled',{id:voice.id,version:voice.installed.version});
    }
    evidence.identityAfter = await inspectCandidateIdentity(options, await call('installation-status'));
    assert.equal(evidence.identityAfter.processId, evidence.identityBefore.processId, 'Application process changed during the gate');
    assert.equal(evidence.identityAfter.codeDirectorySha256, evidence.identityBefore.codeDirectorySha256, 'Candidate build bytes changed during the gate');
    evidence.passed = true;
  } catch (error) {
    evidence.error = {message: error.message, stack: error.stack};
    if (activeRow?.packageKey && action) try {
      const current = await call('installation-status');
      assert.equal(current.processId, evidence.identityBefore.processId, 'Do not clean up another instance');
      assert.equal(resolve(current.build), evidence.identityBefore.build, 'Do not clean up another build');
      evidence.failureCleanup = await action({action: 'dsh-disable', packageKey: activeRow.packageKey});
      evidence.failureCleanupNeedsDrain = !!evidence.failureCleanup?.job;
    } catch (cleanup) {evidence.cleanupError = cleanup.message;}
  } finally {evidence.finishedAt = new Date().toISOString(); await save();}
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseGateArgs(process.argv.slice(2)), result = await validateInstalledPluginRuntime(options);
    console.log(JSON.stringify({passed: result.passed, mode: result.mode, result: join(options.out, 'RESULT.json'), plugins: result.rows.map(row => ({name: row.packageName, passed: row.passed === true})), error: result.error?.message}));
    if (!result.passed) process.exitCode = 1;
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
