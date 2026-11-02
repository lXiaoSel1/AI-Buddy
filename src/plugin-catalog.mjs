import {createHash, createPublicKey, verify as verifySignature} from 'node:crypto';
import {
  PLUGIN_API_VERSION, PLUGIN_PACKAGE_LIMIT, canonicalPluginJson, compareVersions, freezePluginData,
  parsePluginManifest, parsePluginVersion, pluginBytes, pluginCompatibility, pluginHttpsUrl,
  pluginId, pluginSha256, readPluginJson, satisfiesVersionRange, validateVersionRange,
} from './plugin-manifest.mjs';

export const PLUGIN_CATALOG_VERSION = 1;
export const PLUGIN_CATALOG_NAMESPACE = 'ai-buddy-plugin-catalog';
// Same public release identity as installer/Core/ReleaseIdentity.cs. No development key is trusted here.
export const OFFICIAL_PLUGIN_TRUST_KEYS = Object.freeze({
  'ai-buddy-release': 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFLmFoAgOaffTLAwNJ+U1v0MK4iaTHbMZ+BjaidVla05',
});
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
function fail(message, code = 'INVALID_PLUGIN_CATALOG') { const error = new Error(message); error.code = code; throw error; }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be an object'); return value; }
function fields(value, allowed) { if (Object.keys(value).some(key => !allowed.includes(key))) fail('Unknown catalog field'); }
function date(value) {
  const match = typeof value === 'string' && /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?Z$/.exec(value);
  const time = match ? Date.parse(value) : NaN;
  if (!match || !Number.isFinite(time) || new Date(time).toISOString() !== match[1] + '.' + (match[2] ?? '').padEnd(3, '0') + 'Z') fail('Invalid catalog date');
  return value;
}
function shortText(value, label, limit) { if (typeof value !== 'string' || value.length > limit || /\x00/.test(value)) fail('Invalid ' + label); return value; }

export function parsePluginCatalog(input) {
  const catalog = object(readPluginJson(input, {maximum: MAX_CATALOG_BYTES}), 'Catalog');
  fields(catalog, ['schemaVersion', 'id', 'generatedAt', 'packages']);
  if (catalog.schemaVersion !== PLUGIN_CATALOG_VERSION) fail('Unsupported plugin catalog version');
  pluginId(catalog.id); date(catalog.generatedAt);
  if (!Array.isArray(catalog.packages) || catalog.packages.length > 1000) fail('Invalid catalog package list');
  const identities = new Set(), archives = new Map();
  const packages = catalog.packages.map(item => {
    object(item, 'Catalog package'); fields(item, ['manifest', 'archive', 'publishedAt', 'releaseNotes']);
    const manifest = parsePluginManifest(item.manifest), archive = object(item.archive, 'Archive');
    fields(archive, ['url', 'bytes', 'sha256']);
    pluginHttpsUrl(archive.url); pluginBytes(archive.bytes, {positive: true, maximum: PLUGIN_PACKAGE_LIMIT}); pluginSha256(archive.sha256);
    if (!/\.(?:zip|aibuddy-plugin|aibuddy-pack)(?:$)/i.test(new URL(archive.url).pathname)) fail('Unsupported archive container');
    date(item.publishedAt);
    if (Date.parse(item.publishedAt) > Date.parse(catalog.generatedAt)) fail('Package publication is later than catalog generation');
    if (item.releaseNotes !== undefined) shortText(item.releaseNotes, 'release notes', 20000);
    // Build metadata is not a distinct release version: prevent ambiguous precedence and overwrite.
    const identity = `${manifest.id}@${manifest.version.split('+')[0]}:${manifest.platform}-${manifest.arch}`;
    if (identities.has(identity)) fail('Duplicate package identity'); identities.add(identity);
    const reused = archives.get(archive.url);
    if (reused && (reused.sha256 !== archive.sha256 || reused.bytes !== archive.bytes)) fail('Conflicting archive URL');
    archives.set(archive.url, archive);
    return {...item, manifest, archive: {...archive}};
  });
  return freezePluginData({...catalog, packages});
}

