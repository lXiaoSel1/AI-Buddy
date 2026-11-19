import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,realpath} from 'node:fs/promises';
import {isAbsolute,join,relative,sep} from 'node:path';
import {promisify} from 'node:util';

const execute=promisify(execFile);
const sha256=/^[a-f0-9]{64}$/;
const within=(root,path)=>{
 const rel=relative(root,path);
 return rel!==''&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);
};

async function digest(path){
 const hash=createHash('sha256');
 for await(const chunk of createReadStream(path))hash.update(chunk);
 return hash.digest('hex');
}

async function verifiedFile(path,expected,label){
 const info=await lstat(path);
 assert.ok(info.isFile()&&!info.isSymbolicLink(),label+' must be a regular file');
 assert.match(expected??'',sha256,label+' SHA-256 missing from freeze');
 assert.equal(await digest(path),expected,label+' SHA-256 differs from freeze');
}

export async function exportVerifiedCompanionRollback({build,dataRoot,freeze}){
 const exporter=join(build,'export-companion-for-rollback.mjs'),worker=join(build,'companion-storage-worker.mjs');
 const exporterSha256=freeze.companionRollbackExporterSha256,storageWorkerSha256=freeze.companionStorageWorkerSha256;
 await Promise.all([verifiedFile(exporter,exporterSha256,'Rollback exporter'),verifiedFile(worker,storageWorkerSha256,'Companion storage worker')]);
 const {stdout}=await execute(process.execPath,[exporter,dataRoot],{cwd:build,windowsHide:true,maxBuffer:64*1024*1024});
 const receipt=JSON.parse(stdout);
 assert.ok(Array.isArray(receipt.ownerCounts),'Rollback owner counts are missing');
 const unique=new Set();let total=0;
 for(const result of receipt.ownerCounts){
  const key=JSON.stringify([result.type,result.ownerId]);
  assert.ok(['private','group'].includes(result.type)&&typeof result.ownerId==='string'&&!unique.has(key),'Invalid or duplicate rollback owner');
  assert.ok(Number.isSafeInteger(result.sqliteCount)&&result.sqliteCount>=0&&result.sqliteCount===result.jsonCount,'Rollback owner message count mismatch');
  unique.add(key);total+=result.jsonCount;
 }
 assert.equal(total,receipt.activeMessageCount,'Rollback active message count mismatch');
 const {messageCount,totalMessageCount,stagedMessageCount,sealedTargetMessageCount}=receipt;
 assert.ok([messageCount,totalMessageCount,stagedMessageCount,sealedTargetMessageCount].every(value=>Number.isSafeInteger(value)&&value>=0),'Rollback message totals are invalid');
 assert.ok(totalMessageCount-stagedMessageCount>=total,'Rollback database does not contain all active messages');
 assert.equal(messageCount,totalMessageCount-stagedMessageCount+sealedTargetMessageCount,'Rollback exported message total mismatch');
 const exportPath=await realpath(receipt.exportPath);
 assert.ok(isAbsolute(receipt.exportPath)&&within(await realpath(dataRoot),exportPath),'Rollback export path leaves the data directory');
 await verifiedFile(receipt.exportPath,receipt.exportSha256,'Rollback JSON');
 return {...receipt,exporterSha256,storageWorkerSha256};
}
