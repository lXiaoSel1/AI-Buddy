import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,lstat,realpath,readdir,open} from 'node:fs/promises';
import {lstatSync,realpathSync,unlinkSync} from 'node:fs';
import {resolve,join,dirname,basename,relative,isAbsolute,sep} from 'node:path';
import {zstdDecompressSync} from 'node:zlib';
import {writeAtomic} from './atomic-write.mjs';

const fail=(message,code='WORK_NATIVE_HISTORY_DENIED')=>Object.assign(Error(message),{code});
const canonical=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).filter(k=>x[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
const hash=x=>createHash('sha256').update(Buffer.isBuffer(x)||typeof x==='string'?x:canonical(x)).digest('hex');
const same=(a,b)=>canonical(a)===canonical(b),copy=x=>structuredClone(x);
const key=x=>process.platform==='win32'?resolve(x).toLowerCase():resolve(x);
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&key(a)===key(b);
const inside=(a,b)=>{const p=relative(resolve(a),resolve(b));return !p||!isAbsolute(p)&&p!=='..'&&!p.startsWith('..'+sep);};
const ids=['characterId','personaId','lifeId','operationId'];
const ownerScope=x=>Object.fromEntries(ids.map(k=>[k,x.scope?.[k]??x[k]]));
const equalScope=(a,b)=>ids.every(k=>typeof a?.[k]==='string'&&a[k]&&a[k]===b?.[k]);
const statKey=s=>['dev','ino','nlink','size','mtimeNs','ctimeNs'].map(k=>String(s[k])).join(':');
const id=x=>typeof x==='string'&&x.length>0&&x.length<=500&&!x.includes('\0');
function keys(x,allowed){if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!allowed.includes(k)))throw fail('Native history accepts only its opaque identifiers');}
async function noLinks(path){for(let p=resolve(path);;p=dirname(p)){const s=await lstat(p);if(s.isSymbolicLink())throw fail('Linked native history ancestor','WORK_NATIVE_HISTORY_LINK');if(dirname(p)===p)break;}const physical=await realpath(path);if(!samePath(physical,path))throw fail('Redirected native history path','WORK_NATIVE_HISTORY_LINK');return physical;}
async function safeDirectory(path){let p=resolve(path);for(;;){try{await noLinks(p);break;}catch(e){if(e.code!=='ENOENT')throw e;}if(dirname(p)===p)throw fail('No verified history metadata parent');p=dirname(p);}await mkdir(path,{recursive:true});return noLinks(path);}
async function stable(path,maximum=64*1024*1024){await noLinks(path);const before=await lstat(path,{bigint:true});if(!before.isFile()||before.nlink!==1n||before.size>BigInt(maximum))throw fail('Native history file is not a bounded independent file','WORK_NATIVE_HISTORY_LINK');const h=await open(path,'r');try{const start=await h.stat({bigint:true});if(statKey(start)!==statKey(before))throw fail('Native history changed while opening','WORK_NATIVE_HISTORY_CHANGED');const bytes=await h.readFile(),end=await h.stat({bigint:true}),after=await lstat(path,{bigint:true});if(statKey(start)!==statKey(end)||statKey(end)!==statKey(after))throw fail('Native history changed while reading','WORK_NATIVE_HISTORY_CHANGED');return {path,bytes,sha256:hash(bytes),fileIdentity:statKey(end)};}finally{await h.close();}}
async function json(path){const f=await stable(path,2*1024*1024);try{return {...f,value:JSON.parse(f.bytes.toString('utf8'))};}catch{throw fail('Invalid Core native-history metadata');}}
function checkCommit(files){for(const f of files){for(let p=resolve(f.path);;p=dirname(p)){if(lstatSync(p).isSymbolicLink())throw fail('Native history ancestor changed','WORK_NATIVE_HISTORY_CHANGED');if(dirname(p)===p)break;}if(!samePath(realpathSync(f.path),f.path)||statKey(lstatSync(f.path,{bigint:true}))!==f.fileIdentity)throw fail('Native history changed at admission','WORK_NATIVE_HISTORY_CHANGED');}}
function decodeDsh(file){let bytes=file.bytes;if(file.path.endsWith('.zstd')){const chunks=[];let at=0,total=0,frames=0;while(at<bytes.length){const r=zstdDecompressSync(bytes.subarray(at),{info:true}),used=r.engine.bytesWritten;if(!Number.isSafeInteger(used)||used<=0||at+used>bytes.length||(total+=r.buffer.length)>64*1024*1024||++frames>10000)throw fail('Native history compressed stream exceeds its bound');chunks.push(r.buffer);at+=used;}bytes=Buffer.concat(chunks);}if(bytes.length>64*1024*1024||!bytes.length||bytes.at(-1)!==10)throw fail('Native history has an incomplete tail','WORK_NATIVE_HISTORY_CHANGED');let records;try{records=bytes.toString('utf8').split('\n').filter(s=>s.trim()).map(s=>JSON.parse(s));}catch{throw fail('Native history contains a complete invalid record');}const [header,...events]=records;if(header?.type!=='session'||header.version!==4||header.isSeeded!==false||!id(header.id)||!isAbsolute(header.cwd??'')||!events.length)throw fail('Only complete unseeded native v4 histories are supported','WORK_NATIVE_HISTORY_UNSUPPORTED');let lastSeq=-1,lastTurn=-1,lastStart=-1,lastEnd=-1;for(const row of events){if(!Number.isSafeInteger(row.seq)||row.seq<=lastSeq||!row.data||typeof row.type!=='string')throw fail('Native history sequence is invalid');lastSeq=row.seq;if(Number.isSafeInteger(row.data.turn))lastTurn=Math.max(lastTurn,row.data.turn);if(row.type==='turn/start')lastStart=row.seq;if(row.type==='turn/end')lastEnd=row.seq;}return {header,events,cursor:{lastSeq,lastTurn,eventCount:events.length,prefixSha256:hash(events)},terminal:lastEnd>=lastStart&&lastEnd>=0};}

/** Core-owned metadata/approval reservation. Actual DSH exclusion is acquired
 * by the guard-admitted SDK session/resume; no sidecar lock impersonates it. */
