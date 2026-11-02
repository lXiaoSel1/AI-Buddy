import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  canonicalPluginJson, compareVersions, parsePluginManifest, pluginCompatibility,
  pluginRelativePath, readPluginJson, satisfiesVersionRange, validatePackageEntries,
} from '../src/plugin-manifest.mjs';

const digest = content => createHash('sha256').update(content).digest('hex');
const file = (path = 'dist/entry.mjs', content = 'export const activate=()=>{};') => ({path, bytes: Buffer.byteLength(content), sha256: digest(content)});
function fixture(changes = {}) {
  return {schemaVersion: 1, id: 'ai-buddy.kimi-engine', name: 'Kimi 工作引擎', description: '按需启动 ACP 工作任务', version: '1.0.0', kind: 'plugin',
    appRange: '>=1.9.2 <2.0.0', apiRange: '^1.0.0', platform: 'win32', arch: 'x64', entry: 'dist/entry.mjs',
    activationEvents: ['onHarness:kimi'], capabilities: ['harness.register', 'storage'], dependencies: {'ai-buddy.kimi-runtime': '^1.0.0'}, files: [file()], ...changes};
}
function inventory(manifest) { return [{path: 'plugin.json', type: 'file', bytes: Buffer.byteLength(JSON.stringify(manifest))}, {path: 'dist/', type: 'directory'}, ...manifest.files.map(f => ({...f, type: 'file'}))]; }

test('package schema preserves independent package version and explicit host API range', () => {
  const manifest = parsePluginManifest(JSON.stringify(fixture({version: '4.2.0'})));
  assert.equal(manifest.version, '4.2.0'); assert.equal(manifest.apiRange, '^1.0.0');
  assert.deepEqual(pluginCompatibility(manifest, {appVersion: '1.9.2'}), {compatible: true, reasons: []});
  assert.deepEqual(pluginCompatibility(manifest, {appVersion: '1.9.1', apiVersion: '2.0.0', platform: 'linux'}), {compatible: false, reasons: ['platform', 'app-version', 'api-version']});
  assert.ok(Object.isFrozen(manifest.files[0]));
});

test('canonical metadata is deterministic without relying on source formatting', () => {
  assert.equal(canonicalPluginJson({z: [2, {b: true, a: '鲸鱼'}], a: null}), '{"a":null,"z":[2,{"a":"鲸鱼","b":true}]}');
  assert.deepEqual(readPluginJson(Buffer.from('{"ok":true}')), {ok: true});
  for (const value of [undefined, Infinity, {x: undefined}, JSON.parse('{"__proto__":1}'), {get value() { throw Error('must not run'); }}]) assert.throws(() => canonicalPluginJson(value));
  const cycle = {}; cycle.self = cycle; assert.throws(() => canonicalPluginJson(cycle));
  assert.throws(() => readPluginJson('{"ok":true}', {maximum: 2}));
  assert.throws(() => readPluginJson(Buffer.from([0xff])));
});

test('semver precedence handles numeric prereleases and ignores build identity', () => {
  const versions = ['1.0.0-alpha', '1.0.0-alpha.2', '1.0.0-alpha.10', '1.0.0-beta', '1.0.0', '1.0.1', '2.0.0'];
  assert.deepEqual([...versions].reverse().sort(compareVersions), versions);
  assert.equal(compareVersions('1.0.0+one', '1.0.0+two'), 0);
  for (const invalid of ['v1.0.0', '1.0', '01.0.0', '1.0.0-01', '1.0.0.0', '9007199254740992.0.0']) assert.throws(() => compareVersions(invalid, '1.0.0'));
});

test('bounded semver ranges reject unknown syntax and keep prereleases opt-in', () => {
  assert.equal(satisfiesVersionRange('1.9.2', '>=1.9.2 <2.0.0'), true);
  assert.equal(satisfiesVersionRange('2.0.0', '>=1.9.2 <2.0.0'), false);
  assert.equal(satisfiesVersionRange('1.9.9', '^1.2.3'), true);
  assert.equal(satisfiesVersionRange('0.2.9', '^0.2.3'), true);
  assert.equal(satisfiesVersionRange('0.3.0', '^0.2.3'), false);
  assert.equal(satisfiesVersionRange('0.0.4', '^0.0.3'), false);
  assert.equal(satisfiesVersionRange('1.2.9', '~1.2.3'), true);
  assert.equal(satisfiesVersionRange('1.3.0', '~1.2.3'), false);
  assert.equal(satisfiesVersionRange('2.2.0', '^1.0.0 || >=2.1.0 <3.0.0'), true);
  assert.equal(satisfiesVersionRange('1.1.0-beta.2', '*'), false);
  assert.equal(satisfiesVersionRange('1.1.0-beta.2', '>=1.1.0-beta.1 <1.1.0'), true);
  for (const invalid of ['', '^1', '1.x', '>= 1.0.0', '1.0.0 || nonsense']) assert.throws(() => satisfiesVersionRange('1.0.0', invalid));
});

