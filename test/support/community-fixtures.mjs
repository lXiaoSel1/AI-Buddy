import {generateKeyPairSync, sign, createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonicalPluginJson} from '../../src/plugin-manifest.mjs';
import {pluginSourceFingerprint} from '../../src/plugin-sources.mjs';
import {createCommunityService} from '../../src/community/service.mjs';

export const sha = value => createHash('sha256').update(value).digest('hex');
export function publisher() {
  const {publicKey, privateKey} = generateKeyPairSync('ed25519'), raw = publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
  const field = value => { const b = Buffer.from(value), h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]); };
  const publicSsh = 'ssh-ed25519 ' + Buffer.concat([field('ssh-ed25519'), field(raw)]).toString('base64');
  const source = {sourceId: '11111111-1111-1111-1111-111111111111', descriptorId: 'community.test', keyId: 'community-test', publicKey: publicSsh, keyFingerprint: pluginSourceFingerprint(publicSsh), enabled: true, removed: false, generation: 0};
  return {privateKey, source};
}
export const signed = (payload, pub) => ({payload, signature: {algorithm: 'ed25519', keyId: pub.source.keyId, value: sign(null, Buffer.from(canonicalPluginJson(payload)), pub.privateKey).toString('base64')}});
export function catalog(pub, changes = {}) {
  const ref = {backend: 'dsh', packageName: '@community-test/test-tools', exactVersion: '1.0.0', sourceDigest: sha('native-tarball'), spec: {kind: 'tarball', value: 'https://github.com/test/native/releases/download/v1.0.0/native.tgz'}, compatibility: {app: '^1.9.2', dsh: '^1.0.0', bridge: '^1.0.0'}, capabilities: ['characters.getContext'], dataSchemaVersion: 1};
  return {schemaVersion: 1, type: 'ai-buddy-community-catalog', id: 'community.test', generatedAt: '2026-10-24T22:00:00Z', source: {descriptorId: pub.source.descriptorId, keyFingerprint: pub.source.keyFingerprint}, authors: [{id: 'author.test', name: 'Test author', githubLogin: 'author-test', url: 'https://github.com/author-test'}], works: [{id: 'test.tools', backend: 'dsh', packageName: ref.packageName, name: '真实工具测试包（模拟目录）', description: 'Simulation fixture; not an installed or reviewed product', authorId: 'author.test', category: 'function', tags: ['fixture'], repositoryUrl: 'https://github.com/test/native', discussionUrl: 'https://github.com/test/native/discussions/1', reviewsRepository: 'test/native', releases: [{version: '1.0.0', publishedAt: '2026-10-24T21:00:00Z', package: ref}], status: 'published'}, ...changes.extraWorks ?? []], ...Object.fromEntries(Object.entries(changes).filter(([key]) => key !== 'extraWorks'))};
}
export function githubIssue(changes = {}) { return {id: 101, node_id: 'I_test101', number: 1, html_url: 'https://github.com/test/native/issues/1', user: {id: 77, login: 'real-user', type: 'User'}, labels: [{name: 'community-review'}], created_at: '2026-10-24T21:00:00Z', updated_at: '2026-10-24T22:00:00Z', body: '### Work ID\n\ntest.tools\n\n### Work version\n\n1.0.0\n\n### Stars\n\n5\n\n### Review\n\nUseful tool, tested on Windows.', ...changes}; }
export function simulatedBackend(calls) {
  return {
    async probe() { calls.push(['probe']); return {backend: 'dsh', ready: true, version: '1.0.0', phase: 'simulated'}; },
    async planInstall(request) { calls.push(['plan', request]); return {schemaVersion: 1, packageRef: request.packageRef, profileId: request.profileId, planDigest: sha(JSON.stringify(request)), phase: 'simulated-plan'}; },
    async install(plan, options) { calls.push(['install', plan, options]); return {installed: true, enabled: options.enabled, phase: 'simulated-installed', profileId: plan.profileId}; },
    async enable(ref) { calls.push(['enable', ref]); return {enabled: true, loaded: true, phase: 'simulated-loaded'}; },
    async disable(ref) { calls.push(['disable', ref]); return {enabled: false, phase: 'simulated-disabled'}; },
    async rollback(ref, options) { calls.push(['rollback', ref, options]); return {installed: true, enabled: false, phase: 'simulated-rollback'}; },
    async uninstall(ref) { calls.push(['uninstall', ref]); return {installed: false, enabled: false, phase: 'simulated-uninstalled'}; },
    async openClient(ref) { calls.push(['openClient', ref]); return {runtimeId: 'simulated-runtime', profileId: ref.profileId, authURL: 'http://127.0.0.1:1234/?token=DO-NOT-EXPOSE', webOrigin: 'http://127.0.0.1:1234', clientState: 'simulated-client'}; },
    async close() { calls.push(['close']); },
  };
}
export async function setupCommunity(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'buddy-community-simulation-')), dataRoot = join(root, 'data'), pub = publisher(), calls = [], grants = [], opened = [];
  const legacy = {snapshot: () => ({appVersion: '1.9.2', service: {state: 'ready', usable: true}, installed: {}, packages: []}), action: async request => request.action === 'status' ? legacy.snapshot() : {legacy: true, request}, resolveTrustedSource: async id => { if (id !== pub.source.sourceId) throw Error('Unknown source'); return {...pub.source}; }, close: async () => {}, prepareOffline: async () => ({}), resolveInstalled: async () => ({legacy: true})};
  const backend = simulatedBackend(calls), config = {root, dataRoot, legacyManager: legacy, dshBackend: backend, pollMs: 0, onPackageState: async value => grants.push(value), onOpenClient: async (descriptor, intent) => opened.push({descriptor, intent}), ...options};
  let service = await createCommunityService(config);
  t.after(async () => { await service.close(); await rm(root, {recursive: true, force: true}); });
  return {root, dataRoot, pub, calls, grants, opened, backend, legacy, config, get service() { return service; }, async restart() { await service.close(); service = await createCommunityService(config); return service; }, async load(value = catalog(pub)) { return service.action({action: 'community-load-catalog', sourceId: pub.source.sourceId, envelope: signed(value, pub)}); }, async install() { const plan = await service.action({action: 'dsh-plan', sourceId: pub.source.sourceId, id: 'test.tools'}); const result = await service.action({action: 'dsh-install', planId: plan.planId, grantedCapabilities: plan.declaredCapabilities}); await service.drainMaintenance(); return result; }};
}
