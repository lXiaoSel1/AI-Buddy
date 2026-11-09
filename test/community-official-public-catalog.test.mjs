import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {communityDigest} from '../src/community/catalog.mjs';
import {catalog, setupCommunity, signed, sha} from './support/community-fixtures.mjs';

const firstAt = '2026-11-08T20:00:00Z', acceptedAt = '2026-11-08T21:00:00Z', localAt = '2026-11-08T22:00:00Z';
const ids = ['ai-buddy.bilibili', 'ai-buddy.cards', 'ai-buddy.qq'];
function officialCatalog(pub, {generatedAt = firstAt, onlyCards = false, cardUrl, cardVersion = '1.0.0'} = {}) {
  const payload = catalog(pub, {generatedAt});
  payload.works = ['bilibili', 'qq', 'cards'].filter(name => !onlyCards || name === 'cards').map(name => {
    const work = structuredClone(payload.works[0]), version = name === 'cards' ? cardVersion : '1.0.0';
    work.id = 'ai-buddy.' + name;
    work.packageName = '@ai-buddy/' + name;
    work.name = 'Synthetic ' + name;
    const release = work.releases[0];
    release.version = release.package.exactVersion = version;
    release.package.packageName = work.packageName;
    release.package.sourceDigest = sha(name + version);
    release.package.spec.value = name === 'cards' && cardUrl ? cardUrl : 'https://github.com/test/' + name + '/releases/download/v' + version + '/' + name + '.tgz';
    return work;
  });
  return payload;
}
async function setupOfficial(t) {
  const f = await setupCommunity(t);
  f.pub.source.sourceId = 'official';
  f.pub.source.descriptorId = 'ai-buddy.extensions';
  // Existing service validation seam: the ephemeral fixture key is official only in this isolated service.
  f.config.officialFingerprints = new Set([f.pub.source.keyFingerprint]);
  await f.restart();
  return f;
}
const load = (f, payload) => f.service.action({action: 'community-load-catalog', sourceId: f.pub.source.sourceId, envelope: signed(payload, f.pub)});
const listedIds = async f => (await f.service.action({action: 'community-search'})).items.map(work => work.id).sort();

test('official local maintenance import preserves the full discovery catalog and watermark', async t => {
  const f = await setupOfficial(t), cachePath = join(f.root, 'local/community/catalog-cache-v1.json');
  await load(f, officialCatalog(f.pub));
  assert.deepEqual(await listedIds(f), ids);
  const beforeCache = await readFile(cachePath, 'utf8');
  const local = officialCatalog(f.pub, {generatedAt: localAt, onlyCards: true, cardVersion: '1.0.1', cardUrl: 'https://127.0.0.1:18487/cards-1.0.1.tgz'});
  const refusal = await load(f, local).then(() => null, cause => cause);
  assert.deepEqual({code: refusal?.code, workIds: await listedIds(f), cacheUnchanged: await readFile(cachePath, 'utf8') === beforeCache, stale: f.service.snapshot().community.sources[0].stale}, {
    code: 'COMMUNITY_OFFICIAL_LOCAL_CATALOG', workIds: ids, cacheUnchanged: true, stale: false,
  });
  assert.match(refusal.message, /public HTTPS|公开 HTTPS/);
  // Newer than the accepted catalog, older than the refused local input: rejection must not advance replay state.
  await load(f, officialCatalog(f.pub, {generatedAt: acceptedAt, cardVersion: '1.0.1'}));
  assert.deepEqual(await listedIds(f), ids);
  const acceptedCache = JSON.parse(await readFile(cachePath, 'utf8'));
  assert.equal(acceptedCache.sources.official.watermark.generatedAt, acceptedAt);
  await f.restart();
  assert.deepEqual(await listedIds(f), ids);
  assert.equal(f.service.snapshot().community.sources[0].generatedAt, acceptedAt);
});

test('official discovery rejects private tarball hosts without marking a local input as a network outage', async t => {
  const f = await setupOfficial(t), cachePath = join(f.root, 'local/community/catalog-cache-v1.json');
  await load(f, officialCatalog(f.pub));
  const beforeCache = await readFile(cachePath, 'utf8');
  for (const host of ['192.168.1.2', '[::1]', 'localhost.']) {
    await assert.rejects(load(f, officialCatalog(f.pub, {generatedAt: localAt, onlyCards: true, cardVersion: '1.0.1', cardUrl: 'https://' + host + '/cards-1.0.1.tgz'})), {code: 'COMMUNITY_OFFICIAL_LOCAL_CATALOG'});
    assert.deepEqual(await listedIds(f), ids);
    assert.equal(await readFile(cachePath, 'utf8'), beforeCache);
    assert.equal(f.service.snapshot().community.sources[0].stale, false);
  }
});

