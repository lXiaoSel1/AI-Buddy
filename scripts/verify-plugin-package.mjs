import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractPluginArchive} from '../src/plugin-archive.mjs';
const args = Object.fromEntries(process.argv.slice(2).map(value => value.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)));
if (!args.entry || !args.archive) throw Error('Required: --entry=<release-entry.json> --archive=<package.zip>');
const entry = JSON.parse(await readFile(args.entry, 'utf8')), bytes = await readFile(args.archive);
if (bytes.length !== entry.archive.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.archive.sha256) throw Error('Package differs from release metadata');
const temporary = await mkdtemp(join(tmpdir(), 'ai-buddy-plugin-verify-'));
try {
  const result = await extractPluginArchive(bytes, temporary, entry.manifest);
  console.log(JSON.stringify({ok: true, signatureVerified: false, note: 'Container and all payload hashes verified; verify signed catalog separately before installation', files: result.files, unpackedBytes: result.bytes}));
} finally { await rm(temporary, {recursive: true, force: true}); }
