import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {canonicalPluginJson, PLUGIN_PACKAGE_LIMIT} from '../src/plugin-manifest.mjs';
import {
  catalogPackages, OFFICIAL_PLUGIN_TRUST_KEYS, parsePluginCatalog, PLUGIN_CATALOG_NAMESPACE,
  resolvePluginInstallPlan, verifyPluginCatalog,
} from '../src/plugin-catalog.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const {publicKey, privateKey} = generateKeyPairSync('ed25519');
const trust = {trustedKeys: {'local-test': publicKey}};
function packageFixture(id = 'ai-buddy.kimi-engine', version = '1.0.0', dependencies = {'ai-buddy.kimi-runtime': '^1.0.0'}, changes = {}) {
  const content = `export const version=${JSON.stringify(version)};`;
  return {manifest: {schemaVersion: 1, id, name: id, description: 'Official 可选工作引擎', version, kind: 'plugin', appRange: '>=1.9.2 <2.0.0', apiRange: '^1.0.0', platform: 'win32', arch: 'x64', entry: 'dist/entry.mjs',
    activationEvents: ['onHarness:kimi'], capabilities: ['harness.register'], dependencies, files: [{path: 'dist/entry.mjs', bytes: Buffer.byteLength(content), sha256: sha(content)}]},
    archive: {url: `https://github.com/lXiaoSel1/AI-Buddy-Plugins/releases/download/${id}-${version}/${id}.zip`, bytes: 123, sha256: sha(id + version)}, publishedAt: '2026-10-23T12:00:00Z', ...changes};
}
function catalogFixture(packages = [packageFixture(), packageFixture('ai-buddy.kimi-runtime', '1.0.0', {})]) {
  return {schemaVersion: 1, id: 'ai-buddy-official', generatedAt: '2026-10-23T12:01:00Z', packages};
}
function signed(payload, key = privateKey, keyId = 'local-test') {
  return {payload, signature: {algorithm: 'ed25519', keyId, value: sign(null, Buffer.from(canonicalPluginJson(payload)), key).toString('base64')}};
}
function sshField(bytes) { const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return Buffer.concat([length, bytes]); }
function sshEnvelope(payload, {namespace = PLUGIN_CATALOG_NAMESPACE, key = privateKey, pub = publicKey, hashName = 'sha512'} = {}) {
  const raw = pub.export({format: 'jwk'}).x, publicBlob = Buffer.concat([sshField(Buffer.from('ssh-ed25519')), sshField(Buffer.from(raw, 'base64url'))]);
  const fields = [Buffer.from(namespace), Buffer.alloc(0), Buffer.from(hashName), createHash(hashName).update(canonicalPluginJson(payload)).digest()];
  const message = Buffer.concat([Buffer.from('SSHSIG'), ...fields.map(sshField)]);
  const signatureBlob = Buffer.concat([sshField(Buffer.from('ssh-ed25519')), sshField(sign(null, message, key))]);
  const version = Buffer.alloc(4); version.writeUInt32BE(1);
  const binary = Buffer.concat([Buffer.from('SSHSIG'), version, sshField(publicBlob), ...fields.slice(0, 3).map(sshField), sshField(signatureBlob)]);
  const armored = '-----BEGIN SSH SIGNATURE-----\n' + binary.toString('base64').match(/.{1,70}/g).join('\n') + '\n-----END SSH SIGNATURE-----\n';
  return {payload, signature: {algorithm: 'sshsig', keyId: 'local-test', value: armored}, publicSsh: 'ssh-ed25519 ' + publicBlob.toString('base64')};
}

test('signed catalog authenticates manifests and external archive hashes without circular self-hashing', () => {
  const payload = catalogFixture(), verified = verifyPluginCatalog(JSON.stringify(signed(payload)), trust);
  assert.equal(verified.verified.payloadSha256, sha(canonicalPluginJson(payload)));
  assert.equal(verified.verified.keyId, 'local-test'); assert.equal(verified.packages[0].manifest.id, 'ai-buddy.kimi-engine');
  assert.ok(Object.isFrozen(verified.packages[0].archive));
  assert.equal(verified.packages[0].manifest.sha256, undefined);
});

test('signature canonicalization survives object key order and formatting changes', () => {
  const envelope = signed(catalogFixture());
  const reordered = {signature: {...envelope.signature}, payload: {packages: envelope.payload.packages, generatedAt: envelope.payload.generatedAt, id: envelope.payload.id, schemaVersion: 1}};
  assert.equal(verifyPluginCatalog(JSON.stringify(reordered, null, 4), trust).verified.payloadSha256, verifyPluginCatalog(envelope, trust).verified.payloadSha256);
});

