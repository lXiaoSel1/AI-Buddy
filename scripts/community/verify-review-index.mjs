import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parsePluginSourceDescriptor, pluginSourceFingerprint} from '../../src/plugin-sources.mjs';
import {verifyCommunityCatalog} from '../../src/community/catalog.mjs';
import {verifyReviewIndex} from '../../src/community/reviews.mjs';

export async function verifySharedReviewArtifact({sourcePath, catalogPath, indexPath}) {
  const descriptor = parsePluginSourceDescriptor(JSON.parse(await readFile(sourcePath, 'utf8'))), source = {...descriptor, descriptorId: descriptor.id, sourceId: 'publication-verifier', enabled: true, removed: false, keyFingerprint: pluginSourceFingerprint(descriptor.publicKey)};
  const catalog = verifyCommunityCatalog(JSON.parse(await readFile(catalogPath, 'utf8')), source), index = verifyReviewIndex(JSON.parse(await readFile(indexPath, 'utf8')), source, catalog.id), works = new Set(catalog.works.map(work => work.id));
  if (index.reviews.some(review => !works.has(review.workId))) throw Error('Review index contains a work absent from the current signed catalog');
  if (index.reviews.some(review => !catalog.works.find(work => work.id === review.workId)?.releases.some(release => release.version === review.version))) throw Error('Review index contains an unpublished work version');
  return {catalogId: catalog.id, catalogDigest: catalog.verified.payloadSha256, reviewIndexDigest: index.verified.payloadSha256, reviews: index.reviews.length, signatureVerified: true};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { const args = Object.fromEntries(process.argv.slice(2).map(value => { const at = value.indexOf('='); return [value.slice(0, at).replace(/^--/, ''), value.slice(at + 1)]; })); if (!args.source || !args.catalog || !args.index) throw Error('Required: --source=<source.json> --catalog=<catalog-v1.json> --index=<reviews-v1.json>'); console.log(JSON.stringify(await verifySharedReviewArtifact({sourcePath: args.source, catalogPath: args.catalog, indexPath: args.index}))); }
