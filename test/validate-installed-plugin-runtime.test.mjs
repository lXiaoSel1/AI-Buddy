import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve, sep} from 'node:path';
import {
  parseGateArgs, inspectCandidateIdentity, requireDocumentHandshake,
  requirePluginPlan, requireOldPlugin, requireProcessBinding, validateInstalledPluginRuntime, OFFICIAL_TARGETS,
} from '../scripts/validate-installed-plugin-runtime.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const args = ['--allowed-root=C:/isolated', '--install-root=C:/isolated/candidate', '--pipe=audit214-candidate', '--out=C:/isolated/evidence', '--expected-version=2.0.14', '--cdp-port=49152', '--expected-main-sha256=' + 'a'.repeat(64)];
test('installed runtime gate refuses missing independent identity and ambiguous arguments', () => {
  assert.equal(parseGateArgs(args).expectedVersion, '2.0.14');
  assert.throws(() => parseGateArgs(args.filter(arg => !arg.startsWith('--expected-main-sha256='))), /expected-main-sha256/);
  assert.throws(() => parseGateArgs([...args, '--pipe=second-instance']), /Duplicate/);
  assert.throws(() => parseGateArgs(args.map(arg => arg.startsWith('--cdp-port=') ? '--cdp-port=0' : arg)), /cdp-port/);
  assert.throws(() => parseGateArgs(args.filter(arg => !arg.startsWith('--allowed-root='))), /allowed-root/);
  assert.throws(() => parseGateArgs(args.map(arg => arg.startsWith('--install-root=') ? '--install-root=C:/isolated/tools/whale-companion' : arg)), /Daily/);
});

async function installedFixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'audit214-gate-contract-'));
  assert.ok(resolve(parent).startsWith(resolve(tmpdir()) + sep));
  t.after(() => rm(parent, {recursive: true, force: true}));
  const root = join(parent, '安装 中文 (candidate)'), build = join(root, 'builds', 'v2.0.14-contract');
  const files = ['main.cjs', 'preload.cjs', 'plugin-client-preload.cjs', 'dsh-network-bootstrap.mjs', 'dsh-platform/native-bridge-host.mjs', 'dsh-platform/inert-bootstrap.mjs', 'dsh-component-worker.mjs', 'ffmpeg-component-worker.mjs', 'work-archive-cursor-worker.mjs', 'voice-assets-worker.cjs', 'bili-full-media-worker.mjs', 'monitor-worker.cjs', 'plugin-maintenance.cjs', 'index.html'];
  for (const file of files) { await mkdir(dirname(join(build, file)), {recursive: true}); await writeFile(join(build, file), 'synthetic contract bytes: ' + file); }
  await writeFile(join(build, 'package.json'), JSON.stringify({version: '2.0.14', main: 'main.cjs'}));
  await mkdir(join(root, 'local'), {recursive: true});
  const installation = {version: '2.0.14', build: 'builds/v2.0.14-contract', pipe: 'audit214-candidate', manifestSha256: 'b'.repeat(64), edition: '30fps', packageHashes: {'app-30fps': 'c'.repeat(64)}};
  await writeFile(join(root, 'local/installation.json'), JSON.stringify(installation));
  const status = {root, build, dataRoot: join(root, 'local/data-v003'), version: '2.0.14', processId: process.pid, ready: true, onboarding: false, safeMode: false, startupFailure: null};
  await mkdir(status.dataRoot, {recursive: true});
  return {parent, root, build, status, installation, options: {allowedRoot: parent, installRoot: root, pipe: 'audit214-candidate', expectedVersion: '2.0.14', expectedMainSha256: sha(await readFile(join(build, 'main.cjs')))}};
}
test('ready flags cannot replace matching installed build bytes and manifest identity', async t => {
  const f = await installedFixture(t), evidence = await inspectCandidateIdentity(f.options, f.status);
  assert.match(evidence.codeDirectorySha256, /^[a-f0-9]{64}$/);
  assert.equal(evidence.mainSha256, f.options.expectedMainSha256);
  await assert.rejects(inspectCandidateIdentity({...f.options, expectedMainSha256: 'd'.repeat(64)}, f.status), /main.*SHA|SHA.*main/i);
  delete f.installation.manifestSha256;
  await writeFile(join(f.root, 'local/installation.json'), JSON.stringify(f.installation));
  await assert.rejects(inspectCandidateIdentity(f.options, f.status), /manifest/i);
});
test('candidate identity refuses a source checkout or another pipe even when services are ready', async t => {
  const f = await installedFixture(t);
  await assert.rejects(inspectCandidateIdentity(f.options, {...f.status, build: join(f.root, 'src')}), /build/i);
  await assert.rejects(inspectCandidateIdentity({...f.options, pipe: 'another-instance'}, f.status), /pipe/i);
  assert.throws(() => requireProcessBinding({processInfo: [{type: 'browser', id: process.pid + 1}]}, process.pid), /process/i);
  requireProcessBinding({processInfo: [{type: 'browser', id: process.pid}]}, process.pid);
});
test('the gate rejects out-of-bound data and an installation junction escaping its allowed fixture', async t => {
  const f = await installedFixture(t);
  await assert.rejects(inspectCandidateIdentity(f.options, {...f.status, dataRoot: dirname(f.parent)}), /allowed isolated root/);
  const allowed = join(f.parent, 'allowed'), linked = join(allowed, 'candidate');
  await mkdir(allowed);
  await symlink(f.root, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectCandidateIdentity({...f.options, allowedRoot: allowed, installRoot: linked}, {...f.status, root: linked}), /through a link/);
});

