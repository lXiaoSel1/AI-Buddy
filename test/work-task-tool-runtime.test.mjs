import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {prepareTaskToolBackend,assertOnlyTaskToolBundles,taskToolModelScope} from '../src/dsh-platform/task-tool-runtime.mjs';
// Actual temporary artifact/provenance bytes. PM transport is explicitly controlled.
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'buddy-tool-deploy-'));t.after(()=>rm(root,{recursive:true,force:true}));const artifact=join(root,'approved.tgz'),bytes=Buffer.from('controlled artifact bytes; not an npm package');await writeFile(artifact,bytes);const record={backend:'dsh',enabled:true,sourceId:'signed-source',packageName:'native-package',packageKey:'dsh:signed:native-package',pluginId:'dsh.native',exactVersion:'1.0.0',sourceDigest:'a'.repeat(64),generation:3,backendPlan:{artifact,artifactSha256:createHash('sha256').update(bytes).digest('hex')}};return {root,record};}
test('task tool Agent scope uses only its exact captured DSH model and omits null effort',()=>{assert.equal(taskToolModelScope(null),undefined);assert.deepEqual(taskToolModelScope({provider:'deepseek-official',model:'exact-model',effort:null}),{modelSelection:{provider:'deepseek-official',model:'exact-model'}});assert.deepEqual(taskToolModelScope({provider:'deepseek-official',model:'second-member-model',effort:'high'}),{modelSelection:{provider:'deepseek-official',model:'second-member-model',reasoningEffort:'high'}});});

test('controlled PM contract: task deployment uses exact cached bytes, observed activation and source identity',async t=>{
  const {root,record}=await fixture(t),calls=[],bundles=[];let checks=0;
  const backend={async planInstall({packageRef}){calls.push(['plan',packageRef]);return {artifactSha256:record.backendPlan.artifactSha256};},async snapshot(){return {bundles,plugins:[]};},async install(_plan,options){calls.push(['install',options]);},async enable(ref){calls.push(['enable',ref]);bundles.push({name:ref.packageName,version:ref.exactVersion,enabled:true});return {enabled:true,activation:{observed:true}};}};
  const result=await prepareTaskToolBackend({records:[record],backend,stateDir:root,assertCurrent:async()=>{checks++;}});assert.ok(checks>=4);assert.equal(calls[0][1].spec.value,record.backendPlan.artifact);assert.equal(calls[0][1].sourceDigest,record.backendPlan.artifactSha256);assert.equal(calls[0][1].hostPluginId,record.pluginId);assert.deepEqual(calls[1],['install',{enabled:false}]);assert.equal(result[0].sourceDigest,record.sourceDigest);assert.equal(JSON.parse(await readFile(join(root,'task-tools-provenance.json'),'utf8')).packages[0].activationObserved,true);assert.equal('openClient' in backend,false);
});

test('controlled PM contract: changed or absent approved artifact cannot reach native PM',async t=>{
  const {root,record}=await fixture(t),backend={planInstall:async()=>assert.fail('must not inspect native PM')};await writeFile(record.backendPlan.artifact,'tampered');await assert.rejects(prepareTaskToolBackend({records:[record],backend,stateDir:root,assertCurrent:async()=>{}}),{code:'DSH_PACKAGE_DIGEST_MISMATCH'});await assert.rejects(prepareTaskToolBackend({records:[{...record,backendPlan:null}],backend,stateDir:root,assertCurrent:async()=>{}}),{code:'WORK_TOOL_ARTIFACT_REQUIRED'});
});

test('controlled PM contract: stale authority, mismatched artifact, unobserved activation and foreign packages fail closed',async t=>{
  const {root,record}=await fixture(t),plan={artifactSha256:record.backendPlan.artifactSha256};let mode='changed-plan',installed=0;
  const backend={planInstall:async()=>mode==='changed-plan'?{artifactSha256:'b'.repeat(64)}:plan,snapshot:async()=>({plugins:[],bundles:mode==='foreign'?[{name:'not-approved',enabled:false}]:[]}),install:async()=>{installed++;},enable:async()=>({enabled:true,activation:{observed:false}})};
  await assert.rejects(prepareTaskToolBackend({records:[record],backend,stateDir:root,assertCurrent:async()=>{}}),{code:'DSH_PACKAGE_DIGEST_MISMATCH'});assert.equal(installed,0);mode='foreign';await assert.rejects(prepareTaskToolBackend({records:[record],backend,stateDir:root,assertCurrent:async()=>{}}),{code:'WORK_TOOL_PROFILE_NOT_ISOLATED'});assert.equal(installed,0);mode='unobserved';await assert.rejects(prepareTaskToolBackend({records:[record],backend,stateDir:root,assertCurrent:async()=>{}}),{code:'DSH_ACTIVATION_FAILED'});assert.equal(installed,1);await assert.rejects(prepareTaskToolBackend({records:[record],backend,stateDir:root,assertCurrent:async()=>{throw Object.assign(Error('revoked'),{code:'WORK_SCOPE_STALE'});}}),{code:'WORK_SCOPE_STALE'});assert.equal(installed,1);
});

test('task-only native inventory rejects unknown enabled entries and the Work business package',async t=>{
  const {root,record}=await fixture(t);assert.equal(assertOnlyTaskToolBundles({bundles:[{name:record.packageName}],plugins:[{enabled:true,moduleName:record.packageName+'/server'}]},[record]),true);assert.throws(()=>assertOnlyTaskToolBundles({bundles:[],plugins:[{enabled:true,moduleName:'file:///untrusted.mjs'}]},[record]),{code:'WORK_TOOL_PROFILE_NOT_ISOLATED'});await assert.rejects(prepareTaskToolBackend({records:[{...record,packageName:'@ai-buddy/work-collaboration'}],backend:{},stateDir:root,assertCurrent:async()=>{}}),{code:'WORK_TOOL_RUNTIME_DENIED'});
});
