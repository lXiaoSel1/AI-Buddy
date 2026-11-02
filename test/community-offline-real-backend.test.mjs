// Review 低-6 (adapted from the reviewer's probe): the real DSH backend, not the simulated one, re-verifies the host-staged
// offline copy. No runtime component exists here, so planning stops at the runtime and nothing is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createDshBackend} from '../src/dsh-platform/backend.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function tarEntry(name, data) {
  const header = Buffer.alloc(512), put = (text, offset, length) => header.write(text, offset, length, 'utf8');
  put(name, 0, 100); put('0000644\0', 100, 8); put('0000000\0', 108, 8); put('0000000\0', 116, 8); put(data.length.toString(8).padStart(11, '0') + '\0', 124, 12); put('00000000000\0', 136, 12); put('        ', 148, 8); put('0', 156, 1); put('ustar\0', 257, 6); put('00', 263, 2);
  let sum = 0; for (const byte of header) sum += byte; put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
const pack = (name, version, body = 'export default 1;\n') => gzipSync(Buffer.concat([tarEntry('package/package.json', Buffer.from(JSON.stringify({name, version}))), tarEntry('package/index.js', Buffer.from(body)), Buffer.alloc(1024)]));

test('real DSH backend re-checks the staged offline file: tampered bytes and a wrong identity are refused, the right file is copied into its own cache', async t => {
  const root = await mkdtemp(join(process.env.AI_BUDDY_TEST_TEMP_BASE || tmpdir(), 'buddy-dsh-offline-')); t.after(() => rm(root, {recursive: true, force: true}));
  const backend = createDshBackend({runtimeLockPath: join(root, 'missing-lock.json'), dshHome: join(root, 'home'), stateDir: join(root, 'state')});
  t.after(() => backend.close?.().catch(() => {}));
  const good = pack('@community-test/test-tools', '1.0.0'), staged = join(root, 'offline', sha(good) + '.tgz');
  await mkdir(join(root, 'offline'), {recursive: true});
  const packageRef = {backend: 'dsh', sourceId: 's', packageName: '@community-test/test-tools', exactVersion: '1.0.0', sourceDigest: sha(good), digestType: 'tarball-sha256', spec: {kind: 'tarball', value: 'https://example.invalid/p.tgz'}, capabilities: [], dataSchemaVersion: 1};
  await writeFile(staged, pack('@community-test/test-tools', '1.0.0', 'evil()\n'));
  await assert.rejects(backend.planInstall({packageRef, spec: staged}), {code: 'DSH_PACKAGE_DIGEST_MISMATCH'});
  const other = pack('@evil/other', '1.0.0'); await writeFile(staged, other);
  await assert.rejects(backend.planInstall({packageRef: {...packageRef, sourceDigest: sha(other)}, spec: staged}), {code: 'DSH_PACKAGE_IDENTITY_MISMATCH'});
  await writeFile(staged, good);
  await assert.rejects(backend.planInstall({packageRef, spec: staged}), error => !['DSH_PACKAGE_DIGEST_MISMATCH', 'DSH_PACKAGE_IDENTITY_MISMATCH'].includes(error.code));
  assert.deepEqual(await readFile(join(root, 'state', 'verified-packages', sha(good) + '.tgz')), good);
});
