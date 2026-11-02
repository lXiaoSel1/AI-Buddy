import test from 'node:test';
import assert from 'node:assert/strict';
import {buildGitHubReviewIndex, readGitHubDownloadStatistics} from '../src/community/github-indexer.mjs';
import {githubIssue} from './support/community-fixtures.mjs';

test('simulated GitHub API: complete pagination verifies identities and invalidates deleted ratings', async () => {
  const calls = [], issue = githubIssue(), previousIndex = {repository: 'test/native', reviews: [{issueId: 999}], deletedIssueIds: []};
  const result = await buildGitHubReviewIndex({repository: 'test/native', catalogId: 'community.test', validWorkIds: ['test.tools'], previousIndex, now: () => Date.parse('2026-10-24T23:00:00Z'), fetchImpl: async (url, options) => { calls.push({url, options}); return url.includes('page=2') ? Response.json([]) : Response.json([issue], {headers: {link: '<https://api.github.com/repos/test/native/issues?state=all&labels=community-review&per_page=100&page=2>; rel="next"'}}); }});
  assert.equal(result.index.evidence.complete, true); assert.equal(result.index.evidence.pages, 2); assert.deepEqual(result.index.deletedIssueIds, [999]); assert.equal(result.totals['test.tools'].count, 1); assert.equal(result.index.reviews[0].githubUserId, 77); assert.equal(result.receipt.inferenceRequests, 0); assert.equal(calls.every(call => !call.options.method || call.options.method === 'GET'), true);
});
test('simulated GitHub API: partial failure and foreign pagination never produce a shared index', async () => {
  await assert.rejects(buildGitHubReviewIndex({repository: 'test/native', catalogId: 'community.test', fetchImpl: async () => new Response('denied', {status: 403})}), /403/);
  await assert.rejects(buildGitHubReviewIndex({repository: 'test/native', catalogId: 'community.test', fetchImpl: async () => Response.json([], {headers: {link: '<https://evil.test/steal?token=secret>; rel="next"'}})}), {code: 'COMMUNITY_GITHUB_PAGINATION'});
});
test('simulated GitHub API: edits and unlabeled issues are reflected without evaluating issue code', async () => {
  const issue = githubIssue({body: githubIssue().body.replace('Useful tool, tested on Windows.', '`process.exit(1)` / $(do-not-run)')});
  const result = await buildGitHubReviewIndex({repository: 'test/native', catalogId: 'community.test', validWorkIds: ['test.tools'], fetchImpl: async () => Response.json([issue, githubIssue({id: 102, labels: []})])});
  assert.match(result.index.reviews[0].text, /do-not-run/); assert.equal(result.index.reviews.length, 1);
});
test('simulated release API: cumulative counters are not falsely called 90-day downloads', async () => {
  const asset = {id: 1, name: 'canonical.tgz', created_at: '2026-01-01T00:00:00Z', download_count: 99}; const config = {repository: 'test/native', assetNames: ['canonical.tgz'], now: () => Date.parse('2026-10-24T23:00:00Z'), fetchImpl: async () => Response.json([{assets: [asset]}])};
  const old = await readGitHubDownloadStatistics(config); assert.equal(old.cumulativeDownloadCount, 99); assert.equal(old.downloadCount90d, null);
  asset.created_at = '2026-10-24T00:00:00Z'; const recent = await readGitHubDownloadStatistics(config); assert.equal(recent.downloadCount90d, 99);
  const partial = await readGitHubDownloadStatistics({...config, fetchImpl: async () => Response.json([{assets: [asset]}], {headers: {link: '<https://api.github.com/next>; rel="next"'}})}); assert.equal(partial.downloadCount90d, null); assert.equal(partial.cumulativeDownloadCount, null);
});

test('simulated GitHub API: edited stars replace a vote; deletion, unlabeling and unknown versions remove it', async () => {
  const options = {repository: 'test/native', catalogId: 'community.test', validWorkIds: ['test.tools'], validVersionsByWork: {'test.tools': ['1.0.0']}};
  const first = await buildGitHubReviewIndex({...options, fetchImpl: async () => Response.json([githubIssue()])});
  const editedIssue = githubIssue({body: githubIssue().body.replace('### Stars\n\n5', '### Stars\n\n2'), updated_at: '2026-10-24T23:01:00Z'});
  const edited = await buildGitHubReviewIndex({...options, previousIndex: first.index, fetchImpl: async () => Response.json([editedIssue])});
  assert.equal(edited.totals['test.tools'].count, 1); assert.equal(edited.totals['test.tools'].sum, 2); assert.deepEqual(edited.index.deletedIssueIds, []);
  for (const values of [[], [{...editedIssue, labels: []}], [{...editedIssue, body: editedIssue.body.replace('1.0.0', '99.0.0')}]]) {
    const removed = await buildGitHubReviewIndex({...options, previousIndex: edited.index, fetchImpl: async () => Response.json(values)});
    assert.deepEqual(removed.totals, {}); assert.deepEqual(removed.index.deletedIssueIds, [101]);
  }
  const restored = await buildGitHubReviewIndex({...options, previousIndex: {...edited.index, reviews: [], deletedIssueIds: [101]}, fetchImpl: async () => Response.json([editedIssue])});
  assert.deepEqual(restored.index.deletedIssueIds, []); assert.equal(restored.totals['test.tools'].sum, 2);
});
