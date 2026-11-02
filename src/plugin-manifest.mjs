/** Official extension package contract. This does not relax the application installer contract. */
export const PLUGIN_MANIFEST_VERSION = 1;
export const PLUGIN_API_VERSION = '1.0.0';
export const PLUGIN_PACKAGE_LIMIT = 1024 * 1024 * 1024;
export const PLUGIN_EXPANDED_LIMIT = 8 * PLUGIN_PACKAGE_LIMIT;
export const PLUGIN_CAPABILITIES = Object.freeze([
  'commands.register', 'settings.register', 'ui.registerPanel', 'storage',
  'events.subscribe', 'assets.resolve', 'harness.register', 'models.request', 'characters.getContext',
]);

function fail(message, code = 'INVALID_PLUGIN_MANIFEST') { const error = new Error(message); error.code = code; throw error; }
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(label + ' must be an object');
  return value;
}
function text(value, label, max = 500, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail('Invalid ' + label);
  return value;
}
const idPattern = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;
export function pluginId(value) { if (typeof value !== 'string' || value.length > 100 || !idPattern.test(value) || ['constructor', 'prototype'].includes(value)) fail('Invalid package id'); return value; }
export function pluginSha256(value) { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('Invalid SHA-256'); return value; }
export function pluginBytes(value, {positive = false, maximum = PLUGIN_EXPANDED_LIMIT} = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > maximum) fail('Invalid package size');
  return value;
}

/** Sorted, UTF-8 JSON with no trailing newline. Only JSON data is accepted. */
export function canonicalPluginJson(value) {
  const ancestors = new Set();
  function visit(item, depth) {
    if (depth > 100) fail('JSON nesting limit exceeded');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || !item || ancestors.has(item)) fail('Non-JSON or cyclic metadata');
    ancestors.add(item);
    let result;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length || Object.keys(item).some(key => !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) fail('Sparse or decorated JSON array');
      result = '[' + item.map(value => visit(value, depth + 1)).join(',') + ']';
    } else {
      record(item, 'Metadata');
      const keys = Object.keys(item).sort();
      result = '{' + keys.map(key => {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('Unsafe metadata key');
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !('value' in descriptor)) fail('Metadata accessors are unsupported');
        return JSON.stringify(key) + ':' + visit(descriptor.value, depth + 1);
      }).join(',') + '}';
    }
    ancestors.delete(item);
    return result;
  }
  return visit(value, 0);
}

export function freezePluginData(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freezePluginData(child); Object.freeze(value); }
  return value;
}
export function readPluginJson(value, {maximum = 4 * 1024 * 1024} = {}) {
  const source = typeof value === 'string' ? value : ArrayBuffer.isView(value) ? new TextDecoder('utf-8', {fatal: true}).decode(value) : canonicalPluginJson(value);
  if (new TextEncoder().encode(source).length > maximum) fail('Metadata exceeds size limit');
  try { const parsed = JSON.parse(source); canonicalPluginJson(parsed); return parsed; } catch (error) { fail('Invalid metadata JSON: ' + error.message); }
}

