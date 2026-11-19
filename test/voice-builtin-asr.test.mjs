import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createVoiceAssets} from '../src/voice/runtime-assets.mjs';
import {stageBuiltinAsrAssets} from '../scripts/builtin-asr-assets.mjs';

const repo = resolve(import.meta.dirname, '..');

async function application(t) {
  const root = await mkdtemp(join(tmpdir(), 'voice-builtin-asr-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const app = join(root, 'app');
  await stageBuiltinAsrAssets(repo, app);
  const directory = join(app, 'assets', 'voice-asr');
  return {root, directory};
}

test('the built-in recognition component offers the official download with no voice plugin installed', async t => {
  const {root, directory} = await application(t);
  let pluginCalls = 0;
  const assets = createVoiceAssets({dataRoot:root, builtinAsrDirectory:directory,
    resolveVoicePackage:() => { pluginCalls++; throw Error('no voice plugin installed'); }});
  t.after(() => assets.close());
  const result = await assets.status('asr', 'builtin-asr');
  assert.deepEqual([result.state,result.downloadAvailable,pluginCalls], ['missing',true,0]);
  assert.ok(result.downloadBytes > 0 && result.bytes > 0);
});

test('paused and failed cloud ASR downloads wait for manual resume across application restarts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'builtin-asr-pause-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const {createBuiltinAsr} = await import('../src/voice/builtin-asr.mjs');
  const events = [];
  let attempts = 0, ready = false, failNext = false, finish;
  const assets = {
    status:async () => ({state:ready ? 'ready' : 'missing',downloadAvailable:true,downloadBytes:100}),
    prepare:async (kind, {engineId,signal,onProgress}) => {
      assert.deepEqual([kind,engineId], ['asr','builtin-asr']);
      attempts++;
      onProgress({phase:'downloading',downloadReceivedBytes:40,downloadBytes:100});
      if (failNext) throw Object.assign(Error('synthetic offline'), {code:'NETWORK_FAILED'});
      await new Promise((resolve,reject) => {
        finish = () => {ready = true;resolve();};
        signal.addEventListener('abort', () => reject(signal.reason), {once:true});
      });
    }
  };
  const manager = () => createBuiltinAsr({dataRoot:root,assets,publish:row => events.push(row)});
  let first = manager();
  await Promise.all([first.auto(), first.auto()]);
  assert.equal(attempts, 1);
  assert.deepEqual([events.at(-1).received,events.at(-1).total], [40,100]);
  assert.equal((await first.pause()).state, 'paused');
  await first.close();
  let next = manager();
  assert.equal((await next.auto()).state,'paused');
  assert.equal(attempts,1);
  failNext = true;
  await next.resume();
  await waitForState(next, 'failed');
  await next.close();
  next = manager();
  assert.equal((await next.auto()).state,'failed');
  assert.equal(attempts,2);
  failNext = false;
  await next.resume();
  finish();
  await waitForState(next, 'ready');
  assert.equal(attempts,3);
  await next.close();
});

async function waitForState(manager, expected) {
  for (let index = 0; index < 100; index++) {
    if ((await manager.status()).state === expected) return;
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  assert.equal((await manager.status()).state, expected);
}

test('candidate ASR ships its verified scripts, downloadable descriptors and licenses, and recognizes an existing official component', async t => {
  const root = await mkdtemp(join(tmpdir(), 'builtin-asr-package-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const index = await stageBuiltinAsrAssets(repo, root);
  const directory = join(root,'assets','voice-asr');
  const names = ['assets.json','downloads.json','asr.py','asr_worker.py','worker_protocol.py','ASSET-NOTICES.md','LICENSE.md'].sort();
  assert.deepEqual((await readdir(directory)).sort(),names);
  assert.deepEqual(index.map(row => row.path).sort(),names.map(name => 'assets/voice-asr/' + name));
  for (const row of index) {
    const bytes = await readFile(join(root,row.path));
    assert.equal(row.bytes,bytes.length);
    assert.equal(row.sha256,createHash('sha256').update(bytes).digest('hex'));
  }
  const descriptor = '36402e36a0e3249db75d6d93995bfd696f1759b0c1c8620300ab8a3df92b5eee';
  const receipt = 'asr:official:2a649fc210a00f20b5000d82ac56ba8a6e383c71947bc899880a9307ac90c06e:' + descriptor;
  const installed = join(root,'voice','components','asr',descriptor);
  await mkdir(installed,{recursive:true});
  await writeFile(join(installed,'.ready'),receipt);
  const assets = createVoiceAssets({dataRoot:root,builtinAsrDirectory:directory,
    resolveVoicePackage:() => {throw Error('no plugin installed');}});
  t.after(() => assets.close());
  assert.equal((await assets.status('asr','builtin-asr')).state,'ready');
  const priorReceipt = 'asr:legacy:' + 'a'.repeat(64) + ':' + descriptor;
  await writeFile(join(installed,'.ready'),priorReceipt);
  assert.equal((await assets.status('asr','builtin-asr')).state,'ready','an existing validated distribution with identical members is shared');
  assert.equal(await readFile(join(installed,'.ready'),'utf8'),priorReceipt,'built-in ASR preserves the local plugin receipt');
  await assert.rejects(assets.resolve('asr','builtin-asr'),error => ['ENOENT','VOICE_ASSET_MISSING','VOICE_ASSET_HASH'].includes(error.code),'the old marker cannot authorize missing payload bytes');
  await writeFile(join(directory,'asr_worker.py'),'changed');
  await assert.rejects(assets.resolve('asr','builtin-asr'), {code:'VOICE_ASSET_MANIFEST'});
});
