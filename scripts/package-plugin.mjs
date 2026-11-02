import {createHash} from 'node:crypto';
import {lstat, readdir, readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve, join, relative, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildPluginArchive, assertPluginTreeNoLinks} from '../src/plugin-archive.mjs';
import {parsePluginManifest, pluginHttpsUrl} from '../src/plugin-manifest.mjs';

export async function packagePlugin({manifest: templateFile, files: source, out, url}) {
  if (!templateFile || !source || !out || !url) throw Error('Required: --manifest --files --out --url');
  pluginHttpsUrl(url); source = resolve(source); out = resolve(out); await assertPluginTreeNoLinks(source);
  const template = JSON.parse(await readFile(resolve(templateFile), 'utf8')), files = new Map();
  async function scan(directory) {
    for (const row of await readdir(directory, {withFileTypes: true})) { const file = join(directory, row.name), info = await lstat(file); if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw Error('Package source contains a link or special file'); if (info.isDirectory()) await scan(file); else files.set(relative(source, file).split(sep).join('/'), await readFile(file)); }
  }
  await scan(source);
  const manifest = parsePluginManifest({...template, files: [...files].map(([path, bytes]) => ({path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')}))});
  const bytes = buildPluginArchive(manifest, files), name = manifest.id + '-' + manifest.version + '.zip';
  await assertPluginTreeNoLinks(out); await mkdir(out, {recursive: true}); await writeFile(join(out, name), bytes, {flag: 'wx'});
  const entry = {manifest, archive: {url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')}, publishedAt: new Date().toISOString()};
  await writeFile(join(out, 'release-entry.json'), JSON.stringify(entry, null, 2), {flag: 'wx'});
  return {archive: join(out, name), entry: join(out, 'release-entry.json'), bytes: bytes.length, sha256: entry.archive.sha256};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = Object.fromEntries(process.argv.slice(2).map(value => { const at = value.indexOf('='); if (!value.startsWith('--') || at < 3) throw Error('Use --name=value'); return [value.slice(2, at), value.slice(at + 1)]; }));
  console.log(JSON.stringify(await packagePlugin(options), null, 2));
}
