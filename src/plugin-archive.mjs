import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdir, lstat, readFile, readdir} from 'node:fs/promises';
import {resolve, dirname, relative, isAbsolute, sep} from 'node:path';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {crc32, createInflateRaw, deflateRawSync, inflateRawSync} from 'node:zlib';
import {canonicalPluginJson, parsePluginManifest, PLUGIN_EXPANDED_LIMIT, PLUGIN_PACKAGE_LIMIT, pluginRelativePath, validatePackageEntries} from './plugin-manifest.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw Object.assign(Error(message), {code: 'INVALID_PLUGIN_ARCHIVE'}); };
const utf8 = bytes => new TextDecoder('utf-8', {fatal: true}).decode(bytes);
function inspect(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > PLUGIN_PACKAGE_LIMIT) fail('Invalid extension ZIP size');
  const end = bytes.length - 22;
  if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 20)) fail('Unsupported ZIP footer');
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16), size = bytes.readUInt32LE(end + 12);
  if (!count || count > 20001 || count !== bytes.readUInt16LE(end + 8) || start + size !== end) fail('Invalid ZIP directory');
  let at = start, total = 0;
  const entries = [], ranges = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) fail('Truncated ZIP directory');
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), checksum = bytes.readUInt32LE(at + 16), packed = bytes.readUInt32LE(at + 20), length = bytes.readUInt32LE(at + 24), names = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32), disk = bytes.readUInt16LE(at + 34), attributes = bytes.readUInt32LE(at + 38), local = bytes.readUInt32LE(at + 42);
    if (at + 46 + names + extra + comment > end || ![0, 0x800].includes(flags) || ![0, 8].includes(method) || extra || comment || disk || local + 30 > start) fail('Unsupported ZIP entry');
    const rawName = bytes.subarray(at + 46, at + 46 + names), path = utf8(rawName);
    if (!flags && rawName.some(byte => byte > 127)) fail('Non-UTF8 ZIP name');
    pluginRelativePath(path);
    const mode = attributes >>> 16, modeType = mode & 0xf000;
    if (modeType && modeType !== 0x8000 || attributes & 0x400 || path.endsWith('/')) fail('ZIP links, directories or special entries are unsupported');
    if (bytes.readUInt32LE(local) !== 0x04034b50) fail('Invalid ZIP local header');
    const localNames = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), begin = local + 30 + localNames + localExtra, stop = begin + packed;
    if (localExtra || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt32LE(local + 14) !== checksum || bytes.readUInt32LE(local + 18) !== packed || bytes.readUInt32LE(local + 22) !== length || !bytes.subarray(local + 30, local + 30 + localNames).equals(rawName) || stop > start) fail('ZIP local header differs from directory');
    total += length; if (total > PLUGIN_EXPANDED_LIMIT + 4 * 1024 * 1024) fail('ZIP expanded size exceeds limit');
    entries.push({path, type: 'file', bytes: length, mode, checksum, method, begin, stop});
    ranges.push([local, stop]); at += 46 + names;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (at !== end || ranges.some(([begin], i) => begin !== (i ? ranges[i - 1][1] : 0)) || ranges.at(-1)[1] !== start) fail('ZIP contains overlapping or undeclared data');
  return entries;
}
export function inspectPluginArchive(bytes, manifest) {
  const entries = inspect(bytes), metadata = entries.find(entry => entry.path === 'plugin.json');
  if (!metadata || metadata.bytes > 4 * 1024 * 1024) fail('ZIP plugin.json is missing or too large');
  const compressed = bytes.subarray(metadata.begin, metadata.stop), raw = metadata.method ? inflateRawSync(compressed, {maxOutputLength: Math.max(1, metadata.bytes)}) : compressed;
  if (raw.length !== metadata.bytes || crc32(raw) >>> 0 !== metadata.checksum) fail('ZIP plugin.json checksum failed');
  const pluginJson = utf8(raw);
  validatePackageEntries(manifest, entries, {pluginJson, requireHashes: false});
  return {entries, pluginJson, unpackedBytes: entries.reduce((sum, item) => sum + item.bytes, 0)};
}
export async function assertPluginTreeNoLinks(directory) {
  for (let path = resolve(directory);; path = dirname(path)) { try { if ((await lstat(path)).isSymbolicLink()) fail('Extension destination contains a link'); } catch (error) { if (error.code !== 'ENOENT') throw error; } if (dirname(path) === path) break; }
}
export async function verifyInstalledPlugin(directory, manifest) {
  await assertPluginTreeNoLinks(directory);
  const entries = [];
  async function scan(current) {
    for (const entry of await readdir(current, {withFileTypes: true})) {
      const path = resolve(current, entry.name), rel = relative(directory, path).split(sep).join('/'), info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) fail('Installed extension contains a link or special file');
      if (info.isDirectory()) { entries.push({path: rel, type: 'directory'}); await scan(path); }
      else { const bytes = await readFile(path); entries.push({path: rel, type: 'file', bytes: bytes.length, sha256: hash(bytes)}); }
    }
  }
  await scan(directory);
  return validatePackageEntries(manifest, entries, {pluginJson: await readFile(resolve(directory, 'plugin.json'), 'utf8')});
}
export async function extractPluginArchive(bytes, directory, manifest, {signal} = {}) {
  const inspected = inspectPluginArchive(bytes, manifest);
  await assertPluginTreeNoLinks(directory); await mkdir(directory, {recursive: true});
  for (const entry of inspected.entries) {
    if (signal?.aborted) throw signal.reason ?? Object.assign(Error('Extension installation cancelled'), {name: 'AbortError'});
    const target = resolve(directory, entry.path), rel = relative(directory, target);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) fail('ZIP destination escapes staging');
    await assertPluginTreeNoLinks(dirname(target)); await mkdir(dirname(target), {recursive: true});
    let length = 0, checksum = 0;
    const check = new Transform({transform(chunk, encoding, done) { length += chunk.length; if (length > entry.bytes) return done(Error('ZIP output exceeds declared size')); checksum = crc32(chunk, checksum) >>> 0; done(null, chunk); }});
    const input = Readable.from([bytes.subarray(entry.begin, entry.stop)]), output = createWriteStream(target, {flags: 'wx'});
    if (entry.method) await pipeline(input, createInflateRaw(), check, output, {signal}); else await pipeline(input, check, output, {signal});
    if (length !== entry.bytes || checksum !== entry.checksum) fail('ZIP file checksum or size failed: ' + entry.path);
  }
  return verifyInstalledPlugin(directory, manifest);
}
/** Deterministic prebuilt ZIP, no npm install and no package lifecycle scripts. */
export function buildPluginArchive(input, fileMap) {
  const manifest = parsePluginManifest(input), files = new Map(fileMap), metadata = Buffer.from(canonicalPluginJson(manifest));
  if (files.has('plugin.json')) fail('plugin.json is supplied by the package builder');
  validatePackageEntries(manifest, [{path: 'plugin.json', type: 'file', bytes: metadata.length}, ...[...files].map(([path, bytes]) => ({path, type: 'file', bytes: bytes.length, sha256: hash(bytes)}))], {pluginJson: manifest});
  files.set('plugin.json', metadata);
  const localParts = [], centralParts = []; let offset = 0;
  for (const [name, raw] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const key = Buffer.from(name), body = deflateRawSync(raw), checksum = crc32(raw) >>> 0, local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(key.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(key.length, 28); central.writeUInt32LE(offset, 42);
    localParts.push(local, key, body); centralParts.push(central, key); offset += local.length + key.length + body.length;
  }
  const central = Buffer.concat(centralParts), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...localParts, central, end]); inspectPluginArchive(archive, manifest); return archive;
}
