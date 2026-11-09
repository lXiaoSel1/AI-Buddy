import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {createAppReleaseProofArtifact,checkAppReleasePublication} from '../src/app-release-proof-artifact.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
 const assetsDirectory=await mkdtemp(join(tmpdir(),'release-artifact-'));t.after(()=>rm(assetsDirectory,{recursive:true,force:true}));const version='2.0.13',tag='v'+version,source='d'.repeat(40),installer=Buffer.from('fixture installer'),manifest=Buffer.from(JSON.stringify({version,sourceCommit:source})),installerName=`AI-Buddy-Setup-${version}-win-x64.exe`,manifestName=`install-manifest-${version}.json`;
 const checksums=Buffer.from(sha(installer)+'  '+installerName+'\n'+sha(manifest)+'  '+manifestName+'\n');for(const[name,bytes]of [[installerName,installer],[manifestName,manifest],[`SHA256SUMS-${version}.txt`,checksums]])await writeFile(join(assetsDirectory,name),bytes);
 const payload=`object ${source}\ntype commit\ntag ${tag}\ntagger Fixture\n\nSource: ${source}\nInstaller SHA-256: ${sha(installer)}\nManifest SHA-256: ${sha(manifest)}\nChecksums SHA-256: ${sha(checksums)}\nApp Update Protocol: 1\nApp Bootstrap Protocol: 1\n`,signature='-----BEGIN SSH SIGNATURE-----\nfixture-only\n-----END SSH SIGNATURE-----\n',bytes=Buffer.from(payload+signature),objectSha=createHash('sha1').update(Buffer.from('tag '+bytes.length+'\0')).update(bytes).digest('hex');
 return {assetsDirectory,repository:'unused-fixture-repository',tag,loadTag:()=>({bytes,objectSha}),verifySignature:(actual,armored)=>actual===payload&&armored===signature,installerName,payload,signature};
}
test('proof generator binds frozen hashes to exact annotated tag bytes without signing',async t=>{
 const f=await fixture(t),proof=await createAppReleaseProofArtifact(f);assert.equal(proof.release.signedPayload,f.payload);assert.equal(proof.release.signature,f.signature);assert.equal(proof.release.version,'2.0.13');
 // The fixture verifier is deliberately not the production pinned verifier.
 await assert.rejects(createAppReleaseProofArtifact({...f,verifySignature:undefined}),{code:'APP_UPDATE_VERIFICATION_FAILED'});
});
test('unsigned tags and a changed frozen installer are rejected',async t=>{
 const f=await fixture(t);await assert.rejects(createAppReleaseProofArtifact({...f,loadTag:()=>({bytes:Buffer.from(f.payload),objectSha:'e'.repeat(40)})}),{code:'APP_RELEASE_ARTIFACT_INVALID'});
 await writeFile(join(f.assetsDirectory,f.installerName),'changed installer');await assert.rejects(createAppReleaseProofArtifact(f),{code:'APP_RELEASE_ARTIFACT_INVALID'});
});
test('publication gate requires the exact proof in the actual uploaded asset receipt',async t=>{
 const f=await fixture(t),proof=await createAppReleaseProofArtifact(f),bytes=Buffer.from(JSON.stringify(proof,null,2)+'\n');await writeFile(join(f.assetsDirectory,'app-release-proof.json'),bytes);
 await assert.rejects(checkAppReleasePublication(f,[]),{code:'APP_RELEASE_ARTIFACT_INVALID'});
 await assert.rejects(checkAppReleasePublication(f,[{name:'app-release-proof.json',state:'uploaded',size:bytes.length,digest:'sha256:'+'a'.repeat(64)}]),{code:'APP_RELEASE_ARTIFACT_INVALID'});
 assert.equal((await checkAppReleasePublication(f,[{name:'app-release-proof.json',state:'uploaded',size:bytes.length,digest:'sha256:'+sha(bytes)}])).ok,true);
});
