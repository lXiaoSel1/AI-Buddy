import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertPluginTreeNoLinks} from '../plugin-archive.mjs';
import {writeAtomicAsync} from '../atomic-write.mjs';
import {DSH_PUBLIC_COMPONENT} from './component-download.mjs';
import {createManagedDshComponentManager} from './component-task-manager.mjs';

const fail=message=>Object.assign(Error(message),{code:'DSH_COMPONENT_LOCATION_INVALID'});
const inside=(root,path)=>{const part=relative(root,path);return part===''||!isAbsolute(part)&&part!=='..'&&!part.startsWith('..'+sep);};
const managedProfile=path=>/^local\/(?:data-v\d+|data-profiles\/[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,127})$/.test(path);
// One installation owns the immutable component location. Native homes and
// business data remain profile-local. Selection is lazy and never copies bytes.
export function createInstallDshComponentManager({root,dataRoot,descriptor=DSH_PUBLIC_COMPONENT,managerFactory=createManagedDshComponentManager,...options}){
 root=resolve(root);dataRoot=resolve(dataRoot);
 const canonical=join(root,'local','runtime-components','dsh'),locator=join(root,'local','runtime-components','dsh-location-v1.json');
 const portable=path=>relative(root,path).split(sep).join('/');
 const allowed=path=>path==='local/runtime-components/dsh'||path.endsWith('/plugin-runtimes/dsh-components')&&managedProfile(path.slice(0,-'/plugin-runtimes/dsh-components'.length));
 let selected,selecting,closed=false,failure,invalidBytes;
 async function optional(path){await assertPluginTreeNoLinks(path);try{return await readFile(path,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}}
 function pin(state){if(state.state==='ready'&&(state.archiveSha256!==descriptor.sha256||state.sourceCommit!==descriptor.sourceCommit||state.nodeVersion!==descriptor.nodeVersion||state.pnpmVersion!==descriptor.pnpmVersion))throw fail('Installed DSH component differs from the release pin');return state;}
 async function publish(destination,state){
  if(closed)throw Object.assign(Error('Component manager is closed'),{code:'PLUGIN_CLOSED'});
  if(!inside(root,destination))return;const path=portable(destination);if(!allowed(path))throw fail('DSH component is not in an installation-managed directory');
  await assertPluginTreeNoLinks(destination);await assertPluginTreeNoLinks(locator);await mkdir(dirname(locator),{recursive:true});
  const value={schemaVersion:1,relativeRoot:path,sourceCommit:state.sourceCommit,nodeVersion:state.nodeVersion,pnpmVersion:state.pnpmVersion,archiveSha256:state.archiveSha256};
  const existing=await optional(locator);if(existing===JSON.stringify(value))return;
  if(invalidBytes!==undefined){if(existing!==invalidBytes)throw fail('Invalid component locator changed before repair');if(existing!==null)await writeFile(locator+'.invalid-'+randomUUID()+'.json',existing,{flag:'wx'});}
  await writeAtomicAsync(locator,JSON.stringify(value));invalidBytes=undefined;
 }
 async function choose(){
  let located;const raw=await optional(locator);
  if(raw!==null){try{located=JSON.parse(raw);if(located.schemaVersion!==1||typeof located.relativeRoot!=='string'||!allowed(located.relativeRoot)||located.sourceCommit!==descriptor.sourceCommit||located.nodeVersion!==descriptor.nodeVersion||located.pnpmVersion!==descriptor.pnpmVersion||located.archiveSha256!==descriptor.sha256)throw fail('DSH component locator identity is invalid');}catch(error){invalidBytes=raw;throw error.code==='DSH_COMPONENT_LOCATION_INVALID'?error:fail('DSH component locator is damaged');}}
  const current=portable(dataRoot),candidates=[canonical];
  if(located)candidates.push(resolve(root,located.relativeRoot));
  else{
   if(inside(root,dataRoot)&&managedProfile(current))candidates.push(join(dataRoot,'plugin-runtimes','dsh-components'));
   const registryText=await optional(join(root,'local','community','dsh-registry-v1.json'));
   if(registryText){const registry=JSON.parse(registryText);for(const record of Object.values(registry.packages??{})){
    const artifact=record?.backendPlan?.artifact;if(typeof artifact!=='string'||!isAbsolute(artifact)||!inside(root,resolve(artifact)))continue;
    const path=portable(resolve(artifact)),match=/^(local\/(?:data-v\d+|data-profiles\/[^/]+))\/plugin-platform\/dsh\/verified-packages\/[a-f0-9]{64}\.tgz$/.exec(path);
    if(match&&managedProfile(match[1]))candidates.push(resolve(root,match[1],'plugin-runtimes','dsh-components'));
   }}
  }
  const unique=[...new Set(candidates)];if(unique.length>18)throw fail('Too many legacy DSH component locations; review the installation');
  for(const destination of unique){
   await assertPluginTreeNoLinks(destination);
   // No scan of absent roots and no arbitrary fallback after a damaged pointer.
   if(await optional(join(destination,'current.json'))===null){if(located&&destination===resolve(root,located.relativeRoot))throw fail('The installation component locator no longer has its current pointer');continue;}
   const manager=managerFactory({...options,destinationRoot:destination});let state;
   try{state=pin(await manager.status());if(state.state!=='ready')throw fail('The installed component pointer cannot be verified');await publish(destination,state);return {manager,destination};}catch(error){await manager.close();throw error;}
  }
  // Explicit external data directories retain their prior scope; they are never
  // promoted to an installation-wide locator by inference.
  const destination=!inside(root,dataRoot)?join(dataRoot,'plugin-runtimes','dsh-components'):canonical;
  return {manager:managerFactory({...options,destinationRoot:destination}),destination};
 }
 async function selection(){
  if(closed)throw Object.assign(Error('Component manager is closed'),{code:'PLUGIN_CLOSED'});
  if(!selecting)selecting=choose().catch(error=>{failure=error;return {manager:managerFactory({...options,destinationRoot:canonical}),destination:canonical};}).then(value=>{selected=value;return value;});
  const value=await selecting;if(closed)throw Object.assign(Error('Component manager is closed'),{code:'PLUGIN_CLOSED'});return value;
 }
 return {
  async status(){const {manager}=await selection();if(failure)return {state:'failed',sourceCommit:descriptor.sourceCommit,error:{code:failure.code??'DSH_COMPONENT_LOCATION_INVALID',message:failure.message}};return pin(await manager.status());},
  async plan(input){return (await selection()).manager.plan(input);},
  async install(request){const {manager,destination}=await selection(),state=pin(await manager.install(request));if(state.state==='ready'){await publish(destination,state);failure=undefined;}return state;},
  cancel(){return selected?.manager.cancel()??{cancelled:false};},
  installing(){return selected?.manager.installing()??false;},
  async close(){closed=true;if(selecting){await selecting;await selected?.manager.close();}return {closed:true};},
 };
}
