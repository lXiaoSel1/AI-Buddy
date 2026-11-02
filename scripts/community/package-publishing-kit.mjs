import {readFile, writeFile, mkdir, readdir, lstat, copyFile, stat} from 'node:fs/promises';
import {resolve, dirname, relative, isAbsolute, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {assertPluginTreeNoLinks} from '../../src/plugin-archive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const allowedFiles = ['src/plugin-manifest.mjs', 'src/plugin-catalog.mjs', 'src/plugin-sources.mjs', 'src/community/catalog.mjs', 'src/community/reviews.mjs', 'src/community/github-indexer.mjs', 'scripts/community/build-review-index.mjs', 'scripts/community/check-package.mjs', 'scripts/community/verify-review-index.mjs'];
export async function packageCommunityPublishingKit(out) {
  const target = resolve(out), delta = relative(root, target); if (!delta || !isAbsolute(target)) throw Error('A separate output directory is required');
  await assertPluginTreeNoLinks(target); try { await stat(target); throw Error('Publishing kit output already exists; choose a new revision'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(target, {recursive: true}); const files = [];
  async function copy(source, destination) { const info = await lstat(source); if (!info.isFile() || info.isSymbolicLink()) throw Error('Publishing kit input is not a regular file'); const bytes = await readFile(source); await mkdir(dirname(destination), {recursive: true}); await copyFile(source, destination); files.push({path: relative(target, destination).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')}); }
  async function directory(source, destination) { for (const entry of await readdir(source, {withFileTypes: true})) { if (entry.isSymbolicLink()) throw Error('Publishing kit contains a link'); if (entry.isDirectory()) await directory(join(source, entry.name), join(destination, entry.name)); else if (entry.isFile()) await copy(join(source, entry.name), join(destination, entry.name)); else throw Error('Publishing kit contains a special file'); } }
  for (const file of allowedFiles) await copy(resolve(root, file), resolve(target, file));
  await directory(resolve(root, 'community-publishing'), target);
  const packageBytes = Buffer.from(JSON.stringify({name: 'ai-buddy-community-publishing-kit', version: '1.0.0', private: true, type: 'module', engines: {node: '>=24'}}, null, 2) + '\n');
  await writeFile(join(target, 'package.json'), packageBytes);
  files.push({path: 'package.json', bytes: packageBytes.length, sha256: createHash('sha256').update(packageBytes).digest('hex')});
  const manifest = {schemaVersion: 1, kind: 'local-reviewable-community-publishing-kit', deployment: 'not-deployed', files: files.sort((a, b) => a.path.localeCompare(b.path)), privateSigningKeysIncluded: false}; await writeFile(join(target, 'MANIFEST-SHA256.json'), JSON.stringify(manifest, null, 2) + '\n');
  return {directory: target, files: files.length, deployment: 'not-deployed'};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { const argument = process.argv.slice(2).find(value => value.startsWith('--out=')); if (!argument) throw Error('Required: --out=<new-directory>'); console.log(JSON.stringify(await packageCommunityPublishingKit(argument.slice(6)))); }
