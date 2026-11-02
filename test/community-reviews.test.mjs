import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateReviews, buildReviewFormUrl, parseReviewIndex, reviewFromGitHubIssue, verifyReviewIndex} from '../src/community/reviews.mjs';
import {githubIssue, publisher, signed} from './support/community-fixtures.mjs';

const index = reviews => ({schemaVersion: 1, type: 'ai-buddy-community-reviews', catalogId: 'community.test', generatedAt: '2026-10-24T22:00:00Z', repository: 'test/native', reviews, deletedIssueIds: [], evidence: {provider: 'github-api', complete: true, fetchedAt: '2026-10-24T22:00:00Z', pages: 1}});
test('simulation: review identity comes from GitHub API user, never markdown claims', () => {
  const issue = githubIssue({body: githubIssue().body + '\n\nGitHub user: maintainer'}), row = reviewFromGitHubIssue(issue, {repository: 'test/native', validWorkIds: ['test.tools']});
  assert.equal(row.githubUserId, 77); assert.equal(row.githubLogin, 'real-user');
  const multiline = reviewFromGitHubIssue(githubIssue({body: githubIssue().body + '\n\nSecond paragraph.\n### My notes\nMore detail.'}), {repository: 'test/native'}); assert.match(multiline.text, /Second paragraph[\s\S]*More detail\./);
  assert.equal(reviewFromGitHubIssue({...issue, user: {...issue.user, type: 'Bot'}}, {repository: 'test/native'}), null);
  assert.equal(reviewFromGitHubIssue({...issue, labels: []}, {repository: 'test/native'}), null);
  assert.equal(reviewFromGitHubIssue({...issue, body: issue.body.replace('### Stars\n\n5', '### Stars\n\n99')}, {repository: 'test/native'}), null);
});
test('simulation: only latest valid rating per GitHub user and work contributes', () => {
  const first = reviewFromGitHubIssue(githubIssue(), {repository: 'test/native'}), second = {...first, issueId: 102, issueNumber: 2, url: 'https://github.com/test/native/issues/2', stars: 2, updatedAt: '2026-10-24T22:01:00Z'};
  const totals = aggregateReviews(index([first, second])); assert.equal(totals['test.tools'].count, 1); assert.equal(totals['test.tools'].sum, 2); assert.equal(totals['test.tools'].reviews[0].issueId, 102);
  assert.deepEqual(aggregateReviews(index([second]), ['other']), {});
});
test('review index requires complete verified API provenance and matching repository', () => {
  const row = reviewFromGitHubIssue(githubIssue(), {repository: 'test/native'}), payload = index([row]), pub = publisher();
  assert.equal(verifyReviewIndex(signed(payload, pub), pub.source, 'community.test').reviews.length, 1);
  assert.throws(() => verifyReviewIndex(signed(payload, pub), pub.source, 'other'), /another/);
  assert.throws(() => parseReviewIndex({...payload, evidence: {...payload.evidence, complete: false}}), /Incomplete/);
  assert.throws(() => parseReviewIndex({...payload, reviews: [{...row, url: 'https://github.com/other/repo/issues/1'}]}), /match/);
});
test('draft URLs prefill stars/text but are not submission or identity evidence', () => {
  const url = new URL(buildReviewFormUrl({repository: 'test/native', workId: 'test.tools', version: '1.0.0', stars: 4, text: 'A&B # 好用'}));
  assert.equal(url.searchParams.get('stars'), '4'); assert.equal(url.searchParams.get('review-text'), 'A&B # 好用'); assert.equal(url.searchParams.get('template'), 'community-review.yml');
  assert.throws(() => buildReviewFormUrl({repository: 'https://evil.test', workId: 'test.tools', version: '1', stars: 5}), /Invalid/);
});

test('review ingestion binds exact published versions and rejects unversioned claims', () => {
  const options = {repository: 'test/native', validWorkIds: ['test.tools'], validVersionsByWork: {'test.tools': ['1.0.0']}};
  assert.equal(reviewFromGitHubIssue(githubIssue(), options).version, '1.0.0');
  for (const version of ['latest', '1.0.1', '999.0.0']) assert.equal(reviewFromGitHubIssue(githubIssue({body: githubIssue().body.replace('1.0.0', version)}), options), null);
  const row = reviewFromGitHubIssue(githubIssue(), options); assert.throws(() => parseReviewIndex(index([{...row, version: 'latest'}])), /version/);
});
