import path from 'node:path';
import {runOwnedTests} from './run-owned-tests.mjs';

const sourceRoot=path.resolve(import.meta.dirname,'..');
const receiptDirectory=path.join(sourceRoot,'local','test-receipts');
const controller=new AbortController();
const interrupt=()=>controller.abort();
process.once('SIGINT',interrupt);
process.once('SIGTERM',interrupt);
try{
  const result=await runOwnedTests({
    sourceRoot,
    testFiles:process.argv.slice(2),
    receiptDirectory,
    signal:controller.signal
  });
  console.log(JSON.stringify({
    status:result.status,
    tests:result.testFiles.length,
    exitCode:result.child?.exitCode,
    receipt:result.receipt,
    ownedTempRoot:result.root
  }));
  if(result.status!=='passed-cleaned')process.exitCode=1;
}catch(error){
  console.error(JSON.stringify({status:'test-runner-failed',error:String(error)}));
  process.exitCode=1;
}finally{
  process.removeListener('SIGINT',interrupt);
  process.removeListener('SIGTERM',interrupt);
}
