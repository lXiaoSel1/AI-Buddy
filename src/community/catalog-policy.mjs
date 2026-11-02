import {OFFICIAL_PLUGIN_TRUST_KEYS} from '../plugin-catalog.mjs';
import {pluginSourceFingerprint} from '../plugin-sources.mjs';

export const OFFICIAL_SOURCE_FINGERPRINT = pluginSourceFingerprint(OFFICIAL_PLUGIN_TRUST_KEYS['ai-buddy-release']);
// Review 中-1: the oldest signed catalog this build accepts from a source, keyed by the source key fingerprint. Release
// tooling sets it to the generatedAt of the newest catalog published for the release, so an old signed file cannot bring
// back releases the publisher has since withdrawn. Official: the 2.0.1 catalog of 2026-10-29 (formal-201 stage).
export const COMMUNITY_MINIMUM_WATERMARKS = Object.freeze({[OFFICIAL_SOURCE_FINGERPRINT]: '2026-10-29T04:59:59.120Z'});
// Package names under @ai-buddy/ belong to the official source; another trusted source listing them is refused.
// AI_BUDDY_VALIDATION_OFFICIAL_FINGERPRINTS (comma separated) lets an isolated validation run sign them with a test key.
// It counts only in an app launched with --validation=1: an environment variable alone never widens official trust.
export const RESERVED_PACKAGE_SCOPE = '@ai-buddy/';
export function officialScopeFingerprints(env = process.env, argv = process.argv) {
  const extra = Array.isArray(argv) && argv.includes('--validation=1') ? String(env?.AI_BUDDY_VALIDATION_OFFICIAL_FINGERPRINTS ?? '').split(',').map(value => value.trim()).filter(value => /^SHA256:[A-Za-z0-9+/=]{20,}$/.test(value)) : [];
  return new Set([OFFICIAL_SOURCE_FINGERPRINT, ...extra]);
}
// Offline catalogs older than this get a visible warning that later withdrawals may be missing.
export const OFFLINE_CATALOG_WARN_DAYS = 30;
