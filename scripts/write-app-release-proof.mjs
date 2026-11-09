// Offline: read the real signed annotated tag and frozen assets. Never sign,
// replace an existing proof, access credentials, push or publish.
import {writeFile} from 'node:fs/promises';import {join,resolve} from 'node:path';
import {createAppReleaseProofArtifact} from '../src/app-release-proof-artifact.mjs';
if(process.argv.length!==5)throw Error('Usage: node scripts/write-app-release-proof.mjs <repository> <vX.Y.Z> <frozen-assets-directory>');
const assetsDirectory=resolve(process.argv[4]);
const proof=await createAppReleaseProofArtifact({repository:resolve(process.argv[2]),tag:process.argv[3],assetsDirectory});
await writeFile(join(assetsDirectory,'app-release-proof.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({ok:true,version:proof.release.version,artifact:'app-release-proof.json',signed:false,published:false}));