export function createWorkNativeHistoryAuthority({dataRoot,readEntity,getJob,assertLive,verifyApproval,bindingIdentity,supervisor,onRegisterUsageSource=async()=>{},audit=()=>{}}={}){
  const base=join(dataRoot,'work-host','native-history-v1'),tails=new Map();
  async function serial(k,fn){const before=tails.get(k)??Promise.resolve(),p=before.catch(()=>{}).then(fn);tails.set(k,p);try{return await p;}finally{if(tails.get(k)===p)tails.delete(k);}}
  const sourceFile=sourceId=>join(base,'sources',hash(sourceId)+'.json'),restoreFile=restoreId=>join(base,'preparations',hash(restoreId)+'.json');
  const claimFile=claimId=>join(base,'claims',hash(claimId)+'.json'),activeFile=sourceKey=>join(base,'active',sourceKey+'.json');
  async function save(path,value,{exclusive=false}={}){await safeDirectory(dirname(path));if(exclusive)await writeFile(path,JSON.stringify(value),{flag:'wx',mode:0o600});else{try{await noLinks(path);if((await lstat(path)).nlink!==1)throw fail('Linked Core history metadata');}catch(e){if(e.code!=='ENOENT')throw e;}writeAtomic(path,JSON.stringify(value));}}
  async function load(path){return (await json(path)).value;}
  async function snapshot(pluginId,path){
    if(!/^dsh\.[a-f0-9]{16,64}$/.test(pluginId??''))throw fail('Unverified Work plugin history source');
    const root=join(dataRoot,'ep',hash(pluginId).slice(0,12)),physical=await noLinks(path);if(!inside(root,physical)||!['session.v4.jsonl.zstd','session.v4.jsonl'].includes(basename(physical)))throw fail('Native history is outside Core managed source roots','WORK_NATIVE_HISTORY_SCOPE');
    const directory=dirname(physical),sessions=dirname(dirname(directory)),profileRoot=dirname(sessions);
    if(basename(sessions)!=='sessions'||!samePath(dirname(profileRoot),join(root,'dsh')))throw fail('Native history profile namespace is not admitted');
    const sourceOwner=await json(join(root,'source-owner-v1.json')),owner=await json(join(profileRoot,'AI-BUDDY-BINDING.json'));
    if(sourceOwner.value.schemaVersion!==1||sourceOwner.value.pluginId!==pluginId||hash(owner.value)!==basename(profileRoot)||owner.value.engine!=='dsh'||owner.value.bindingSnapshot?.engine!=='dsh')throw fail('Native history owner metadata is invalid','WORK_NATIVE_HISTORY_OWNER');
    const file=await stable(physical),native=decodeDsh(file),originCwd=await noLinks(native.header.cwd);
    if(!samePath(owner.value.workspace?.path,originCwd)||!id(owner.value.projectId)||!isAbsolute(owner.value.projectRootIdentity?.realPath??''))throw fail('Native cwd or shared project identity differs from its Core profile owner','WORK_NATIVE_HISTORY_OWNER');
    const sourceProjectRoot=await noLinks(owner.value.projectRootIdentity.realPath),project=readEntity(pluginId,'projects',owner.value.projectId),projectInfo=await lstat(sourceProjectRoot,{bigint:true});
    if(!project||!samePath(project.canonicalPath,sourceProjectRoot)||!projectInfo.isDirectory()||!samePath(project.rootIdentity?.realPath??sourceProjectRoot,sourceProjectRoot))throw fail('Native shared project does not match its persisted original project','WORK_NATIVE_HISTORY_OWNER');
    for(const field of ['volume','fileIdentity','checkoutId']){const captured=owner.value.projectRootIdentity[field];if(captured!=null&&String(project.rootIdentity?.[field])!==String(captured))throw fail('Native shared project identity changed','WORK_NATIVE_HISTORY_OWNER');}
    if(owner.value.projectRootIdentity.volume!=null&&String(projectInfo.dev)!==String(owner.value.projectRootIdentity.volume)||owner.value.projectRootIdentity.fileIdentity!=null&&String(projectInfo.ino)!==String(owner.value.projectRootIdentity.fileIdentity))throw fail('Native shared project directory was replaced','WORK_NATIVE_HISTORY_OWNER');
    if(!samePath(originCwd,sourceProjectRoot)&&!inside(join(dataRoot,'plugin-data','work-v1',pluginId),originCwd))throw fail('Native execution history cwd is outside its protected work copy','WORK_NATIVE_HISTORY_OWNER');
    const files=[];let size=0,directories=0;async function tree(dir,depth=0){if(depth>16||++directories>512)throw fail('Native history directory bound exceeded');for(const e of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(e.isSymbolicLink())throw fail('Native history contains linked content','WORK_NATIVE_HISTORY_LINK');const p=join(dir,e.name);if(e.isDirectory())await tree(p,depth+1);else{const v=await stable(p);files.push(v);size+=v.bytes.length;if(files.length>512||size>256*1024*1024)throw fail('Native session content exceeds its supported bound');}}}await tree(directory);
    if(!files.some(f=>samePath(f.path,physical)&&f.sha256===file.sha256))throw fail('Native log changed during closure capture','WORK_NATIVE_HISTORY_CHANGED');
    const proofFiles=[sourceOwner,owner,...files];checkCommit(proofFiles);
    return {profileRoot,sessionPersistenceRoot:join(profileRoot,'sessions'),profileIdentityHash:hash(owner.value),owner:owner.value,ownerSha256:owner.sha256,path:physical,directory,originCwd,nativeOriginCwd:originCwd,sourceProjectRoot,sourceProjectId:owner.value.projectId,native,proofFiles,
      closure:files.map(f=>({path:relative(directory,f.path),bytes:f.bytes.length,sha256:f.sha256})),sourceKey:hash([pluginId,key(profileRoot),native.header.id])};
  }
  const scopeFor=context=>ownerScope(context);
  async function discoveryRoots({context}){const root=join(dataRoot,'ep',hash(context.pluginId).slice(0,12));let entries;try{const owner=await json(join(root,'source-owner-v1.json'));if(owner.value.schemaVersion!==1||owner.value.pluginId!==context.pluginId)throw fail('Private history roots belong to another source');entries=await readdir(join(root,'dsh'),{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];throw e;}if(entries.length>4096)throw fail('Managed history root enumeration exceeds its bound');const result=[];for(const entry of entries){if(entry.isSymbolicLink())throw fail('Linked managed native history profile','WORK_NATIVE_HISTORY_LINK');if(!entry.isDirectory()||!/^[a-f0-9]{64}$/.test(entry.name))continue;const profile=join(root,'dsh',entry.name),owner=await json(join(profile,'AI-BUDDY-BINDING.json'));if(hash(owner.value)!==entry.name||owner.value.engine!=='dsh')throw fail('Managed native history profile identity changed');if(equalScope(owner.value.scope,scopeFor(context)))result.push({engine:'dsh',hostId:'local',profileId:owner.value.bindingSnapshot?.profileId??'buddy-work',accountRef:owner.value.bindingSnapshot?.accountRef??'unknown',root:join(profile,'sessions')});}return result;}
  function sourceSummary(s){return {sourceKey:s.sourceKey,path:s.path,sourceProfileRoot:s.profileRoot,sessionPersistenceRoot:s.sessionPersistenceRoot,profileIdentityHash:s.profileIdentityHash,ownerSha256:s.ownerSha256,nativeSessionId:s.native.header.id,originCwd:s.originCwd,nativeOriginCwd:s.originCwd,sourceProjectRoot:s.sourceProjectRoot,sourceProjectId:s.sourceProjectId,headerSha256:hash(s.native.header),nativeUsageCursor:s.native.cursor,closure:s.closure};}
  async function source(sourceId,context){if(!id(sourceId))throw fail('A Core-issued native history source is required');const r=await load(sourceFile(sourceId));if(r.version!==1||r.sourceId!==sourceId||r.pluginId!==context.pluginId||!equalScope(r.scope,scopeFor(context)))throw fail('Native history belongs to another owner','WORK_NATIVE_HISTORY_SCOPE');return r;}
  async function unchanged(r){const now=await snapshot(r.pluginId,r.path);if(hash(sourceSummary(now))!==r.sourceDigest)throw fail('Native source changed; inspect and approve a new plan','WORK_NATIVE_HISTORY_CHANGED');return now;}
  async function inspect({context,ref}){
    if(ref?.engine!=='dsh')return {state:'unknown',authoritative:false,canResume:false,resumeCapability:'read-or-evidence-copy-only',reason:'external-native-write-ownership-unproven'};
    if(!id(ref.nativeSessionId)||typeof ref.sourcePath!=='string')throw fail('Native discovery reference is incomplete');
    const s=await snapshot(context.pluginId,ref.sourcePath);if(s.native.header.id!==ref.nativeSessionId||!samePath(ref.worktreePath,s.originCwd)||!equalScope(s.owner.scope,scopeFor(context)))throw fail('Native source does not match this discovered owner','WORK_NATIVE_HISTORY_SCOPE');
    if(!s.native.terminal)return {state:'unknown',authoritative:false,canResume:false,resumeCapability:'read-only',reason:'native-history-is-not-terminal'};
    const summary=sourceSummary(s),sourceId='native-history:'+randomUUID(),r={version:1,sourceId,pluginId:context.pluginId,scope:scopeFor(context),...summary,sourceDigest:hash(summary),originalBinding:s.owner.bindingSnapshot,createdAt:Date.now()};
    checkCommit(s.proofFiles);await save(sourceFile(sourceId),r,{exclusive:true});
    const availability=await reservationAvailability(r,context);
    return {state:availability.canPrepareRestore?'claim-required':'active',authoritative:true,source:'native-state',canResume:false,canPrepareRestore:availability.canPrepareRestore,requiresReservationReconciliation:availability.needsReconcile,resumeCapability:'conditional-native-lease',nativeHistorySourceId:sourceId,accountRef:s.owner.bindingSnapshot.accountRef,profileId:s.owner.bindingSnapshot.profileId??'buddy-work',nativeSessionId:r.nativeSessionId,projectRoot:r.sourceProjectRoot,projectId:r.sourceProjectId,nativeOriginCwd:r.originCwd,rawNativeWorkspace:r.originCwd,reason:availability.reason??'native-lease-required-after-approval'};
  }
  async function bindingFor(r,projectId,bindingId){const project=readEntity(r.pluginId,'projects',projectId),binding=project?.bindings?.find(b=>b.id===bindingId);if(!project||!binding||binding.engine!=='dsh'||binding.provider!=='deepseek-official'||!binding.connectionRef||!binding.fingerprint||project.id!==r.sourceProjectId||!samePath(await noLinks(project.canonicalPath),r.sourceProjectRoot))throw fail('Native history requires the exact current project and DSH binding','WORK_NATIVE_HISTORY_BINDING');if(r.originalBinding.accountRef!==binding.accountRef||r.originalBinding.connectionRef!==binding.connectionRef||r.originalBinding.provider!==binding.provider||r.originalBinding.hostRuntime?.sourceCommit!==binding.hostRuntime?.sourceCommit||r.originalBinding.hostRuntime?.nativeVersion!==binding.hostRuntime?.nativeVersion)throw fail('Native history account or native version differs from the selected binding','WORK_NATIVE_HISTORY_BINDING');const identity=await bindingIdentity(binding);return {project,binding,identity};}
  function isOS0(proof,required=false){return proof?.stopped===true&&proof.osActiveProcesses===0&&!proof.alive?.length&&!proof.unconfirmed?.length&&(!required||proof.registered>0);}
  async function markerRecord(r,context){
    let marker;try{marker=await json(activeFile(r.sourceKey));}catch(e){if(e.code==='ENOENT')return null;throw e;}
    const m=marker.value;if(m.version!==1||m.pluginId!==context.pluginId||!id(m.claimId)||!id(m.jobId)||!id(m.runId))throw fail('Native active marker identity is invalid','WORK_NATIVE_HISTORY_SCOPE');
    let c;try{c=await load(claimFile(m.claimId));}catch(e){if(e.code!=='ENOENT')throw e;}
    if(c){if(c.version!==1||c.claimId!==m.claimId||c.sourceKey!==r.sourceKey||c.pluginId!==context.pluginId||c.jobId!==m.jobId||c.runId!==m.runId||!equalScope(c.scope,scopeFor(context)))throw fail('History reservation belongs to another owner','WORK_NATIVE_HISTORY_SCOPE');return {marker,c};}
    // Compatibility for the earlier, never-installed preparation order: an
    // orphan marker is recoverable only through its persisted exact run and
    // source identity plus terminal/actual OS0 evidence. Missing data stays held.
    const run=readEntity(context.pluginId,'engine_runs',m.runId),d=run?.nativeHistoryRestore;
    if(!run||run.jobId!==m.jobId||!equalScope(run.scope,scopeFor(context))||!d||d.engine!=='dsh'||d.nativeSessionId!==r.nativeSessionId||!samePath(d.sourceProfileRoot,r.sourceProfileRoot)||!samePath(d.sessionPersistenceRoot,r.sessionPersistenceRoot))throw fail('Orphan native marker has no matching persisted run','WORK_NATIVE_HISTORY_BUSY');
    return {marker,c:{version:1,claimId:m.claimId,sourceKey:r.sourceKey,pluginId:context.pluginId,scope:copy(run.scope),jobId:m.jobId,runId:m.runId,taskId:run.taskId,descriptor:d,state:'orphaned',orphaned:true}};
  }
  function terminalRun(c){const saved=readEntity(c.pluginId,'jobs',c.jobId),run=readEntity(c.pluginId,'engine_runs',c.runId);if(!saved||saved.taskId!==c.taskId||!['completed','failed','paused-recoverable','cancelled'].includes(saved.state)||!run||run.jobId!==c.jobId||run.taskId!==c.taskId||run.exited!==true||!equalScope(run.scope,c.scope)||!same(run.nativeHistoryRestore,c.descriptor))return null;return run;}
  async function currentStop(c,{wait=false}={}){const q={jobId:c.jobId,runId:c.runId};return !wait&&typeof supervisor.status==='function'?supervisor.status(q):supervisor.awaitStopped({...q,timeoutMs:wait?5000:0});}
  function needsRegistered(c,run){return !!c.processes?.length||run?.submitted===true||!!run?.nativeSessionId;}
  async function reservationAvailability(r,context){
    const found=await markerRecord(r,context);if(!found)return {canPrepareRestore:true,needsReconcile:false};const {c}=found;
    if(c.state==='released'){if(!isOS0(c.stopProof,needsRegistered(c)))return {canPrepareRestore:false,reason:'released-reservation-stop-evidence-invalid'};const proof=await currentStop(c);return {canPrepareRestore:isOS0(proof,needsRegistered(c)),needsReconcile:true,reason:'stopped-core-reservation-needs-reconcile'};}
    const live=getJob?.(c.jobId);if(live&&!live.stopped)return {canPrepareRestore:false,reason:'core-history-reservation-held'};
    const run=terminalRun(c);if(!run)return {canPrepareRestore:false,reason:'interrupted-reservation-needs-terminal-evidence'};
    const proof=await currentStop(c);return {canPrepareRestore:isOS0(proof,needsRegistered(c,run)),needsReconcile:true,reason:isOS0(proof,needsRegistered(c,run))?'stopped-core-reservation-needs-reconcile':'native-stop-unconfirmed'};
  }
  async function removeExactMarker(c){
    let marker;try{marker=await json(activeFile(c.sourceKey));}catch(e){if(e.code==='ENOENT')return {removed:false,absent:true};throw e;}
    if(marker.value.claimId!==c.claimId)return {removed:false,otherClaimPreserved:true};
    if(marker.value.pluginId!==c.pluginId||marker.value.jobId!==c.jobId||marker.value.runId!==c.runId)throw fail('Native marker changed owner before removal','WORK_NATIVE_HISTORY_SCOPE');
    checkCommit([marker]);unlinkSync(activeFile(c.sourceKey));return {removed:true};
  }
  async function finishReleased(c,context){if(c.state!=='released'||!equalScope(c.scope,scopeFor(context))||c.pluginId!==context.pluginId||!isOS0(c.stopProof,needsRegistered(c)))throw fail('Released native custody lacks its durable own stop result','WORK_PROCESS_STOP_UNCONFIRMED');const proof=await currentStop(c,{wait:true});if(!isOS0(proof,needsRegistered(c)))throw fail('Released custody cleanup still requires actual owned OS0','WORK_PROCESS_STOP_UNCONFIRMED');return removeExactMarker(c);}
  async function reconcileStoppedReservation(r,context){
    const found=await markerRecord(r,context);if(!found)return;const {c}=found;
    if(c.state==='released'){await finishReleased(c,context);return;}
    const live=getJob?.(c.jobId);if(live&&!live.stopped)throw fail('Native history still has a live admitted job','WORK_NATIVE_HISTORY_BUSY');
    const run=terminalRun(c);if(!run)throw fail('Interrupted native history needs persisted terminal and stop evidence','WORK_NATIVE_HISTORY_BUSY');
    if(c.orphaned){const proof=await currentStop(c,{wait:true});if(!isOS0(proof,needsRegistered(c,run)))throw fail('Orphan reservation cleanup requires actual owned OS0','WORK_PROCESS_STOP_UNCONFIRMED');await removeExactMarker(c);audit({type:'native-history-unadmitted-marker-reconciled',claimId:c.claimId,jobId:c.jobId,runId:c.runId});return;}
    const recovered={pluginId:c.pluginId,jobId:c.jobId,taskId:c.taskId,scope:c.scope,members:[{id:run.memberId,scope:run.scope,engineBindingSnapshot:run.bindingSnapshot}],nativeSpawnAdmitted:new Set(c.processes?.length?[c.runId]:[])};
    await release({job:recovered,context,payload:{runId:c.runId,claimId:c.claimId}});audit({type:'native-history-stopped-reservation-reconciled',claimId:c.claimId,jobId:c.jobId,runId:c.runId});
  }
  async function prepare({context,payload}){
    keys(payload,['sourceId','projectId','bindingId']);const r=await source(payload.sourceId,context);await reconcileStoppedReservation(r,context);const b=await bindingFor(r,payload.projectId,payload.bindingId),s=await unchanged(r),restoreId='native-restore:'+randomUUID();
    const descriptor={version:1,restoreId,sourceId:r.sourceId,engine:'dsh',mode:'resume-original',sourceDigest:r.sourceDigest,sourceProfileRoot:r.sourceProfileRoot,sessionPersistenceRoot:r.sessionPersistenceRoot,profileIdentityHash:r.profileIdentityHash,nativeSessionId:r.nativeSessionId,originCwd:r.originCwd,nativeOriginCwd:r.originCwd,sourceProjectRoot:r.sourceProjectRoot,sourceProjectId:r.sourceProjectId,projectId:b.project.id,projectPath:b.project.canonicalPath,bindingId:b.binding.id,bindingFingerprint:b.binding.fingerprint,nativeVersion:b.binding.hostRuntime?.nativeVersion??null,sourceCommit:b.binding.hostRuntime?.sourceCommit??null,nativeUsageCursor:r.nativeUsageCursor,accounting:'native-step-new-turns-only'};
    checkCommit(s.proofFiles);await save(restoreFile(restoreId),{version:1,descriptor,pluginId:r.pluginId,scope:r.scope,binding:copy(b.binding),bindingIdentity:copy(b.identity)},{exclusive:true});return copy(descriptor);
  }
  async function checkedDescriptor({context,task,plan,checkSource=true}){const d=task.nativeHistoryRestore;if(!d){if(plan?.nativeHistoryRestore)throw fail('Plan contains an unattached history restore');return null;}if(!same(d,plan?.nativeHistoryRestore))throw fail('Task and concrete plan history source differ','WORK_NATIVE_HISTORY_APPROVAL');const p=await load(restoreFile(d.restoreId)),r=await source(d.sourceId,context);if(p.version!==1||p.pluginId!==context.pluginId||!equalScope(p.scope,scopeFor(context))||!same(p.descriptor,d)||d.projectId!==task.projectId)throw fail('Native restore descriptor changed','WORK_NATIVE_HISTORY_APPROVAL');const b=await bindingFor(r,d.projectId,d.bindingId),lead=task.team?.find(m=>m.id===task.leadMemberId);if(!lead||!equalScope(lead.scope,r.scope)||!same(lead.engineBindingSnapshot,p.binding)||!same(b.binding,p.binding)||!same(b.identity,p.bindingIdentity))throw fail('Native restore binding changed','WORK_NATIVE_HISTORY_BINDING');if(checkSource)await unchanged(r);return {descriptor:copy(d),record:p,source:r};}
  async function validateApproval(args){
    const v=await checkedDescriptor({...args,checkSource:false});if(!v)return null;
    let marker;try{marker=await load(activeFile(v.source.sourceKey));}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!marker){
      // A private live job may continue central validation after its own SDK
      // releases the original SID. No history/claim discovery grants authority.
      let ownedAppend=false;const job=id(args.context.jobId)?getJob?.(args.context.jobId):null,runId=args.task.nativeHistoryRestoreRunId;
      if(job&&job.jobId===args.context.jobId&&job.stopped===false&&job.phase==='execution'&&job.pluginId===args.context.pluginId&&job.taskId===args.task.id&&equalScope(job.scope,scopeFor(args.context))&&equalScope(args.task.scope,job.scope)&&id(runId)){
        const run=readEntity(job.pluginId,'engine_runs',runId),member=job.members?.find(m=>m.id===run?.memberId),stop=run?.exitProof?.nativeHistoryStatus;
        if(run&&run.id===runId&&run.taskId===args.task.id&&run.jobId===job.jobId&&run.kind!=='validation-process'&&run.phase==='execution'&&run.state==='completed'&&run.submitted===true&&run.exited===true&&run.nativeSessionId===v.descriptor.nativeSessionId&&run.memberId===args.task.leadMemberId&&member&&equalScope(run.scope,member.scope)&&equalScope(member.scope,job.scope)&&same(run.bindingSnapshot,member.engineBindingSnapshot)&&same(run.nativeHistoryRestore,v.descriptor)&&run.exitProof?.exited===true&&run.exitProof.ownedChildrenStopped===true&&stop?.released===true&&stop.stopped===true&&stop.osActiveProcesses===0){
          const claimId='native-claim:'+hash([v.source.sourceKey,job.pluginId,job.jobId,run.id,v.descriptor.restoreId]);let c,claimProof;try{claimProof=await json(claimFile(claimId));c=claimProof.value;}catch(e){if(e.code!=='ENOENT')throw e;}
          const seal=c?.releasedSource,authorization={taskGeneration:job.taskGeneration,planRevision:job.planRevision,planHash:job.planHash,approvalHash:job.approvalHash,nativeHostInstanceId:job.nativeHostInstanceId};
          if(c?.version===1&&c.claimId===claimId&&c.sourceKey===v.source.sourceKey&&c.state==='released'&&c.pluginId===job.pluginId&&c.jobId===job.jobId&&c.runId===run.id&&c.taskId===args.task.id&&equalScope(c.scope,job.scope)&&same(c.descriptor,v.descriptor)&&same(c.workspace,run.workspace)&&Number.isFinite(c.confirmedAt)&&c.confirmedPrefix&&c.processes?.length&&isOS0(c.stopProof,true)&&seal?.version===1&&seal.nativeTerminal===true&&/^[a-f0-9]{64}$/.test(seal.sourceDigest??'')&&same(seal.authorization,authorization)&&Number.isSafeInteger(authorization.taskGeneration)&&authorization.taskGeneration===args.task.generation&&Number.isSafeInteger(authorization.planRevision)&&authorization.planRevision===args.task.planRevision&&/^[a-f0-9]{64}$/.test(authorization.planHash??'')&&authorization.planHash===args.task.planHash&&/^[a-f0-9]{64}$/.test(authorization.approvalHash??'')&&authorization.approvalHash===args.task.approval?.approvalHash&&id(authorization.nativeHostInstanceId)){
            const workspace=await noLinks(c.workspace.path);if(!inside(join(dataRoot,'plugin-data','work-v1',job.pluginId),workspace)||(await lstat(workspace)).isDirectory()!==true)throw fail('Released native workspace changed','WORK_NATIVE_HISTORY_SCOPE');
            const now=await prefix(c);if(!now.native.terminal||hash(sourceSummary(now))!==seal.sourceDigest||!same(now.native.cursor,seal.nativeUsageCursor))throw fail('Native source changed after its owned release','WORK_NATIVE_HISTORY_CHANGED');
            if(!isOS0(await currentStop(c),true))throw fail('Released native execution no longer has confirmed own OS0','WORK_PROCESS_STOP_UNCONFIRMED');
            try{lstatSync(activeFile(c.sourceKey));throw fail('Another native claim appeared after release','WORK_NATIVE_HISTORY_BUSY');}catch(e){if(e.code!=='ENOENT')throw e;}
            checkCommit([...now.proofFiles,claimProof]);ownedAppend=true;
          }
        }
      }
      if(!ownedAppend)await unchanged(v.source);
    }
    else{const c=await load(claimFile(marker.claimId)),job=getJob?.(c.jobId),run=job&&readEntity(c.pluginId,'engine_runs',c.runId);if(!job||c.taskId!==args.task.id||c.pluginId!==args.context.pluginId||!equalScope(c.scope,scopeFor(args.context))||!same(c.descriptor,v.descriptor)||!run)throw fail('History is reserved by another or interrupted task','WORK_NATIVE_HISTORY_BUSY');
      const rows=job.nativeProcesses?.get(c.runId)??[],sdk=rows.find(p=>rows.some(parent=>parent.pid===p.parentPid));
      if(!sdk)await unchanged(v.source);else{await observedProcesses(job,run,sdk.pid);const s=await prefix(c);if(c.state==='reserved')assertBeforePrompt(c,s);}
    }
    return hash(v.descriptor);
  }
  async function runFor(job,context,runId,{cleanup=false}={}){const run=job&&readEntity(job.pluginId,'engine_runs',runId),task=job&&readEntity(job.pluginId,'tasks',job.taskId),member=run&&job.members?.find(m=>m.id===run.memberId);if(!job||!run||!task||run.kind==='validation-process'||run.jobId!==job.jobId||run.taskId!==job.taskId||!member||!equalScope(run.scope,member.scope)||!equalScope(job.scope,scopeFor(context))||!same(run.bindingSnapshot,member.engineBindingSnapshot)||!run.nativeHistoryRestore||!cleanup&&(run.memberId!==task.leadMemberId||!same(run.nativeHistoryRestore,task.nativeHistoryRestore)))throw fail('Native restore is outside its persisted lead run','WORK_NATIVE_HISTORY_SCOPE');if(!cleanup){if(job.phase!=='execution')throw fail('Native restore requires an approved execution','WORK_PLAN_READ_ONLY');const workspace=await noLinks(run.workspace?.path??'');if(!inside(join(dataRoot,'plugin-data','work-v1',job.pluginId),workspace)||!id(run.workspace?.id)||(await lstat(workspace)).isDirectory()!==true)throw fail('Native restore requires its persisted private work copy','WORK_NATIVE_HISTORY_SCOPE');await assertLive({job,run,context});await verifyApproval({job,context});}return {run,task};}
  const planFor=(job,task)=>readEntity(job.pluginId,'plans',task.id+':'+task.planRevision)?.plan;
  function runtimeValue(c){return {claimId:c.claimId,sourceId:c.descriptor.sourceId,engine:'dsh',mode:'resume-original',profileRoot:c.descriptor.sourceProfileRoot,sessionPersistenceRoot:c.descriptor.sessionPersistenceRoot,jobConfigHome:c.jobConfigHome,nativeSessionId:c.descriptor.nativeSessionId,originCwd:c.descriptor.originCwd,nativeOriginCwd:c.descriptor.nativeOriginCwd,sourceProjectRoot:c.descriptor.sourceProjectRoot,sourceProjectId:c.descriptor.sourceProjectId,workspace:copy(c.workspace),nativeUsageCursor:copy(c.descriptor.nativeUsageCursor),jobConfigOwner:copy(c.jobConfigOwner)};}
  async function claim({job,context,payload}){
    keys(payload,['runId','sourceId']);const {run,task}=await runFor(job,context,payload.runId),v=await checkedDescriptor({context,task,plan:planFor(job,task)});if(v.descriptor.sourceId!==payload.sourceId)throw fail('Run selected another native source');
    return serial(v.source.sourceKey,async()=>{
      let active;try{active=await load(activeFile(v.source.sourceKey));}catch(e){if(e.code!=='ENOENT')throw e;}
      if(active){const c=await load(claimFile(active.claimId));if(c.jobId===job.jobId&&c.runId===run.id&&c.pluginId===job.pluginId&&c.state!=='released')return runtimeValue(c);throw fail('Native source already has an unresolved Core reservation','WORK_NATIVE_HISTORY_BUSY');}
      const claimId='native-claim:'+hash([v.source.sourceKey,job.pluginId,job.jobId,run.id,v.descriptor.restoreId]),jobConfigHome=join(dataRoot,'work-host','runtime-profiles',hash(JSON.stringify([job.pluginId,job.jobId,run.id,'dsh'])).slice(0,40));
      let c={version:1,claimId,sourceKey:v.source.sourceKey,pluginId:job.pluginId,scope:copy(job.scope),jobId:job.jobId,runId:run.id,taskId:task.id,descriptor:v.descriptor,workspace:copy(run.workspace),jobConfigHome,state:'reserved',createdAt:Date.now()};
      const owner={version:1,claimId,pluginId:c.pluginId,jobId:c.jobId,runId:c.runId,sourceId:c.descriptor.sourceId,descriptorDigest:hash(c.descriptor),workspace:c.workspace},ownerPath=join(c.jobConfigHome,'AI-BUDDY-NATIVE-HISTORY.json');
      try{await save(ownerPath,owner,{exclusive:true});}catch(e){if(e.code!=='EEXIST')throw e;if(!same((await json(ownerPath)).value,owner))throw fail('Native history config belongs to another preparation','WORK_NATIVE_HISTORY_OWNER');}
      c.jobConfigOwner={path:ownerPath,sha256:hash(JSON.stringify(owner))};audit({type:'native-history-config-prepared',claimId,jobId:c.jobId,runId:c.runId});
      try{await save(claimFile(claimId),c,{exclusive:true});}catch(e){if(e.code!=='EEXIST')throw e;const existing=await load(claimFile(claimId));if(existing.state!=='reserved'||existing.pluginId!==c.pluginId||existing.jobId!==c.jobId||existing.runId!==c.runId||!same(existing.descriptor,c.descriptor)||!same(existing.workspace,c.workspace)||!same(existing.jobConfigOwner,c.jobConfigOwner))throw fail('Native history durable preparation changed','WORK_NATIVE_HISTORY_OWNER');c=existing;}
      audit({type:'native-history-claim-prepared',claimId,jobId:c.jobId,runId:c.runId});
      // Only a complete claim/config can be published as active. Interrupted
      // preparation leaves an inert orphan, never an executable missing claim.
      await safeDirectory(dirname(activeFile(c.sourceKey)));await assertLive({job,run,context});await verifyApproval({job,context});const current=await unchanged(v.source);checkCommit(current.proofFiles);
      await save(activeFile(c.sourceKey),{version:1,claimId,jobId:c.jobId,runId:c.runId,pluginId:c.pluginId},{exclusive:true});audit({type:'native-history-reserved',claimId,jobId:c.jobId,runId:c.runId});return runtimeValue(c);
    });
  }
  async function ownedClaim({job,context,runId,claimId,cleanup=false}){const {run,task}=await runFor(job,context,runId,{cleanup}),c=await load(claimFile(claimId));if(c.version!==1||c.claimId!==claimId||c.pluginId!==job.pluginId||c.jobId!==job.jobId||c.runId!==run.id||!equalScope(c.scope,job.scope)||!same(c.descriptor,run.nativeHistoryRestore))throw fail('Native history claim belongs to another run','WORK_NATIVE_HISTORY_SCOPE');const active=await load(activeFile(c.sourceKey));if(active.claimId!==claimId)throw fail('Native history reservation changed','WORK_NATIVE_HISTORY_BUSY');return {run,task,c};}
  async function runtimeFor({job,context,runId}){const run=readEntity(job.pluginId,'engine_runs',runId);if(job.phase!=='execution'||!run?.nativeHistoryRestore)return null;const marker=await load(activeFile((await source(run.nativeHistoryRestore.sourceId,context)).sourceKey)),a=await ownedClaim({job,context,runId,claimId:marker.claimId});if(a.c.state!=='reserved')throw fail('Native session initialization must have an unconsumed reservation');await checkedDescriptor({context,task:a.task,plan:planFor(job,a.task)});const owner=await json(a.c.jobConfigOwner.path);if(owner.sha256!==a.c.jobConfigOwner.sha256||owner.value.claimId!==a.c.claimId||owner.value.jobId!==job.jobId||owner.value.runId!==runId||!samePath(dirname(a.c.jobConfigOwner.path),a.c.jobConfigHome))throw fail('Native history job config ownership changed','WORK_NATIVE_HISTORY_OWNER');return runtimeValue(a.c);}
  async function observedProcesses(job,run,sdkPid){const rows=job.nativeProcesses?.get(run.id)??[],sdk=rows.find(p=>p.pid===sdkPid),parent=sdk&&rows.find(p=>p.pid===sdk.parentPid);if(!sdk||!parent||![sdk,parent].every(p=>p.registered===true&&p.guardProof?.ready===true&&p.jobId===job.jobId&&p.runId===run.id&&p.nativeHostInstanceId===job.nativeHostInstanceId)||sdk.exeSha256!==run.bindingSnapshot.hostRuntime?.executableSha256)throw fail('Native resume has no registered SDK carrier','WORK_NATIVE_HISTORY_PROCESS');for(const p of [parent,sdk]){const actual=await supervisor.inspectOwned({runtimeId:job.nativeHostInstanceId,pid:p.pid});if(actual.pid!==p.pid||actual.creationTime!==p.creationTime||actual.parentPid!==p.parentPid||actual.exeSha256!==p.exeSha256||!samePath(actual.exeRealPath,p.exeRealPath))throw fail('Native resume process identity changed','WORK_NATIVE_HISTORY_PROCESS');}return [parent,sdk].map(p=>({pid:p.pid,parentPid:p.parentPid,creationTime:p.creationTime,exeSha256:p.exeSha256,guardId:p.guardProof.guardId}));}
  async function prefix(c){const r=await load(sourceFile(c.descriptor.sourceId)),s=await snapshot(c.pluginId,r.path),n=c.descriptor.nativeUsageCursor.eventCount;if(s.profileIdentityHash!==r.profileIdentityHash||s.ownerSha256!==r.ownerSha256||hash(s.native.header)!==r.headerSha256||s.native.header.id!==r.nativeSessionId||s.native.events.length<n||hash(s.native.events.slice(0,n))!==r.nativeUsageCursor.prefixSha256)throw fail('Native resume altered the historical prefix','WORK_NATIVE_HISTORY_CHANGED');if(c.confirmedPrefix&&(s.native.events.length<c.confirmedPrefix.eventCount||hash(s.native.events.slice(0,c.confirmedPrefix.eventCount))!==c.confirmedPrefix.prefixSha256))throw fail('Native restore metadata prefix changed after confirmation','WORK_NATIVE_HISTORY_CHANGED');for(const f of r.closure)if(f.path!==basename(r.path)&&!s.closure.some(now=>same(now,f)))throw fail('Native session attachment changed before resume','WORK_NATIVE_HISTORY_CHANGED');if(s.closure.some(f=>!r.closure.some(old=>old.path===f.path)))throw fail('Unknown native session content appeared after approval','WORK_NATIVE_HISTORY_CHANGED');return s;}
  function assertBeforePrompt(c,s){
    const invalid=()=>{throw fail('Native initialization differs from the exact approved metadata projection','WORK_NATIVE_HISTORY_PREMATURE');};
    const shape=(value,allowed,required=allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(value,k));
    const queues={'next-step':[],'next-turn':[]},seenIds=new Set();let cwd=s.native.header.cwd;
    function splice(data){
      if(!shape(data,['target','start','removedCount','inserted','outcome'],['target','start','inserted'])||!Object.hasOwn(queues,data.target)||!Array.isArray(data.inserted)||!Number.isSafeInteger(data.start)||data.start<0||data.outcome!==undefined&&data.outcome!=='canceled')invalid();
      const before=queues[data.target],removed=data.removedCount??0;
      if(!Number.isSafeInteger(removed)||removed<0||data.start>before.length||data.start+removed>before.length)invalid();
      for(const message of data.inserted)if(!message||typeof message!=='object'||Array.isArray(message)||!id(message.id)||message.role!=='user'||!Array.isArray(message.content)||!message.source||typeof message.source.kind!=='string')invalid();
      const next=before.toSpliced(data.start,removed,...data.inserted),pending=data.target==='next-step'?[...next,...queues['next-turn']]:[...queues['next-step'],...next];
      if(new Set(pending.map(message=>message.id)).size!==pending.length)invalid();
      queues[data.target]=next;for(const message of data.inserted)seenIds.add(message.id);
    }
    const boundary=c.descriptor.nativeUsageCursor.eventCount,prefix=s.native.events.slice(0,boundary),tail=s.native.events.slice(boundary);
    // Fold the complete approved prefix: a failed prior initialization can
    // leave a private cwd while the immutable header still names the origin.
    for(const event of prefix){
      if(event.type==='working-directory/change'){if(!shape(event.data,['cwd'])||!isAbsolute(event.data.cwd??''))invalid();cwd=event.data.cwd;}
      else if(event.type==='agent/inbox/spliced')splice(event.data);
    }
    let previous=null,noticeId=null,cwdChanges=0,seedMarkers=0,expectedSeq=(prefix.at(-1)?.seq??-1)+1;
    for(const event of tail){
      if(event.seq!==expectedSeq++)invalid();
      const data=event.data;
      if(event.type==='session/end-seed'){
        if(previous!==null||++seedMarkers!==1||!shape(data,[]))invalid();
      }else if(event.type==='model/selection'){
        const binding=readEntity(c.pluginId,'engine_runs',c.runId)?.bindingSnapshot;
        if(!binding||!shape(data,['provider','model','reasoningEffort'],['provider','model'])||data.provider!==binding.provider||data.model!==binding.model||(data.reasoningEffort??null)!==(binding.effort??null))invalid();
      }else if(event.type==='working-directory/change'){
        if(++cwdChanges!==1||!shape(data,['cwd'])||!isAbsolute(data.cwd??'')||!samePath(data.cwd,c.workspace.path))invalid();
        previous={type:event.type,from:cwd,to:data.cwd};cwd=data.cwd;continue;
      }else if(event.type==='agent/inbox/spliced'){
        if(!shape(data,['target','start','removedCount','inserted','outcome'],['target','start','inserted'])||data.target!=='next-step'||!Array.isArray(data.inserted))invalid();
        if(data.inserted.length===1){
          const message=data.inserted[0],text=previous?.type==='working-directory/change'?`The working directory changed from ${JSON.stringify(previous.from)} to ${JSON.stringify(previous.to)}.`:null;
          if(noticeId!==null||text===null||data.start!==queues['next-step'].length||(data.removedCount??0)!==0||data.outcome!==undefined||!shape(message,['id','role','source','content'])||!id(message.id)||seenIds.has(message.id)||message.role!=='user'||!shape(message.source,['kind'])||message.source.kind!=='working-directory'||!Array.isArray(message.content)||message.content.length!==1||!shape(message.content[0],['type','text'])||message.content[0].type!=='text'||message.content[0].text!==text)invalid();
          splice(data);noticeId=message.id;
        }else{
          // Disposal may cancel this initialization's notice. Never treat an
          // inbox claim or deletion of approved pending input as metadata.
          if(data.inserted.length!==0||noticeId===null||data.outcome!=='canceled'||data.removedCount!==1||data.start!==queues['next-step'].findIndex(message=>message.id===noticeId))invalid();
          splice(data);noticeId=null;
        }
      }else invalid();
      previous={type:event.type};
    }
  }
  async function registerRange(c,s,{closing=false}={}){const id='managed-'+hash(['dsh',resolve(s.path)]).slice(0,24),d=c.descriptor,workAttribution={schemaVersion:1,origin:'work-host-v1',pluginId:c.pluginId,jobId:c.jobId,taskId:c.taskId,runId:c.runId,memberId:readEntity(c.pluginId,'engine_runs',c.runId).memberId,nativeSessionId:d.nativeSessionId,nativeParentId:null,projectId:d.projectId,projectPath:d.projectPath,ownerScope:c.scope};const nativeHistoryRange={version:1,claimId:c.claimId,nativeSessionId:d.nativeSessionId,sourcePath:s.path,prefixSha256:d.nativeUsageCursor.prefixSha256,afterTurnExclusive:d.nativeUsageCursor.lastTurn,throughTurnInclusive:closing?s.native.cursor.lastTurn:null,workAttribution};return onRegisterUsageSource({id,engine:'dsh',path:s.path,format:'dsh-jsonl-generations',nativeSessionId:d.nativeSessionId,origin:'native-log',pluginId:c.pluginId,purpose:'work',nativeHistoryRange});}
  async function confirm({job,context,payload}){
    keys(payload,['runId','claimId','nativeSessionId','nativeProof']);
    return serial(payload.claimId,async()=>{
      const {run,c}=await ownedClaim({job,context,runId:payload.runId,claimId:payload.claimId}),p=payload.nativeProof;
      keys(p,['kind','sessionId','cwd','sourceProfileRoot','sessionPersistenceRoot','sdkChildPid','initialized','nativeLease']);
      if(p.kind!=='dsh-native-session-resume'||p.nativeLease!=='session-resume-write-handle'||p.sessionId!==c.descriptor.nativeSessionId||payload.nativeSessionId!==p.sessionId||!samePath(p.cwd,c.workspace.path)||!samePath(p.sourceProfileRoot,c.descriptor.sourceProfileRoot)||!samePath(p.sessionPersistenceRoot,c.descriptor.sessionPersistenceRoot)||p.initialized?.serverInfo?.name!=='deepseek-harness-sdk-runtime'||p.initialized.serverInfo.version!=='0.0.1')throw fail('Native resume result differs from the admitted source');
      const processes=await observedProcesses(job,run,p.sdkChildPid),s=await prefix(c);
      if(c.state==='reserved'){assertBeforePrompt(c,s);const cwd=s.native.events.slice(c.descriptor.nativeUsageCursor.eventCount).findLast(e=>e.type==='working-directory/change')?.data?.cwd;if(!samePath(cwd,c.workspace.path))throw fail('Native log has not confirmed the private working directory','WORK_NATIVE_HISTORY_CWD_UNCONFIRMED');}else if(c.state!=='confirmed'||!same(c.processes,processes))throw fail('Native history confirmation changed its owner');
      await assertLive({job,run,context});await verifyApproval({job,context});checkCommit(s.proofFiles);
      // Issuance is durable before the asynchronous monitor callback. A failed
      // acknowledgement never enables prompting, and cleanup must seal even a
      // partially acknowledged accounting range after actual OS0.
      c.processes=processes;c.accountingRangeIssued=true;await save(claimFile(c.claimId),c);
      const usageSource=await registerRange(c,s);
      await assertLive({job,run,context});await verifyApproval({job,context});
      const current=await prefix(c);if(c.state==='reserved')assertBeforePrompt(c,current);checkCommit(current.proofFiles);
      const marker=await load(activeFile(c.sourceKey));if(marker.claimId!==c.claimId)throw fail('Native reservation changed during confirmation');
      c.state='confirmed';c.confirmedPrefix={eventCount:current.native.events.length,prefixSha256:hash(current.native.events)};c.confirmedAt??=Date.now();await save(claimFile(c.claimId),c);
      return {confirmed:true,claimId:c.claimId,nativeSessionId:c.descriptor.nativeSessionId,nativeUsageCursor:copy(c.descriptor.nativeUsageCursor),usageSource};
    });
  }
  async function assertConfirmed({job,context,runId}){const run=readEntity(job.pluginId,'engine_runs',runId);if(!run?.nativeHistoryRestore||job.phase!=='execution')return;const marker=await load(activeFile((await source(run.nativeHistoryRestore.sourceId,context)).sourceKey)),a=await ownedClaim({job,context,runId,claimId:marker.claimId});if(a.c.state!=='confirmed')throw fail('Native history must be genuinely resumed before prompting','WORK_NATIVE_HISTORY_UNCONFIRMED');await observedProcesses(job,run,a.c.processes.at(-1).pid);await prefix(a.c);}
  async function release({job,context,payload}){keys(payload,['runId','claimId']);if(!payload.claimId){const {run}=await runFor(job,context,payload.runId,{cleanup:true}),r=await source(run.nativeHistoryRestore.sourceId,context);try{const active=await load(activeFile(r.sourceKey));payload={...payload,claimId:active.claimId};}catch(e){if(e.code!=='ENOENT')throw e;const proof=await supervisor.awaitStopped({jobId:job.jobId,runId:run.id});if(proof.stopped!==true||proof.osActiveProcesses!==0||proof.unconfirmed?.length||job.nativeSpawnAdmitted?.has(run.id)&&!(proof.registered>0))throw fail('Unused history cleanup requires real OS0','WORK_PROCESS_STOP_UNCONFIRMED');return {released:true,empty:true,stopped:true,osActiveProcesses:0};}}return serial(payload.claimId,async()=>{const saved=await load(claimFile(payload.claimId));if(saved.state==='released'){if(saved.pluginId!==job?.pluginId||saved.jobId!==job?.jobId||saved.runId!==payload.runId||!equalScope(saved.scope,ownerScope(context)))throw fail('Released history claim belongs to another owner');const cleanup=await finishReleased(saved,context);return {released:true,stopped:true,osActiveProcesses:0,...cleanup};}const {c}=await ownedClaim({job,context,runId:payload.runId,claimId:payload.claimId,cleanup:true}),proof=await supervisor.awaitStopped({jobId:c.jobId,runId:c.runId});if(proof.stopped!==true||proof.osActiveProcesses!==0||proof.alive?.length||proof.unconfirmed?.length||(c.state==='confirmed'||job.nativeSpawnAdmitted?.has(c.runId))&&!(proof.registered>0))throw fail('Native history claim requires actual subtree OS0','WORK_PROCESS_STOP_UNCONFIRMED');const s=await prefix(c);if(c.state==='confirmed'||c.accountingRangeIssued)await registerRange(c,s,{closing:true});checkCommit(s.proofFiles);c.releasedSource={version:1,sourceDigest:hash(sourceSummary(s)),nativeUsageCursor:copy(s.native.cursor),nativeTerminal:s.native.terminal,authorization:{taskGeneration:job.taskGeneration,planRevision:job.planRevision,planHash:job.planHash,approvalHash:job.approvalHash,nativeHostInstanceId:job.nativeHostInstanceId}};c.state='released';c.releasedAt=Date.now();c.stopProof={stopped:true,osActiveProcesses:0,registered:proof.registered??0};await save(claimFile(c.claimId),c);audit({type:'native-history-release-committed',claimId:c.claimId,jobId:c.jobId,runId:c.runId});await finishReleased(c,context);return {released:true,stopped:true,osActiveProcesses:0};});}
  return {discoveryRoots,inspect,prepare,validateApproval,claim,runtimeFor,confirm,assertConfirmed,release};
}
