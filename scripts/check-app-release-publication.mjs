// Run against an actual GitHub upload receipt before promoting a release.
// This command makes no network requests and cannot sign or publish.
import {readFile} from 'node:fs/promises';import {resolve} from 'node:path';
import {checkAppReleasePublication} from '../src/app-release-proof-artifact.mjs';
if(process.argv.length!==6)throw Error('Usage: node scripts/check-app-release-publication.mjs <repository> <vX.Y.Z> <frozen-assets-directory> <uploaded-assets.json>');
const receipt=JSON.parse(await readFile(resolve(process.argv[5]),'utf8'));
console.log(JSON.stringify(await checkAppReleasePublication({repository:resolve(process.argv[2]),tag:process.argv[3],assetsDirectory:resolve(process.argv[4])},Array.isArray(receipt)?receipt:receipt.assets)));