test('offline catalog verification rejects unknown signers, tampering and caller-provided public keys', () => {
  const payload = catalogFixture(), envelope = signed(payload);
  assert.throws(() => verifyPluginCatalog(envelope), error => error.code === 'PLUGIN_SIGNATURE_UNTRUSTED');
  assert.equal(Object.keys(OFFICIAL_PLUGIN_TRUST_KEYS).length, 1);
  const changed = structuredClone(envelope); changed.payload.packages[0].archive.sha256 = '0'.repeat(64);
  assert.throws(() => verifyPluginCatalog(changed, trust), error => error.code === 'PLUGIN_SIGNATURE_INVALID');
  assert.throws(() => verifyPluginCatalog({...envelope, publicKey: publicKey.export({format: 'pem', type: 'spki'})}, trust), /Unknown/);
  assert.throws(() => verifyPluginCatalog({...envelope, signature: {...envelope.signature, algorithm: 'none'}}, trust), /Unsupported/);
  assert.throws(() => verifyPluginCatalog({...envelope, signature: {...envelope.signature, value: '!!!'}}, trust), /verification/);
  const another = generateKeyPairSync('ed25519');
  assert.throws(() => verifyPluginCatalog(signed(payload, another.privateKey), trust), /verification/);
});

test('OpenSSH signatures use the extension-specific namespace and the pinned signer', () => {
  for (const hashName of ['sha256', 'sha512']) {
    const {publicSsh, ...envelope} = sshEnvelope(catalogFixture(), {hashName});
    const verified = verifyPluginCatalog(envelope, {trustedKeys: {'local-test': publicSsh}});
    assert.equal(verified.verified.algorithm, 'sshsig');
  }
  const {publicSsh, ...wrongNamespace} = sshEnvelope(catalogFixture(), {namespace: 'git'});
  assert.throws(() => verifyPluginCatalog(wrongNamespace, {trustedKeys: {'local-test': publicSsh}}), /verification/);
  const {privateKey: otherPrivate, publicKey: otherPublic} = generateKeyPairSync('ed25519');
  const {publicSsh: unused, ...wrongSigner} = sshEnvelope(catalogFixture(), {key: otherPrivate, pub: otherPublic});
  assert.throws(() => verifyPluginCatalog(wrongSigner, {trustedKeys: {'local-test': publicSsh}}), /verification/);
});

test('catalog limits archive size and requires immutable HTTPS locations', () => {
  for (const url of ['http://example.test/package.zip', 'https://example.test/latest/package.zip', 'https://example.test/package.zip?latest=1', 'https://user:pass@example.test/package.zip', 'https://example.test/package.zip#hash']) {
    const item = packageFixture(); item.archive.url = url;
    assert.throws(() => parsePluginCatalog(catalogFixture([item])), /HTTPS/);
  }
  for (const bytes of [0, -1, PLUGIN_PACKAGE_LIMIT + 1, 1.5]) {
    const item = packageFixture(); item.archive.bytes = bytes;
    assert.throws(() => parsePluginCatalog(catalogFixture([item])), /size/);
  }
  const item = packageFixture(); item.archive.bytes = PLUGIN_PACKAGE_LIMIT;
  assert.equal(parsePluginCatalog(catalogFixture([item])).packages[0].archive.bytes, PLUGIN_PACKAGE_LIMIT);
});

test('catalog rejects ambiguous duplicate release identities and conflicting archive aliases', () => {
  const item = packageFixture();
  assert.throws(() => parsePluginCatalog(catalogFixture([item, structuredClone(item)])), /Duplicate/);
  const buildA = packageFixture(undefined, '1.0.0+a'), buildB = packageFixture(undefined, '1.0.0+b');
  assert.throws(() => parsePluginCatalog(catalogFixture([buildA, buildB])), /Duplicate/);
  const other = packageFixture('another', '1.0.0', {}); other.archive.url = item.archive.url;
  assert.throws(() => parsePluginCatalog(catalogFixture([item, other])), /Conflicting/);
});

