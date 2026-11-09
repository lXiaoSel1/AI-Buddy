import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {canonicalPluginJson} from '../src/plugin-manifest.mjs';
import {buildPluginArchive, extractPluginArchive} from '../src/plugin-archive.mjs';
import {createPluginManager} from '../src/plugin-manager.mjs';
import {verifyPluginCatalog} from '../src/plugin-catalog.mjs';
import {OFFICIAL_SOURCE_CATALOG_URL} from '../src/plugin-sources.mjs';
import {setupCommunity, catalog as communityCatalog, sha as communitySha} from './support/community-fixtures.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const field = value => {const b = Buffer.from(value), h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]);};
function fixturePackage(version, appRange = '^2.0.0') {
  const entry = Buffer.from('export function activate() {}');
  const manifest = {schemaVersion: 1, id: 'ai-buddy.kimi-engine', name: 'Kimi fixture', description: '', version,
    kind: 'plugin', appRange, apiRange: '^1.0.0', platform: 'win32', arch: 'x64', entry: 'entry.mjs',
    activationEvents: ['onHarness:kimi'], capabilities: ['harness.register'], dependencies: {},
    files: [{path: 'entry.mjs', bytes: entry.length, sha256: sha(entry)}]};
  const bytes = buildPluginArchive(manifest, new Map([['entry.mjs', entry]]));
  return {manifest, archive: {url: 'https://registration.example/' + version + '.zip', bytes: bytes.length, sha256: sha(bytes)}, publishedAt: '2026-11-09T00:00:00Z', bytes};
}
async function setup(t, {packages = [fixturePackage('1.0.0', '2.0.8'), fixturePackage('1.0.1')], appVersion = '2.0.8'} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'registration-212-')), dataRoot = join(root, 'data'); await mkdir(dataRoot);
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  const key = 'ssh-ed25519 ' + Buffer.concat([field('ssh-ed25519'), field(publicKey.export({format: 'der', type: 'spki'}).subarray(-32))]).toString('base64');
  const payload = {schemaVersion: 1, id: 'registration.fixture', generatedAt: '2026-11-09T00:00:00Z', packages: packages.map(({bytes, ...item}) => item)};
  const envelope = {payload, signature: {algorithm: 'ed25519', keyId: 'fixture', value: sign(null, Buffer.from(canonicalPluginJson(payload)), privateKey).toString('base64')}};
  const config = {root, dataRoot, appVersion, fetchImpl: async url => url.endsWith('/source.json') ? Response.json({schemaVersion: 1, id: payload.id, name: 'Registration fixture', keyId: 'fixture', publicKey: key, catalogUrl: 'https://registration.example/catalog.json'}) : url.endsWith('/catalog.json') ? Response.json(envelope) : new Response(packages.find(item => item.archive.url === url)?.bytes ?? '', {status: packages.some(item => item.archive.url === url) ? 200 : 404})};
  let manager = await createPluginManager(config);
  t.after(async () => {await manager.close(); await rm(root, {recursive: true, force: true});});
  const p = await manager.action({action: 'sources-preview', url: 'https://registration.example/source.json'});
  await manager.action({action: 'sources-add', previewId: p.previewId, keyFingerprint: p.source.keyFingerprint});
  return {root, dataRoot, sourceId: p.source.sourceId, get manager() {return manager;}, async restart(appVersion) {await manager.close(); manager = await createPluginManager({...config, appVersion});}};
}

