import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog, setupCommunity, signed, githubIssue, sha} from './support/community-fixtures.mjs';
import {reviewFromGitHubIssue} from '../src/community/reviews.mjs';

const otherWork = (id, packageName) => ({id, backend: 'dsh', packageName, name: id, description: 'fixture', authorId: 'author.test', category: 'function', releases: [{version: '1.0.0', publishedAt: '2026-10-24T20:00:00Z', package: {backend: 'dsh', packageName, exactVersion: '1.0.0', sourceDigest: sha(id), spec: {kind: 'tarball', value: 'https://github.com/test/native/releases/download/v1.0.0/' + id + '.tgz'}, compatibility: {app: '^1.9.2', dsh: '^1.0.0', bridge: '^1.0.0'}, capabilities: [], dataSchemaVersion: 1}}], status: 'published'});
const issue = (n, user, workId, stars) => githubIssue({id: 100 + n, node_id: 'I_' + n, number: n, html_url: 'https://github.com/test/native/issues/' + n, user: {id: user, login: 'user-' + user, type: 'User'}, body: `### Work ID\n\n${workId}\n\n### Work version\n\n1.0.0\n\n### Stars\n\n${stars}\n\n### Review\n\nreview ${n}`});
const json = value => new Response(JSON.stringify(value), {status: 200, headers: {'content-type': 'application/json'}});

test('B1 五星评价 sorts by the smoothed GitHub rating; unrated works come last and get no invented score', async t => {
  const f = await setupCommunity(t), payload = catalog(f.pub, {extraWorks: [otherWork('test.loved', '@community-test/loved'), otherWork('test.unrated', '@community-test/unrated')]});
  const rows = [issue(1, 1, 'test.tools', 3), issue(2, 2, 'test.loved', 5), issue(3, 3, 'test.loved', 5)].map(value => reviewFromGitHubIssue(value, {repository: 'test/native'}));
  const index = {schemaVersion: 1, type: 'ai-buddy-community-reviews', catalogId: payload.id, generatedAt: '2026-10-24T22:00:00Z', repository: 'test/native', reviews: rows, deletedIssueIds: [], evidence: {provider: 'github-api', complete: true, fetchedAt: '2026-10-24T22:00:00Z', pages: 1}};
  await f.service.action({action: 'community-load-catalog', sourceId: f.pub.source.sourceId, envelope: signed(payload, f.pub), reviewEnvelope: signed(index, f.pub)});
  const listing = await f.service.action({action: 'community-search', sort: 'stars'});
  assert.deepEqual(listing.items.map(work => work.id), ['test.loved', 'test.tools', 'test.unrated']);
  assert.equal(listing.items[2].rating.mean, null); assert.equal(listing.items[2].rating.count, 0);
  const detail = await f.service.action({action: 'community-details', sourceId: f.pub.source.sourceId, id: 'test.loved'});
  assert.deepEqual(detail.reviews.distribution, [0, 0, 0, 0, 2]); assert.equal(detail.authorWorks, 3); assert.equal(detail.followed, false);
  await f.service.action({action: 'community-follow', key: f.pub.source.sourceId + ':author.test', enabled: true});
  assert.equal((await f.service.action({action: 'community-details', sourceId: f.pub.source.sourceId, id: 'test.loved'})).followed, true);
});

