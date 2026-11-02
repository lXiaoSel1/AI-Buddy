import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildReviewIndexArtifact} from '../scripts/community/build-review-index.mjs';
import {verifyReviewIndex} from '../src/community/reviews.mjs';
import {catalog, githubIssue, publisher} from './support/community-fixtures.mjs';

test('simulation: final signed review artifact verifies with pinned source and retains undeployed status', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-review-artifact-')); t.after(() => rm(directory, {recursive: true, force: true})); const pub = publisher(), catalogPath = join(directory, 'catalog.json'), out = join(directory, 'reviews.json'); await writeFile(catalogPath, JSON.stringify(catalog(pub)));
  const receipt = await buildReviewIndexArtifact({catalogPath, repository: 'test/native', out, keyId: pub.source.keyId, signingKey: pub.privateKey.export({type: 'pkcs8', format: 'pem'}), requireSignature: true, fetchImpl: async () => Response.json([githubIssue()])});
  assert.equal(receipt.signed, true); assert.equal(receipt.deploymentStatus, 'local-artifact-not-deployed'); assert.equal(receipt.methodsUsed[0], 'GET'); assert.equal(verifyReviewIndex(JSON.parse(await readFile(out, 'utf8')), pub.source, 'community.test').reviews.length, 1);
  assert.equal((await readFile(out, 'utf8')).includes('PRIVATE KEY'), false);
});
test('simulation: publication mode without a signing key fails before writing unsigned output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-review-no-signer-')); t.after(() => rm(directory, {recursive: true, force: true})); const pub = publisher(), catalogPath = join(directory, 'catalog.json'), out = join(directory, 'reviews.json'); await writeFile(catalogPath, JSON.stringify(catalog(pub)));
  await assert.rejects(buildReviewIndexArtifact({catalogPath, repository: 'test/native', out, requireSignature: true, fetchImpl: async () => Response.json([])}), /configured signing key/); await assert.rejects(stat(out), {code: 'ENOENT'});
});
