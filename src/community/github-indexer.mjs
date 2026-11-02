import {aggregateReviews, parseReviewIndex, reviewFromGitHubIssue} from './reviews.mjs';

const fail = (message, code = 'COMMUNITY_GITHUB_FAILED') => { throw Object.assign(Error(message), {code}); };
const validRepository = repository => { if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) fail('Invalid GitHub repository'); return repository; };

/** Read-only API crawler. A partial crawl is never returned as a complete shared index. */
export async function buildGitHubReviewIndex({repository, catalogId, validWorkIds, validVersionsByWork, previousIndex, fetchImpl = globalThis.fetch, token, now = Date.now, maximumPages = 1000, signal} = {}) {
  validRepository(repository);
  const base = 'https://api.github.com/repos/' + repository + '/issues';
  const headers = {Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'AI-Buddy-Community-Indexer'};
  if (token) headers.Authorization = 'Bearer ' + token;
  let url = base + '?state=all&labels=community-review&per_page=100', pages = 0;
  const issues = [], seen = new Set(), seenPages = new Set();
  while (url) {
    if (++pages > maximumPages || seenPages.has(url)) fail('Review pagination did not terminate', 'COMMUNITY_GITHUB_PAGINATION'); seenPages.add(url);
    const response = await fetchImpl(url, {headers, signal, redirect: 'error'});
    if (!response.ok) fail('GitHub review read failed: HTTP ' + response.status);
    const values = await response.json(); if (!Array.isArray(values)) fail('GitHub issue list is invalid');
    for (const issue of values) { if (!Number.isSafeInteger(issue?.id) || seen.has(issue.id)) continue; seen.add(issue.id); issues.push(issue); }
    const link = response.headers.get('link') ?? '', match = /<([^>]+)>;\s*rel="next"/.exec(link);
    if (!match) { url = null; continue; }
    const next = new URL(match[1]); if (next.origin !== 'https://api.github.com' || next.pathname !== new URL(base).pathname || next.username || next.password || next.searchParams.get('labels') !== 'community-review' || next.searchParams.get('state') !== 'all') fail('Untrusted GitHub pagination URL', 'COMMUNITY_GITHUB_PAGINATION'); url = next.href;
  }
  const reviews = issues.map(issue => reviewFromGitHubIssue(issue, {repository, validWorkIds, validVersionsByWork})).filter(Boolean), activeIds = new Set(reviews.map(review => review.issueId));
  if (previousIndex && previousIndex.repository !== repository) fail('Previous index repository differs');
  const deletedIssueIds = [...new Set([...(previousIndex?.deletedIssueIds ?? []), ...(previousIndex?.reviews ?? []).filter(review => !activeIds.has(review.issueId)).map(review => review.issueId)])].filter(id => !activeIds.has(id)).sort((a, b) => a - b);
  const timestamp = new Date(now()).toISOString();
  const index = {schemaVersion: 1, type: 'ai-buddy-community-reviews', catalogId, generatedAt: timestamp, repository, reviews: reviews.sort((a, b) => a.issueId - b.issueId), deletedIssueIds, evidence: {provider: 'github-api', fetchedAt: timestamp, complete: true, pages}};
  parseReviewIndex(index);
  return {index, totals: aggregateReviews(index, validWorkIds), receipt: {provider: 'github-api', repository, pages, issueRecordsRead: issues.length, validReviewRecords: reviews.length, deletedOrInvalidatedRecords: deletedIssueIds.length, inferenceRequests: 0, methodsUsed: ['GET'], fetchedAt: timestamp}};
}

/** Cumulative asset downloads are not fabricated into a 90-day window. */
export async function readGitHubDownloadStatistics({repository, assetNames, fetchImpl = globalThis.fetch, token, now = Date.now, signal} = {}) {
  validRepository(repository); if (!Array.isArray(assetNames) || !assetNames.length || assetNames.some(name => typeof name !== 'string' || name.length > 250) || new Set(assetNames).size !== assetNames.length) fail('Explicit canonical asset names are required');
  const headers = {Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'AI-Buddy-Community-Indexer'}; if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetchImpl('https://api.github.com/repos/' + repository + '/releases?per_page=100', {headers, signal, redirect: 'error'}); if (!response.ok) fail('GitHub release read failed: HTTP ' + response.status);
  const releases = await response.json(); if (!Array.isArray(releases)) fail('GitHub release list is invalid');
  // A complete all-time total is unknown when pagination is needed. New samples
  // can later supply a real window; this first-party reader never guesses it.
  const complete = !/<[^>]+>;\s*rel="next"/.test(response.headers.get('link') ?? '');
  const assets = releases.flatMap(release => release.draft ? [] : release.assets ?? []).filter(asset => assetNames.includes(asset.name)), start = now() - 90 * 86400000;
  if (assets.some(asset => !Number.isSafeInteger(asset.download_count) || asset.download_count < 0 || !Number.isFinite(Date.parse(asset.created_at)))) fail('GitHub asset counters are invalid');
  const cumulative = complete ? assets.reduce((sum, asset) => sum + asset.download_count, 0) : null, entirelyInsideWindow = complete && assets.length > 0 && assets.every(asset => Date.parse(asset.created_at) >= start);
  return {cumulativeDownloadCount: cumulative, downloadCount90d: entirelyInsideWindow ? cumulative : null, windowStart: new Date(start).toISOString(), windowEnd: new Date(now()).toISOString(), provenance: 'GitHub release assets GET; canonical names: ' + assetNames.join(', ') + (entirelyInsideWindow ? '; all counted assets created inside this window' : '; no complete 90-day observation history, window count unknown'), assets: assets.map(asset => ({id: asset.id, name: asset.name, count: asset.download_count, createdAt: asset.created_at})), complete};
}
