import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {createDshComponentManager,packDshComponent,DSH_SOURCE_COMMIT,DSH_NODE_VERSION,DSH_PNPM_VERSION} from '../src/dsh-platform/component-manager.mjs';
import {DSH_PUBLIC_COMPONENT} from '../src/dsh-platform/component-download.mjs';
import {planHostDshComponent,createManagedDshComponentManager} from '../src/dsh-platform/component-task-manager.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'public-dsh-'));t.after(()=>rm(root,{recursive:true,force:true}));const source=join(root,'source'),paths={node:'node/node.exe',pnpm:'pnpm/pnpm.cjs',cli:'installation/cli.js',sdk:'installation/sdk.js',bridge:'bridge/host.mjs'},files=[];for(const[key,path]of Object.entries(paths)){const bytes=Buffer.from('fixture '+key);await mkdir(dirname(join(source,path)),{recursive:true});await writeFile(join(source,path),bytes);files.push({path,bytes:bytes.length,sha256:digest(bytes)});}await writeFile(join(source,'runtime-lock.json'),JSON.stringify({schemaVersion:1,stage:'ready',sourceCommit:DSH_SOURCE_COMMIT,nodeVersion:DSH_NODE_VERSION,pnpmVersion:DSH_PNPM_VERSION,paths,files}));const archive=join(root,'component.tgz'),descriptor=await packDshComponent(source,archive);return {root,source,archive,descriptor,destinationRoot:join(root,'installed')};}
test('host online and explicit local plans ignore renderer descriptors and paths',async()=>{
  const captured=[];let picks=0;const manager={plan:async value=>{captured.push(value);return {planId:'host-plan',bytes:value.bytes};}},chooseArchive=async()=>{picks++;return join(tmpdir(),'chosen.tgz');},request={url:'https://evil.example/a',sha256:'f'.repeat(64),bytes:1,archivePath:join(tmpdir(),'injected.tgz'),descriptor:{url:'https://evil.example'}};
  assert.equal((await planHostDshComponent({request,descriptor:DSH_PUBLIC_COMPONENT,manager,chooseArchive})).mode,'online');assert.equal(picks,0);assert.deepEqual(captured[0],DSH_PUBLIC_COMPONENT);
  assert.equal((await planHostDshComponent({request:{...request,localArchive:true},descriptor:DSH_PUBLIC_COMPONENT,manager,chooseArchive})).mode,'local');assert.equal(picks,1);assert.equal(captured[1].archivePath,join(tmpdir(),'chosen.tgz'));assert.equal(captured[1].sha256,DSH_PUBLIC_COMPONENT.sha256);assert.equal(captured[1].url,undefined);
  assert.deepEqual(await planHostDshComponent({request:{localArchive:true},descriptor:DSH_PUBLIC_COMPONENT,manager,chooseArchive:async()=>null}),{cancelled:true});assert.equal(captured.length,2);
  await assert.rejects(planHostDshComponent({request:{localArchive:'yes'},descriptor:DSH_PUBLIC_COMPONENT,manager}),{code:'DSH_COMPONENT_INVALID'});
});
test('production manager accepts only the compiled host descriptor online, without a renderer bypass',async t=>{
  const {destinationRoot}=await fixture(t),manager=createDshComponentManager({destinationRoot}),managed=createManagedDshComponentManager({destinationRoot,workerFactory:()=>{throw Error('must not start');}});t.after(()=>managed.close());
  for(const change of [{url:'http://127.0.0.1/asset'},{url:'https://example.com/asset'},{sha256:'f'.repeat(64)},{bytes:1},{manifestSha256:'f'.repeat(64)}]){await assert.rejects(manager.plan({...DSH_PUBLIC_COMPONENT,...change}),{code:'DSH_COMPONENT_DESCRIPTOR_REQUIRED'});await assert.rejects(managed.plan({...DSH_PUBLIC_COMPONENT,...change}));}
  const release=JSON.parse(await readFile(new URL('../release/dsh-component.json',import.meta.url),'utf8'));assert.deepEqual(release,DSH_PUBLIC_COMPONENT);
});
test('pinned online fixture installs once and reuses verified existing component without another download',async t=>{
  const f=await fixture(t),bytes=await readFile(f.archive),server=createServer((request,response)=>request.url==='/start'?response.writeHead(302,{location:'https://release-assets.githubusercontent.com/component?sig=fixture'}).end():response.writeHead(200,{'content-length':bytes.length}).end(bytes));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});let downloads=0;
  const fetchImpl=(url,options)=>{downloads++;return fetch('http://127.0.0.1:'+server.address().port+(new URL(url).hostname==='github.com'?'/start':'/asset'),options);},manager=createDshComponentManager({destinationRoot:f.destinationRoot,fetchImpl}),item={...f.descriptor,url:DSH_PUBLIC_COMPONENT.url};
  const first=await manager.install(await manager.plan(item)),pointer=await readFile(join(f.destinationRoot,'current.json')),second=await manager.install(await manager.plan(item));assert.equal(first.state,'ready');assert.equal(second.runtimeLockPath,first.runtimeLockPath);assert.equal(downloads,2);assert.deepEqual(await readFile(join(f.destinationRoot,'current.json')),pointer);assert.equal((await readdir(f.destinationRoot)).filter(name=>name.startsWith('component-')).length,1);
});
test('bad or cancelled new preparation preserves an installed component and releases its install lock',async t=>{
  const f=await fixture(t),base=createDshComponentManager({destinationRoot:f.destinationRoot}),ready=await base.install(await base.plan({...f.descriptor,archivePath:f.archive})),pointer=await readFile(join(f.destinationRoot,'current.json'));
  const controller=new AbortController(),failing=createDshComponentManager({destinationRoot:f.destinationRoot,fetchImpl:async()=>{controller.abort();throw Error('signed query must stay private');}}),changed={...f.descriptor,sha256:'f'.repeat(64),url:DSH_PUBLIC_COMPONENT.url};await assert.rejects(failing.install({...await failing.plan(changed),signal:controller.signal}),{code:'ABORT_ERR'});
  assert.equal((await base.status()).runtimeLockPath,ready.runtimeLockPath);assert.deepEqual(await readFile(join(f.destinationRoot,'current.json')),pointer);assert.ok(!(await readdir(f.destinationRoot)).includes('component-install.lock'));
});
test('owned failed stages stay bounded and never remove current or unknown directories',async t=>{
  const f=await fixture(t),unknown=join(f.destinationRoot,'staging-user-not-owned');await mkdir(unknown,{recursive:true});await writeFile(join(unknown,'keep'),'keep');
  for(let i=0;i<3;i++){const manager=createDshComponentManager({destinationRoot:f.destinationRoot,renamePlatform:'linux',renameStage:async()=>{throw Object.assign(Error('controlled stage error'),{code:'EACCES'});}});await assert.rejects(manager.install(await manager.plan({...f.descriptor,archivePath:f.archive})),{code:'EACCES'});}
  const names=await readdir(f.destinationRoot);assert.equal(names.filter(name=>/^staging-[a-f0-9-]{36}$/.test(name)).length,1);assert.equal(await readFile(join(unknown,'keep'),'utf8'),'keep');assert.equal(names.filter(name=>name.startsWith('.failed-staging-')).length,1);
});
