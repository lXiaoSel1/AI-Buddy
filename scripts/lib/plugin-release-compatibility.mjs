/** New-publication policy. Historical signed records are checked for immutability,
 * never rewritten to satisfy today's admission policy. Keep standalone copies in
 * plugin source repositories identical to this file. */
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const fail = message => { throw Object.assign(Error(message), {code: 'PLUGIN_RELEASE_COMPATIBILITY'}); };
function version(value, label) {
  const match = typeof value === 'string' && valuePattern(value);
  if (!match) fail(label + ': invalid complete semver');
  return value;
}
function valuePattern(value) {
  const match = versionPattern.exec(value);
  return match && match.slice(1, 4).every(part => Number.isSafeInteger(Number(part))) &&
    (!match[4] || match[4].split('.').every(part => !/^\d+$/.test(part) || !/^0\d/.test(part) && Number.isSafeInteger(Number(part))));
}
function terms(range, label) {
  if (typeof range !== 'string' || !range || range.length > 500) fail(label + ': invalid range');
  const branches = range.split(/\s*\|\|\s*/);
  if (branches.length > 8) fail(label + ': too many range branches');
  return branches.map(branch => {
    if (branch === '*') return [{op: '*'}];
    const parts = branch.split(/\s+/);
    if (!parts.length || parts.length > 16) fail(label + ': invalid range');
    return parts.map(part => {
      const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(part);
      if (!match) fail(label + ': invalid range');
      version(match[2], label);
      return {op: match[1] || '=', version: match[2]};
    });
  });
}
export function assertHostLowerBound(range, label) {
  if (typeof range !== 'string' || !/^>=\S+$/.test(range)) fail(label + ': use one >=X lower bound, without an upper bound');
  version(range.slice(2), label);
}
function assertInterfaceUpperBound(range, label) {
  const branches = terms(range, label);
  if (branches.some(branch => !branch.some(term => term.op === '^' || term.op === '<'))) fail(label + ': use ^X or an explicit < upper bound in every branch');
}
export const COORDINATED_EXACT_DEPENDENCIES = Object.freeze({
  'ai-buddy.voice-breeze': Object.freeze({'ai-buddy.voice-shared-runtime': 'The voice engine and shared runtime are released together at the same package version.'}),
  'ai-buddy.voice-gpt-sovits': Object.freeze({'ai-buddy.voice-shared-runtime': 'The voice engine and shared runtime are released together at the same package version.'}),
});
export function assertNewReleaseCompatibility(manifest, {sourceManifest} = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('Release manifest is required');
  const id = manifest.id ?? manifest.packageName, releaseVersion = manifest.version ?? manifest.exactVersion;
  version(releaseVersion, 'version');
  if (typeof id !== 'string' || !id) fail('Release identity is required');
  if (manifest.compatibility) {
    for (const field of ['app', 'dsh']) assertHostLowerBound(manifest.compatibility[field], 'compatibility.' + field);
    assertInterfaceUpperBound(manifest.compatibility.bridge, 'compatibility.bridge');
  } else {
    assertHostLowerBound(manifest.appRange, 'appRange');
    assertInterfaceUpperBound(manifest.apiRange, 'apiRange');
  }
  for (const [dependency, range] of [...Object.entries(manifest.dependencies ?? {}), ...Object.entries(sourceManifest?.dependencies ?? {})]) {
    const branches = terms(range, 'dependency ' + dependency), exact = branches.length === 1 && branches[0].length === 1 && branches[0][0].op === '=';
    if (branches.some(branch => branch.some(term => term.op === '=')) && (!exact || !COORDINATED_EXACT_DEPENDENCIES[id]?.[dependency] || branches[0][0].version !== releaseVersion)) fail('Exact dependency ' + dependency + ' is not a same-version coordinated voice dependency');
  }
  if (sourceManifest) {
    if (sourceManifest.name !== id || sourceManifest.version !== releaseVersion) fail('Source/release package identity differs');
    if (sourceManifest.engines?.dsh !== manifest.compatibility?.dsh) fail('Source engines.dsh must equal compatibility.dsh');
  }
  return {id, version: releaseVersion};
}
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
function immutableRows(previous, next, key, label) {
  const before = new Map(), after = new Map();
  for (const row of previous) { const id = key(row); if (before.has(id)) fail('Duplicate historical ' + label); before.set(id, row); }
  for (const row of next) { const id = key(row); if (after.has(id)) fail('Duplicate candidate ' + label); after.set(id, row); }
  for (const [id, row] of before) if (!after.has(id) || canonical(after.get(id)) !== canonical(row)) fail('Historical ' + label + ' changed or disappeared: ' + id);
  return next.filter(row => !before.has(key(row)));
}
export function assertCatalogReleaseCompatibility({legacy, community, baselineLegacy, baselineCommunity} = {}) {
  if (!Array.isArray(legacy?.packages) || !Array.isArray(community?.works) || !Array.isArray(baselineLegacy?.packages) || !Array.isArray(baselineCommunity?.works)) fail('Both explicit baseline and candidate catalogs are required');
  const newLegacy = immutableRows(baselineLegacy.packages, legacy.packages, row => row.manifest.id + '@' + row.manifest.version, 'legacy release');
  for (const row of newLegacy) assertNewReleaseCompatibility(row.manifest);
  const flat = catalog => catalog.works.flatMap(work => work.releases.map(release => ({id: work.id, backend: work.backend, release})));
  const newCommunity = immutableRows(flat(baselineCommunity), flat(community), row => row.id + '@' + row.release.version, 'community release');
  for (const row of newCommunity) {
    if (row.backend === 'dsh') {
      if (row.release.version !== row.release.package?.exactVersion) fail('Community release/package versions differ');
      assertNewReleaseCompatibility(row.release.package);
    } else if (!newLegacy.some(entry => entry.manifest.id === row.id && entry.manifest.version === row.release.version)) fail('New buddy-v1 release needs a corresponding newly checked legacy manifest');
  }
  return {historicalReleasesUnchanged: true, addedLegacyReleases: newLegacy.length, addedCommunityReleases: newCommunity.length};
}