test('source search shows one card with current version and historical compatibility in its version menu', async t => {
  const f = await setup(t);
  const plan = await f.manager.action({action: 'plan', sourceId: f.sourceId, requests: [{id: 'ai-buddy.kimi-engine', version: '1.0.0'}]});
  await f.manager.action({action: 'install', planId: plan.planId});
  await f.restart('2.0.12');
  const result = await f.manager.action({action: 'search', sourceId: f.sourceId});
  assert.equal(result.total, 1);
  assert.equal(result.items[0].manifest.version, '1.0.0');
  assert.deepEqual(result.items[0].versions.map(row => [row.manifest.version, row.current, row.compatible]), [['1.0.1', false, true], ['1.0.0', true, false]]);
  const old = await f.manager.action({action: 'details', sourceId: f.sourceId, id: 'ai-buddy.kimi-engine', version: '1.0.0'});
  assert.equal(old.manifest.appRange, '2.0.8');
  const updates = await f.manager.action({action: 'update-candidates'});
  assert.equal(updates.updates[0].requiresCompatibilityUpdate, true);
});

test('community update row identifies the compatible release needed after a host upgrade', async t => {
  let appVersion = '1.9.2';
  const f = await setupCommunity(t); const snapshot = f.legacy.snapshot;
  f.legacy.snapshot = () => ({...snapshot(), appVersion});
  await f.load(); await f.install();
  const value = communityCatalog(f.pub, {generatedAt: '2026-11-09T00:00:00Z'}), release = structuredClone(value.works[0].releases[0]);
  release.version = release.package.exactVersion = '1.0.1'; release.package.sourceDigest = communitySha('compatible-1.0.1');
  release.package.compatibility = {app: '>=1.9.2', dsh: '>=1.0.0', bridge: '^1.0.0'};
  value.works[0].releases.push(release); await f.load(value); appVersion = '2.0.12';
  const result = await f.service.action({action: 'community-check-updates'});
  assert.equal(result.updates[0].to, '1.0.1'); assert.equal(result.updates[0].requiresCompatibilityUpdate, true);
});

