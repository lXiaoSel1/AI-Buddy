import {createHash} from 'node:crypto';
import {canonicalPluginJson, freezePluginData, parsePluginVersion, pluginId, pluginSha256, readPluginJson, validateVersionRange} from '../plugin-manifest.mjs';
import {verifySignedPluginPayload} from '../plugin-catalog.mjs';
import {pluginSourceFingerprint} from '../plugin-sources.mjs';
import {normalizeCommunitySource} from './official-source.mjs';

export const COMMUNITY_NAMESPACE = 'ai-buddy-community-catalog';
export const COMMUNITY_CATEGORIES = Object.freeze(['function', 'work-engine', 'character-motion', 'theme-scene', 'voice']);
const error = message => { throw Object.assign(Error(message), {code: 'COMMUNITY_CATALOG_INVALID'}); };
export function communityRecord(value, keys, label = 'community record') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) error('Invalid ' + label);
  return value;
}
export function communityText(value, label = 'text', max = 4000, empty = false) {
  if (typeof value !== 'string' || value.length > max || !empty && !value.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) error('Invalid ' + label);
  return value;
}
export function communityDate(value) { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) error('Invalid date'); return value; }
export function communityHttps(value) {
  communityText(value, 'URL', 2048); let url;
  try { url = new URL(value); } catch { error('Invalid URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) error('HTTPS URL required');
  return url.href;
}
const list = (value, maximum, map) => { if (!Array.isArray(value) || value.length > maximum) error('Invalid list'); return value.map(map); };
// Optional translations (contract C-6): {en: {name, description, readme}} on a work, {en: {notes}} on a release.
const LOCALE_LIMITS = {name: 150, description: 4000, readme: 100000, notes: 20000};
function communityLocales(value, fields, label) {
  if (value === undefined) return;
  for (const entry of Object.values(communityRecord(value, ['en'], label + ' locales'))) { communityRecord(entry, fields, label + ' translation'); for (const [key, text] of Object.entries(entry)) communityText(text, label + ' ' + key, LOCALE_LIMITS[key], key !== 'name'); }
}
const unique = (items, key) => { const seen = new Set(); for (const item of items) { const id = key(item); if (seen.has(id)) error('Duplicate community identity'); seen.add(id); } return items; };
export const communityPackageKey = value => [value.backend, value.sourceId, value.packageName].join(':');
export const communityReleaseKey = value => communityPackageKey(value) + '@' + value.exactVersion;

export function parseDshPackageRef(input, {sourceId} = {}) {
  const value = communityRecord(input, ['backend', 'packageName', 'exactVersion', 'sourceDigest', 'digestType', 'spec', 'compatibility', 'capabilities', 'dataSchemaVersion'], 'DSH package');
  if (value.backend !== 'dsh' || !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value.packageName ?? '') || value.packageName.length > 214) error('Invalid DSH package identity');
  parsePluginVersion(value.exactVersion); pluginSha256(value.sourceDigest);
  const spec = communityRecord(value.spec, ['kind', 'value', 'commit'], 'package spec'); communityText(spec.value, 'package spec', 2048);
  if (!['registry', 'git', 'tarball'].includes(spec.kind)) error('Unsupported DSH package spec');
  const digestType = value.digestType ?? 'tarball-sha256';
  if (spec.kind === 'git' ? digestType !== 'git-archive-sha256' : digestType !== 'tarball-sha256') error('Package digest type does not match the source kind');
  if (spec.kind === 'registry') { if (spec.value !== value.packageName + '@' + value.exactVersion || spec.commit !== undefined) error('Registry package must use an exact version'); }
  else {
    const url = new URL(communityHttps(spec.value));
    if (spec.kind === 'tarball' && (url.search || url.hash || !/\.(tgz|tar\.gz)$/.test(url.pathname) || /(?:^|\/)latest(?:\/|$)/i.test(url.pathname))) error('Immutable tarball URL required');
    if (spec.kind === 'git' && (!/^[0-9a-f]{40}$/.test(spec.commit ?? '') || url.search || url.hash)) error('Git package must pin a complete commit');
  }
  const compatibility = communityRecord(value.compatibility, ['app', 'dsh', 'bridge'], 'compatibility');
  for (const range of Object.values(compatibility)) validateVersionRange(range);
  if (!compatibility.app || !compatibility.dsh || !compatibility.bridge) error('Complete compatibility ranges required');
  const capabilities = unique(list(value.capabilities ?? [], 100, item => { communityText(item, 'capability', 150); if (!/^[a-z][a-zA-Z0-9.-]+$/.test(item)) error('Invalid capability'); return item; }), item => item);
  const dataSchemaVersion = value.dataSchemaVersion ?? 1;
  if (!Number.isSafeInteger(dataSchemaVersion) || dataSchemaVersion < 1 || dataSchemaVersion > 65536) error('Invalid data schema');
  return freezePluginData({...value, digestType, ...(sourceId ? {sourceId} : {}), capabilities, dataSchemaVersion});
}

export function parseCommunityCatalog(input) {
  const value = communityRecord(readPluginJson(input, {maximum: 16 * 1024 * 1024}), ['schemaVersion', 'type', 'id', 'generatedAt', 'source', 'authors', 'works'], 'catalog');
  if (value.schemaVersion !== 1 || value.type !== 'ai-buddy-community-catalog') error('Unsupported community catalog');
  pluginId(value.id); communityDate(value.generatedAt);
  const source = communityRecord(value.source, ['descriptorId', 'keyFingerprint'], 'source'); pluginId(source.descriptorId); communityText(source.keyFingerprint, 'source fingerprint', 150);
  const authors = unique(list(value.authors, 2000, raw => {
    const author = communityRecord(raw, ['id', 'name', 'githubLogin', 'url', 'description', 'avatarUrl'], 'author'); pluginId(author.id); communityText(author.name, 'author name', 150);
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(author.githubLogin ?? '')) error('Invalid GitHub login');
    if (author.url) communityHttps(author.url); if (author.avatarUrl) communityHttps(author.avatarUrl); if (author.description) communityText(author.description, 'author description', 4000);
    return author;
  }), author => author.id);
  const authorIds = new Set(authors.map(author => author.id));
  const works = unique(list(value.works, 10000, raw => {
    const work = communityRecord(raw, ['id', 'backend', 'packageName', 'name', 'description', 'authorId', 'category', 'tags', 'screenshots', 'readme', 'repositoryUrl', 'discussionUrl', 'reviewsRepository', 'releases', 'status', 'statusReason', 'statistics', 'locales'], 'work');
    pluginId(work.id); communityText(work.name, 'work name', 150); communityText(work.description, 'work description', 4000, true); communityLocales(work.locales, ['name', 'description', 'readme'], 'work');
    if (!authorIds.has(work.authorId) || !COMMUNITY_CATEGORIES.includes(work.category) || !['buddy-v1', 'dsh'].includes(work.backend)) error('Invalid work relationship');
    communityText(work.packageName, 'package name', 214);
    for (const key of ['repositoryUrl', 'discussionUrl']) if (work[key]) communityHttps(work[key]);
    if (work.reviewsRepository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(work.reviewsRepository)) error('Invalid review repository');
    if (work.readme) communityText(work.readme, 'readme', 100000);
    list(work.tags ?? [], 30, tag => communityText(tag, 'tag', 80)); list(work.screenshots ?? [], 12, communityHttps);
    if (!['published', 'withdrawn', 'unsupported-category'].includes(work.status ?? 'published')) error('Invalid work state');
    if (work.statusReason) communityText(work.statusReason, 'status reason', 4000);
    unique(list(work.releases, 200, release => {
      communityRecord(release, ['version', 'publishedAt', 'package', 'notes', 'locales'], 'release'); parsePluginVersion(release.version); communityDate(release.publishedAt); communityLocales(release.locales, ['notes'], 'release');
      if (Date.parse(release.publishedAt) > Date.parse(value.generatedAt)) error('Release newer than catalog');
      if (release.notes) communityText(release.notes, 'release notes', 20000);
      if (work.backend === 'dsh') { const ref = parseDshPackageRef(release.package); if (ref.packageName !== work.packageName || ref.exactVersion !== release.version) error('DSH release mismatch'); }
      else if (release.package !== undefined) error('Legacy package metadata belongs to its existing signed catalog');
      return release;
    }), release => release.version.split('+')[0]);
    if (!work.releases.length) error('Work must have a release');
    if (work.statistics) { communityRecord(work.statistics, ['downloadCount90d', 'windowStart', 'windowEnd', 'provenance'], 'statistics'); const n = work.statistics.downloadCount90d; if (n !== null && (!Number.isSafeInteger(n) || n < 0)) error('Invalid download count'); communityDate(work.statistics.windowStart); communityDate(work.statistics.windowEnd); communityText(work.statistics.provenance, 'statistics provenance', 2000); }
    return work;
  }), work => work.id);
  return freezePluginData({...value, authors, works});
}

