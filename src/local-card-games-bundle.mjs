import {createHash} from 'node:crypto';
import {lstat,mkdir,readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {writeAtomicAsync} from './atomic-write.mjs';
import {communityDigest,communityPackageKey} from './community/catalog.mjs';
import {createDshBackend,tarballIdentity} from './dsh-platform/backend.mjs';
import {verifyInstalledDshArtifact} from './dsh-platform/installed-artifact.mjs';
import {assertOnlyWorkBundle,nativeModulePolicyFromLock} from './dsh-platform/work-runtime.mjs';
import {assertPluginTreeNoLinks} from './plugin-archive.mjs';

export const LOCAL_CARD_GAMES=Object.freeze({
  backend:'dsh',sourceId:'buddy-local-card-games',packageName:'@ai-buddy/card-games',exactVersion:'0.1.0-dev.1',
  capabilities:Object.freeze(['games.table','games.models','games.chat','games.replay']),
});
const SHA256=/^[a-f0-9]{64}$/, PROFILE='buddy-card-games-v1';
const defaults=['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'];
const {packageName,exactVersion,capabilities,sourceId}=LOCAL_CARD_GAMES;
const packageKey=communityPackageKey(LOCAL_CARD_GAMES);
const pluginId='dsh.'+communityDigest({sourceId,packageName}).slice(0,32);
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=(code,message)=>Object.assign(Error(message),{code});
const invalid=()=>fail('LOCAL_CARD_GAMES_INTEGRITY','The bundled card package, private profile or install record failed verification');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const onlyKeys=(object,keys)=>Object.keys(object).every(key=>keys.includes(key));
const entry=path=>lstat(path).catch(cause=>{if(cause.code!=='ENOENT')throw cause;return null;});
const compiledDigest=typeof __AI_BUDDY_LOCAL_CARD_BUNDLE_SHA256__==='undefined'?null:__AI_BUDDY_LOCAL_CARD_BUNDLE_SHA256__;

/** Only a host build can supply the pin. No renderer input, catalog or trust store participates. */
export async function createLocalCardGamesBundle({build,dataRoot,selectedRuntimeLock,voiceGamesServices,clientHost,foreignInstalled=()=>false,onUpdate=()=>{},audit=()=>{},backendFactory=createDshBackend,digest=compiledDigest}){
  if(digest===null)return null;
  if(!SHA256.test(digest))throw invalid();
  const archivePath=join(build,'bundled-plugins','card-games.tgz');
  const recordPath=join(dataRoot,'plugin-platform','local-card-games-v1.json');
  const dshHome=join(dataRoot,'plugin-runtimes','dsh-card-games'),profileRoot=join(dshHome,'profiles',PROFILE);
  const stateDir=join(dataRoot,'plugin-platform','dsh-card-games'),hostBridgeSourcePath=join(build,'dsh-platform','native-bridge-host.mjs');
  const identity={packageName,pluginId,exactVersion,sourceDigest:digest};
  const ref={...LOCAL_CARD_GAMES,sourceDigest:digest,digestType:'tarball-sha256',hostPluginId:pluginId,spec:{kind:'tarball',value:archivePath}};
  let record=null,loadError=null,lastError=null,live=null,active=null,closed=false,closing=null,tail=Promise.resolve(),busy=0;
  const ready=()=>record?.enabled===true&&active!==null&&!foreignInstalled();
  const status=()=>({available:true,packageKey,exactVersion,sourceDigest:digest,enabled:record?.enabled===true,installed:record?.installed===true,runtimeVerified:ready(),phase:loadError||lastError?'failed':ready()?'loaded':record?.enabled?'pending-load':record?.installed?'disabled':'not-installed',error:(loadError??lastError)?.code??null});
  function notify(){try{onUpdate();}catch{}}
  async function safeFile(path,maxBytes,optional=false){
    await assertPluginTreeNoLinks(path);
    const info=await entry(path);
    if(!info&&optional)return null;
    if(!info?.isFile()||info.size>maxBytes)throw invalid();
    return readFile(path);
  }
  try{
    const raw=await safeFile(recordPath,4096,true);
    if(raw){
      const value=JSON.parse(raw.toString('utf8'));
      if(value?.schemaVersion!==1||!Object.entries(identity).every(([key,expected])=>value[key]===expected)||typeof value.installed!=='boolean'||typeof value.enabled!=='boolean'||value.enabled&&!value.installed||!Number.isSafeInteger(value.generation)||value.generation<1)throw invalid();
      record=value;
    }
  }catch(cause){loadError=Object.assign(invalid(),{cause});}
  async function save(installed,enabled){
    const value={schemaVersion:1,...identity,installed,enabled,generation:(record?.generation??0)+1};
    await assertPluginTreeNoLinks(recordPath);
    await mkdir(dirname(recordPath),{recursive:true});
    await writeAtomicAsync(recordPath,JSON.stringify(value,null,2)+'\n');
    record=value;
  }
  function run(operation,{allowClosed=false}={}){
    if(closed&&!allowClosed)return Promise.reject(fail('PLUGIN_CLOSED','Plugin platform is closed'));
    busy++;
    const pending=tail.then(()=>{if(closed&&!allowClosed)throw fail('PLUGIN_CLOSED','Plugin platform is closed');return operation();});
    tail=pending.catch(()=>{}).finally(()=>{busy--;});
    return pending;
  }
  function requireCurrent(){
    if(closed)throw fail('PLUGIN_CLOSED','Plugin platform is closed');
    if(loadError)throw loadError;
    if(foreignInstalled())throw fail('LOCAL_CARD_GAMES_IDENTITY_CONFLICT','Another installed package uses this card-games package name');
  }
  async function verifiedArchive(){
    const bytes=await safeFile(archivePath,8*1024*1024);
    if(hash(bytes)!==digest)throw invalid();
    const files=new Map(),manifest=tarballIdentity(bytes,files);
    if(manifest.name!==packageName||manifest.version!==exactVersion||!same(manifest.aiBuddy?.capabilities,capabilities)||manifest.aiBuddy?.voiceGamesContractVersion!=='voice-games-v1'||['dependencies','optionalDependencies','peerDependencies','bundledDependencies','bundleDependencies','scripts'].some(key=>Object.keys(manifest[key]??{}).length))throw invalid();
    return files;
  }
  async function verifyProfile(files){
    const profile=await safeFile(join(profileRoot,'package.json'),16384,true);
    const identities=await safeFile(join(stateDir,'package-identities.json'),16384,true);
    const existing=await entry(join(profileRoot,'node_modules','@ai-buddy','card-games'));
    for(const name of ['cordis.yml','cordis.patch.yml']){
      const raw=await safeFile(join(profileRoot,name),8192,true);
      if(raw&&raw.toString('utf8').replace(/^\s*#[^\r\n]*/gm,'').trim()!=='[]')throw invalid();
    }
    if(profile){
      const value=JSON.parse(profile.toString('utf8')),dependencies=value?.dependencies??{},bundles=value?.dsh?.profile?.bundles;
      const expected=join(stateDir,'verified-packages',digest+'.tgz').replaceAll('\\','/');
      if(!onlyKeys(value,['name','private','dependencies','dsh'])||value.name!=='dsh-profile-'+PROFILE||value.private!==true||!onlyKeys(dependencies,[packageName])||!onlyKeys(value.dsh??{},['profile'])||!onlyKeys(value.dsh?.profile??{},['bundles'])||!(same(bundles,defaults)||same(bundles,[...defaults,packageName]))||!!dependencies[packageName]!==!!existing||dependencies[packageName]&&String(dependencies[packageName]).replaceAll('\\','/')!=='file:'+expected||bundles.includes(packageName)&&!existing)throw invalid();
    }else if(existing||identities||await entry(profileRoot))throw invalid();
    if(!existing){if(record?.installed||identities)throw invalid();return false;}
    if(!record)throw invalid();
    const stored=identities&&JSON.parse(identities.toString('utf8'));
    if(!stored||!onlyKeys(stored,[packageName])||!Object.entries(identity).every(([key,value])=>stored[packageName]?.[key]===value))throw invalid();
    const cached=await safeFile(join(stateDir,'verified-packages',digest+'.tgz'),8*1024*1024);
    if(hash(cached)!==digest)throw invalid();
    await verifyInstalledDshArtifact({profileRoot,packageName,exactVersion,files});
    return true;
  }
  async function cleanup(current=live){
    active=null;
    if(!current)return;
    if(live===current)live=null;
    const results=await Promise.allSettled([voiceGamesServices.revoke(pluginId),current.descriptor&&clientHost.closeRuntime(current.descriptor.runtimeId)]);
    const stop=await current.backend.close();
    if(stop?.stopped!==true||stop.forced===true)throw fail('LOCAL_CARD_GAMES_STOP_UNCONFIRMED','The private card runtime did not confirm a normal stop');
    const rejected=results.find(value=>value.status==='rejected');
    if(rejected)throw rejected.reason;
  }
  async function start(files){
    if(live)return live;
    const existing=await verifyProfile(files),runtimeLockPath=await selectedRuntimeLock();
    const policy=await nativeModulePolicyFromLock(runtimeLockPath,{stateDir,hostBridgeSourcePath});
    requireCurrent();
    const current={descriptor:null,existing,policy,backend:backendFactory({runtimeLockPath,dshHome,profileId:PROFILE,stateDir,hostBridgeSourcePath,voiceGamesServices,onEvent:event=>{
      if(event.kind==='runtime-exit'&&live===current){
        active=null;current.exited=true;
        void run(async()=>{if(live===current)await cleanup(current);notify();}).catch(cause=>audit({type:'local-card-games-close-failed',code:cause.code??'LOCAL_CARD_GAMES_CLOSE_FAILED'}));
        notify();
      }
      if(event.kind!=='runtime-log')audit({type:'local-card-games-runtime',...event});
    }})};
    live=current;
    current.descriptor=await current.backend.openClient();
    assertOnlyWorkBundle(await current.backend.snapshot(),packageName,policy);
    return current;
  }
  async function activate({install=false,explicitEnable=false}={}){
    requireCurrent();
    if(!install&&!explicitEnable&&!record?.enabled)throw fail('PLUGIN_DISABLED','The bundled card game is not enabled');
    if(install&&record?.installed&&!record.enabled)return status();
    if(ready())return status();
    try{
      const files=await verifiedArchive();
      // Persist the attempt before the private runtime creates its own files.
      if(!record)await save(false,false);
      const current=await start(files);
      if(!current.existing){
        const plan=await current.backend.planInstall({packageRef:ref,grantedCapabilities:[...capabilities]});
        if(plan.artifactSha256!==digest)throw invalid();
        await current.backend.install(plan,{enabled:false});
        await verifyProfile(files);
        current.existing=true;
      }
      const enabled=await current.backend.enable(ref),snapshot=await current.backend.snapshot();
      assertOnlyWorkBundle(snapshot,packageName,current.policy);
      if(enabled?.enabled!==true||enabled.activation?.observed!==true||enabled.activation.packageName!==packageName||enabled.activation.version!==exactVersion||!enabled.activation.entries?.some(value=>value.enabled&&value.fiberPhase==='active')||!snapshot.bundles.some(value=>value.name===packageName&&value.version===exactVersion&&value.enabled===true&&!value.error))throw fail('DSH_ACTIVATION_FAILED','The card runtime did not observe active entries for the pinned bundle');
      requireCurrent();if(current.exited||live!==current)throw fail('DSH_RUNTIME_NOT_LIVE','The private card runtime exited during activation');
      if(!record.enabled)await save(true,true);
      if(current.exited||live!==current||closed)throw fail('DSH_RUNTIME_NOT_LIVE','The private card runtime exited during activation');
      active=current;lastError=null;return status();
    }catch(cause){
      lastError=cause;await cleanup().catch(cleanupError=>audit({type:'local-card-games-close-failed',code:cleanupError.code??'LOCAL_CARD_GAMES_CLOSE_FAILED'}));throw cause;
    }finally{notify();}
  }
  function publicRecord(){
    if(!record?.installed)return null;
    const value=status();
    return {...identity,packageKey,backend:'dsh',sourceId,profileId:PROFILE,displayName:'一起玩牌',name:'一起玩牌',description:'一起玩斗地主和德州扑克',category:'function',dataSchemaVersion:1,generation:record.generation,declaredCapabilities:[...capabilities],grantedCapabilities:[...capabilities],enabled:value.enabled,enabledIntent:value.enabled,runtimeVerified:value.runtimeVerified,runtimeState:value.phase,phase:value.phase,previous:null,localBundled:true,...value.error&&{runtimeFailure:{code:value.error,message:'Bundled card game runtime is unavailable'}}};
  }
  return {
    owns:key=>key===packageKey||key===pluginId, status, publicRecord,busy:()=>busy>0,
    grant(value){if(!ready()||!Object.entries(identity).every(([key,expected])=>value?.[key]===expected))return null;return {...identity,enabled:true,generation:record.generation,granted:[...capabilities],declaredCapabilities:[...capabilities]};},
    verifyUI(request){return ready()?active.backend.verifySocialUI(request):false;},
    install:()=>run(()=>activate({install:true})),
    activate:()=>run(async()=>{await activate();return publicRecord();}),
    enable:()=>run(async()=>{if(!record?.installed)throw fail('PLUGIN_NOT_INSTALLED','The bundled card game must first be installed by the host');return activate({install:false,explicitEnable:true});}),
    disable:()=>run(async()=>{
      if(!record?.installed)throw fail('PLUGIN_NOT_INSTALLED','The bundled card game is not installed');
      const current=live;active=null;notify();
      try{
        if(record.enabled)await save(true,false);
        if(current&&!current.exited){const disabled=await current.backend.disable(ref);if(disabled?.application!=='applied'||disabled?.enabled!==false||disabled?.error)throw fail('DSH_PACKAGE_DISABLE_FAILED','The native card profile could not confirm disable');}
        lastError=null;
      }catch(cause){lastError=cause;throw cause;}
      finally{try{await cleanup(current);}finally{notify();}}
      return status();
    }),
    open:surface=>run(async()=>{await activate();return clientHost.open(active.descriptor,{surface,panel:packageName});}),
    invalidate:()=>run(async()=>{try{await cleanup();}finally{notify();}}),
    close(){if(!closing){closed=true;active=null;closing=run(cleanup,{allowClosed:true});}return closing;},
  };
}
