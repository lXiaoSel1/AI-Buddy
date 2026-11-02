import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPublicKey, createPrivateKey, sign, createHash} from 'node:crypto';
import {canonicalPluginJson} from '../../src/plugin-manifest.mjs';
import {parseCommunityCatalog} from '../../src/community/catalog.mjs';
import {buildGitHubReviewIndex} from '../../src/community/github-indexer.mjs';
import {pluginSourceFingerprint} from '../../src/plugin-sources.mjs';

const field = value => { const data = Buffer.from(value), length = Buffer.alloc(4); length.writeUInt32BE(data.length); return Buffer.concat([length, data]); };
export function signReviewIndex(payload, {keyId, privateKey, expectedFingerprint}) {
  const key = createPrivateKey(privateKey), publicKey = createPublicKey(key);
  if (key.asymmetricKeyType !== 'ed25519') throw Error('Review index signer must be Ed25519');
  const ssh = 'ssh-ed25519 ' + Buffer.concat([field('ssh-ed25519'), field(publicKey.export({type: 'spki', format: 'der'}).subarray(-32))]).toString('base64');
  if (pluginSourceFingerprint(ssh) !== expectedFingerprint) throw Error('Signing key does not match the catalog source');
  return {payload, signature: {algorithm: 'ed25519', keyId, value: sign(null, Buffer.from(canonicalPluginJson(payload)), key).toString('base64')}};
}
export async function buildReviewIndexArtifact({catalogPath, repository, previousPath, out, receiptPath, keyId, signingKey, requireSignature = false, fetchImpl, token, now} = {}) {
  const raw = JSON.parse(await readFile(catalogPath, 'utf8')), catalog = parseCommunityCatalog(raw.payload ?? raw);
  let previousIndex; if (previousPath) { try { const previous = JSON.parse(await readFile(previousPath, 'utf8')); previousIndex = previous.payload ?? previous; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  const reviewWorks = catalog.works.filter(work => work.reviewsRepository === repository);
  const result = await buildGitHubReviewIndex({repository, catalogId: catalog.id, validWorkIds: reviewWorks.map(work => work.id), validVersionsByWork: Object.fromEntries(reviewWorks.map(work => [work.id, work.releases.map(release => release.version)])), previousIndex, fetchImpl, token, now});
  if (requireSignature && (!signingKey || !keyId)) throw Error('Publication requires a configured signing key and key ID; no unsigned shared index was written');
  const output = signingKey ? signReviewIndex(result.index, {keyId, privateKey: signingKey, expectedFingerprint: catalog.source.keyFingerprint}) : result.index;
  const encoded = canonicalPluginJson(output), path = resolve(out); await mkdir(dirname(path), {recursive: true}); await writeFile(path, encoded + '\n');
  const receipt = {...result.receipt, signed: !!signingKey, deploymentStatus: 'local-artifact-not-deployed', bytes: Buffer.byteLength(encoded + '\n'), sha256: createHash('sha256').update(encoded + '\n').digest('hex')};
  if (receiptPath) { await mkdir(dirname(resolve(receiptPath)), {recursive: true}); await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n'); }
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = Object.fromEntries(process.argv.slice(2).map(value => { const at = value.indexOf('='); return at < 0 ? [value.replace(/^--/, ''), true] : [value.slice(0, at).replace(/^--/, ''), value.slice(at + 1)]; }));
  if (!args.catalog || !args.repository || !args.out) throw Error('Required: --catalog=<path> --repository=<owner/repo> --out=<path>');
  console.log(JSON.stringify(await buildReviewIndexArtifact({catalogPath: args.catalog, repository: args.repository, previousPath: args.previous, out: args.out, receiptPath: args.receipt, keyId: args['key-id'], signingKey: process.env.COMMUNITY_SIGNING_KEY_PEM, token: process.env.GITHUB_TOKEN, requireSignature: args['require-signature'] === true}), null, 2));
}