test('B5 updates carry the signed release notes in between, and 全部更新 queues only updates that ask for nothing new', async t => {
  const f = await setupCommunity(t); await f.load(); await f.install();
  assert.equal(f.service.snapshot().maintenance.jobs[0].version, '1.0.0');
  const next = catalog(f.pub, {generatedAt: '2026-10-24T23:00:00Z'}), first = structuredClone(next.works[0].releases[0]);
  for (const [version, notes] of [['1.1.0', 'Smaller fixes'], ['1.2.0', 'Failed entries can be collapsed']]) { const release = structuredClone(first); release.version = release.package.exactVersion = version; release.notes = notes; release.publishedAt = '2026-10-24T22:3' + version.at(-3) + ':00Z'; next.works[0].releases.push(release); }
  next.works[0].releases.at(-1).locales = {en: {notes: 'English notes'}};
  await f.load(next);
  const {updates} = await f.service.action({action: 'community-check-updates'});
  assert.equal(updates[0].to, '1.2.0'); assert.deepEqual(updates[0].changes.map(row => [row.version, row.notes]), [['1.2.0', 'Failed entries can be collapsed'], ['1.1.0', 'Smaller fixes']]); assert.equal(updates[0].changes[0].locales.en.notes, 'English notes'); assert.equal(updates[0].workId, 'test.tools');
  const plansBefore = f.calls.filter(call => call[0] === 'plan').length, result = await f.service.action({action: 'community-update-all'});
  assert.equal(result.updates[0].state, 'queued'); assert.equal(f.calls.filter(call => call[0] === 'plan').length, plansBefore + 1);
  await f.service.drainMaintenance(); const record = f.service.snapshot().dsh.installed[0]; assert.equal(record.exactVersion, '1.2.0'); assert.deepEqual(record.grantedCapabilities, ['characters.getContext']); assert.equal(record.enabled, false);
  // a newer version asking for a new permission is left for the user to review
  const asking = catalog(f.pub, {generatedAt: '2026-10-25T01:00:00Z'}); asking.works[0].releases = [...next.works[0].releases, {...structuredClone(first), version: '1.3.0', publishedAt: '2026-10-25T00:00:00Z', package: {...structuredClone(first.package), exactVersion: '1.3.0', capabilities: ['characters.getContext', 'models.request']}}];
  await f.load(asking); const plans = f.calls.filter(call => call[0] === 'plan').length, again = await f.service.action({action: 'community-update-all'});
  assert.equal(again.updates[0].state, 'needs-user'); assert.deepEqual(again.updates[0].addedCapabilities, ['models.request']); assert.equal(f.calls.filter(call => call[0] === 'plan').length, plans);
});

test('B2 「检查」 finds the review by its draft tag; identity and rating still come only from the GitHub API issue', async t => {
  let answer = [];const requested = [];
  const f = await setupCommunity(t, {fetchImpl: async url => { requested.push(String(url)); return json(answer); }}); await f.load();
  const {draft, url} = await f.service.action({action: 'community-review-draft', sourceId: f.pub.source.sourceId, id: 'test.tools', stars: 4, text: ''});
  const marker = '#' + draft.id.slice(0, 8); assert.equal(new URL(url).searchParams.get('title'), '[Review] test.tools ' + marker);
  assert.equal((await f.service.action({action: 'community-find-review', draftId: draft.id})).status, 'not-found');
  assert.match(requested[0], /^https:\/\/api\.github\.com\/repos\/test\/native\/issues\?labels=community-review&state=all/);
  const now = new Date().toISOString(), mine = githubIssue({title: '[Review] test.tools ' + marker, created_at: now, updated_at: now}), someoneElse = githubIssue({id: 202, number: 2, html_url: 'https://github.com/test/native/issues/2', title: '[Review] test.tools #00000000', created_at: now, updated_at: now, user: {id: 88, login: 'other', type: 'User'}});
  answer = [someoneElse, mine];
  const found = await f.service.action({action: 'community-find-review', draftId: draft.id});
  assert.equal(found.status, 'submitted-pending-sync'); assert.equal(found.review.githubLogin, 'real-user'); assert.equal(found.review.stars, 5);
  // a tagged issue whose body is not a valid review is not counted
  answer = [{...mine, body: 'no form fields'}]; assert.equal((await f.service.action({action: 'community-find-review', draftId: draft.id})).status, 'not-found');
  answer = [mine, {...mine, id: 303, number: 3, html_url: 'https://github.com/test/native/issues/3'}]; assert.equal((await f.service.action({action: 'community-find-review', draftId: draft.id})).status, 'ambiguous');
  await assert.rejects(f.service.action({action: 'community-find-review', draftId: 'invented'}), {code: 'COMMUNITY_REVIEW_NOT_FOUND'});
});
