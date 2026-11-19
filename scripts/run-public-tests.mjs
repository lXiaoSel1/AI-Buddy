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
const storageTiming=new Set(['test/companion-storage-r15.test.mjs','test/companion-sqlite-store.test.mjs']);
// This test exercises real Windows process inspection, whose fixed deadline
// should measure the offline lease without hundreds of parallel test processes.
const offlineLease='test/snapshot-backlog-r14.test.mjs';
const cacheTiming='test/companion-cache-window-r5.test.mjs';
const networkSession='test/audit214-network-service.test.mjs';
const lanes=[
 {name:'storage-timing',files:selected.filter(file=>storageTiming.has(file)),serial:true,environment:{AI_BUDDY_R15_STORAGE_TIMING:'1'}},
 {name:'offline-lease',files:selected.filter(file=>file===offlineLease),serial:true},
 {name:'network-session',files:selected.filter(file=>file===networkSession),serial:true},
 {name:'cache-timing',files:selected.filter(file=>file===cacheTiming),serial:true},
 {name:'general',files:selected.filter(file=>!storageTiming.has(file)&&file!==offlineLease&&file!==networkSession&&file!==cacheTiming)}
];
try{
 for(const {name,files,serial,environment} of lanes){
  if(!files.length||controller.signal.aborted)continue;
  const result=await runOwnedTests({sourceRoot:root,testFiles:files.map(file=>path.join(root,file)),receiptDirectory:path.join(root,'local/test-receipts'),signal:controller.signal,serial,environment});
  console.log(JSON.stringify({lane:name,status:result.status,testFiles:result.testFiles.length,exitCode:result.child?.exitCode,receipt:result.receipt,ownedTempRoot:result.root}));
  if(result.status!=='passed-cleaned')process.exitCode=1;
 }
}finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
