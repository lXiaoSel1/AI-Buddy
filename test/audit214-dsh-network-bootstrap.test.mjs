import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createDshBackend} from '../src/dsh-platform/backend.mjs';
import {createNetworkService} from '../src/network-service.mjs';

// Opt in with a real, unchanged component receipt. The backend still performs
// its production full verification and owns the real component Node process.
// No test launcher, synthetic CLI, internal spawn mock, or hand-written Node
// import arguments may substitute for createDshBackend's launch path here.
const runtimeLockPath = process.env.AI_BUDDY_AUDIT214_RUNTIME_LOCK;
const reproRoot = resolve(process.env.AI_BUDDY_AUDIT214_REPRO_ROOT ?? join(tmpdir(), 'audit214-dsh-network'));
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('Windows DSH reaches host readiness with the production network preload and real component Node', {
  skip: process.platform !== 'win32' ? 'Windows drive-letter module regression' : !runtimeLockPath ? 'Set AI_BUDDY_AUDIT214_RUNTIME_LOCK to a real pinned component receipt' : false,
  timeout: 180000,
}, async t => {
  await mkdir(reproRoot, {recursive: true});
  const root = await mkdtemp(join(reproRoot, 'DSH 中文 (network preload)-'));
  const lockBytes = await readFile(runtimeLockPath);
  const lock = JSON.parse(lockBytes);
  const events = [];
  const network = await createNetworkService();
  await network.save({mode: 'direct'});
  const backend = createDshBackend({
    runtimeLockPath: resolve(runtimeLockPath),
    dshHome: join(root, '合成资料 (DSH home)'),
    stateDir: join(root, '隔离状态 (host state)'),
    profileId: 'audit214-network-preload',
    network,
    handshakeTimeoutMs: 30000,
    onEvent: event => events.push(event),
  });
  const evidence = {
    startedAt: new Date().toISOString(),
    seam: 'createDshBackend.openClient -> production start/args/spawn -> real component Node -> host readiness',
    sourceRoot,
    root,
    runtimeLockPath: resolve(runtimeLockPath),
    componentNodePath: resolve(dirname(runtimeLockPath), lock.paths.node),
    componentNodeVersion: lock.nodeVersion,
    componentSourceCommit: lock.sourceCommit,
    runtimeLockSha256: sha256(lockBytes),
    backendSha256: sha256(await readFile(join(sourceRoot, 'src/dsh-platform/backend.mjs'))),
    networkBootstrapSha256: sha256(await readFile(join(sourceRoot, 'src/network-process-bootstrap.mjs'))),
    runnerNodeVersion: process.versions.node,
    network: network.snapshot(),
    events,
  };
  const started = performance.now();
  t.diagnostic(`Preserved isolated runtime evidence: ${join(root, 'result.json')}`);
  try {
    // openClient is the public boundary over the private production start().
    // Success requires both native bridge readiness and the private Web URL;
    // component presence or an outer utility service's ready flag is not enough.
    let client;
    await assert.doesNotReject(async () => {
      try {
        client = await backend.openClient();
      } catch (error) {
        evidence.startError = {name: error.name, code: error.code, message: error.message, stack: error.stack};
        throw error;
      }
    }, 'A network-enabled DSH host must reach readiness with its actual component Node');
    evidence.client = {runtimeId: client.runtimeId, profileId: client.profileId, clientState: client.clientState, webOrigin: client.webOrigin};
    evidence.identity = await backend.identity();
    assert.equal(evidence.identity.phase, 'running');
    assert.equal(client.clientState, 'host-ready-client-not-yet-observed');
  } finally {
    evidence.elapsedMs = Math.round(performance.now() - started);
    try {
      evidence.close = await backend.close();
      assert.equal(evidence.close.stopped, true);
      assert.notEqual(evidence.close.forced, true, 'This regression must exit through the owned backend without forced termination');
    } finally {
      evidence.finishedAt = new Date().toISOString();
      await writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
      await writeFile(join(root, 'runtime.log'), events.filter(event => event.kind === 'runtime-log').map(event => `[${event.stream}] ${event.text}`).join(''));
    }
  }
});