test('catalog listing provides individual compatibility reasons and preserves history', () => {
  const v1 = packageFixture(undefined, '1.0.0'), v2 = packageFixture(undefined, '2.0.0'); v2.manifest.appRange = '>=2.0.0';
  const rows = catalogPackages(catalogFixture([v1, v2]), {appVersion: '1.9.2', query: '可选'});
  assert.equal(rows.length, 2); assert.equal(rows[0].manifest.version, '2.0.0');
  assert.deepEqual(rows[0].reasons, ['app-version']); assert.equal(rows[1].compatible, true);
  assert.equal(catalogPackages(catalogFixture(), {appVersion: '1.9.2', query: 'does-not-exist'}).length, 0);
});

test('install plan pins compatible versions, orders dependencies and reuses only matching content', () => {
  const latest = packageFixture(undefined, '1.1.0'), payload = catalogFixture([...catalogFixture().packages, latest]);
  const verified = verifyPluginCatalog(signed(payload), trust), options = {appVersion: '1.9.2', installed: [{id: 'ai-buddy.kimi-runtime', version: '1.0.0', sha256: payload.packages[1].archive.sha256}]};
  const plan = resolvePluginInstallPlan(verified, ['ai-buddy.kimi-engine'], options);
  assert.deepEqual(plan.packages.map(p => [p.manifest.id, p.manifest.version, p.reuse]), [['ai-buddy.kimi-runtime', '1.0.0', true], ['ai-buddy.kimi-engine', '1.1.0', false]]);
  assert.equal(plan.downloadBytes, 123); assert.equal(plan.catalogSha256, verified.verified.payloadSha256);
  assert.equal(plan.planId, resolvePluginInstallPlan(verified, ['ai-buddy.kimi-engine'], options).planId);
  assert.ok(Object.isFrozen(plan.packages[1].manifest));
  const wrongHash = resolvePluginInstallPlan(verified, ['ai-buddy.kimi-engine'], {...options, installed: [{...options.installed[0], sha256: '0'.repeat(64)}]});
  assert.equal(wrongHash.downloadBytes, 246);
  assert.equal(resolvePluginInstallPlan(verified, [{id: 'ai-buddy.kimi-engine', version: '1.0.0'}], options).packages.at(-1).manifest.version, '1.0.0');
});

test('dependency solver backtracks when later roots constrain an earlier latest choice', () => {
  const payload = catalogFixture([packageFixture('app-one', '1.0.0', {shared: '>=1.0.0 <3.0.0'}), packageFixture('app-two', '1.0.0', {shared: '^1.0.0'}), packageFixture('shared', '2.0.0', {}), packageFixture('shared', '1.5.0', {})]);
  const plan = resolvePluginInstallPlan(payload, ['app-one', 'app-two'], {appVersion: '1.9.2'});
  assert.equal(plan.packages.find(p => p.manifest.id === 'shared').manifest.version, '1.5.0');
  assert.equal(plan.packages.filter(p => p.manifest.id === 'shared').length, 1);
});

test('missing, incompatible, cyclic and unsatisfiable dependency graphs cannot start downloading', () => {
  const options = {appVersion: '1.9.2'};
  assert.throws(() => resolvePluginInstallPlan(catalogFixture([packageFixture()]), ['ai-buddy.kimi-engine'], options), /Missing/);
  assert.throws(() => resolvePluginInstallPlan(catalogFixture(), ['ai-buddy.kimi-engine'], {...options, apiVersion: '2.0.0'}), /incompatible/);
  const cyclic = catalogFixture([packageFixture('one', '1.0.0', {two: '*'}), packageFixture('two', '1.0.0', {one: '*'})]);
  assert.throws(() => resolvePluginInstallPlan(cyclic, ['one'], options), /Cyclic/);
  const conflict = catalogFixture([packageFixture('one', '1.0.0', {shared: '^1.0.0'}), packageFixture('two', '1.0.0', {shared: '^2.0.0'}), packageFixture('shared', '1.0.0', {}), packageFixture('shared', '2.0.0', {})]);
  assert.throws(() => resolvePluginInstallPlan(conflict, ['one', 'two'], options), /conflicting/);
});

test('catalog parsing is separate from cryptographic trust and permits a valid offline empty catalog', () => {
  const empty = catalogFixture([]);
  assert.equal(verifyPluginCatalog(signed(empty), trust).packages.length, 0);
  assert.equal(parsePluginCatalog(empty).verified, undefined);
  const malformed = catalogFixture(); malformed.packages[0].publishedAt = '2026-10-23T13:00:00Z';
  assert.throws(() => verifyPluginCatalog(signed(malformed), trust), /publication/);
});
