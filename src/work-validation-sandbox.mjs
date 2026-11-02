import {readFile,realpath} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {assertPluginTreeNoLinks} from './plugin-archive.mjs';
import {DSH_SOURCE_COMMIT} from './dsh-platform/component-manager.mjs';
const prefix='installation/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/',entry=prefix+'index.js';
const fail=()=>Object.assign(Error('The fixed validation sandbox does not match the verified component'),{code:'WORK_VALIDATION_SANDBOX_PIN'}),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function trustedValidationSandbox(component,{guardPath}={}){
 try{const lockPath=resolve(component.lockPath),root=dirname(lockPath);await assertPluginTreeNoLinks(lockPath);const lockBytes=await readFile(lockPath),lock=JSON.parse(lockBytes);
  if(component.sourceCommit!==DSH_SOURCE_COMMIT||lock.sourceCommit!==DSH_SOURCE_COMMIT||lock.stage!=='ready'||!Array.isArray(lock.files)||lock.paths?.node!=='node/node.exe')throw fail();
  const nodePath=await realpath(join(root,lock.paths.node));if(nodePath!==await realpath(component.nodePath))throw fail();const nodeRow=lock.files.find(row=>row.path===lock.paths.node);if(!nodeRow||hash(await readFile(nodePath))!==nodeRow.sha256)throw fail();
  const files=new Map(),queue=['@deepseek-ai/dsh-sandbox-windows-acl'],packages=new Set();let totalBytes=0;
  while(queue.length){const name=queue.shift();if(packages.has(name))continue;if(!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name))throw fail();packages.add(name);const packagePrefix='installation/node_modules/'+name+'/',manifestRow=lock.files.find(row=>row.path===packagePrefix+'package.json');if(!manifestRow)throw fail();const manifestBytes=await readFile(resolve(root,manifestRow.path));if(hash(manifestBytes)!==manifestRow.sha256)throw fail();const manifest=JSON.parse(manifestBytes);
   for(const row of lock.files.filter(row=>row.path.startsWith(packagePrefix))){if(row.path.includes('..')||row.path.includes('\\'))throw fail();if(files.has(row.path))continue;const path=resolve(root,row.path);await assertPluginTreeNoLinks(path);const bytes=await readFile(path);if(hash(bytes)!==row.sha256)throw fail();totalBytes+=bytes.length;if(files.size>=5000||totalBytes>128*1024*1024)throw fail();files.set(row.path,{path:await realpath(path),sha256:row.sha256});}
   for(const name of Object.keys(manifest.dependencies??{}))queue.push(name);for(const name of [...Object.keys(manifest.optionalDependencies??{}),...Object.keys(manifest.peerDependencies??{})])if(lock.files.some(row=>row.path==='installation/node_modules/'+name+'/package.json'))queue.push(name);
  }
  if(!files.has(entry))throw fail();const moduleFiles=[...files.values()];
  await assertPluginTreeNoLinks(guardPath);const actualGuard=await realpath(guardPath);return {version:1,enforcement:'windows-restricted-token-low',modulePath:await realpath(resolve(root,entry)),moduleFiles,guardPath:actualGuard,guardSha256:hash(await readFile(actualGuard)),lockSha256:hash(lockBytes)};
 }catch(error){if(error.code==='WORK_VALIDATION_SANDBOX_PIN')throw error;throw fail();}
}
