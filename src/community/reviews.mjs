import {freezePluginData, parsePluginVersion, pluginId, readPluginJson} from '../plugin-manifest.mjs';
import {verifySignedPluginPayload} from '../plugin-catalog.mjs';
import {communityDate, communityHttps, communityRecord, communityText} from './catalog.mjs';

export const REVIEW_NAMESPACE = 'ai-buddy-community-reviews';
const fail = message => { throw Object.assign(Error(message), {code: 'COMMUNITY_REVIEWS_INVALID'}); };
/** Identity is taken only from the authenticated GitHub API response, never body text. */
export function reviewFromGitHubIssue(issue, {repository, validWorkIds, validVersionsByWork} = {}) {
  if (!issue || issue.pull_request || !issue.labels?.some(label => (typeof label === 'string' ? label : label.name) === 'community-review') || issue.user?.type !== 'User') return null;
  const fields = new Map();
  for (const match of String(issue.body ?? '').matchAll(/^### (Work ID|Work version|Stars|Review)\r?\n\r?\n([\s\S]*?)(?=\r?\n### (?:Work ID|Work version|Stars|Review)\r?\n|(?![\s\S]))/gm)) { if (fields.has(match[1])) return null; fields.set(match[1], match[2].trim()); }
  const workId = fields.get('Work ID'), starsText = fields.get('Stars');
  if (!workId || validWorkIds && !validWorkIds.includes(workId) || !/^[1-5]$/.test(starsText ?? '') || !fields.get('Review') || fields.get('Review') === '_No response_') return null;
  if (validVersionsByWork && !validVersionsByWork[workId]?.includes(fields.get('Work version'))) return null;
  const review = {workId, version: fields.get('Work version'), stars: Number(starsText), text: fields.get('Review'), githubUserId: issue.user.id, githubLogin: issue.user.login, issueId: issue.id, issueNumber: issue.number, issueNodeId: issue.node_id, url: issue.html_url, createdAt: issue.created_at, updatedAt: issue.updated_at};
  try { parseReviewIndex({schemaVersion: 1, type: 'ai-buddy-community-reviews', catalogId: 'validation', generatedAt: issue.updated_at, repository, reviews: [review], deletedIssueIds: [], evidence: {provider: 'github-api', fetchedAt: issue.updated_at, complete: true, pages: 1}}); } catch { return null; }
  return review;
}
export function parseReviewIndex(input) {
  const value = communityRecord(readPluginJson(input, {maximum: 16 * 1024 * 1024}), ['schemaVersion', 'type', 'catalogId', 'generatedAt', 'repository', 'reviews', 'deletedIssueIds', 'evidence'], 'review index');
  if (value.schemaVersion !== 1 || value.type !== 'ai-buddy-community-reviews' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository ?? '')) fail('Unsupported review index');
  pluginId(value.catalogId); communityDate(value.generatedAt);
  if (!Array.isArray(value.reviews) || value.reviews.length > 50000 || !Array.isArray(value.deletedIssueIds ?? [])) fail('Invalid reviews');
  const issues = new Set();
  for (const review of value.reviews) {
    communityRecord(review, ['workId', 'version', 'stars', 'text', 'githubUserId', 'githubLogin', 'issueId', 'issueNumber', 'issueNodeId', 'url', 'createdAt', 'updatedAt'], 'review');
    pluginId(review.workId); parsePluginVersion(review.version); communityText(review.text, 'review text', 10000); communityText(review.githubLogin, 'GitHub login', 39);
    for (const key of ['githubUserId', 'issueId', 'issueNumber']) if (!Number.isSafeInteger(review[key]) || review[key] <= 0) fail('GitHub identity must come from API');
    if (!Number.isInteger(review.stars) || review.stars < 1 || review.stars > 5 || issues.has(review.issueId)) fail('Invalid or duplicate rating');
    if (new URL(communityHttps(review.url)).origin !== 'https://github.com' || new URL(review.url).pathname !== '/' + value.repository + '/issues/' + review.issueNumber) fail('Review URL does not match API identity');
    communityText(review.issueNodeId, 'GitHub node identity', 200); communityDate(review.createdAt); communityDate(review.updatedAt); issues.add(review.issueId);
  }
  if (value.deletedIssueIds?.some(id => !Number.isSafeInteger(id) || id <= 0 || issues.has(id))) fail('Invalid deleted review identity');
  communityRecord(value.evidence, ['provider', 'fetchedAt', 'complete', 'pages'], 'index evidence');
  if (value.evidence.provider !== 'github-api' || value.evidence.complete !== true || !Number.isSafeInteger(value.evidence.pages) || value.evidence.pages < 1) fail('Incomplete GitHub API evidence');
  communityDate(value.evidence.fetchedAt);
  return freezePluginData(value);
}
export function verifyReviewIndex(envelope, source, catalogId) {
  if (!source || source.enabled === false || source.removed) fail('Trusted enabled source required');
  const result = verifySignedPluginPayload(envelope, {namespace: REVIEW_NAMESPACE, trustedKeys: {[source.keyId]: source.publicKey}});
  const value = parseReviewIndex(result.payload); if (value.catalogId !== catalogId) fail('Review index belongs to another catalog');
  return freezePluginData({...value, verified: {...result.verified, sourceId: source.sourceId}});
}
export function aggregateReviews(index, validWorks) {
  const allowed = validWorks ? new Set(validWorks) : null, latest = new Map();
  for (const row of index?.reviews ?? []) {
    if (allowed && !allowed.has(row.workId)) continue;
    const key = row.workId + ':' + row.githubUserId, prior = latest.get(key);
    if (!prior || Date.parse(row.updatedAt) > Date.parse(prior.updatedAt) || row.updatedAt === prior.updatedAt && row.issueId > prior.issueId) latest.set(key, row);
  }
  const totals = {};
  for (const row of latest.values()) { const aggregate = totals[row.workId] ??= {count: 0, sum: 0, distribution: [0, 0, 0, 0, 0], reviews: []}; aggregate.count++; aggregate.sum += row.stars; aggregate.distribution[row.stars - 1]++; aggregate.reviews.push(row); }
  for (const value of Object.values(totals)) value.reviews.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.issueId - left.issueId);
  return totals;
}
/** Opening this URL records a pending draft, never a successful review. */
// marker (optional, 8 hex): a draft tag in the issue title so 「检查」 can find the issue without a pasted link. The title is never parsed as review data.
export function buildReviewFormUrl({repository, workId, version, stars, text = '', marker}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !Number.isInteger(stars) || stars < 1 || stars > 5 || marker !== undefined && !/^[0-9a-f]{8}$/.test(marker)) fail('Invalid review draft');
  pluginId(workId); communityText(version, 'version', 150); communityText(text, 'review text', 10000, true);
  const url = new URL('https://github.com/' + repository + '/issues/new');
  url.searchParams.set('template', 'community-review.yml'); url.searchParams.set('title', '[Review] ' + workId + (marker ? ' #' + marker : '')); url.searchParams.set('work-id', workId); url.searchParams.set('work-version', version); url.searchParams.set('stars', String(stars)); url.searchParams.set('review-text', text);
  return url.href;
}