function binaryReader(bytes) {
  let position = 0;
  const raw = n => { if (!Number.isSafeInteger(n) || n < 0 || position + n > bytes.length) fail('Truncated SSH signature', 'PLUGIN_SIGNATURE_INVALID'); const result = bytes.subarray(position, position + n); position += n; return result; };
  const uint32 = () => raw(4).readUInt32BE(0);
  return {raw, uint32, field() { const length = uint32(); if (length > 1024 * 1024) fail('SSH field exceeds limit', 'PLUGIN_SIGNATURE_INVALID'); return raw(length); }, end: () => position === bytes.length};
}
function field(bytes) { const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return Buffer.concat([length, bytes]); }
function strictBase64(value) {
  if (typeof value !== 'string' || !value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('Invalid base64 signature', 'PLUGIN_SIGNATURE_INVALID');
  return Buffer.from(value, 'base64');
}
function sshPublicKey(openssh) {
  const parts = openssh.trim().split(/\s+/);
  if (parts[0] !== 'ssh-ed25519' || !parts[1]) fail('Only Ed25519 trust keys are supported', 'PLUGIN_SIGNATURE_INVALID');
  const blob = strictBase64(parts[1]), reader = binaryReader(blob);
  if (reader.field().toString() !== 'ssh-ed25519') fail('Invalid SSH public key', 'PLUGIN_SIGNATURE_INVALID');
  const raw = reader.field();
  if (!reader.end() || raw.length !== 32) fail('Invalid SSH public key', 'PLUGIN_SIGNATURE_INVALID');
  return {blob, key: createPublicKey({key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), type: 'spki', format: 'der'})};
}
function trustKey(value) {
  if (typeof value === 'string' && value.startsWith('ssh-ed25519 ')) return sshPublicKey(value).key;
  const key = value?.type === 'public' ? value : createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519') fail('Only Ed25519 trust keys are supported', 'PLUGIN_SIGNATURE_INVALID');
  return key;
}
function verifySshSignature(message, armored, trusted, expectedNamespace = PLUGIN_CATALOG_NAMESPACE) {
  if (typeof armored !== 'string' || armored.length > 16000) return false;
  const match = /^-----BEGIN SSH SIGNATURE-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END SSH SIGNATURE-----\r?\n?$/.exec(armored);
  if (!match) return false;
  const reader = binaryReader(strictBase64(match[1].replace(/\s/g, '')));
  if (reader.raw(6).toString() !== 'SSHSIG' || reader.uint32() !== 1) return false;
  const signer = reader.field(), namespace = reader.field(), reserved = reader.field(), hashName = reader.field(), signed = reader.field();
  if (!reader.end() || namespace.toString() !== expectedNamespace || reserved.length || !['sha256', 'sha512'].includes(hashName.toString())) return false;
  const signerKey = sshPublicKey('ssh-ed25519 ' + signer.toString('base64')).key;
  const key = trustKey(trusted);
  if (!key.export({format: 'der', type: 'spki'}).equals(signerKey.export({format: 'der', type: 'spki'}))) return false;
  const signatureReader = binaryReader(signed);
  if (signatureReader.field().toString() !== 'ssh-ed25519') return false;
  const signature = signatureReader.field();
  if (!signatureReader.end() || signature.length !== 64) return false;
  const digest = createHash(hashName.toString()).update(message).digest();
  const data = Buffer.concat([Buffer.from('SSHSIG'), field(namespace), field(reserved), field(hashName), field(digest)]);
  return verifySignature(null, data, key, signature);
}

/** A detached signature covers the entire catalog, including manifests and archive hashes.
 * Offline installation must call the same verifier. Trust keys come from the host,
 * never from the envelope. Test roots are accepted only through explicit injection.
 */
export function verifySignedPluginPayload(input, {trustedKeys = OFFICIAL_PLUGIN_TRUST_KEYS, namespace = PLUGIN_CATALOG_NAMESPACE} = {}) {
  if (typeof namespace !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,100}$/.test(namespace)) fail('Invalid signature namespace');
  const envelope = object(readPluginJson(input, {maximum: MAX_CATALOG_BYTES + 20000}), 'Signed catalog');
  fields(envelope, ['payload', 'signature']);
  const signature = object(envelope.signature, 'Catalog signature');
  fields(signature, ['algorithm', 'keyId', 'value']);
  pluginId(signature.keyId);
  if (!['ed25519', 'sshsig'].includes(signature.algorithm)) fail('Unsupported catalog signature', 'PLUGIN_SIGNATURE_INVALID');
  const trusted = trustedKeys instanceof Map ? trustedKeys.get(signature.keyId) : Object.hasOwn(trustedKeys, signature.keyId) ? trustedKeys[signature.keyId] : undefined;
  if (!trusted) fail('Catalog signing key is not trusted', 'PLUGIN_SIGNATURE_UNTRUSTED');
  const payload = Buffer.from(canonicalPluginJson(envelope.payload), 'utf8');
  if (payload.length > MAX_CATALOG_BYTES) fail('Catalog exceeds size limit');
  let valid = false;
  try {
    if (signature.algorithm === 'sshsig') valid = verifySshSignature(payload, signature.value, trusted, namespace);
    else { const bytes = strictBase64(signature.value); valid = bytes.length === 64 && verifySignature(null, payload, trustKey(trusted), bytes); }
  } catch { valid = false; }
  if (!valid) fail('Catalog signature verification failed', 'PLUGIN_SIGNATURE_INVALID');
  return freezePluginData({payload: envelope.payload, verified: {keyId: signature.keyId, algorithm: signature.algorithm, payloadSha256: sha(payload), namespace}});
}

export function verifyPluginCatalog(input, options = {}) {
  const {payload, verified} = verifySignedPluginPayload(input, {...options, namespace: PLUGIN_CATALOG_NAMESPACE});
  const {namespace, ...proof} = verified;
  return freezePluginData({...parsePluginCatalog(payload), verified: proof});
}

