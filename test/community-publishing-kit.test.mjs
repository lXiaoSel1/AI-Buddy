import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {packageCommunityPublishingKit} from '../scripts/community/package-publishing-kit.mjs';

test('publication kit inventory binds every copied and generated file, excluding its own manifest', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'buddy-publishing-kit-')); t.after(() => rm(parent, {recursive: true, force: true}));
  const target = join(parent, 'kit'), result = await packageCommunityPublishingKit(target), manifest = JSON.parse(await readFile(join(target, 'MANIFEST-SHA256.json'), 'utf8'));
  assert.equal(result.deployment, 'not-deployed'); assert.equal(manifest.privateSigningKeysIncluded, false); assert.equal(manifest.files.some(row => row.path === 'package.json'), true);
  for (const row of manifest.files) { const bytes = await readFile(join(target, row.path)); assert.equal(bytes.length, row.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256); }
  async function inventory(path, prefix = '') { const names = []; for (const value of await readdir(path, {withFileTypes: true})) value.isDirectory() ? names.push(...await inventory(join(path, value.name), prefix + value.name + '/')) : names.push(prefix + value.name); return names; }
  assert.deepEqual((await inventory(target)).filter(path => path !== 'MANIFEST-SHA256.json').sort(), manifest.files.map(row => row.path).sort());
  await assert.rejects(packageCommunityPublishingKit(target), /already exists/);
});
