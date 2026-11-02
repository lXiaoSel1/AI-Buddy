import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCommunityCatalog, parseDshPackageRef, rankCommunityWorks, verifyCommunityCatalog} from '../src/community/catalog.mjs';
import {verifyPluginCatalog} from '../src/plugin-catalog.mjs';
import {publisher, catalog, signed} from './support/community-fixtures.mjs';

test('community schema is independent and cannot be interpreted as a legacy signed catalog', () => {
  const pub = publisher(), envelope = signed(catalog(pub), pub);
  assert.equal(verifyCommunityCatalog(envelope, pub.source).works.length, 1);
  assert.throws(() => verifyPluginCatalog(envelope, {trustedKeys: {[pub.source.keyId]: pub.source.publicKey}}), /Unknown|Unsupported/);
  assert.throws(() => parseCommunityCatalog({...catalog(pub), unexpected: 'value'}), /Invalid/);
});
test('community source identity and package digests cannot be substituted', () => {
  const pub = publisher(), other = publisher(), payload = catalog(pub);
  assert.throws(() => verifyCommunityCatalog(signed(payload, pub), other.source), /verification/);
  assert.throws(() => verifyCommunityCatalog(signed({...payload, source: {...payload.source, descriptorId: 'other'}}, pub), pub.source), /pinned/);
  assert.throws(() => verifyCommunityCatalog(signed(payload, pub), {...pub.source, removed: true}), /enabled/);
  const invalid = structuredClone(payload); invalid.works[0].releases[0].package.sourceDigest = 'x'; assert.throws(() => parseCommunityCatalog(invalid), /SHA/);
});
test('DSH package specs freeze registry versions, tarballs and Git commits', () => {
  const ref = catalog(publisher()).works[0].releases[0].package;
  assert.throws(() => parseDshPackageRef({...ref, spec: {kind: 'registry', value: '@community-test/test-tools@latest'}}), /exact/);
  assert.throws(() => parseDshPackageRef({...ref, spec: {kind: 'tarball', value: 'https://example.test/latest/pkg.tgz'}}), /Immutable/);
  assert.throws(() => parseDshPackageRef({...ref, digestType: 'git-archive-sha256', spec: {kind: 'git', value: 'https://github.com/a/b', commit: 'main'}}), /complete commit/);
  assert.throws(() => parseDshPackageRef({...ref, spec: {kind: 'git', value: 'https://github.com/a/b', commit: 'a'.repeat(40)}}), /digest type/);
  assert.equal(parseDshPackageRef({...ref, digestType: 'git-archive-sha256', spec: {kind: 'git', value: 'https://github.com/a/b', commit: 'a'.repeat(40)}}).spec.commit, 'a'.repeat(40));
});
test('rank formula preserves unknown data, sample size and deterministic order', () => {
  const work = catalog(publisher()).works[0], duplicate = {...work, id: 'other', statistics: {downloadCount90d: 100}};
  const ranked = rankCommunityWorks([work, duplicate], {ratings: {'test.tools': {count: 1, sum: 5}}, now: Date.parse('2026-10-24T22:00:00Z')});
  const rated = ranked.find(value => value.id === work.id), unrated = ranked.find(value => value.id === 'other');
  assert.equal(rated.rating.smoothed, 20 / 6); assert.equal(rated.rating.insufficientSample, true); assert.equal(rated.recommendation.components.downloads, null);
  assert.equal(unrated.rating.mean, null); assert.equal(unrated.rating.count, 0); assert.equal(unrated.recommendation.components.rating, null);
  assert.deepEqual(rankCommunityWorks([work, {...work, id: 'aaa'}], {now: 0}).map(value => value.id), ['aaa', 'test.tools']);
});
