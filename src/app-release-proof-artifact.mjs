import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {verifyAppReleaseProof,parseAppReleaseProofEnvelope} from './update-release-proof.mjs';
const invalid=message=>Object.assign(Error(message),{code:'APP_RELEASE_ARTIFACT_INVALID'});
const requireArtifact=(value,message)=>{if(!value)throw invalid(message);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function readTag(repository,tag){
 const run=args=>execFileSync('git',['--no-replace-objects','-C',resolve(repository),...args],{windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:5*1024*1024});
 const objectSha=run(['rev-parse','--verify','refs/tags/'+tag+'^{tag}']).toString('utf8').trim();
 return {objectSha,bytes:run(['cat-file','tag',objectSha])};
}
async function frozenFile(path){
 const before=await lstat(path,{bigint:true});requireArtifact(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n,'Release artifact must be an independent file');
 const bytes=await readFile(path),after=await lstat(path,{bigint:true});
 requireArtifact(['dev','ino','size','mtimeNs','ctimeNs','nlink'].every(key=>before[key]===after[key])&&BigInt(bytes.length)===after.size,'Release artifact changed while reading');return bytes;
}
// loadTag/verifySignature are test seams only. The CLI exposes neither and
// always reads Git's actual tag object and uses the existing pinned verifier.
export async function createAppReleaseProofArtifact({repository,tag,assetsDirectory,loadTag=readTag,verifySignature}={}){
 requireArtifact(/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(tag??''),'An exact stable annotated tag is required');
 const raw=await loadTag(repository,tag),tagBytes=Buffer.from(raw.bytes),tagText=tagBytes.toString('utf8'),at=tagText.indexOf('-----BEGIN SSH SIGNATURE-----\n');
 requireArtifact(Buffer.from(tagText,'utf8').equals(tagBytes)&&at>0,'An unchanged UTF-8 signed tag object is required');
 const objectSha=createHash('sha1').update(Buffer.from('tag '+tagBytes.length+'\0')).update(tagBytes).digest('hex');
 requireArtifact(raw.objectSha===objectSha,'Git tag object identity differs');
 const signedPayload=tagText.slice(0,at),signature=tagText.slice(at),source=/^object ([a-f0-9]{40})\ntype commit\n/m.exec(signedPayload);
 requireArtifact(source,'Tag must reference a commit');
 const version=tag.slice(1),installerName=`AI-Buddy-Setup-${version}-win-x64.exe`,manifestName=`install-manifest-${version}.json`,checksumsName=`SHA256SUMS-${version}.txt`;
 const [installer,manifest,checksums]=await Promise.all([installerName,manifestName,checksumsName].map(name=>frozenFile(join(assetsDirectory,name))));
 const installerSha256=sha(installer),manifestSha256=sha(manifest),checksumsSha256=sha(checksums);
 const rows=new Map();for(const line of checksums.toString('utf8').split(/\r?\n/)){if(!line.trim())continue;const match=/^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);requireArtifact(match&&!rows.has(match[2]),'Invalid or duplicate checksum entry');rows.set(match[2],match[1].toLowerCase());}
 requireArtifact(rows.get(installerName)===installerSha256&&rows.get(manifestName)===manifestSha256,'Frozen artifact SHA-256 differs from checksums');
 let manifestValue;try{manifestValue=JSON.parse(manifest.toString('utf8'));}catch{throw invalid('Installer manifest is not JSON');}
 requireArtifact((manifestValue.version??version)===version&&(manifestValue.sourceCommit??source[1])===source[1],'Manifest differs from tag version or source');
 const web='https://github.com/lXiaoSel1/AI-Buddy',release=verifyAppReleaseProof({version,tag,installerName,releaseUrl:web+'/releases/tag/'+tag,installerUrl:web+'/releases/download/'+tag+'/'+installerName,bytes:installer.length,installerSha256,manifestSha256,checksumsSha256,sourceCommit:source[1],tagObjectSha:objectSha,signedPayload,signature},{verifySignature});
 return {schemaVersion:1,release};
}
export function assertProofUploaded(proofBytes,assets){
 requireArtifact(Array.isArray(assets),'Actual uploaded release asset list is required');const matches=assets.filter(row=>row.name==='app-release-proof.json');
 requireArtifact(matches.length===1&&matches[0].state==='uploaded'&&matches[0].size===proofBytes.length&&matches[0].digest==='sha256:'+sha(proofBytes),'Published release must include the exact app-release-proof.json asset');return true;
}
export async function checkAppReleasePublication(options,assets){
 const expected=await createAppReleaseProofArtifact(options),bytes=await frozenFile(join(options.assetsDirectory,'app-release-proof.json'));let envelope;
 try{envelope=JSON.parse(bytes.toString('utf8'));}catch{throw invalid('Release proof is not JSON');}
 const actual=parseAppReleaseProofEnvelope(envelope,{verifySignature:options.verifySignature});
 requireArtifact(Object.keys(actual).length===Object.keys(expected.release).length&&Object.entries(expected.release).every(([key,value])=>actual[key]===value),'Release proof differs from the signed tag or frozen assets');
 assertProofUploaded(bytes,assets);return {ok:true,version:actual.version,proofSha256:sha(bytes),bytes:bytes.length};
}
