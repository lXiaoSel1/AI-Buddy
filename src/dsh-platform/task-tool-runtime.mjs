import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {assertPluginTreeNoLinks} from '../plugin-archive.mjs';

const fail=(message,code='WORK_TOOL_RUNTIME_DENIED')=>Object.assign(Error(message),{code});
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const taskToolModelScope=binding=>binding?{modelSelection:{provider:binding.provider,model:binding.model,...binding.effort==null?{}:{reasoningEffort:binding.effort}}}:undefined;
export function assertOnlyTaskToolBundles(snapshot,records,{allowedModules=new Set(),trustedBridgeModule}={}){
  if(!Array.isArray(snapshot?.bundles)||!Array.isArray(snapshot?.plugins))throw fail('Task tool native inventory was not observed','WORK_TOOL_PROFILE_NOT_OBSERVED');
  const names=new Set(records.map(record=>record.packageName));
  if(snapshot.bundles.some(bundle=>bundle.official!==true&&bundle.installed!==false&&!names.has(bundle.name)))throw fail('Task tool profile contains an unapproved third-party package','WORK_TOOL_PROFILE_NOT_ISOLATED');
  for(const entry of snapshot.plugins){if(!entry.enabled)continue;const name=entry.moduleName,root=typeof name==='string'&&name.startsWith('@')?name.split('/').slice(0,2).join('/'):name?.split('/')[0];if(name==='cordis:include'||name===trustedBridgeModule||allowedModules.has(root)||[...names].some(pkg=>name===pkg||name?.startsWith(pkg+'/')))continue;throw fail('Task tool profile contains an unverified Host entry','WORK_TOOL_PROFILE_NOT_ISOLATED');}
  return true;
}
/** PM deploys the exact approved artifact bytes. No source URL/tag is re-resolved. */
export async function prepareTaskToolBackend({records,backend,stateDir,assertCurrent,nativePolicy}){
  if(!Array.isArray(records)||!records.length||new Set(records.map(record=>record.packageName)).size!==records.length||typeof assertCurrent!=='function')throw fail('Exact source-bound approved tool records are required');
  const receipts=[];
  for(const record of records){
    if(record.backend!=='dsh'||record.enabled!==true||!record.packageName||record.packageName==='@ai-buddy/work-collaboration'||!record.pluginId||!record.packageKey||!Number.isSafeInteger(record.generation))throw fail('An enabled non-work native tool package is required');
    await assertCurrent();const approved=record.backendPlan;
    if(!approved?.artifact||!/^[a-f0-9]{64}$/.test(approved.artifactSha256??''))throw fail('The approved exact tool artifact is unavailable','WORK_TOOL_ARTIFACT_REQUIRED');
    await assertPluginTreeNoLinks(approved.artifact);if(sha256(await readFile(approved.artifact))!==approved.artifactSha256)throw fail('Approved task tool cache bytes changed','DSH_PACKAGE_DIGEST_MISMATCH');
    const packageRef={backend:'dsh',sourceId:record.sourceId,packageName:record.packageName,exactVersion:record.exactVersion,sourceDigest:approved.artifactSha256,digestType:'tarball-sha256',spec:{kind:'tarball',value:approved.artifact},hostPluginId:record.pluginId};
    const plan=await backend.planInstall({packageRef});await assertCurrent();assertOnlyTaskToolBundles(await backend.snapshot(),records,nativePolicy);
    if(plan.artifactSha256!==approved.artifactSha256)throw fail('Native PM inspected different approved artifact bytes','DSH_PACKAGE_DIGEST_MISMATCH');
    await backend.install(plan,{enabled:false});await assertCurrent();const enabled=await backend.enable(packageRef);
    if(enabled.enabled!==true||enabled.activation?.observed!==true)throw fail('Task tool Host activation was not observed','DSH_ACTIVATION_FAILED');
    const actual=await backend.snapshot();assertOnlyTaskToolBundles(actual,records,nativePolicy);const bundle=actual.bundles.find(row=>row.name===record.packageName);
    if(bundle?.enabled!==true||bundle.version!==record.exactVersion)throw fail('Task tool profile selected a different native version','WORK_TOOL_PACKAGE_CHANGED');
    receipts.push({packageKey:record.packageKey,pluginId:record.pluginId,exactVersion:record.exactVersion,sourceDigest:record.sourceDigest,artifactSha256:plan.artifactSha256,generation:record.generation,activationObserved:true});
  }
  await assertCurrent();await mkdir(stateDir,{recursive:true});await writeFile(join(stateDir,'task-tools-provenance.json'),JSON.stringify({schemaVersion:1,packages:receipts,at:new Date().toISOString()},null,2)+'\n');return receipts;
}
