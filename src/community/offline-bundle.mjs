import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

// Offline plugin file (approved design B6 「离线导入」). Two shapes are read, both strictly:
//  - a bundle (`*.aibuddy-plugins`): a ustar tar, optionally gzip-compressed, holding
//      catalog.json              the signed community catalog envelope, exactly as served online
//      packages/<sha256>.tgz     zero or more package tarballs, each named by the SHA-256 of its bytes
//  - a bare package tarball (`*.tgz`, an npm pack): accepted only when an already verified catalog lists its digest.
// Nothing here decides trust: the community service verifies the envelope with an already trusted source key and
// matches every tarball against a signed release digest before it can be planned or installed.
export const OFFLINE_BUNDLE_EXTENSION = 'aibuddy-plugins';
// Review 低-2: bounded so a hostile or broken file cannot hold the main process for long (official packages are a few MB).
export const OFFLINE_FILE_LIMIT = 160 * 1024 * 1024;
const CATALOG_LIMIT = 16 * 1024 * 1024 + 20000, PACKAGE_LIMIT = 128 * 1024 * 1024, MAX_PACKAGES = 32, ZERO = Buffer.alloc(64 * 1024);
const allZero = bytes => { for (let at = 0; at < bytes.length; at += ZERO.length) { const part = bytes.subarray(at, at + ZERO.length); if (!part.equals(ZERO.subarray(0, part.length))) return false; } return true; };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw Object.assign(Error(message), {code: 'COMMUNITY_OFFLINE_INVALID'}); };
const gzip = bytes => bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
function entries(tar) {
  const out = [];
  for (let offset = 0; ;) {
    if (offset + 512 > tar.length) fail('Truncated offline file');
    const header = tar.subarray(offset, offset + 512);
    if (allZero(header)) { if (!allZero(tar.subarray(offset))) fail('Offline file has undeclared trailing content'); break; }
    const text = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    let checksum = 0; for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (checksum !== Number.parseInt(text(148, 156).trim() || '-1', 8)) fail('Offline file header checksum failed');
    const size = Number.parseInt(text(124, 136).trim() || '0', 8), type = text(156, 157) || '0', prefix = text(345, 500), name = (prefix ? prefix + '/' : '') + text(0, 100);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) fail('Offline file entry is truncated');
    out.push({name, type, size, data: tar.subarray(offset + 512, offset + 512 + size)});
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
/** Returns {envelope: object|null, packages: [{sha256, bytes}]}; throws COMMUNITY_OFFLINE_INVALID for anything else. */
export function readOfflinePluginFile(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20 || bytes.length > OFFLINE_FILE_LIMIT) fail('Offline file size is invalid');
  let tar;
  try { tar = gzip(bytes) ? gunzipSync(bytes, {maxOutputLength: OFFLINE_FILE_LIMIT}) : bytes; } catch { fail('Offline file is not a readable archive'); }
  const list = entries(tar);
  // A bare npm package: every member lives under package/ and its manifest is there. Its digest is that of the file as given.
  if (list.length && list.every(entry => entry.name.startsWith('package/')) && list.some(entry => entry.name === 'package/package.json')) {
    if (!gzip(bytes)) fail('A package tarball must be gzip-compressed');
    if (bytes.length > PACKAGE_LIMIT) fail('Package exceeds the size limit');
    return {envelope: null, packages: [{sha256: sha(bytes), bytes}]};
  }
  let envelope = null; const packages = [], seen = new Set();
  for (const entry of list) {
    const name = entry.name.replace(/^\.\//, '');
    if (seen.has(name)) fail('Offline file has a duplicate entry');
    seen.add(name);
    if (entry.type === '5') { if (!['', '.', 'packages', 'packages/'].includes(name) || entry.size) fail('Offline file has an unexpected folder'); continue; }
    if (entry.type !== '0') fail('Offline file entries must be plain files');
    if (name === 'catalog.json') {
      if (entry.size > CATALOG_LIMIT) fail('Catalog exceeds the size limit');
      try { envelope = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(entry.data)); } catch { fail('catalog.json is not valid JSON'); }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) fail('catalog.json is not a signed envelope');
      continue;
    }
    const match = /^packages\/([0-9a-f]{64})\.tgz$/.exec(name);
    if (!match) fail('Offline file has an unexpected entry');
    if (entry.size > PACKAGE_LIMIT || packages.length >= MAX_PACKAGES) fail('Offline file has too many or too large packages');
    const data = Buffer.from(entry.data);
    if (sha(data) !== match[1]) fail('Package bytes differ from the name they were packed under');
    packages.push({sha256: match[1], bytes: data});
  }
  if (!envelope) fail('Offline bundle has no signed catalog');
  return {envelope, packages};
}
/** Release tooling (review 低-10): the checks DSH applies to a package tarball, made before it is bundled: npm layout, plain files and folders only (no PAX, links or devices), and its name and version. */
export function inspectNpmTarball(bytes) {
  let tar; try { tar = gunzipSync(bytes, {maxOutputLength: OFFLINE_FILE_LIMIT}); } catch { fail('Package is not a gzip tarball'); }
  let manifest = null;
  for (const entry of entries(tar)) {
    if (!entry.name.startsWith('package/') || entry.name.includes('\\') || entry.name.split('/').includes('..') || !['0', '5'].includes(entry.type)) fail('Package has an entry DSH refuses: ' + entry.name + ' (type ' + entry.type + ')');
    if (entry.name === 'package/package.json' && entry.type === '0') { try { manifest = JSON.parse(entry.data.toString('utf8')); } catch { fail('package.json is not valid JSON'); } }
  }
  if (!manifest?.name || !manifest?.version) fail('Package has no package.json name and version');
  return {name: manifest.name, version: manifest.version};
}
function header(name, size, type = '0') {
  const value = Buffer.alloc(512), put = (text, offset, length) => value.write(text, offset, length, 'utf8');
  if (Buffer.byteLength(name) > 100) fail('Entry name too long');
  put(name, 0, 100); put('0000644\0', 100, 8); put('0000000\0', 108, 8); put('0000000\0', 116, 8); put(size.toString(8).padStart(11, '0') + '\0', 124, 12); put('00000000000\0', 136, 12); put('        ', 148, 8); put(type, 156, 1); put('ustar\0', 257, 6); put('00', 263, 2);
  let checksum = 0; for (const byte of value) checksum += byte; put(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return value;
}
/** Deterministic bundle writer for release tooling: catalog.json + packages/<sha256>.tgz, uncompressed ustar. */
export function buildOfflinePluginBundle({envelope, packages = []}) {
  if (!envelope || typeof envelope !== 'object' || !envelope.payload || !envelope.signature) fail('A signed catalog envelope is required');
  const parts = [], add = (name, data) => { parts.push(header(name, data.length), data, Buffer.alloc((512 - data.length % 512) % 512)); };
  add('catalog.json', Buffer.from(JSON.stringify(envelope)));
  const seen = new Set();
  for (const bytes of packages) { if (!Buffer.isBuffer(bytes) || !gzip(bytes)) fail('Packages must be gzip tarballs'); const digest = sha(bytes); if (seen.has(digest)) continue; seen.add(digest); add('packages/' + digest + '.tgz', bytes); }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