test('a public official catalog may legitimately withdraw works', async t => {
  const f = await setupOfficial(t);
  await load(f, officialCatalog(f.pub));
  await load(f, officialCatalog(f.pub, {generatedAt: acceptedAt, onlyCards: true}));
  assert.deepEqual(await listedIds(f), ['ai-buddy.cards']);
  await f.restart();
  assert.deepEqual(await listedIds(f), ['ai-buddy.cards']);
});

test('explicit custom sources retain their local tarball import behavior', async t => {
  const f = await setupCommunity(t);
  // A custom source ID stays custom even if its publisher is in the isolated validation scope.
  f.config.officialFingerprints = new Set([f.pub.source.keyFingerprint]);
  await f.restart();
  const payload = catalog(f.pub);
  payload.works[0].releases[0].package.spec.value = 'https://127.0.0.1:18487/custom-1.0.0.tgz';
  await load(f, payload);
  await f.restart();
  assert.deepEqual(await listedIds(f), ['test.tools']);
  assert.equal(f.service.snapshot().community.sources[0].stale, false);
});

test('startup reads an existing local official cache without persisting or relaxing subsequent imports', async t => {
  const f = await setupOfficial(t), cachePath = join(f.root, 'local/community/catalog-cache-v1.json');
  const payload = officialCatalog(f.pub, {generatedAt: localAt, onlyCards: true, cardVersion: '1.0.1', cardUrl: 'https://127.0.0.1:18487/cards-1.0.1.tgz'});
  const saved = JSON.stringify({schemaVersion: 1, sources: {official: {url: null, reviewUrl: null, envelope: signed(payload, f.pub), reviewEnvelope: null, cachedAt: localAt, watermark: {generatedAt: localAt, digest: communityDigest(payload)}}}});
  await f.service.close();
  await writeFile(cachePath, saved);
  await f.restart();
  assert.deepEqual(await listedIds(f), ['ai-buddy.cards']);
  assert.equal(await readFile(cachePath, 'utf8'), saved);
  assert.equal(f.service.snapshot().community.sources[0].stale, false);
  await assert.rejects(load(f, payload), {code: 'COMMUNITY_OFFICIAL_LOCAL_CATALOG'});
  assert.equal(await readFile(cachePath, 'utf8'), saved);
});

test('official public imports retain signature, pinned-source, replay and immutable-release checks', async t => {
  const f = await setupOfficial(t), cachePath = join(f.root, 'local/community/catalog-cache-v1.json');
  await load(f, officialCatalog(f.pub, {generatedAt: acceptedAt}));
  const beforeCache = await readFile(cachePath, 'utf8');
  const tampered = signed(officialCatalog(f.pub, {generatedAt: localAt}), f.pub);
  tampered.payload.works[0].name = 'tampered after signing';
  await assert.rejects(f.service.action({action: 'community-load-catalog', sourceId: 'official', envelope: tampered}), /verification/);
  const wrongSource = officialCatalog(f.pub, {generatedAt: localAt});
  wrongSource.source.descriptorId = 'unrelated.source';
  await assert.rejects(load(f, wrongSource), /pinned/);
  await assert.rejects(load(f, officialCatalog(f.pub)), {code: 'COMMUNITY_CATALOG_REPLAY'});
  const equivocation = officialCatalog(f.pub, {generatedAt: acceptedAt});
  equivocation.works[0].name = 'changed at same timestamp';
  await assert.rejects(load(f, equivocation), {code: 'COMMUNITY_CATALOG_REPLAY'});
  await assert.rejects(load(f, officialCatalog(f.pub, {generatedAt: localAt, cardUrl: 'https://github.com/test/cards/releases/download/v1.0.0/changed.tgz'})), {code: 'COMMUNITY_RELEASE_CHANGED'});
  assert.deepEqual(await listedIds(f), ids);
  assert.equal(await readFile(cachePath, 'utf8'), beforeCache);
});
