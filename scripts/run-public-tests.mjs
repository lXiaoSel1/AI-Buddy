import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {runOwnedTests} from './run-owned-tests.mjs';
const root=path.resolve(import.meta.dirname,'..');
if(process.versions.node!=='24.21.0')throw Error('Use pinned Node24.21.0');
const scope=JSON.parse(await readFile(path.join(root,'TEST-SCOPE.json'),'utf8'));
const allowed=new Set(scope.retainedTestFiles);
const requested=process.argv.slice(2).map(value=>{const rel=path.isAbsolute(value)?path.relative(root,value).replaceAll('\\','/'):value.replaceAll('\\','/');return rel.startsWith('test/')?rel:'test/'+rel;});
const selected=requested.length?requested:scope.retainedTestFiles;
if(!selected.length||selected.some(file=>!allowed.has(file)))throw Error('Test selection must be in TEST-SCOPE.json');
const controller=new AbortController(),interrupt=()=>controller.abort();process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
try{const result=await runOwnedTests({sourceRoot:root,testFiles:selected.map(file=>path.join(root,file)),receiptDirectory:path.join(root,'local/test-receipts'),signal:controller.signal});console.log(JSON.stringify({status:result.status,testFiles:result.testFiles.length,exitCode:result.child?.exitCode,receipt:result.receipt,ownedTempRoot:result.root}));if(result.status!=='passed-cleaned')process.exitCode=1;}finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
