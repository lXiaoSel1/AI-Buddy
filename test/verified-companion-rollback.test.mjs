import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build as bundle} from 'esbuild';
import {exportVerifiedCompanionRollback} from '../scripts/verified-companion-rollback.mjs';
import {openCompanionStore} from '../src/companion-store.mjs';
import {createSnapshotStorage} from '../src/storage.mjs';
import {tmpDir} from './support/audit-harness.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');

test('the bundled rollback exporter and adjacent worker export a real closed SQLite profile',async t=>{
 const root=tmpDir('bundled-rollback',{t}),build=join(root,'build'),dataRoot=join(root,'profile');
 const artifact=filename=>join(build,filename);
 const exporter='export-companion-for-rollback.mjs',worker='companion-storage-worker.mjs';
 await Promise.all([['scripts',exporter],['src',worker]].map(([from,name])=>bundle({
  entryPoints:[fileURLToPath(new URL('../'+from+'/'+name,import.meta.url))],
  outfile:artifact(name),bundle:true,format:'esm',target:'node24',platform:'node',logLevel:'silent',
 })));
 const fixture={schema:2,conversations:{id:{messages:[{id:'original',text:'合成原文'}]}},groups:{g:{messages:[]}}};
 const legacy=join(dataRoot,'galgame','companion.json');
 await createSnapshotStorage(legacy).writeText(JSON.stringify(fixture));
 const store=await openCompanionStore(dataRoot);
 try{await store.mutate((_state,tx)=>tx.messages.append('private','id',{id:'new',text:'合成追加'}));}finally{await store.close();}
 const freeze={companionRollbackExporterSha256:hash(readFileSync(artifact(exporter))),companionStorageWorkerSha256:hash(readFileSync(artifact(worker)))};
 const result=await exportVerifiedCompanionRollback({build,dataRoot,freeze});
 assert.equal(result.activeMessageCount,2);assert.equal(result.totalMessageCount,2);assert.equal(result.messageCount,2);
 assert.equal(result.stagedMessageCount,0);assert.equal(result.sealedTargetMessageCount,0);
 assert.deepEqual(result.ownerCounts,[{type:'group',ownerId:'g',sqliteCount:0,jsonCount:0},{type:'private',ownerId:'id',sqliteCount:2,jsonCount:2}]);
 assert.deepEqual(JSON.parse(readFileSync(legacy)).conversations.id.messages.map(message=>message.id),['original','new']);
 assert.deepEqual(await exportVerifiedCompanionRollback({build,dataRoot,freeze}),result,'verified export is safe to retry after publication');
});

test('the rollback command rejects changed build code before running the installed exporter',async t=>{
 const root=tmpDir('verified-rollback',{t}),build=join(root,'build'),dataRoot=join(root,'data');
 mkdirSync(build);mkdirSync(dataRoot);
 const exporter=join(build,'export-companion-for-rollback.mjs'),worker=join(build,'companion-storage-worker.mjs');
 const marker=join(dataRoot,'export-started'),exportPath=join(dataRoot,'export.json');
 const bytes='{"conversations":{"id":{"messages":[]}},"groups":{}}';
 const receipt={messageCount:0,activeMessageCount:0,totalMessageCount:0,stagedMessageCount:0,sealedTargetMessageCount:0,ownerCounts:[{type:'private',ownerId:'id',sqliteCount:0,jsonCount:0}],exportPath,exportSha256:hash(bytes)};
 const code=`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, process.argv[2]); writeFileSync(${JSON.stringify(exportPath)}, ${JSON.stringify(bytes)}); console.log(${JSON.stringify(JSON.stringify(receipt))});`;
 writeFileSync(exporter,code);writeFileSync(worker,'export const x = 1;');
 const freeze={companionRollbackExporterSha256:hash(code),companionStorageWorkerSha256:hash('export const x = 1;')};
 writeFileSync(exporter,code+' ');
 await assert.rejects(exportVerifiedCompanionRollback({build,dataRoot,freeze}),/exporter SHA-256/);
 assert.equal(existsSync(marker),false);
 writeFileSync(exporter,code);writeFileSync(worker,'export const x = 2;');
 await assert.rejects(exportVerifiedCompanionRollback({build,dataRoot,freeze}),/worker SHA-256/);
 assert.equal(existsSync(marker),false);
 writeFileSync(worker,'export const x = 1;');
 const result=await exportVerifiedCompanionRollback({build,dataRoot,freeze});
 assert.equal(result.exporterSha256,freeze.companionRollbackExporterSha256);
 assert.equal(result.storageWorkerSha256,freeze.companionStorageWorkerSha256);
 assert.deepEqual(result.ownerCounts,receipt.ownerCounts);
 assert.equal(existsSync(marker),true);
});
