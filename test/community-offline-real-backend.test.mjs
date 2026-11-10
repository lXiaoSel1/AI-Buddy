// Review 低-6 (adapted from the reviewer's probe): the real DSH backend, not the simulated one, re-verifies the host-staged
// offline copy. No runtime component exists here, so planning stops at the runtime and nothing is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile, readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createDshBackend} from '../src/dsh-platform/backend.mjs';
import {canonicalPluginJson} from '../src/plugin-manifest.mjs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {DSH_SOURCE_COMMIT,DSH_NODE_VERSION,DSH_PNPM_VERSION} from '../src/dsh-platform/component-manager.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function tarEntry(name, data) {
  const header = Buffer.alloc(512), put = (text, offset, length) => header.write(text, offset, length, 'utf8');
  put(name, 0, 100); put('0000644\0', 100, 8); put('0000000\0', 108, 8); put('0000000\0', 116, 8); put(data.length.toString(8).padStart(11, '0') + '\0', 124, 12); put('00000000000\0', 136, 12); put('        ', 148, 8); put('0', 156, 1); put('ustar\0', 257, 6); put('00', 263, 2);
  let sum = 0; for (const byte of header) sum += byte; put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
const pack = (name, version, body = 'export default 1;\n') => gzipSync(Buffer.concat([tarEntry('package/package.json', Buffer.from(JSON.stringify({name, version}))), tarEntry('package/index.js', Buffer.from(body)), Buffer.alloc(1024)]));

test('review: real backend install succeeds with complete artifact evidence through applied and already-installed IPC',async t=>{
 for(const existing of [false,true])await t.test(existing?'already-installed exact artifact':'newly applied archive',async t=>{
  const root=await mkdtemp(join(tmpdir(),'buddy-install-ipc-')),component=join(root,'component'),stateDir=join(root,'state'),home=join(root,'home'),profileId='install-return-test',name='@community-test/test-tools',version='1.0.0',sourceDigest='b'.repeat(64),pluginId='dsh.install-return-test',body='export default 1;\n',packageBytes=pack(name,version,body),artifactSha256=sha(packageBytes),packageRoot=join(home,'profiles',profileId,'node_modules','@community-test','test-tools');
  await mkdir(component,{recursive:true});await mkdir(stateDir);await writeFile(join(root,'approved.tgz'),packageBytes);
  if(existing){await mkdir(packageRoot,{recursive:true});await writeFile(join(packageRoot,'package.json'),JSON.stringify({name,version}));await writeFile(join(packageRoot,'index.js'),body);await writeFile(join(stateDir,'package-identities.json'),JSON.stringify({[name]:{packageName:name,exactVersion:version,sourceDigest,pluginId}}));}
  // A real local IPC process provides the native-system boundary. The product
  // backend still verifies its component, tarball, exact plan, installed tree,
  // management responses and durable identity/receipt. No network or app runs.
  const cli=`const fs=require('node:fs'),path=require('node:path');
const channel='ai-buddy-dsh-platform-v1',name=${JSON.stringify(name)},version=${JSON.stringify(version)},body=${JSON.stringify(body)};
const profile=process.argv[process.argv.indexOf('--profile')+1],root=path.join(process.env.DSH_HOME,'profiles',profile,'node_modules','@community-test','test-tools');
const patch=fs.readFileSync(process.argv[process.argv.indexOf('--patch')+1],'utf8'),policy=JSON.parse(patch.match(/uiPolicy: ([^\\n]+)/)[1]);let installed=fs.existsSync(path.join(root,'package.json')),enabled=false;
const ready=setInterval(()=>{process.stdout.write('dsh web: http://127.0.0.1:54321/?token=local-fixture\\n');process.send({channel,kind:'bridge-ready',purpose:'ui',uiPolicy:policy});},20);
process.on('message',message=>{if(message.channel!==channel||message.kind!=='request')return;clearInterval(ready);let result;
 if(message.method==='runtime.shutdown'){process.disconnect();return;}
 if(message.method==='bridge.schemaSnapshot')result=[];
 else if(message.method==='management.snapshot')result={bundles:installed?[{name,version,installed:true,enabled,rows:[]}]:[],plugins:[]};
 else if(message.method==='management.inspect')result={name,version};
 else if(message.method==='management.install'){if(installed)result={error:{code:'already-installed'}};else{fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name,version}));fs.writeFileSync(path.join(root,'index.js'),body);installed=true;enabled=message.params.options.enabled;result={application:'applied',bundle:name,version,installed:true,enabled};}}
 else if(message.method==='management.disable'){enabled=false;result={application:'applied',bundle:name,version,installed:true,enabled:false};}
 else throw Error('Unexpected local native RPC '+message.method);
 process.send({channel,kind:'response',id:message.id,result});
});process.on('disconnect',()=>process.exit(0));`;
  const paths={node:'node.exe',pnpm:'pnpm.cjs',cli:'cli.cjs',sdk:'sdk.cjs',bridge:'bridge.cjs'},files=[];
  for(const [key,path]of Object.entries(paths)){const bytes=Buffer.from(key==='cli'?cli:'SIMULATED COMPONENT ENTRY '+key);await writeFile(join(component,path),bytes);files.push({path,bytes:bytes.length,sha256:sha(bytes)});}
  const runtimeLockPath=join(component,'runtime-lock.json');await writeFile(runtimeLockPath,JSON.stringify({schemaVersion:1,stage:'ready',sourceCommit:DSH_SOURCE_COMMIT,nodeVersion:DSH_NODE_VERSION,pnpmVersion:DSH_PNPM_VERSION,paths,files}));
  const originalSpawn=childProcess.spawn;let launches=0;childProcess.spawn=(executable,args,options)=>{assert.equal(executable,join(component,'node.exe'));launches++;return originalSpawn(process.execPath,args,options);};syncBuiltinESMExports();
  const backend=createDshBackend({runtimeLockPath,dshHome:home,stateDir,profileId,handshakeTimeoutMs:3000});
  try{
   const fresh=await backend.planInstall({packageRef:{backend:'dsh',sourceId:'approved',packageName:name,exactVersion:version,sourceDigest:artifactSha256,hostPluginId:pluginId,spec:{kind:'tarball',value:join(root,'approved.tgz')}}}),plan={...fresh,packageRef:{...fresh.packageRef,sourceDigest}};
   plan.planDigest=sha(canonicalPluginJson({packageRef:plan.packageRef,profileId:plan.profileId,spec:plan.spec,artifactSha256:plan.artifactSha256,sourceVerification:plan.sourceVerification}));
   const result=await backend.install(plan,{enabled:false});assert.equal(result.application,'applied');assert.equal(result.enabled,false);assert.equal(result.packageRef.sourceDigest,sourceDigest);assert.equal(result.artifactVerification.sha256,artifactSha256);assert.equal(result.verification.sha256,artifactSha256);assert.equal(Boolean(result.reusedExisting),existing);if(existing)assert.equal(result.existingArtifactVerification.verified,true);
   assert.deepEqual({name:result.artifactVerification.name,version:result.artifactVerification.version,bytes:result.artifactVerification.bytes},{name,version,bytes:packageBytes.length});
   const identities=JSON.parse(await readFile(join(stateDir,'package-identities.json'),'utf8'));assert.deepEqual(identities[name],{packageName:name,pluginId,exactVersion:version,sourceDigest});const audit=await Promise.all((await readdir(stateDir)).filter(file=>/^event-.*\.json$/.test(file)).map(async file=>JSON.parse(await readFile(join(stateDir,file),'utf8')))),saved=audit.find(row=>row.type==='install-result');assert.equal(saved.artifact.sha256,artifactSha256);assert.equal(saved.packageRef.sourceDigest,sourceDigest);assert.equal(launches,1);
  }finally{await backend.close();childProcess.spawn=originalSpawn;syncBuiltinESMExports();await rm(root,{recursive:true,force:true});}
 });
});

test('review: real backend rejects an invalid rollback plan before any native uninstall can start',async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-rollback-preflight-'));t.after(()=>rm(root,{recursive:true,force:true}));const backend=createDshBackend({runtimeLockPath:join(root,'missing-lock.json'),dshHome:join(root,'home'),stateDir:join(root,'current-state')});t.after(()=>backend.close());
 await assert.rejects(backend.rollback({packageName:'@community-test/test-tools'},{plan:{profileId:'old-profile',artifact:join(root,'old-state','old.tgz'),artifactSha256:'a'.repeat(64)}}),{code:'DSH_INSTALL_PLAN_CHANGED'});
 const bytes=pack('@community-test/test-tools','1.0.0'),artifact=join(root,'old-state',sha(bytes)+'.tgz');await mkdir(join(root,'old-state'));await writeFile(artifact,bytes);const packageRef={backend:'dsh',sourceId:'s',packageName:'@community-test/test-tools',exactVersion:'1.0.0',sourceDigest:sha(bytes),spec:{kind:'tarball',value:artifact}},plan={packageRef,profileId:'buddy-community-v1',spec:artifact,artifact,artifactSha256:sha(bytes),sourceVerification:{sha256:sha(bytes)}};plan.planDigest=sha(canonicalPluginJson({packageRef,profileId:plan.profileId,spec:plan.spec,artifactSha256:plan.artifactSha256,sourceVerification:plan.sourceVerification}));
 await assert.rejects(backend.rollback(packageRef,{plan}),{code:'DSH_INSTALL_PLAN_CHANGED'});
 const current=join(root,'current-state','verified-packages',sha(bytes)+'.tgz');await mkdir(join(root,'current-state','verified-packages'),{recursive:true});const local={...plan,artifact:current};await writeFile(current,Buffer.from('changed cache'));
 await assert.rejects(backend.rollback(packageRef,{plan:local}),{code:'DSH_PACKAGE_DIGEST_MISMATCH'});await writeFile(current,bytes);
 await assert.rejects(backend.rollback(packageRef,{plan:local}),{code:'DSH_RUNTIME_NOT_READY'},'Only a path/digest/hash-valid target may proceed toward the native operation');
});