/** Deliberately accepts complete semver only; unrecognized ranges fail closed. */
export function parsePluginVersion(value) {
  if (typeof value !== 'string' || value.length > 150) fail('Invalid package version');
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) fail('Invalid package version: ' + value);
  const core = match.slice(1, 4).map(Number), pre = match[4] ? match[4].split('.') : [];
  if (core.some(n => !Number.isSafeInteger(n)) || pre.some(n => /^\d+$/.test(n) && (n.length > 1 && n[0] === '0' || !Number.isSafeInteger(Number(n))))) fail('Invalid package version: ' + value);
  return {value, core, pre};
}
export function compareVersions(a, b) {
  const left = parsePluginVersion(a), right = parsePluginVersion(b);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    if (left.pre[i] === undefined) return -1; if (right.pre[i] === undefined) return 1;
    const l = left.pre[i], r = right.pre[i]; if (l === r) continue;
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r);
    if (ln && rn) return Number(l) < Number(r) ? -1 : 1;
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}
function versionRange(range) {
  text(range, 'version range', 500);
  const branches = range.trim().split(/\s*\|\|\s*/);
  if (branches.length > 8 || branches.some(branch => !branch)) fail('Invalid version range');
  return branches.map(branch => {
    if (branch === '*') return [];
    const terms = branch.split(/\s+/);
    if (terms.length > 16) fail('Invalid version range');
    return terms.flatMap(term => {
      const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(term), op = match[1] || '=', v = parsePluginVersion(match[2]);
      if (op !== '^' && op !== '~') return [{op, version: v.value, parsed: v}];
      const [major, minor, patch] = v.core;
      const next = op === '~' ? [major, minor + 1, 0] : major ? [major + 1, 0, 0] : minor ? [0, minor + 1, 0] : [0, 0, patch + 1];
      const upper = next.join('.'); parsePluginVersion(upper);
      return [{op: '>=', version: v.value, parsed: v}, {op: '<', version: upper, parsed: parsePluginVersion(upper)}];
    });
  });
}
export function validateVersionRange(range) { versionRange(range); return range; }
export function satisfiesVersionRange(version, range) {
  const parsed = parsePluginVersion(version), branches = versionRange(range);
  return branches.some(terms => {
    if (parsed.pre.length && !terms.some(term => term.parsed.pre.length && term.parsed.core.every((n, i) => n === parsed.core[i]))) return false;
    return terms.every(({op, version: target}) => { const result = compareVersions(version, target); return op === '=' ? result === 0 : op === '>=' ? result >= 0 : op === '<=' ? result <= 0 : op === '>' ? result > 0 : result < 0; });
  });
}

