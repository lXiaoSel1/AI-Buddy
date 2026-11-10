import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {assertPluginTreeNoLinks} from '../plugin-archive.mjs';
import {canonicalPluginJson} from '../plugin-manifest.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=(message,code='DSH_INSTALLED_IDENTITY_MISMATCH')=>{throw Object.assign(Error(message),{code});};

/** Rebind original approval evidence to this backend's exact artifact cache.
 * Used before materialization and rollback; never replay an old profile plan. */
export async function rebindApprovedDshPackagePlan({record,backend,check}){
 await check();
 const prior=record.backendPlan,approved=prior?.packageRef;
 if(!prior?.artifact||!/^[a-f0-9]{64}$/.test(prior.artifactSha256??'')||approved?.packageName!==record.packageName||approved.exactVersion!==record.exactVersion||approved.sourceId!==record.sourceId||approved.sourceDigest!==record.sourceDigest)fail('The approved exact package cache is unavailable; reinstall this exact release','DSH_APPROVED_ARTIFACT_REQUIRED');
 await assertPluginTreeNoLinks(prior.artifact);await check();
 let bytes;try{bytes=await readFile(prior.artifact);}catch(error){if(error.code==='ENOENT')fail('The approved exact package cache is missing; reinstall this exact release','DSH_APPROVED_ARTIFACT_REQUIRED');throw error;}
 if(digest(bytes)!==prior.artifactSha256)fail('The approved exact package cache changed','DSH_PACKAGE_DIGEST_MISMATCH');
 const ref=Object.fromEntries(['backend','sourceId','packageName','exactVersion','sourceDigest','digestType','spec','compatibility','capabilities','dataSchemaVersion'].filter(key=>record[key]!==undefined).map(key=>[key,record[key]]));ref.hostPluginId=record.pluginId;
 await check();
 // The backend independently checks the exact tarball and caches it in this
 // profile. Bind that fresh plan back to the approved source identity; a git
 // source digest and the resulting archive SHA identify different things.
 const fresh=await backend.planInstall({packageRef:{...ref,sourceDigest:prior.artifactSha256,digestType:'tarball-sha256',spec:{kind:'tarball',value:prior.artifact}}});await check();
 const plan={...fresh,packageRef:ref};plan.planDigest=digest(canonicalPluginJson({packageRef:plan.packageRef,profileId:plan.profileId,spec:plan.spec,artifactSha256:plan.artifactSha256,sourceVerification:plan.sourceVerification}));
 if(plan.artifactSha256!==prior.artifactSha256)fail('The current native plan selected a different archive','DSH_PACKAGE_DIGEST_MISMATCH');
 return plan;
}

/** Host-only recovery. Inventory is observed after startup; no old native home
 * is copied. Existing packages also get a fresh current-profile exact plan. */
export async function prepareCurrentDshPackage({record,backend,check}){
 await check();const actual=await backend.currentInventory(record);await check();
 if(!Array.isArray(actual?.bundles))fail('The current native package inventory was not observed','DSH_PROFILE_NOT_OBSERVED');
 const bundle=actual.bundles.find(row=>row.name===record.packageName),present=bundle&&bundle.installed!==false;
 if(present){const identity=actual.identity;if(bundle.error||bundle.version!==record.exactVersion||identity?.packageName!==record.packageName||identity.exactVersion!==record.exactVersion||identity.sourceDigest!==record.sourceDigest||identity.pluginId!==record.pluginId)fail('The current native package conflicts with the approved installation');}
 const plan=await rebindApprovedDshPackagePlan({record,backend,check});if(present)return {materialized:false,plan};
 const result=await backend.install(plan,{enabled:false,grantedCapabilities:record.grantedCapabilities});await check();
 if(result?.application!=='applied'||result.enabled!==false)fail('Native package recovery was not confirmed disabled','DSH_PACKAGE_INSTALL_FAILED');
 const installed=await backend.currentInventory(record);await check();const current=installed?.bundles?.find(row=>row.name===record.packageName);
 if(!current||current.installed===false||current.enabled||current.error||current.version!==record.exactVersion||installed.identity?.packageName!==record.packageName||installed.identity?.exactVersion!==record.exactVersion||installed.identity?.sourceDigest!==record.sourceDigest||installed.identity?.pluginId!==record.pluginId)fail('Native recovery did not produce the approved disabled package');
 return {materialized:true,plan};
}
