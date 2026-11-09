import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonicalPluginJson} from '../src/plugin-manifest.mjs';
import {buildPluginArchive} from '../src/plugin-archive.mjs';
import {createPluginManager} from '../src/plugin-manager.mjs';
import {pluginSourceFingerprint} from '../src/plugin-sources.mjs';
import React from 'react';
import {VoiceInstalledMoreMenu} from '../src/community-installed-voice.mjs';
import {PluginVersionMenu,PluginInstallPlanDialog} from '../src/plugin-center.mjs';
import {setLocale} from '../src/i18n.mjs';

const shared = 'ai-buddy.voice-shared-runtime', breeze = 'ai-buddy.voice-breeze', gpt = 'ai-buddy.voice-gpt-sovits';
const sha = value => createHash('sha256').update(value).digest('hex');
function pack(id, version) {
  const runtime = id === shared, engine = id === breeze ? 'breeze' : 'gpt-sovits';
  const files = new Map([['assets.json', Buffer.from('{}')], ...(runtime ? [['asr_worker.py', Buffer.from('# fixture')]] : [['entry.mjs', Buffer.from('export function activate() {}')], [id === breeze ? 'breeze_worker.py' : 'gpt_worker.py', Buffer.from('# fixture')]])]);
  const manifest = {schemaVersion: 1, id, name: id, description: '', version, kind: runtime ? 'runtime' : 'plugin', appRange: '^2.0.11', apiRange: '^1.0.0', platform: 'win32', arch: 'x64', entry: runtime ? 'asr_worker.py' : 'entry.mjs', activationEvents: runtime ? [] : ['onCommand:voice.' + engine], capabilities: runtime ? [] : ['commands.register'], dependencies: runtime ? {} : {[shared]: version}, files: [...files].map(([path, bytes]) => ({path, bytes: bytes.length, sha256: sha(bytes)}))};
  const bytes = buildPluginArchive(manifest, files); return {bytes, manifest, archive: {url: 'https://voice-switch.example/' + id + '/' + version + '.zip', bytes: bytes.length, sha256: sha(bytes)}, publishedAt: '2026-11-09T00:00:00Z'};
}
async function setup(t, {legacy = false, missingOldGpt = false, singleEngine = false} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'voice-switch-212-')), dataRoot = join(root, 'data'); await mkdir(dataRoot);
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  const field = value => {const b = Buffer.from(value), h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]);};
  const key = 'ssh-ed25519 ' + Buffer.concat([field('ssh-ed25519'), field(publicKey.export({type: 'spki', format: 'der'}).subarray(-32))]).toString('base64');
  const packages = ['1.0.1', '1.0.2'].flatMap(version => [shared, breeze, gpt].filter(id => !(missingOldGpt && id === gpt && version === '1.0.1')).map(id => pack(id, version)));
  const payload = {schemaVersion: 1, id: 'switch.fixture', generatedAt: '2026-11-09T00:00:00Z', packages: packages.map(({bytes, ...item}) => item)};
  const envelope = {payload, signature: {algorithm: 'ed25519', keyId: 'fixture', value: sign(null, Buffer.from(canonicalPluginJson(payload)), privateKey).toString('base64')}};
  const config = {root, dataRoot, appVersion: '2.0.12', voiceTestFingerprint: pluginSourceFingerprint(key), trustedKeys: {fixture: publicKey}, fetchImpl: async url => url.endsWith('/source.json') ? Response.json({schemaVersion: 1, id: payload.id, name: 'Voice switch fixture', keyId: 'fixture', publicKey: key, catalogUrl: 'https://voice-switch.example/catalog.json'}) : url.endsWith('/catalog.json') ? Response.json(envelope) : new Response(packages.find(item => item.archive.url === url)?.bytes ?? '', {status: packages.some(item => item.archive.url === url) ? 200 : 404})};
  let manager = await createPluginManager(config), sourceId = 'legacy';
  t.after(async () => {await manager.close(); await rm(root, {recursive: true, force: true});});
  if (legacy) await manager.loadCatalog(envelope);
  else {const preview = await manager.action({action: 'sources-preview', url: 'https://voice-switch.example/source.json'}); sourceId = preview.source.sourceId; await manager.action({action: 'sources-add', previewId: preview.previewId, keyFingerprint: preview.source.keyFingerprint});}
  const initial = await manager.action({action: 'plan', sourceId, requests: (singleEngine ? [breeze] : [breeze, gpt]).map(id => ({id, version: '1.0.2'}))});
  await manager.action({action: 'install', planId: initial.planId});
  for (const id of singleEngine ? [breeze] : [breeze, gpt]) await manager.action({action: 'enable', sourceId, id});
  return {sourceId, get manager() {return manager;}, async restart() {await manager.close(); manager = await createPluginManager(config);}};
}