/** Portable relative path rules also reject NTFS streams and Windows aliases. */
export function pluginRelativePath(value) {
  text(value, 'package path', 1024);
  if (value.includes('\\') || /[\x00-\x1f\x7f<>:"|?*]/.test(value)) fail('Unsafe package path: ' + value);
  for (const segment of value.split('/')) if (!segment || segment === '.' || segment === '..' || segment.length > 240 || /[. ]$/.test(segment) || /^(?:con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)) fail('Unsafe package path: ' + value);
  return value;
}
const pathKey = value => value.normalize('NFC').toLowerCase();
function uniquePaths(files) {
  const names = new Map();
  for (const file of files) { const key = pathKey(file.path); if (names.has(key)) fail('Duplicate package path: ' + file.path); names.set(key, file); }
  for (const key of names.keys()) {
    const parts = key.split('/'); parts.pop();
    while (parts.length) { const ancestor = names.get(parts.join('/')); if (ancestor && ancestor.type !== 'directory') fail('Package path overlaps a file: ' + key); parts.pop(); }
  }
  return names;
}
function stringList(value, label, {max = 100, itemMax = 150, check} = {}) {
  if (!Array.isArray(value) || value.length > max) fail('Invalid ' + label);
  const seen = new Set();
  return value.map(item => { text(item, label, itemMax); if (seen.has(item) || check && !check(item)) fail('Invalid or duplicate ' + label); seen.add(item); return item; });
}
export function pluginHttpsUrl(value) {
  text(value, 'HTTPS URL', 2048);
  let url; try { url = new URL(value); } catch { fail('Invalid HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || !url.hostname || /(?:^|\/)latest(?:\/|$)/i.test(url.pathname)) fail('A fixed HTTPS URL is required');
  return value;
}

export function parsePluginManifest(input) {
  const manifest = record(readPluginJson(input), 'Plugin manifest');
  if (manifest.schemaVersion !== PLUGIN_MANIFEST_VERSION) fail('Unsupported plugin manifest version');
  const allowed = new Set(['schemaVersion', 'id', 'name', 'description', 'version', 'kind', 'appRange', 'apiRange', 'platform', 'arch', 'entry', 'activationEvents', 'capabilities', 'dependencies', 'files', 'author', 'license', 'category', 'tags', 'screenshots', 'homepage', 'repository', 'feedbackUrl', 'dataSchemaVersion', 'compatibleDataVersions', 'nativeVersion']);
  if (Object.keys(manifest).some(key => !allowed.has(key))) fail('Unknown plugin manifest field');
  pluginId(manifest.id); text(manifest.name, 'package name', 150); text(manifest.description, 'description', 4000, true); parsePluginVersion(manifest.version);
  if (!['plugin', 'runtime', 'asset'].includes(manifest.kind)) fail('Unsupported package kind');
  if (manifest.nativeVersion !== undefined) { if (manifest.kind !== 'runtime') fail('Native version belongs to runtime packages'); parsePluginVersion(manifest.nativeVersion); }
  validateVersionRange(manifest.appRange); validateVersionRange(manifest.apiRange);
  if (manifest.platform !== 'win32' || manifest.arch !== 'x64') fail('Unsupported package platform');
  const capabilities = stringList(manifest.capabilities ?? [], 'capabilities', {check: item => PLUGIN_CAPABILITIES.includes(item)});
  const activationEvents = stringList(manifest.activationEvents ?? [], 'activation events', {check: item => /^(?:onCommand|onPanel|onHarness|onTask):[a-z0-9][a-z0-9.\/-]{0,99}$/.test(item)});
  const dependencies = record(manifest.dependencies ?? {}, 'Dependencies');
  const dataSchemaVersion = manifest.dataSchemaVersion ?? 1, compatibleDataVersions = manifest.compatibleDataVersions ?? [dataSchemaVersion];
  if (!Number.isSafeInteger(dataSchemaVersion) || dataSchemaVersion < 1 || dataSchemaVersion > 65536 || !Array.isArray(compatibleDataVersions) || !compatibleDataVersions.length || compatibleDataVersions.length > 100 || new Set(compatibleDataVersions).size !== compatibleDataVersions.length || compatibleDataVersions.some(value => !Number.isSafeInteger(value) || value < 1 || value > 65536) || !compatibleDataVersions.includes(dataSchemaVersion)) fail('Invalid plugin data compatibility');
  if (Object.keys(dependencies).length > 100) fail('Too many package dependencies');
  for (const [id, range] of Object.entries(dependencies)) { pluginId(id); validateVersionRange(range); if (id === manifest.id) fail('A package cannot depend on itself'); }
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 20000) fail('Invalid package file index');
  let unpackedBytes = 0;
  const files = manifest.files.map(file => {
    record(file, 'File'); if (Object.keys(file).some(key => !['path', 'bytes', 'sha256'].includes(key))) fail('Unknown file index field');
    const result = {path: pluginRelativePath(file.path), bytes: pluginBytes(file.bytes), sha256: pluginSha256(file.sha256)};
    if (pathKey(result.path) === 'plugin.json') fail('The file index cannot hash its own plugin.json');
    unpackedBytes += result.bytes; if (unpackedBytes > PLUGIN_EXPANDED_LIMIT) fail('Expanded package exceeds size limit');
    return result;
  });
  const names = uniquePaths(files);
  if (manifest.kind === 'asset') {
    if (manifest.entry !== undefined || capabilities.length || activationEvents.length) fail('Asset packages cannot execute code');
  } else {
    pluginRelativePath(manifest.entry);
    if (!names.has(pathKey(manifest.entry)) || manifest.entry !== names.get(pathKey(manifest.entry)).path) fail('Package entry must match an indexed file');
    if (manifest.kind === 'plugin' && !/\.m?js$/.test(manifest.entry)) fail('Plugin entry must be JavaScript');
    if (manifest.kind === 'runtime' && (capabilities.length || activationEvents.length)) fail('Runtime packages cannot register host features');
  }
  for (const field of ['author', 'license', 'category']) if (manifest[field] !== undefined) text(manifest[field], field, 250);
  if (manifest.tags !== undefined) stringList(manifest.tags, 'tags', {max: 30, itemMax: 80});
  if (manifest.screenshots !== undefined) stringList(manifest.screenshots, 'screenshots', {max: 12, itemMax: 2048, check: value => !!pluginHttpsUrl(value)});
  for (const field of ['homepage', 'repository', 'feedbackUrl']) if (manifest[field] !== undefined) pluginHttpsUrl(manifest[field]);
  return freezePluginData({...manifest, capabilities, activationEvents, dependencies, files, dataSchemaVersion, compatibleDataVersions});
}

export function pluginCompatibility(input, {appVersion, apiVersion = PLUGIN_API_VERSION, platform = 'win32', arch = 'x64'} = {}) {
  const manifest = parsePluginManifest(input), reasons = [];
  if (manifest.platform !== platform || manifest.arch !== arch) reasons.push('platform');
  if (!appVersion || !satisfiesVersionRange(appVersion, manifest.appRange)) reasons.push('app-version');
  if (!apiVersion || !satisfiesVersionRange(apiVersion, manifest.apiRange)) reasons.push('api-version');
  return {compatible: reasons.length === 0, reasons};
}

/** Validate decoded archive inventory before installation, and hashes after extraction.
 * pluginJson is mandatory: its normalized contents must equal the signed manifest.
 * The caller must also use lstat on the staging tree (not stat) and reject links.
 */
export function validatePackageEntries(input, entries, {pluginJson, requireHashes = true} = {}) {
  const manifest = parsePluginManifest(input);
  if (!Array.isArray(entries) || entries.length > 40001) fail('Invalid archive inventory', 'INVALID_PLUGIN_ARCHIVE');
  const observed = [];
  for (const entry of entries) {
    record(entry, 'Archive entry');
    if (!['file', 'directory'].includes(entry.type) || entry.isSymbolicLink || entry.symlink || entry.linkTarget !== undefined || entry.linkname !== undefined) fail('Archive links or special files are forbidden', 'INVALID_PLUGIN_ARCHIVE');
    const unixMode = entry.mode ?? (entry.externalAttributes === undefined ? 0 : entry.externalAttributes >>> 16);
    if (!Number.isInteger(unixMode) || unixMode < 0 || unixMode > 0xffff) fail('Invalid archive mode', 'INVALID_PLUGIN_ARCHIVE');
    const modeType = unixMode & 0xf000;
    if (modeType && modeType !== (entry.type === 'file' ? 0x8000 : 0x4000) || entry.externalAttributes !== undefined && (entry.externalAttributes & 0x400)) fail('Archive links or special files are forbidden', 'INVALID_PLUGIN_ARCHIVE');
    const filename = entry.type === 'directory' && entry.path?.endsWith('/') ? entry.path.slice(0, -1) : entry.path;
    observed.push({...entry, path: pluginRelativePath(filename)});
  }
  const names = uniquePaths(observed), expected = new Map(manifest.files.map(file => [pathKey(file.path), file]));
  const metadata = names.get('plugin.json');
  if (!metadata || metadata.path !== 'plugin.json' || metadata.type !== 'file' || pluginJson === undefined) fail('Archive plugin.json is missing', 'INVALID_PLUGIN_ARCHIVE');
  if (canonicalPluginJson(parsePluginManifest(pluginJson)) !== canonicalPluginJson(manifest)) fail('Archive manifest does not match signed metadata', 'INVALID_PLUGIN_ARCHIVE');
  const allowedDirectories = new Set();
  for (const file of manifest.files) { const parts = file.path.split('/'); parts.pop(); while (parts.length) { allowedDirectories.add(pathKey(parts.join('/'))); parts.pop(); } }
  let bytes = 0;
  for (const entry of observed) {
    const key = pathKey(entry.path);
    if (entry.type === 'directory') { if (!allowedDirectories.has(key)) fail('Undeclared archive directory: ' + entry.path, 'INVALID_PLUGIN_ARCHIVE'); continue; }
    pluginBytes(entry.bytes);
    if (key === 'plugin.json') continue;
    const indexed = expected.get(key);
    if (!indexed || indexed.path !== entry.path || indexed.bytes !== entry.bytes || requireHashes && indexed.sha256 !== pluginSha256(entry.sha256)) fail('Archive file differs from signed index: ' + entry.path, 'INVALID_PLUGIN_ARCHIVE');
    bytes += entry.bytes; expected.delete(key);
  }
  if (expected.size) fail('Archive is missing indexed files', 'INVALID_PLUGIN_ARCHIVE');
  return {files: manifest.files.length, bytes, manifest};
}
