import {createHash} from 'node:crypto';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyDshComponent, DSH_SOURCE_COMMIT} from './component-manager.mjs';
import {assertPluginTreeNoLinks} from '../plugin-archive.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (message, code = 'WORK_RUNTIME_DENIED') => Object.assign(Error(message), {code});
const inside = (root, path) => { const delta = relative(root, path); return delta === '' || !isAbsolute(delta) && delta !== '..' && !delta.startsWith('..' + sep); };
export async function trustedRuntimeDescriptor(lockPath, {verifyComponent = verifyDshComponent} = {}) {
  const absolute = resolve(lockPath), root = dirname(absolute); await assertPluginTreeNoLinks(absolute);
  const proof = await verifyComponent(root), lock = proof.lock;
  if (lock.sourceCommit !== DSH_SOURCE_COMMIT || lock.stage !== 'ready') throw fail('DSH component does not match the pinned source', 'DSH_RUNTIME_NOT_READY');
  const entries = {};
  for (const [name, key] of [['nodePath', 'node'], ['sdkEntry', 'sdk'], ['cliEntry', 'cli']]) { const value = lock.paths?.[key], path = typeof value === 'string' ? resolve(root, value) : null; if (!path || isAbsolute(value) || !inside(root, path)) throw fail('Runtime descriptor path escapes the component'); const row = lock.files.find(entry => entry.path === value); if (!row || digest(await readFile(path)) !== row.sha256) throw fail('Runtime descriptor entry differs from its verified inventory', 'DSH_RUNTIME_HASH_MISMATCH'); entries[name] = path; }
  return Object.freeze({...entries, sourceCommit: lock.sourceCommit, version: lock.version, lockPath: absolute});
}
export async function nativeModulePolicyFromLock(lockPath, {hostBridgeSourcePath, stateDir} = {}) {
  const root = dirname(resolve(lockPath)), lock = JSON.parse(await readFile(lockPath, 'utf8')), allowedModules = new Set();
  for (const row of lock.files ?? []) { const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/.exec(row.path); if (match) allowedModules.add(match[1]); }
  const bridge = typeof lock.paths?.bridge === 'string' ? resolve(root, lock.paths.bridge) : null; if (!bridge || !inside(root, bridge)) throw fail('Native bridge is outside the component');
  if (hostBridgeSourcePath !== undefined || stateDir !== undefined) {
    if (!isAbsolute(hostBridgeSourcePath ?? '') || !isAbsolute(stateDir ?? '')) throw fail('Application bridge policy requires host-owned absolute paths');
    await assertPluginTreeNoLinks(hostBridgeSourcePath); await assertPluginTreeNoLinks(stateDir);
    const sha256 = digest(await readFile(hostBridgeSourcePath));
    return {allowedModules, trustedBridgeModule: pathToFileURL(join(stateDir, 'host-shims', sha256, 'native-bridge-host.mjs')).href, applicationBridgeSha256: sha256};
  }
  return {allowedModules, trustedBridgeModule: pathToFileURL(bridge).href};
}
export function assertOnlyWorkBundle(snapshot, packageName = '@ai-buddy/work-collaboration', {allowedModules = new Set(), trustedBridgeModule} = {}) {
  if (!Array.isArray(snapshot?.bundles) || !Array.isArray(snapshot?.plugins)) throw fail('Native profile has no actual bundle/entry inventory', 'WORK_PROFILE_NOT_OBSERVED');
  const foreign = snapshot.bundles.filter(bundle => bundle.official !== true && bundle.installed !== false && bundle.name !== packageName);
  if (foreign.length) throw fail('The private work profile contains another third-party package; preserve it for inspection', 'WORK_PROFILE_NOT_ISOLATED');
  const unknownEntries = snapshot.plugins.filter(entry => {
    if (!entry.enabled) return false; const name = entry.moduleName;
    if (name === 'cordis:include' || name === trustedBridgeModule || name === packageName || name?.startsWith(packageName + '/')) return false;
    const rootName = typeof name === 'string' && name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name?.split('/')[0];
    return !allowedModules.has(rootName);
  });
  if (unknownEntries.length) throw fail('The private work profile contains an unverified native Host entry', 'WORK_PROFILE_NOT_ISOLATED');
  return true;
}
/** Real backend deployment from an already approved exact artifact, never a browser supplied spec. */
export async function prepareIsolatedWorkBackend({record, backend, stateDir, isCurrent, confirmActivation, nativePolicy}) {
  if (record?.backend !== 'dsh' || record.packageName !== '@ai-buddy/work-collaboration' || record.enabled !== true || !record.pluginId || !record.packageKey || !Number.isSafeInteger(record.generation)) throw fail('An enabled installed work package is required');
  await isCurrent(record); await backend.openClient(); assertOnlyWorkBundle(await backend.snapshot(), record.packageName, nativePolicy);
  const prior = record.backendPlan;
  let packageRef = {...record, hostPluginId: record.pluginId};
  if (prior?.artifact && prior.artifactSha256) {
    await assertPluginTreeNoLinks(prior.artifact);
    if (digest(await readFile(prior.artifact)) !== prior.artifactSha256) throw fail('The approved work package cache changed', 'DSH_PACKAGE_DIGEST_MISMATCH');
    packageRef = {...packageRef, sourceDigest: prior.artifactSha256, digestType: 'tarball-sha256', spec: {kind: 'tarball', value: prior.artifact}};
  }
  // Keep private source proofs/old plans out of the native package ref.
  packageRef = Object.fromEntries(['backend', 'sourceId', 'packageName', 'exactVersion', 'sourceDigest', 'digestType', 'spec', 'compatibility', 'capabilities', 'dataSchemaVersion', 'hostPluginId'].filter(key => packageRef[key] !== undefined).map(key => [key, packageRef[key]]));
  const plan = await backend.planInstall({packageRef}); await isCurrent(record);
  const installed = await backend.install(plan, {enabled: false}); await isCurrent(record); const enabled = await backend.enable(packageRef);
  if (enabled?.enabled !== true || enabled?.activation?.observed !== true) throw fail('The real native work package did not confirm active Host entries', 'DSH_ACTIVATION_FAILED');
  const actual = await backend.snapshot(); assertOnlyWorkBundle(actual, record.packageName, nativePolicy); const bundle = actual.bundles.find(value => value.name === record.packageName);
  if (!bundle?.enabled || bundle.version !== record.exactVersion) throw fail('The private work profile selected a different package version', 'WORK_PACKAGE_IDENTITY_MISMATCH');
  await isCurrent(record); await mkdir(stateDir, {recursive: true});
  await writeFile(join(stateDir, 'work-package-provenance.json'), JSON.stringify({schemaVersion: 1, packageKey: record.packageKey, pluginId: record.pluginId, exactVersion: record.exactVersion, originalSourceDigest: record.sourceDigest, artifactSha256: plan.artifactSha256, sourceVerification: plan.sourceVerification, generation: record.generation, profileId: plan.profileId, actual: {enabled: true, version: bundle.version, activationObserved: true}, at: new Date().toISOString()}, null, 2) + '\n');
  await confirmActivation({packageKey: record.packageKey, generation: record.generation, sourceDigest: record.sourceDigest});
  return {backend, plan, installed, enabled};
}
/** Idle-only release. Caller removes the live map before closing so the exit
 * listener cannot independently increment the same package generation. */
export async function retireIsolatedWorkBackend({record,backend,closeClient=async()=>{},confirmStopped,invalidate,onRetire=()=>{},onFailure=()=>{}}){
  if(typeof confirmStopped!=='function'||typeof invalidate!=='function')throw fail('A host OS stop verifier is required','WORK_PROCESS_PROOF_MISSING');
  const actual=await backend.snapshot();onRetire();
  try{await closeClient();const native=await backend.close();if(native?.stopped!==true)throw fail('Native work Host has not stopped','WORK_PROCESS_STOP_UNCONFIRMED');
    const proof=await confirmStopped({runtimeId:actual.runtimeId,pid:actual.pid,profileId:actual.profileId,packageKey:record.packageKey,generation:record.generation});
    if(proof?.stopped!==true||proof.osActiveProcesses!==0)throw fail('Native work Host descendants have not stopped','WORK_PROCESS_STOP_UNCONFIRMED');
    await invalidate({packageKey:record.packageKey,generation:record.generation,phase:'work-runtime-idle-release'});return {released:true,drained:true,stopped:true,osActiveProcesses:0,runtimeId:actual.runtimeId,packageKey:record.packageKey};
  }catch(error){onFailure();throw error;}
}