test('page readiness requires actual requested plugin document and a fresh document after restart', () => {
  const target = OFFICIAL_TARGETS[0];
  assert.throws(() => requireDocumentHandshake({state: 'run', ready: true}, target), /document|handshake/i);
  const first = {targetId: 'document-one', origin: 'http://127.0.0.1:49153', readyState: 'complete', embedded: '1', panel: target.packageName, openPlugin: target.packageName, timeOrigin: 100};
  requireDocumentHandshake(first, target);
  assert.throws(() => requireDocumentHandshake(first, target, first), /fresh|restart/i);
  assert.throws(() => requireDocumentHandshake({...first, targetId: 'document-two', panel: '@other/plugin'}, target, first), /panel|handshake/i);
  requireDocumentHandshake({...first, targetId: 'document-two', timeOrigin: 200}, target, first);
});
test('official plans retain exact package identity and optional no-download preflight', () => {
  const target = OFFICIAL_TARGETS[0], plan = {packageKey: 'dsh:official:' + target.packageName, packageRef: {sourceId: 'official', packageName: target.packageName, exactVersion: target.version, sourceDigest: target.digest}, planId: 'plan', sourceFingerprint: 'SHA256:trusted-catalog', catalogDigest: 'e'.repeat(64), declaredCapabilities: [], hostComponents: [{id: 'dsh', ready: false, downloadBytes: 198580207}]};
  requirePluginPlan(plan, target);
  assert.throws(() => requirePluginPlan(plan, target, {requireComponentsReady: true}), /component|download/i);
  assert.throws(() => requirePluginPlan({...plan, packageRef: {...plan.packageRef, sourceDigest: 'f'.repeat(64)}}, target), /digest|package/i);
});
test('upgrade mode requires a genuinely older installed package and its independent starting digest', () => {
  const target = OFFICIAL_TARGETS[0], old = {sourceId: 'official', packageName: target.packageName, exactVersion: '2.0.15', sourceDigest: 'f'.repeat(64)};
  requireOldPlugin(old, target, {fromVersion: '2.0.15', fromDigest: 'f'.repeat(64)});
  assert.throws(() => requireOldPlugin({...old, exactVersion: target.version}, target, {fromVersion: target.version, fromDigest: old.sourceDigest}), /older|same.version/i);
  assert.throws(() => requireOldPlugin(old, target, {fromVersion: '2.0.15', fromDigest: '0'.repeat(64)}), /digest|starting/i);
});

test('an existing gate output is never overwritten, including failed evidence', async t => {
  const f = await installedFixture(t), out = join(f.parent, 'existing-evidence');
  await mkdir(out); const original = '{"passed":false,"reason":"retained original failure"}\n';
  await writeFile(join(out, 'RESULT.json'), original);
  await assert.rejects(validateInstalledPluginRuntime({...f.options, out, mode:'install'}), {code:'EEXIST'});
  assert.equal(await readFile(join(out, 'RESULT.json'), 'utf8'), original);
});

test('native QQ and card plans do not invent Bilibili-only hostComponents', () => {
  for (const target of OFFICIAL_TARGETS.slice(1)) {
    const plan = {packageKey:'dsh:official:'+target.packageName,packageRef:{sourceId:'official',packageName:target.packageName,exactVersion:target.version,sourceDigest:target.digest},planId:'plan',sourceFingerprint:'SHA256:trusted-catalog',catalogDigest:'e'.repeat(64),declaredCapabilities:[]};
    assert.doesNotThrow(()=>requirePluginPlan(plan,target,{requireComponentsReady:true}));
    assert.throws(()=>requirePluginPlan({...plan,hostComponents:[{ready:false,downloadBytes:1}]},target,{requireComponentsReady:true}),/component|download/i);
  }
});

test('Bilibili no-download preflight still requires explicit host component evidence', () => {
  const target=OFFICIAL_TARGETS[0],plan={packageKey:'dsh:official:'+target.packageName,packageRef:{sourceId:'official',packageName:target.packageName,exactVersion:target.version,sourceDigest:target.digest},planId:'plan',sourceFingerprint:'SHA256:trusted-catalog',catalogDigest:'e'.repeat(64),declaredCapabilities:[]};
  assert.throws(()=>requirePluginPlan(plan,target,{requireComponentsReady:true}),/component|download/i);
});
