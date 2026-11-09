import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {assertNewReleaseCompatibility, assertCatalogReleaseCompatibility} from './lib/plugin-release-compatibility.mjs';

const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--([a-z-]+)=(.+)$/.exec(arg);
  if (!match) throw Error('Use --manifest=<file> [--source=<package.json>] or --legacy=<file> --community=<file> --baseline-legacy=<file> --baseline-community=<file>');
  return match.slice(1);
}));
const read = async path => JSON.parse(await readFile(resolve(path), 'utf8'));
const payload = value => value.payload ?? value;
const result = options.manifest ? assertNewReleaseCompatibility(await read(options.manifest), {sourceManifest: options.source ? await read(options.source) : undefined}) : assertCatalogReleaseCompatibility({legacy: payload(await read(options.legacy)), community: payload(await read(options.community)), baselineLegacy: payload(await read(options['baseline-legacy'])), baselineCommunity: payload(await read(options['baseline-community']))});
console.log(JSON.stringify({passed: true, ...result}));
