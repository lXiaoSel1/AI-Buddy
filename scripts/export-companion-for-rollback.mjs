import {resolve} from 'node:path';
import {exportCompanionForRollback} from '../src/companion-store.mjs';

if(process.argv.length!==3)throw Error('Usage: node scripts/export-companion-for-rollback.mjs <data-directory>');
const receipt=await exportCompanionForRollback(resolve(process.argv[2]));
console.log(JSON.stringify(receipt));
