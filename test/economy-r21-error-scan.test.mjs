import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {test} from 'node:test';
import {businessReceiptCodes,failClosedCodes} from '../src/companion-economy-error-codes.mjs';
import {scanEconomyErrorCodes} from './support/economy-r21-error-scan.mjs';

const root=resolve(import.meta.dirname,'..');
const mutationSources={
 unknown:"const fail=(message,code)=>Object.assign(Error(message),{code});export function write(){throw fail('bad','R21_UNCLASSIFIED_MUTATION');}",
 missing:"const fail=(message,code)=>Object.assign(Error(message),{code});export function write(){throw fail('bad');}",
 direct:"export function write(){throw Error('r21 direct write validation');}",
 newDirect:"export function write(){throw new Error('r21 new Error write validation');}"
};

test('r21 worker import graph and caller roots classify every write error',async t=>{
 const kind=process.env.AI_BUDDY_R21_SCANNER_MUTATION;
 const worker=resolve(root,'src/companion-economy-worker.mjs'),sourceOverrides=new Map();
 let fixture;
 if(kind){
  assert.ok(Object.hasOwn(mutationSources,kind));
  const dir=await mkdtemp(join(root,'src/r21-error-scan-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  fixture=join(dir,'fixture.mjs');await writeFile(fixture,mutationSources[kind]);
  sourceOverrides.set(worker,(await readFile(worker,'utf8'))+`\nimport './${dir.split(/[\\/]/).at(-1)}/fixture.mjs';\n`);
 }
 const report=await scanEconomyErrorCodes({sourceOverrides});
 assert.ok(report.files.includes('src/companion-economy-worker.mjs'));
 assert.ok(report.files.includes('src/voice-games/rules/texas.mjs'),'dynamic approved-rule boundary has its local rule graph');
 assert.ok(report.files.includes('src/companion-feeding.mjs'),'caller admission boundary is explicit');
 if(fixture)assert.ok(report.files.some(path=>path.endsWith('/fixture.mjs')),'new local import entered the graph automatically');
 assert.deepEqual(report.codes.filter(code=>businessReceiptCodes.has(code)===failClosedCodes.has(code)),[],
  'each explicit code needs one documented disposition');
 assert.deepEqual(report.uncoded,[],'write validators need stable codes or an exact reasoned read/open/fail-closed exception');
 assert.ok([...failClosedCodes.values()].every(reason=>typeof reason==='string'&&reason.length>8));
});