test('relative paths reject traversal, Windows aliases, NTFS streams and ambiguous segments', () => {
  assert.equal(pluginRelativePath('assets/鲸鱼.png'), 'assets/鲸鱼.png');
  for (const invalid of ['../outside', '/absolute', 'C:/absolute', 'dist\\entry.mjs', 'a//b', './file', 'a/../file', 'a:stream', 'a/nul.txt', 'COM1', 'lpt¹.log', 'a/file.', 'a/file ', 'a/?', 'a/\u0000']) assert.throws(() => pluginRelativePath(invalid), invalid);
});

test('manifest rejects overlapping Windows paths, unindexed entry and self-hash circularity', () => {
  assert.throws(() => parsePluginManifest(fixture({files: [file(), file('DIST/ENTRY.MJS')]})), /Duplicate/);
  assert.throws(() => parsePluginManifest(fixture({files: [file(), file('dist')]})), /overlaps/);
  assert.throws(() => parsePluginManifest(fixture({files: [file('elsewhere.mjs')]})), /entry/);
  assert.throws(() => parsePluginManifest(fixture({entry: 'DIST/entry.mjs'})), /entry/);
  assert.throws(() => parsePluginManifest(fixture({files: [file(), file('plugin.json')]})), /own plugin.json/);
  assert.throws(() => parsePluginManifest(fixture({sha256: 'unexpected'})), /Unknown/);
  assert.throws(() => parsePluginManifest(fixture({files: [{...file(), bytes: -1}]})), /size/);
  assert.throws(() => parsePluginManifest(fixture({files: [{...file(), sha256: 'A'.repeat(64)}]})), /SHA/);
});

test('asset packages and runtime dependencies cannot silently register executable host features', () => {
  const asset = fixture({kind: 'asset', entry: undefined, capabilities: [], activationEvents: [], dependencies: {}, files: [file('assets/icon.png')]});
  delete asset.entry;
  assert.equal(parsePluginManifest(asset).kind, 'asset');
  assert.throws(() => parsePluginManifest({...asset, entry: 'assets/icon.png'}), /execute/);
  assert.throws(() => parsePluginManifest({...asset, activationEvents: ['onHarness:kimi']}), /execute/);
  assert.throws(() => parsePluginManifest(fixture({kind: 'runtime'})), /register/);
  assert.throws(() => parsePluginManifest(fixture({capabilities: ['everything']})), /capabilities/);
  assert.throws(() => parsePluginManifest(fixture({dependencies: {'ai-buddy.kimi-engine': '*'}})), /itself/);
});

test('archive content matches signed metadata and rejects added, missing or damaged files', () => {
  const manifest = fixture(), entries = inventory(manifest);
  const result = validatePackageEntries(manifest, entries, {pluginJson: JSON.stringify(manifest)});
  assert.equal(result.files, 1); assert.equal(result.bytes, manifest.files[0].bytes);
  assert.throws(() => validatePackageEntries(manifest, entries), /plugin.json/);
  assert.throws(() => validatePackageEntries(manifest, entries, {pluginJson: fixture({name: 'Changed after signing'})}), /signed metadata/);
  assert.throws(() => validatePackageEntries(manifest, entries.slice(0, -1), {pluginJson: manifest}), /missing indexed/);
  assert.throws(() => validatePackageEntries(manifest, [...entries, {...file('extra.mjs'), type: 'file'}], {pluginJson: manifest}), /signed index/);
  assert.throws(() => validatePackageEntries(manifest, entries.map(e => e.sha256 ? {...e, sha256: '0'.repeat(64)} : e), {pluginJson: manifest}), /signed index/);
  assert.throws(() => validatePackageEntries(manifest, entries.map(e => e.sha256 ? {...e, bytes: e.bytes + 1} : e), {pluginJson: manifest}), /signed index/);
});

test('archive preflight checks size and layout before hashes are available, final validation requires hashes', () => {
  const manifest = fixture(), entries = inventory(manifest).map(({sha256, ...e}) => e);
  assert.equal(validatePackageEntries(manifest, entries, {pluginJson: manifest, requireHashes: false}).files, 1);
  assert.throws(() => validatePackageEntries(manifest, entries, {pluginJson: manifest}), /SHA/);
});

test('archive inventory rejects links, special files and case collisions including metadata', () => {
  const manifest = fixture(), base = inventory(manifest);
  for (const extra of [{symlink: true}, {isSymbolicLink: true}, {linkTarget: '../outside'}, {linkname: 'other'}, {mode: 0xa1ff}, {mode: 0x61a4}, {externalAttributes: 0x400}, {type: 'symlink'}]) {
    assert.throws(() => validatePackageEntries(manifest, base.map((e, i) => i === 2 ? {...e, ...extra} : e), {pluginJson: manifest}), /forbidden/);
  }
  assert.throws(() => validatePackageEntries(manifest, [...base, {path: 'PLUGIN.JSON', type: 'file', bytes: 1}], {pluginJson: manifest}), /Duplicate/);
  assert.throws(() => validatePackageEntries(manifest, [...base, {path: 'unused/', type: 'directory'}], {pluginJson: manifest}), /Undeclared/);
  assert.throws(() => validatePackageEntries(manifest, base.map((e, i) => i === 2 ? {...e, path: '../outside'} : e), {pluginJson: manifest}), /Unsafe/);
});
