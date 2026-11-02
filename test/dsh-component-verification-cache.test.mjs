import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat,utimes,symlink,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyDshComponent,invalidateDshComponentVerification,DSH_SOURCE_COMMIT,DSH_NODE_VERSION,DSH_PNPM_VERSION} from '../src/dsh-platform/component-manager.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
// Actual filesystem/inventory/hash tests, with data-only executable fixtures.
// No DSH process, native engine or model is started.
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'dsh-verify-cache-'));t.after(()=>rm(root,{recursive:true,force:true}));const paths={node:'node/node.exe',pnpm:'pnpm/pnpm.cjs',cli:'installation/cli.js',sdk:'installation/sdk.js',bridge:'bridge/host.mjs'},files=[];for(const[path,data]of Object.entries(paths).map(([key,path])=>[path,Buffer.from('fixture-'+key)]).concat(Array.from({length:64},(_,index)=>['modules/file-'+index+'.js',Buffer.alloc(8192,index)]))){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),data);files.push({path,bytes:data.length,sha256:sha(data)});}const lock={schemaVersion:1,stage:'ready',sourceCommit:DSH_SOURCE_COMMIT,nodeVersion:DSH_NODE_VERSION,pnpmVersion:DSH_PNPM_VERSION,paths,files},manifest=join(root,'runtime-lock.json');await writeFile(manifest,JSON.stringify(lock));return{root,paths,files,lock,manifest};}
test('complete concurrent verification shares its in-flight result and later calls restat the full tree',async t=>{
 const f=await fixture(t),[first,shared]=await Promise.all([verifyDshComponent(f.root),verifyDshComponent(f.root)]);assert.equal(first,shared);assert.equal(first.files,69);assert.equal(first.verification.hashedFiles,69);assert.equal(first.verification.cacheHits,0);assert.equal(first.verification.concurrency,16);assert.equal(Object.isFrozen(first.lock.files),true);
 const second=await verifyDshComponent(f.root);assert.equal(second.verification.hashedFiles,0);assert.equal(second.verification.cacheHits,69);assert.notEqual(second,first);
 await writeFile(join(f.root,'unexpected.js'),'new file');await assert.rejects(verifyDshComponent(f.root),/Unindexed component file/);
});
test('same-size tampering with restored mtime still changes stat identity and is rejected',async t=>{
 const f=await fixture(t);await verifyDshComponent(f.root);const path=join(f.root,f.paths.sdk),before=await stat(path),original=await readFile(path);await writeFile(path,Buffer.alloc(original.length,120));await utimes(path,before.atime,before.mtime);await assert.rejects(verifyDshComponent(f.root),/Component digest differs/);
 await writeFile(path,original);const repaired=await verifyDshComponent(f.root);assert.equal(repaired.verification.hashedFiles,69,'failed checks must not keep a partial approval cache');
});
test('changed manifest SHA has a separate verification and cannot revive a failed source pin',async t=>{
 const f=await fixture(t),first=await verifyDshComponent(f.root);f.lock.testMetadata='new manifest bytes';await writeFile(f.manifest,JSON.stringify(f.lock));const changed=await verifyDshComponent(f.root);assert.notEqual(changed.manifestSha256,first.manifestSha256);assert.equal(changed.verification.hashedFiles,69);
 f.lock.sourceCommit='f'.repeat(40);await writeFile(f.manifest,JSON.stringify(f.lock));await assert.rejects(verifyDshComponent(f.root),/pinned component/);await assert.rejects(verifyDshComponent(f.root),/pinned component/);
});
test('an initially corrupt file cannot produce a cached success after a failed parallel pass',async t=>{
 const f=await fixture(t),path=join(f.root,f.paths.node),bytes=await readFile(path);await writeFile(path,Buffer.alloc(bytes.length,97));await assert.rejects(verifyDshComponent(f.root),/digest differs/);await writeFile(path,bytes);const valid=await verifyDshComponent(f.root);assert.equal(valid.verification.hashedFiles,69);assert.equal(valid.verification.cacheHits,0);
});
test('explicit host invalidation forces fresh full byte verification instead of stat-cache reuse',async t=>{
 const f=await fixture(t);await verifyDshComponent(f.root);assert.equal((await verifyDshComponent(f.root)).verification.cacheHits,69);invalidateDshComponentVerification(f.root);const fresh=await verifyDshComponent(f.root);assert.equal(fresh.verification.hashedFiles,69);assert.equal(fresh.verification.cacheHits,0);
});
test('directory links and missing files are detected after a successful hash-cache pass',async t=>{
 const f=await fixture(t);await verifyDshComponent(f.root);const modules=join(f.root,'modules'),saved=join(dirname(f.root),'dsh-outside-'+Date.now());await rename(modules,saved);t.after(()=>rm(saved,{recursive:true,force:true}));await symlink(saved,modules,process.platform==='win32'?'junction':'dir');await assert.rejects(verifyDshComponent(f.root),/link or special/);await rm(modules,{recursive:false,force:true});await rename(saved,modules);
 await rm(join(f.root,f.paths.cli));await assert.rejects(verifyDshComponent(f.root),/file count differs|ENOENT/);
});
