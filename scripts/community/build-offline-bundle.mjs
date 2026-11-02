// node scripts/community/build-offline-bundle.mjs --envelope=community-envelope.json --public-key="ssh-ed25519 AAAA…" --package=a.tgz [--package=b.tgz] --out=ai-buddy-plugins-2.0.2.aibuddy-plugins
// Packs an already signed community catalog envelope and the exact release tarballs it lists into one offline file
// (Extensions → Sources → Import offline). It signs nothing and adds no key: the app verifies the envelope with a source
// it already trusts and every tarball against its signed release digest, exactly as for an online install. The tool makes
// the same checks first (review 低-10) so it never produces a file the app refuses: the signature against the given public
// key, each package listed as a tarball release, and each tarball's layout, entry types, name and version.
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {buildOfflinePluginBundle, readOfflinePluginFile, inspectNpmTarball} from '../../src/community/offline-bundle.mjs';
import {verifyCommunityCatalog} from '../../src/community/catalog.mjs';
import {pluginSourceFingerprint} from '../../src/plugin-sources.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const fail = (message, code) => { throw Object.assign(Error(message), {code}); };
export async function buildBundleFile({envelope, publicKey, packages = [], out}) {
  if (typeof publicKey !== 'string' || !publicKey.trim()) fail('--public-key (the source key the app already trusts) is required', 'COMMUNITY_OFFLINE_KEY_REQUIRED');
  const signed = JSON.parse(await readFile(resolve(envelope), 'utf8'));
  const catalog = verifyCommunityCatalog(signed, {sourceId: 'bundle-check', descriptorId: signed?.payload?.source?.descriptorId, keyId: signed?.signature?.keyId, publicKey: publicKey.trim(), keyFingerprint: pluginSourceFingerprint(publicKey.trim()), enabled: true, removed: false});
  const releases = catalog.works.filter(work => work.backend === 'dsh').flatMap(work => work.releases.map(release => ({work, release})));
  const files = await Promise.all(packages.map(path => readFile(resolve(path))));
  for (const [index, bytes] of files.entries()) {
    const found = releases.filter(({release}) => release.package.sourceDigest === sha(bytes));
    if (!found.length) fail(packages[index] + ' is not listed by the signed catalog', 'COMMUNITY_OFFLINE_UNSIGNED');
    if (found.some(({release}) => release.package.spec.kind !== 'tarball')) fail(packages[index] + ' is published as a registry or Git release; offline files take tarball releases only', 'COMMUNITY_OFFLINE_SOURCE_KIND');
    const identity = inspectNpmTarball(bytes);
    if (!found.some(({work, release}) => identity.name === work.packageName && identity.version === release.version)) fail(packages[index] + ' holds ' + identity.name + '@' + identity.version + ', not the release it is signed for', 'COMMUNITY_OFFLINE_IDENTITY');
  }
  const bundle = buildOfflinePluginBundle({envelope: signed, packages: files}), check = readOfflinePluginFile(bundle);
  await writeFile(resolve(out), bundle);
  return {out: resolve(out), bytes: bundle.length, generatedAt: catalog.generatedAt, packages: check.packages.map(item => item.sha256)};
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2), value = name => args.filter(arg => arg.startsWith('--' + name + '=')).map(arg => arg.slice(name.length + 3));
  if (!value('envelope')[0] || !value('out')[0] || !value('public-key')[0]) { console.error('usage: --envelope=<signed catalog envelope.json> --public-key=<ssh-ed25519 …> --package=<release.tgz>... --out=<file.aibuddy-plugins>'); process.exit(2); }
  console.log(JSON.stringify(await buildBundleFile({envelope: value('envelope')[0], publicKey: value('public-key')[0], packages: value('package'), out: value('out')[0]}), null, 2));
}