for (const legacy of [false, true]) test('one engine version plan switches both installed engines and shared runtime together (' + (legacy ? 'legacy' : 'source') + ')', async t => {
  const f = await setup(t, {legacy}), before = {};
  for (const id of [breeze, gpt]) {const r = await f.manager.resolveInstalled(id); before[id] = r.dataDirectory; await writeFile(join(r.dataDirectory, 'keep.json'), id);}
  for (const version of ['1.0.1', '1.0.2']) {
    const plan = await f.manager.action({action: 'plan', sourceId: f.sourceId, requests: [{id: breeze, version}]});
    assert.deepEqual(plan.packages.map(item => [item.manifest.id, item.manifest.version]).sort(), [shared, breeze, gpt].map(id => [id, version]).sort());
    await f.manager.action({action: 'install', planId: plan.planId});
    for (const id of [shared, breeze, gpt]) assert.equal(f.manager.snapshot().installed[id].current, version);
    for (const id of [breeze, gpt]) {const r = await f.manager.resolveInstalled(id); assert.equal(f.manager.snapshot().installed[id].enabled, true); assert.equal(r.dataDirectory, before[id]); assert.equal(await readFile(join(r.dataDirectory, 'keep.json'), 'utf8'), id);}
  }
  await f.restart();
  for (const id of [breeze, gpt]) {assert.equal((await f.manager.resolveInstalled(id)).version, '1.0.2'); assert.equal(f.manager.snapshot().installed[id].previous, '1.0.1');}
});

test('version switch cannot silently install the absent second engine', async t => {
  const f = await setup(t, {singleEngine: true}), plan = await f.manager.action({action: 'plan', sourceId: f.sourceId, requests: [{id: breeze, version: '1.0.1'}]});
  assert.deepEqual(plan.packages.map(item => item.manifest.id).sort(), [breeze, shared].sort());
  await f.manager.action({action: 'install', planId: plan.planId}); assert.equal(f.manager.snapshot().installed[gpt], undefined);
});

test('version switch without a matching installed sibling release fails during planning and leaves pointers intact', async t => {
  const f = await setup(t, {missingOldGpt: true});
  const cards = await f.manager.action({action: 'search', sourceId: f.sourceId});
  const old = cards.items.find(row => row.manifest.id === breeze).versions.find(row => row.manifest.version === '1.0.1');
  assert.equal(old.switchCompatible, false); assert.equal(old.switchReason, '已安装的另一语音引擎没有相容的成套版本，无法切换');
  await assert.rejects(f.manager.action({action: 'plan', sourceId: f.sourceId, requests: [{id: breeze, version: '1.0.1'}]}), {code: 'PLUGIN_DEPENDENCY_ERROR'});
  for (const id of [shared, breeze, gpt]) assert.equal(f.manager.snapshot().installed[id].current, '1.0.2');
  await assert.rejects(f.manager.action({action: 'plan', sourceId: f.sourceId, requests: [{id: breeze, version: '1.0.1'}, {id: gpt, version: '1.0.2'}]}), {code: 'PLUGIN_DEPENDENCY_ERROR'});
});

test('installed more-menu switch and rollback review the real coordinated plan before changing either engine',async t=>{
  setLocale('zh-CN');
  const f=await setup(t),elements=node=>!node||typeof node!=='object'?[]:[node,...React.Children.toArray(node.props?.children).flatMap(elements),...React.Children.toArray(node.props?.footer).flatMap(elements)];
  let review=null;
  const select=async version=>{review=await f.manager.action({action:'plan',sourceId:version.sourceId,requests:[{id:version.manifest.id,version:version.manifest.version}]});};
  async function menu(){const result=await f.manager.action({action:'search',kind:'installed',sourceId:f.sourceId});return VoiceInstalledMoreMenu({row:result.items.find(row=>row.manifest.id===breeze),versionsOpen:true,onVersionSelect:select});}
  async function confirm(version){
    assert.deepEqual(review.packages.map(row=>[row.manifest.id,row.manifest.version]).sort(),[shared,breeze,gpt].map(id=>[id,version]).sort());
    const dialog=PluginInstallPlanDialog({plan:review,onInstall:()=>f.manager.action({action:'install',planId:review.planId})});
    await elements(dialog).find(value=>value.type==='button'&&value.props.children==='安装').props.onClick();
    for(const id of [shared,breeze,gpt])assert.equal(f.manager.snapshot().installed[id].current,version);
  }
  const initial=await menu(),branch=elements(initial).find(value=>value.type===PluginVersionMenu);
  await PluginVersionMenu(branch.props).props.items.find(value=>value.label==='1.0.1').onSelect();
  for(const id of [shared,breeze,gpt])assert.equal(f.manager.snapshot().installed[id].current,'1.0.2','selecting a release only opens the review');
  await confirm('1.0.1');
  const updated=await menu(),rollback=elements(updated).find(value=>value.props?.items).props.items.find(value=>value.label==='回退到 1.0.2');
  assert.equal(rollback.disabled,false);await rollback.onSelect();
  for(const id of [shared,breeze,gpt])assert.equal(f.manager.snapshot().installed[id].current,'1.0.1','rollback also awaits the coordinated confirmation');
  await confirm('1.0.2');
});