test('real DSH backend re-checks the staged offline file: tampered bytes and a wrong identity are refused, the right file is copied into its own cache', async t => {
  const root = await mkdtemp(join(process.env.AI_BUDDY_TEST_TEMP_BASE || tmpdir(), 'buddy-dsh-offline-')); t.after(() => rm(root, {recursive: true, force: true}));
  const backend = createDshBackend({runtimeLockPath: join(root, 'missing-lock.json'), dshHome: join(root, 'home'), stateDir: join(root, 'state')});
  t.after(() => backend.close?.().catch(() => {}));
  const good = pack('@community-test/test-tools', '1.0.0'), staged = join(root, 'offline', sha(good) + '.tgz');
  await mkdir(join(root, 'offline'), {recursive: true});
  const packageRef = {backend: 'dsh', sourceId: 's', packageName: '@community-test/test-tools', exactVersion: '1.0.0', sourceDigest: sha(good), digestType: 'tarball-sha256', spec: {kind: 'tarball', value: 'https://example.invalid/p.tgz'}, capabilities: [], dataSchemaVersion: 1};
  await writeFile(staged, pack('@community-test/test-tools', '1.0.0', 'evil()\n'));
  await assert.rejects(backend.planInstall({packageRef, spec: staged}), {code: 'DSH_PACKAGE_DIGEST_MISMATCH'});
  const other = pack('@evil/other', '1.0.0'); await writeFile(staged, other);
  await assert.rejects(backend.planInstall({packageRef: {...packageRef, sourceDigest: sha(other)}, spec: staged}), {code: 'DSH_PACKAGE_IDENTITY_MISMATCH'});
  await writeFile(staged, good);
  await assert.rejects(backend.planInstall({packageRef, spec: staged}), error => !['DSH_PACKAGE_DIGEST_MISMATCH', 'DSH_PACKAGE_IDENTITY_MISMATCH'].includes(error.code));
  assert.deepEqual(await readFile(join(root, 'state', 'verified-packages', sha(good) + '.tgz')), good);
});