const officialFixture = new URL('./fixtures/official-registration/', import.meta.url);
async function officialSetup(t, {legacy = false, tamper, interruptMigration = false, mutateAfterInterruption, trustedKeys, remote = new Map(), extra = {}} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'official-registration-212-')), dataRoot = join(root, 'data');
  const control = join(root, 'local/plugins'), id = 'ai-buddy.voice-shared-runtime';
  await mkdir(dataRoot, {recursive: true});
  const envelope = JSON.parse(await readFile(new URL('catalog.json', officialFixture), 'utf8'));
  const catalog = verifyPluginCatalog(envelope), versions = {};
  for (const version of ['1.0.1', '1.0.2']) {
    const item = catalog.packages.find(item => item.manifest.id === id && item.manifest.version === version);
    const bytes = await readFile(new URL('shared-' + version + '.zip', officialFixture));
    assert.equal(sha(bytes), item.archive.sha256, 'fixture is the original immutable published archive');
    versions[version] = {...item, directory: 'packages/' + id + '/' + version + '-' + item.archive.sha256.slice(0, 16), catalogSha256: catalog.verified.payloadSha256, installedAt: '2026-11-09T00:00:00Z'};
    if (legacy) await extractPluginArchive(bytes, join(control, versions[version].directory), item.manifest);
  }
  if (legacy) {
    await mkdir(join(control, 'catalogs'), {recursive: true});
    await writeFile(join(control, 'catalogs', catalog.verified.payloadSha256 + '.json'), JSON.stringify(envelope));
    if (tamper) await tamper({versions, control, envelope});
    await writeFile(join(control, 'registry.json'), JSON.stringify({schemaVersion: 1, packages: {[id]: {versions, current: '1.0.2', previous: '1.0.1', enabled: true, dataSchemaVersion: 1}}}));
    await mkdir(join(dataRoot, 'plugins', id), {recursive: true});
    await writeFile(join(dataRoot, 'plugins', id, 'keep.json'), 'original voice settings');
  }
  let downloads = 0, manager;
  const config = {root, dataRoot, appVersion: '2.0.12', trustedKeys, ...extra, fetchImpl: async url => {
    if(remote.has(url))return Response.json(remote.get(url));
    if (url === OFFICIAL_SOURCE_CATALOG_URL) return Response.json(envelope);
    const item = catalog.packages.find(item => item.archive.url === url);
    if (!item) return new Response('', {status: 404});
    downloads++;
    return new Response(await readFile(new URL('shared-' + item.manifest.version + '.zip', officialFixture)));
  }};
  if (interruptMigration) {
    const code = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const rename=fs.renameSync; fs.renameSync=(from,to)=>{rename(from,to);if(to.endsWith('registry-v2.json'))process.exit(73);}; syncBuiltinESMExports();
      const {createPluginManager}=await import(${JSON.stringify(new URL('../src/plugin-manager.mjs', import.meta.url).href)});
      await createPluginManager(${JSON.stringify({root, dataRoot, appVersion: '2.0.12'})});`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {encoding: 'utf8', timeout: 10000});
    assert.equal(child.status, 73, 'process stops after the real first registry publication: ' + child.stderr);
    if (mutateAfterInterruption) await mutateAfterInterruption({root, control, dataRoot});
  }
  try {manager = await createPluginManager(config);} catch (error) {await rm(root, {recursive: true, force: true}); throw error;}
  t.after(async () => {await manager.close(); await rm(root, {recursive: true, force: true});});
  return {root, dataRoot, id, envelope, config, get downloads() {return downloads;}, get manager() {return manager;}, async restart() {await manager.close(); manager = await createPluginManager(config);}};
}

test('old-extension search filters voice before pagination and keeps official Kimi plus third-party and legacy packages',async t=>{
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),key='ssh-ed25519 '+Buffer.concat([field('ssh-ed25519'),field(publicKey.export({type:'spki',format:'der'}).subarray(-32))]).toString('base64');
  const signed=(id,packages)=>{const payload={schemaVersion:1,id,generatedAt:'2026-11-09T00:00:00Z',packages:packages.map(({bytes,...item})=>item)};return {payload,signature:{algorithm:'ed25519',keyId:'fixture',value:sign(null,Buffer.from(canonicalPluginJson(payload)),privateKey).toString('base64')}};};
  const remote=new Map(),f=await officialSetup(t,{trustedKeys:{fixture:publicKey},remote});
  const old=fixturePackage('1.0.0','^1.9.0');old.manifest={...old.manifest,id:'example.legacy-tool',name:'Legacy tool'};
  await f.manager.loadCatalog(signed('old.fixture',[old]));
  await f.manager.loadCatalog(f.envelope);
  remote.set('https://old-third.example/source.json',{schemaVersion:1,id:'third.fixture',name:'Third-party old extensions',keyId:'fixture',publicKey:key,catalogUrl:'https://old-third.example/catalog.json'});
  remote.set('https://old-third.example/catalog.json',signed('third.fixture',[fixturePackage('1.0.0','^1.9.0')]));
  const preview=await f.manager.action({action:'sources-preview',url:'https://old-third.example/source.json'});
  await f.manager.action({action:'sources-add',previewId:preview.previewId,keyFingerprint:preview.source.keyFingerprint});
  const expected=[['official','ai-buddy.kimi-engine'],['official','ai-buddy.kimi-runtime'],['legacy','example.legacy-tool'],[preview.source.sourceId,'ai-buddy.kimi-engine']].sort();
  const pages=[];
  for(let page=1;page<=4;page++){
    const value=await f.manager.action({action:'search',excludeVoice:true,page,pageSize:1});
    assert.equal(value.total,4);assert.equal(value.items.length,1);pages.push([value.items[0].sourceId,value.items[0].manifest.id]);
  }
  assert.deepEqual(pages.sort(),expected);
  const official=await f.manager.action({action:'search',excludeVoice:true,sourceId:'official'});
  assert.deepEqual(official.items.map(row=>row.manifest.id).sort(),['ai-buddy.kimi-engine','ai-buddy.kimi-runtime']);
  assert.equal((await f.manager.action({action:'search'})).items.filter(row=>row.manifest.id.startsWith('ai-buddy.voice-')).length,2,'unfiltered APIs retain both 2.x engines');
});

test('verified old official registration migrates with enabled previous and original data across restart', async t => {
  const f = await officialSetup(t, {legacy: true});
  const installed = f.manager.snapshot().installed[f.id];
  assert.equal(installed.sourceId, 'official');
  assert.equal(installed.current, '1.0.2'); assert.equal(installed.previous, '1.0.1'); assert.equal(installed.enabled, true);
  const resolved = await f.manager.resolveInstalled(f.id);
  assert.equal(resolved.dataDirectory, join(f.dataRoot, 'plugins', f.id));
  assert.equal(await readFile(join(resolved.dataDirectory, 'keep.json'), 'utf8'), 'original voice settings');
  assert.equal((await f.manager.action({action: 'search', sourceId: 'legacy', kind: 'installed'})).total, 0);
  await f.restart();
  assert.equal((await f.manager.resolveInstalled(f.id)).sourceId, 'official');
  assert.equal(f.downloads, 0);
});

test('new official installation through the existing manager APIs lands in the official registry', async t => {
  const f = await officialSetup(t);
  await f.manager.loadCatalog(f.envelope);
  const plan = await f.manager.plan([{id: f.id, version: '1.0.2'}]);
  await f.manager.install({planId: plan.planId});
  assert.equal(f.manager.snapshot().installed[f.id].sourceId, 'official');
  const resolved = await f.manager.resolveInstalled(f.id, {requireEnabled: false});
  assert.equal(resolved.sourceProof.sourceId, 'official');
  assert.equal(f.downloads, 1);
  await f.restart();
  assert.equal((await f.manager.resolveInstalled(f.id, {requireEnabled: false})).sourceId, 'official');
});

test('historical signed offline proof does not pin a standalone catalog as the official URL identity', async t => {
  const f = await officialSetup(t);
  const historical = JSON.parse(await readFile(new URL('standalone-1.0.0-catalog.json', officialFixture), 'utf8'));
  await f.manager.loadCatalog(historical);
  await f.manager.action({action: 'sources-refresh', sourceId: 'official'});
  assert.equal(f.manager.snapshot().sources.find(row => row.sourceId === 'official').lastError, null);
  const plan = await f.manager.action({action: 'plan', sourceId: 'official', requests: [{id: f.id, version: '1.0.2'}]});
  assert.equal(plan.packages[0].manifest.version, '1.0.2');
  await assert.rejects(f.manager.loadCatalog(historical), {code: 'PLUGIN_SOURCE_CHANGED'}, 'a remotely pinned identity remains immutable');
});

for (const [reason, tamper] of [
  ['archive URL differs from signed publication', async ({versions}) => {versions['1.0.2'].archive = {...versions['1.0.2'].archive, url: 'https://attacker.example/copied.zip'};}],
  ['retained previous version lacks proof', async ({versions}) => {versions['1.0.1'].catalogSha256 = 'a'.repeat(64);}],
  ['extracted file hash changed', async ({versions, control}) => {await writeFile(join(control, versions['1.0.2'].directory, 'assets.json'), '{}');}],
  ['saved signature is invalid', async ({control, envelope}) => {envelope.signature.value = Buffer.alloc(64).toString('base64'); const catalogFile = (await import('node:fs/promises')).readdir; const [name] = await catalogFile(join(control, 'catalogs')); await writeFile(join(control, 'catalogs', name), JSON.stringify(envelope));}],
]) test('untrusted legacy package is never adopted when ' + reason, async t => {
  const f = await officialSetup(t, {legacy: true, tamper});
  assert.equal(f.manager.snapshot().installed[f.id].sourceId, undefined);
  assert.equal(f.manager.snapshot().installed[f.id].enabled, true);
  assert.equal(await readFile(join(f.dataRoot, 'plugins', f.id, 'keep.json'), 'utf8'), 'original voice settings');
  assert.equal(f.downloads, 0);
});

test('interrupted registry migration replays the journal and retains the exact original data path', async t => {
  const f = await officialSetup(t, {legacy: true, interruptMigration: true});
  const resolved = await f.manager.resolveInstalled(f.id);
  assert.equal(resolved.sourceId, 'official');
  assert.equal(resolved.dataDirectory, join(f.dataRoot, 'plugins', f.id));
  assert.equal(await readFile(join(resolved.dataDirectory, 'keep.json'), 'utf8'), 'original voice settings');
  await f.restart(); assert.equal(f.manager.snapshot().ambiguousIds.length, 0);
});

test('interrupted migration refuses to overwrite registration changed by another writer', async t => {
  await assert.rejects(officialSetup(t, {legacy: true, interruptMigration: true, mutateAfterInterruption: async ({control}) => {
    const file = join(control, 'registry.json'), value = JSON.parse(await readFile(file, 'utf8'));
    value.packages['ai-buddy.voice-shared-runtime'].enabled = false;
    await writeFile(file, JSON.stringify(value));
  }}), {code: 'PLUGIN_SOURCE_MIGRATION_CHANGED'});
});

test('A3 official startup waits for installation lock then recovers automatically',async t=>{
 let held=true;
 const f=await officialSetup(t,{legacy:true,extra:{startupRetryMs:5,startupRetryLimitMs:1000,withMaintenanceLock:async run=>{if(held)throw Object.assign(Error('installer held'),{code:'EBUSY',path:'install.lock'});return run();}}});
 assert.equal(f.manager.snapshot().service.state,'waiting-installation');held=false;
 const end=Date.now()+3000;while(f.manager.snapshot().service.state!=='ready'&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(f.manager.snapshot().service.state,'ready');assert.equal(f.manager.snapshot().installed[f.id].sourceId,'official');
});

test('A4 already migrated official registration repairs legacy automatic-update policy keys',async t=>{
 const f=await officialSetup(t,{legacy:true}),directory=join(f.dataRoot,'community');await mkdir(directory,{recursive:true});
 const old='buddy-v1:legacy:'+f.id,next='buddy-v1:official:'+f.id;
 await writeFile(join(directory,'preferences-v1.json'),JSON.stringify({schemaVersion:1,favorites:[],follows:[],pendingReviews:[],updatePolicies:{[old]:'automatic'},failedPluginUpdates:{[old]:{error:{code:'fixture'},from:'1.0.1',to:'1.0.2'}}}));
 await f.restart();const saved=JSON.parse(await readFile(join(directory,'preferences-v1.json'),'utf8'));
 assert.equal(saved.updatePolicies[next],'automatic');assert.equal(saved.updatePolicies[old],undefined);assert.equal(saved.failedPluginUpdates[next].error.code,'fixture');
});

test('A5 incompatible installed release stays visible without a newer catalog release',async t=>{
 const f=await setup(t,{appVersion:'2.0.14',packages:[fixturePackage('1.0.0','>=2.0.14')]});
 const plan=await f.manager.action({action:'plan',sourceId:f.sourceId,requests:[{id:'ai-buddy.kimi-engine',version:'1.0.0'}]});await f.manager.action({action:'install',planId:plan.planId});await f.restart('2.0.13');
 const row=f.manager.snapshot().installed['ai-buddy.kimi-engine'];assert.equal(row.compatible,false);assert.equal(row.compatibility.currentAppVersion,'2.0.13');
 const updates=await f.manager.action({action:'update-candidates'});assert.equal(updates.updates[0].state,'incompatible');assert.equal(updates.updates[0].to,null);assert.equal(updates.updates[0].installedIncompatible,true);await assert.rejects(f.manager.resolveInstalled('ai-buddy.kimi-engine',{requireEnabled:false}),{code:'PLUGIN_INCOMPATIBLE'});
});