export function catalogPackages(catalog, {appVersion, apiVersion = PLUGIN_API_VERSION, platform = 'win32', arch = 'x64', query = '', kind} = {}) {
  const parsed = parsePluginCatalog(Object.fromEntries(Object.entries(catalog).filter(([key]) => key !== 'verified'))), needle = String(query).trim().toLocaleLowerCase();
  return parsed.packages.filter(item => (!kind || item.manifest.kind === kind) && (!needle || [item.manifest.id, item.manifest.name, item.manifest.description, item.manifest.author, ...(item.manifest.tags ?? [])].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle)))
    .map(item => ({...item, ...pluginCompatibility(item.manifest, {appVersion, apiVersion, platform, arch})}))
    .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id) || -compareVersions(a.manifest.version, b.manifest.version));
}

/** Freeze all dependency versions before any download; deterministic backtracking
 * handles a later dependency constraining an earlier latest-version choice.
 * Installed packages are reused only when their version AND archive digest match.
 */
export function resolvePluginInstallPlan(catalog, requests, {installed = [], appVersion, apiVersion = PLUGIN_API_VERSION, platform = 'win32', arch = 'x64'} = {}) {
  if (!Array.isArray(requests) || !requests.length || requests.length > 100) fail('Choose at least one package', 'PLUGIN_DEPENDENCY_ERROR');
  const packages = catalogPackages(catalog, {appVersion, apiVersion, platform, arch}).filter(item => item.compatible);
  const byId = new Map();
  for (const item of packages) { const list = byId.get(item.manifest.id) ?? []; list.push(item); byId.set(item.manifest.id, list); }
  const requirements = new Map(), roots = [];
  for (const request of requests) {
    const spec = typeof request === 'string' ? {id: request, range: '*'} : object(request, 'Package selection');
    pluginId(spec.id); const range = spec.version ?? spec.range ?? '*';
    if (spec.version !== undefined) parsePluginVersion(spec.version); validateVersionRange(range);
    requirements.set(spec.id, [...(requirements.get(spec.id) ?? []), range]); roots.push({id: spec.id, range});
  }
  let steps = 0, cycle = false;
  function hasCycle(selected) {
    const visiting = new Set(), done = new Set();
    function visit(id) {
      if (visiting.has(id)) return true; if (done.has(id) || !selected.has(id)) return false;
      visiting.add(id);
      for (const dependency of Object.keys(selected.get(id).manifest.dependencies)) if (visit(dependency)) return true;
      visiting.delete(id); done.add(id); return false;
    }
    return [...selected.keys()].some(visit);
  }
  function solve(constraints, selected) {
    if (++steps > 10000) fail('Package dependency search exceeds limit', 'PLUGIN_DEPENDENCY_ERROR');
    for (const [id, ranges] of constraints) if (selected.has(id) && !ranges.every(range => satisfiesVersionRange(selected.get(id).manifest.version, range))) return null;
    if (hasCycle(selected)) { cycle = true; return null; }
    const next = [...constraints.keys()].find(id => !selected.has(id));
    if (!next) return selected;
    if (constraints.size > 100) fail('Too many transitive dependencies', 'PLUGIN_DEPENDENCY_ERROR');
    for (const candidate of byId.get(next) ?? []) {
      if (!constraints.get(next).every(range => satisfiesVersionRange(candidate.manifest.version, range))) continue;
      const nextSelected = new Map(selected); nextSelected.set(next, candidate);
      const nextConstraints = new Map([...constraints].map(([id, ranges]) => [id, [...ranges]]));
      for (const [id, range] of Object.entries(candidate.manifest.dependencies)) nextConstraints.set(id, [...(nextConstraints.get(id) ?? []), range]);
      const result = solve(nextConstraints, nextSelected); if (result) return result;
    }
    return null;
  }
  const selected = solve(requirements, new Map());
  if (!selected) fail(cycle ? 'Cyclic package dependencies' : 'Missing, incompatible, or conflicting package dependency', 'PLUGIN_DEPENDENCY_ERROR');
  const ordered = [], visited = new Set();
  function visit(id) { if (visited.has(id)) return; for (const dependency of Object.keys(selected.get(id).manifest.dependencies).sort()) visit(dependency); visited.add(id); ordered.push(selected.get(id)); }
  for (const root of roots) visit(root.id);
  const installedList = Array.isArray(installed) ? installed : Object.values(installed);
  const result = ordered.map(item => ({...item, reuse: installedList.some(saved => saved.id === item.manifest.id && saved.version === item.manifest.version && (saved.sha256 ?? saved.archiveSha256 ?? saved.archive?.sha256) === item.archive.sha256)}));
  const plan = {schemaVersion: 1, catalogId: catalog.id, catalogSha256: catalog.verified?.payloadSha256 ?? null, roots, appVersion, apiVersion, platform, arch, packages: result,
    downloadBytes: result.filter(item => !item.reuse).reduce((sum, item) => sum + item.archive.bytes, 0),
    unpackedBytes: result.filter(item => !item.reuse).reduce((sum, item) => sum + item.manifest.files.reduce((n, file) => n + file.bytes, 0), 0)};
  return freezePluginData({...plan, planId: sha(canonicalPluginJson(plan))});
}
