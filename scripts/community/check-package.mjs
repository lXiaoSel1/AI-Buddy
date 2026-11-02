import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {pluginRelativePath, parsePluginVersion, validateVersionRange} from '../../src/plugin-manifest.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw Object.assign(Error(message), {code: 'COMMUNITY_PACKAGE_CHECK_FAILED'}); };
const string = value => { const at = value.indexOf(0); return new TextDecoder('utf8', {fatal: true}).decode(at < 0 ? value : value.subarray(0, at)); };
const octal = buffer => { const value = string(buffer).trim(); if (!/^[0-7]+$/.test(value)) fail('Unsupported tar numeric field'); const number = Number.parseInt(value, 8); if (!Number.isSafeInteger(number)) fail('Tar number exceeds safe range'); return number; };

/** Non-executing conservative distribution preflight. Native DSH remains the installer. */
export function inspectDshDistribution(bytes, {expectedDigest, expectedPackageName, expectedVersion, maximumArchiveBytes = 64 * 1024 * 1024, maximumExpandedBytes = 256 * 1024 * 1024} = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maximumArchiveBytes) fail('Tarball exceeds configured archive limit');
  const digest = sha(bytes); if (expectedDigest && digest !== expectedDigest) fail('Tarball differs from the expected SHA-256');
  let raw; try { raw = gunzipSync(bytes, {maxOutputLength: maximumExpandedBytes}); } catch { fail('Invalid or oversized gzip archive'); }
  const files = new Map(), paths = new Set(); let offset = 0, ended = false;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) { if (offset + 1024 > raw.length || !raw.subarray(offset).every(value => value === 0)) fail('Tar has undeclared trailing content'); ended = true; break; }
    const checksum = octal(header.subarray(148, 156)), actual = header.reduce((total, value, index) => total + (index >= 148 && index < 156 ? 32 : value), 0); if (checksum !== actual) fail('Tar header checksum mismatch');
    const name = string(header.subarray(0, 100)), prefix = string(header.subarray(345, 500)), combined = prefix ? prefix + '/' + name : name, type = header[156];
    if (![0, 48, 53].includes(type)) fail('Archive links, PAX metadata and special files require separate review');
    const path = pluginRelativePath(type === 53 && combined.endsWith('/') ? combined.slice(0, -1) : combined);
    if (!path.startsWith('package/')) fail('npm tarball must stay under package/');
    const windowsKey = path.toLowerCase(); if (paths.has(windowsKey)) fail('Tar has duplicate or Windows-colliding paths'); paths.add(windowsKey);
    const size = octal(header.subarray(124, 136)), begin = offset + 512, end = begin + size; if (end > raw.length || files.size >= 20000 || type === 53 && size !== 0) fail('Invalid tar entry size');
    if (type !== 53) files.set(path.slice('package/'.length), raw.subarray(begin, end));
    offset = begin + Math.ceil(size / 512) * 512;
  }
  if (!ended) fail('Tar terminator is missing');
  const metadata = files.get('package.json'); if (!metadata) fail('package.json is missing');
  let manifest; try { manifest = JSON.parse(metadata.toString('utf8')); } catch { fail('package.json is invalid'); }
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(manifest.name ?? '')) fail('Invalid npm package name'); parsePluginVersion(manifest.version);
  if (expectedPackageName && manifest.name !== expectedPackageName) fail('Final distribution package name differs from the exact reviewed identity');
  if (expectedVersion && manifest.version !== expectedVersion) fail('Final distribution version differs from the exact reviewed identity');
  const exported = typeof manifest.exports === 'string' ? manifest.exports : typeof manifest.exports?.['.'] === 'string' ? manifest.exports['.'] : manifest.exports?.['.']?.import;
  const entry = manifest.main ?? exported;
  if (typeof entry !== 'string') fail('Compiled server entry is missing'); const entryPath = pluginRelativePath(entry.replace(/^\.\//, ''));
  if (!/\.(mjs|cjs|js)$/.test(entryPath) || !files.has(entryPath) || /(^|\/)src\//.test(entryPath)) fail('Package must contain a compiled JavaScript entry');
  if (typeof manifest.engines?.dsh !== 'string') fail('Explicit DSH engine compatibility is missing'); validateVersionRange(manifest.engines.dsh);
  const patch = manifest.dsh?.bundle?.patch;
  if (typeof patch !== 'string' || !files.has(pluginRelativePath(patch.replace(/^\.\//, '')))) fail('Declared DSH bundle patch is missing');
  if (![...files.keys()].some(path => /(^|\/)LICENSE(?:\.[^/]+)?$/i.test(path))) fail('Distribution license file is missing');
  const clientEntry = typeof manifest.exports?.['./client'] === 'string' ? manifest.exports['./client'].replace(/^\.\//, '') : files.has('lib/client.js') ? 'lib/client.js' : null;
  if (clientEntry && !files.has(pluginRelativePath(clientEntry))) fail('Exported client resource is missing');
  if (manifest.dsh.client && (!clientEntry || manifest.dsh.client.platform !== 'web' || !Array.isArray(manifest.dsh.client.inject) || manifest.dsh.client.inject.some(value => typeof value !== 'string'))) fail('Native web client contract is incomplete or unsupported');
  const lifecycleScripts = Object.fromEntries(Object.entries(manifest.scripts ?? {}).filter(([key]) => ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepack', 'postpack'].includes(key)));
  return {schemaVersion: 1, packageName: manifest.name, version: manifest.version, archive: {bytes: bytes.length, sha256: digest}, automaticCheck: {status: 'passed', scope: 'non-executing distribution structure, paths, integrity and compiled entry'}, aiReview: {status: 'not-run'}, nativeRuntimeValidation: {status: 'not-run'}, serverEntry: entryPath, clientEntry, lifecycleScripts, buildScriptApprovalRequired: Object.keys(lifecycleScripts).length > 0, files: [...files].map(([path, value]) => ({path, bytes: value.length, sha256: sha(value)}))};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = Object.fromEntries(process.argv.slice(2).map(value => { const at = value.indexOf('='); return [value.slice(0, at).replace(/^--/, ''), value.slice(at + 1)]; }));
  if (!args.archive || !args.out) throw Error('Required: --archive=<final.tgz> --out=<report.json> [--sha256=<expected>]');
  const result = inspectDshDistribution(await readFile(resolve(args.archive)), {expectedDigest: args.sha256, expectedPackageName: args.name, expectedVersion: args.version}); await mkdir(dirname(resolve(args.out)), {recursive: true}); await writeFile(resolve(args.out), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify({packageName: result.packageName, version: result.version, automaticCheck: result.automaticCheck, aiReview: result.aiReview, nativeRuntimeValidation: result.nativeRuntimeValidation, archive: result.archive}));
}