export function verifyCommunityCatalog(envelope, trustedSource) {
  trustedSource = normalizeCommunitySource(trustedSource);
  if (!trustedSource || trustedSource.enabled === false || trustedSource.removed || !trustedSource.publicKey || !trustedSource.sourceId) error('Trusted enabled source required');
  const {payload, verified} = verifySignedPluginPayload(envelope, {namespace: COMMUNITY_NAMESPACE, trustedKeys: {[trustedSource.keyId]: trustedSource.publicKey}});
  const catalog = parseCommunityCatalog(payload), fingerprint = pluginSourceFingerprint(trustedSource.publicKey);
  if (catalog.source.keyFingerprint !== fingerprint || trustedSource.keyFingerprint !== fingerprint || catalog.source.descriptorId !== trustedSource.descriptorId) error('Community catalog does not match its pinned source');
  return freezePluginData({...catalog, verified: {...verified, sourceId: trustedSource.sourceId, keyFingerprint: fingerprint}});
}

/** Missing statistics stay null. Rank only combines observed components. */
export function rankCommunityWorks(works, {ratings = {}, now = Date.now()} = {}) {
  const known = works.map(work => work.statistics?.downloadCount90d).filter(value => Number.isSafeInteger(value));
  const maximum = Math.max(1, ...known), weights = {rating: 0.65, downloads: 0.25, recency: 0.10};
  return works.map(work => {
    const review = ratings[work.id], count = review?.count ?? 0, mean = count ? review.sum / count : null;
    const smoothed = count ? (review.sum + 3 * 5) / (count + 5) : null;
    const downloads = work.statistics?.downloadCount90d ?? null, newest = Math.max(...work.releases.map(release => Date.parse(release.publishedAt)));
    const components = {rating: smoothed === null ? null : (smoothed - 1) / 4, downloads: downloads === null ? null : Math.log1p(downloads) / Math.log1p(maximum), recency: Math.exp(-Math.max(0, now - newest) / (90 * 86400000))};
    const available = Object.entries(components).filter(([, score]) => score !== null);
    const score = available.reduce((sum, [key, value]) => sum + weights[key] * value, 0) / available.reduce((sum, [key]) => sum + weights[key], 0);
    return {...work, rating: {mean, count, smoothed, insufficientSample: count < 5}, recommendation: {score, components, formula: 'bayes(3,5)*.65 + log1p(downloads90d)*.25 + exp(-age/90d)*.10; missing weights redistributed'}};
  }).sort((left, right) => right.recommendation.score - left.recommendation.score || left.id.localeCompare(right.id));
}

export const communityDigest = value => createHash('sha256').update(canonicalPluginJson(value)).digest('hex');
