import {createHash} from 'node:crypto';
import {lstat,realpath,open,readdir,mkdir} from 'node:fs/promises';
import {constants,lstatSync,realpathSync,readdirSync} from 'node:fs';
import {resolve,join,dirname,relative,isAbsolute,sep,basename} from 'node:path';

const fail=(message,code='WORK_NATIVE_SOURCE_DENIED')=>Object.assign(Error(message),{code});
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
const hash=value=>createHash('sha256').update(Buffer.isBuffer(value)||typeof value==='string'?value:canonical(value)).digest('hex');
const same=(a,b)=>canonical(a)===canonical(b);
const pathKey=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&pathKey(a)===pathKey(b);
const inside=(root,path)=>{const value=relative(resolve(root),resolve(path));return !value||!isAbsolute(value)&&value!=='..'&&!value.startsWith('..'+sep);};
const id=value=>typeof value==='string'&&value.length>0&&value.length<=500&&!value.includes('\0');
const sid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const scopeFields=['characterId','personaId','lifeId','operationId'];
const equalScope=(a,b)=>scopeFields.every(key=>id(a?.[key])&&a[key]===b?.[key]);
const statKey=value=>['dev','ino','nlink','size','mtimeNs','ctimeNs'].map(key=>String(value[key])).join(':');
const fileKey=value=>['dev','ino','nlink','size','mtimeNs','ctimeNs'].map(key=>String(value[key])).join(':');
const allowed=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw fail('Native log source accepts only opaque identity fields');};

async function noLinks(path){
  let cursor=resolve(path);
  for(;;){const info=await lstat(cursor);if(info.isSymbolicLink())throw fail('Native log paths cannot contain linked ancestors','WORK_NATIVE_SOURCE_LINK');const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}
  return realpath(path);
}
async function noLinkedExistingAncestor(path){
  let cursor=resolve(path);for(;;){try{await lstat(cursor);await noLinks(cursor);return;}catch(error){if(error.code!=='ENOENT')throw error;}const parent=dirname(cursor);if(parent===cursor)throw fail('Native metadata has no verified existing parent');cursor=parent;}
}
async function stableFile(path,{maximum=16*1024*1024,headerOnly=false}={}){
  await noLinks(path);const before=await lstat(path,{bigint:true});
  if(!before.isFile()||before.nlink!==1n||!headerOnly&&before.size>BigInt(maximum))throw fail('Native metadata must be a bounded regular file with one link','WORK_NATIVE_SOURCE_LINK');
  const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const opened=await handle.stat({bigint:true});if(statKey(opened)!==statKey(before))throw fail('Native source changed while opening','WORK_NATIVE_SOURCE_CHANGED');
    let bytes;if(headerOnly){bytes=Buffer.alloc(Math.min(maximum,Number(opened.size)));const read=await handle.read(bytes,0,bytes.length,0);bytes=bytes.subarray(0,read.bytesRead);}else bytes=await handle.readFile();
    const after=await handle.stat({bigint:true}),pathAfter=await lstat(path,{bigint:true});
    if(statKey(opened)!==statKey(after)||statKey(after)!==statKey(pathAfter))throw fail('Native source changed while reading','WORK_NATIVE_SOURCE_CHANGED');
    return {bytes,statKey:statKey(after),bytesRead:bytes.length,size:Number(after.size),sha256:hash(bytes)};
  }finally{await handle.close();}
}
async function jsonFile(path,options){const value=await stableFile(path,options);let json;try{json=JSON.parse(value.bytes.toString('utf8'));}catch{throw fail('Invalid native ownership metadata');}return {...value,json};}

/** Exact profileFor identity; no credential body or global account is read. */
export function workNativeProfileIdentity(run){const binding=run.bindingSnapshot;return {scope:run.scope,taskId:run.taskId,memberId:run.memberId,bindingFingerprint:binding.fingerprint,bindingSnapshot:binding,engine:binding.engine,projectId:run.project?.id??null,projectRootIdentity:run.project?.rootIdentity??null,workspace:{id:run.workspace.id,path:resolve(run.workspace.path)}};}

async function ownedProfile({dataRoot,pluginId,run}){
  const base=join(dataRoot,'ep',hash(pluginId).slice(0,12));await noLinks(base);
  const source=await jsonFile(join(base,'source-owner-v1.json'),{maximum:65536});
  if(source.json.schemaVersion!==1||source.json.pluginId!==pluginId)throw fail('Private profile has another installed source owner');
  const baseReal=await realpath(base),identity=workNativeProfileIdentity(run),identityHash=hash(identity),profileRoot=join(baseReal,'claude',identityHash);
  await noLinks(profileRoot);if(!samePath(await realpath(profileRoot),profileRoot))throw fail('Private profile resolves outside its exact owner','WORK_NATIVE_SOURCE_LINK');
  const owner=await jsonFile(join(profileRoot,'AI-BUDDY-BINDING.json'),{maximum:1024*1024});
  if(!same(owner.json,identity)||hash(owner.json)!==identityHash)throw fail('Private profile owner differs from the persisted full run identity');
  return {profileRoot,profileIdentityHash:identityHash,ownerSha256:owner.sha256,sourceOwnerSha256:source.sha256,ownerFileIdentity:owner.statKey,sourceOwnerFileIdentity:source.statKey};
}

function verifyCommitIdentity(located){
  // All asynchronous authority work has finished. Recheck path/owner identities
  // synchronously immediately before dispatching the private worker message.
  const checkPath=path=>{let cursor=resolve(path);for(;;){if(lstatSync(cursor).isSymbolicLink())throw fail('Native path was replaced by a link','WORK_NATIVE_SOURCE_CHANGED');const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}};
  checkPath(located.path);if(!samePath(realpathSync(located.path),located.path)||statKey(lstatSync(located.path,{bigint:true}))!==located.proof.fileIdentity)throw fail('Native log changed at the source commit boundary','WORK_NATIVE_SOURCE_CHANGED');
  for(const [path,identity] of [[join(located.profileRoot,'AI-BUDDY-BINDING.json'),located.ownerFileIdentity],[join(dirname(dirname(located.profileRoot)),'source-owner-v1.json'),located.sourceOwnerFileIdentity]]){checkPath(path);if(statKey(lstatSync(path,{bigint:true}))!==identity)throw fail('Native owner changed at the source commit boundary','WORK_NATIVE_SOURCE_CHANGED');}
  const projects=join(located.profileRoot,'projects'),entries=readdirSync(projects,{withFileTypes:true});if(entries.length>4096)throw fail('Native source enumeration changed');let count=0;
  for(const entry of entries){const directory=join(projects,entry.name);if(entry.isSymbolicLink())throw fail('Native project became linked','WORK_NATIVE_SOURCE_CHANGED');if(!entry.isDirectory())continue;checkPath(directory);try{const candidate=join(directory,located.nativeSessionId+'.jsonl');lstatSync(candidate);if(!samePath(candidate,located.path))throw fail('Native SID became ambiguous at commit','WORK_NATIVE_SOURCE_AMBIGUOUS');count++;}catch(error){if(error.code!=='ENOENT')throw error;}}
  if(count!==1)throw fail('Native source disappeared at commit','WORK_NATIVE_SOURCE_CHANGED');
}

/** Bounded native enumeration, never a CLI slug implementation or global scan. */
export async function locateClaudeNativeSource({dataRoot,pluginId,run,nativeSessionId,beforeRead}={}){
  if(!/^dsh\.[a-f0-9]{16,64}$/.test(pluginId??'')||!sid(nativeSessionId)||run?.bindingSnapshot?.engine!=='claude'||!id(run.workspace?.id)||!isAbsolute(run.workspace?.path??''))throw fail('An exact persisted Claude run and SID are required');
  const owner=await ownedProfile({dataRoot,pluginId,run}),projects=join(owner.profileRoot,'projects');let dirs;
  try{await noLinks(projects);dirs=await readdir(projects,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return {status:'pending',registered:false,nativeSessionId,reason:'native-log-not-created-yet',...owner};throw error;}
  if(dirs.length>4096)throw fail('Private native project enumeration exceeds its bounded scope');
  const beforeDirectory=await lstat(projects,{bigint:true}),names=dirs.map(row=>row.name).sort(),matches=[];
  for(const entry of dirs){
    const directory=join(projects,entry.name);if(entry.isSymbolicLink())throw fail('Native project directory is linked','WORK_NATIVE_SOURCE_LINK');if(!entry.isDirectory())continue;
    await noLinks(directory);if(!inside(owner.profileRoot,await realpath(directory)))throw fail('Native project directory escaped its private profile');
    const path=join(directory,nativeSessionId+'.jsonl');let info;try{info=await lstat(path,{bigint:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(info.isSymbolicLink()||!info.isFile()||info.nlink!==1n)throw fail('Native session source must be a regular file with one link','WORK_NATIVE_SOURCE_LINK');matches.push(path);
  }
  if(matches.length>1)throw fail('Native SID has multiple files in its private profile','WORK_NATIVE_SOURCE_AMBIGUOUS');
  if(!matches.length)return {status:'pending',registered:false,nativeSessionId,reason:'native-log-not-created-yet',...owner};
  const path=matches[0];await beforeRead?.({path});const header=await stableFile(path,{maximum:2*1024*1024,headerOnly:true});
  const expectedCwd=await noLinks(run.workspace.path),claims=[];
  for(const line of header.bytes.toString('utf8').split('\n').slice(0,128)){
    if(!line.trim())continue;let record;try{record=JSON.parse(line);}catch{continue;}
    if(record.sessionId!=null||record.cwd!=null){
      if(record.sessionId!=null&&record.sessionId!==nativeSessionId)throw fail('Native header SID differs from the persisted run','WORK_NATIVE_SOURCE_IDENTITY');
      if(record.cwd!=null&&(!isAbsolute(record.cwd)||!samePath(await noLinks(record.cwd),expectedCwd)))throw fail('Native header cwd differs from the persisted workspace','WORK_NATIVE_SOURCE_IDENTITY');
      claims.push({sessionId:record.sessionId??null,cwd:record.cwd??null,type:record.type??null});
    }
  }
  if(!claims.some(row=>row.sessionId===nativeSessionId&&row.cwd))throw fail('Native file has no bounded matching SID and cwd header','WORK_NATIVE_SOURCE_HEADER_UNCONFIRMED');
  const afterNames=(await readdir(projects)).sort(),afterDirectory=await lstat(projects,{bigint:true});
  if(!same(names,afterNames)||fileKey(beforeDirectory)!==fileKey(afterDirectory))throw fail('Native project directories changed during discovery','WORK_NATIVE_SOURCE_CHANGED');
  // Detect another exact SID created in an existing sibling during header reads.
  for(const entry of dirs){if(!entry.isDirectory())continue;const candidate=join(projects,entry.name,nativeSessionId+'.jsonl');if(samePath(candidate,path))continue;try{await lstat(candidate);throw fail('Native SID appeared in another project directory','WORK_NATIVE_SOURCE_AMBIGUOUS');}catch(error){if(error.code!=='ENOENT')throw error;}}
  const ownerAfter=await ownedProfile({dataRoot,pluginId,run});if(!same(owner,ownerAfter))throw fail('Native profile source changed while locating its log','WORK_NATIVE_SOURCE_CHANGED');
  const afterFile=await lstat(path,{bigint:true});if(fileKey(afterFile)!==header.statKey)throw fail('Native log changed before admission','WORK_NATIVE_SOURCE_CHANGED');
  return {status:'located',registered:false,engine:'claude',nativeSessionId,path:await realpath(path),logPath:await realpath(path),...owner,
    proof:{version:1,fileIdentity:header.statKey,fileSize:header.size,headerBytes:header.bytesRead,headerSha256:header.sha256,claimsSha256:hash(claims),canonicalCwd:expectedCwd,profileIdentityHash:owner.profileIdentityHash,ownerSha256:owner.ownerSha256}};
}

/** Durable Core/Windows JobObject receipts only: zero inspection/runtime spawn. */
export async function verifyClosedNativeRun({dataRoot,run}){
  const pending=reason=>({stopped:false,status:'pending-stop-proof',reason,spawned:false});
  const exit=run.exitProof,osProof=exit?.supervisorProof??exit;
  // Current native drivers retain the actual supervisor proof under the close
  // receipt; earlier direct OS proofs can also be read without changing data.
  if(!['completed','failed','cancelled','paused-recoverable'].includes(run.state)||run.exited!==true||exit?.ownedChildrenStopped!==true||exit?.exited===false||osProof?.stopped!==true||osProof?.osActiveProcesses!==0)return pending('persisted-run-has-no-final-os0');
  let state;try{state=await jsonFile(join(dataRoot,'work-host','owned-processes.json'));}catch(error){if(error.code==='ENOENT')return pending('core-owned-process-records-not-materialized');throw error;}
  if(state.json.version!==1||!Array.isArray(state.json.records))throw fail('Unknown Core native process ownership format');
  const rows=state.json.records?.filter(row=>row.jobId===run.jobId&&row.runId===run.id)??[];
  if(!rows.length)return pending('no-core-owned-process-record-for-run');
  const proofs=[];
  for(const row of rows){
    const proof=row.guardProof,root=join(dataRoot,'work-host','guard-receipts');
    if(!sid(proof?.guardId)||proof.ready!==true||!Number.isSafeInteger(row.pid)||row.pid<=0||!/^\d+$/.test(String(row.creationTime??''))||!Number.isSafeInteger(proof.ownerPid)||proof.ownerPid<=0||!/^\d+$/.test(String(proof.ownerCreationTime??''))||!isAbsolute(proof.receiptPath??'')||!inside(root,proof.receiptPath)||!samePath(dirname(resolve(proof.receiptPath)),root)||basename(proof.receiptPath)!==proof.guardId+'.json')throw fail('Core native stop receipt has another proof owner');
    let receipt;try{receipt=await jsonFile(proof.receiptPath,{maximum:65536});}catch(error){if(error.code==='ENOENT')return pending('durable-helper-stop-receipt-not-materialized');throw error;}
    const value=receipt.json;
    if(value.schemaVersion!==1||value.guardId!==proof.guardId||value.ownerPid!==proof.ownerPid||String(value.ownerCreationTime)!==String(proof.ownerCreationTime)||value.rootPid!==row.pid||String(value.rootCreationTime)!==String(row.creationTime)||value.activeProcesses!==0)throw fail('Durable stop receipt does not prove the exact admitted subtree','WORK_NATIVE_SOURCE_STOP_UNCONFIRMED');
    if(!/^[a-f0-9]{64}$/.test(proof.guardExeSha256??'')||!isAbsolute(proof.guardExePath??''))throw fail('Core stop receipt lacks its captured guard image');
    const image=await stableFile(proof.guardExePath,{maximum:16*1024*1024});if(image.sha256!==proof.guardExeSha256)throw fail('Captured native guard image changed');
    proofs.push({guardId:proof.guardId,rootPid:row.pid,rootCreationTime:String(row.creationTime),receiptSha256:receipt.sha256,guardSha256:image.sha256});
  }
  return {stopped:true,status:'stopped',osActiveProcesses:0,registered:rows.length,proofs,spawned:false};
}

/** Core authority, independent of Work installation/activation and native runtime. */
export function createWorkNativeUsageSources({dataRoot,readEntity,getCurrentScope,onRegisterUsageSource,assertActive=async()=>{},audit=()=>{},verifyStopped=verifyClosedNativeRun,locate=locateClaudeNativeSource}={}){
  if(typeof readEntity!=='function'||typeof getCurrentScope!=='function'||typeof onRegisterUsageSource!=='function')throw TypeError('Core readonly entity, viewer and source-registration callbacks are required');
  const inflight=new Map();
  const currentOwner=()=>{const value=getCurrentScope();if(value?.then)throw fail('The current Core owner scope must be synchronous','WORK_SCOPE_DENIED');return value;};
  async function registry(){
    // This store is journaled snapshots, not a mutable logical .json file. Read
    // its actual latest committed member each time; never use a cached fallback
    // after a damaged or replaced latest authority record.
    const root=join(dataRoot,'managed-work-sources-v1.json.snapshots'),journal=await stableFile(join(root,'commits.jsonl'));
    const text=journal.bytes.toString('utf8'),complete=text.slice(0,text.lastIndexOf('\n')+1),commits=[];
    for(const line of complete.split('\n')){
      if(!line.trim())continue;let row;try{row=JSON.parse(line);}catch{throw fail('A completed protected authority journal line is malformed','WORK_NATIVE_SOURCE_CHANGED');}
      if(!row||typeof row.file!=='string'||basename(row.file)!==row.file||!/^([^/\\\0]+)\.json$/.test(row.file)||!/^[a-f0-9]{64}$/.test(row.sha256??'')||typeof row.timestamp!=='string'||!Number.isFinite(Date.parse(row.timestamp)))throw fail('A completed protected authority journal record is invalid','WORK_NATIVE_SOURCE_CHANGED');commits.push(row);
    }
    const latest=commits.at(-1);if(!latest)throw fail('Protected managed registry has no committed authority snapshot');
    const value=await jsonFile(join(root,latest.file));if(value.sha256!==latest.sha256||value.json.version!==1||!Array.isArray(value.json.sources))throw fail('Protected managed source snapshot identity changed','WORK_NATIVE_SOURCE_CHANGED');
    const after=await lstat(join(root,'commits.jsonl'),{bigint:true});if(fileKey(after)!==journal.statKey)throw fail('Protected managed registry changed while reading','WORK_NATIVE_SOURCE_CHANGED');
    return {...value,journalSha256:journal.sha256};
  }
  const pendingId=(pluginId,runId,nativeSessionId)=>'pending-native-'+hash([pluginId,runId,nativeSessionId]).slice(0,24);
  async function pendingRecord(sourceId){
    const value=await jsonFile(join(dataRoot,'work-host','pending-native-sources',sourceId+'.json'),{maximum:1024*1024}),row=value.json;
    allowed(row,['schemaVersion','kind','origin','sourceId','pluginId','runId','nativeSessionId','profileIdentityHash','workAttribution']);
    if(row.schemaVersion!==1||row.kind!=='pending-native-source'||row.origin!=='work-host-v1'||row.sourceId!==sourceId||!/^dsh\.[a-f0-9]{16,64}$/.test(row.pluginId??'')||!id(row.runId)||!sid(row.nativeSessionId)||pendingId(row.pluginId,row.runId,row.nativeSessionId)!==sourceId)throw fail('Pending native source has no exact Core identity');
    return {sourceId,tool:'claude',pending:true,workAttribution:row.workAttribution,pendingProfileIdentityHash:row.profileIdentityHash,pendingRecordSha256:value.sha256};
  }
  async function sourceRecord(sourceId){
    if(sourceId.startsWith('pending-native-'))return pendingRecord(sourceId);
    const saved=await registry(),rows=saved.json.sources.filter(row=>row.sourceId===sourceId);if(rows.length!==1)throw fail('Managed accounting source is missing or ambiguous');return rows[0];
  }
  async function capturePending(value){
    const nativeSessionId=value.run.nativeSessionId,sourceId=pendingId(value.pluginId,value.run.id,nativeSessionId),row={schemaVersion:1,kind:'pending-native-source',origin:'work-host-v1',sourceId,pluginId:value.pluginId,runId:value.run.id,nativeSessionId,profileIdentityHash:hash(workNativeProfileIdentity(value.run)),workAttribution:attributed(value,nativeSessionId)},root=join(dataRoot,'work-host','pending-native-sources'),path=join(root,sourceId+'.json');
    await noLinks(dataRoot);await noLinkedExistingAncestor(root);await mkdir(root,{recursive:true});await noLinks(root);
    try{const handle=await open(path,'wx',0o600);try{await handle.writeFile(JSON.stringify(row));await handle.sync();}finally{await handle.close();}}catch(error){if(error.code!=='EEXIST')throw error;const prior=await jsonFile(path,{maximum:1024*1024});if(!same(prior.json,row))throw fail('Pending native source already belongs to another captured identity','WORK_NATIVE_SOURCE_CHANGED');}
    return sourceId;
  }
  function admission(pluginId,runId){
    const run=readEntity(pluginId,'engine_runs',runId),task=run&&readEntity(pluginId,'tasks',run.taskId),job=run&&readEntity(pluginId,'jobs',run.jobId),member=task?.team?.find(value=>value.id===run.memberId),project=task&&readEntity(pluginId,'projects',task.projectId);
    if(!run||run.id!==runId||run.kind==='validation-process'||run.bindingSnapshot?.engine!=='claude'||!task||!job||job.taskId!==task.id||run.taskId!==task.id||!member||!equalScope(member.scope,run.scope)||!same(member.engineBindingSnapshot,run.bindingSnapshot)||!project||run.project?.id!==project.id||run.project?.canonicalPath!==project.canonicalPath||run.taskGeneration!==task.generation||job.taskGeneration!==task.generation)throw fail('Native accounting identity differs from its persisted task, member or run');
    return {pluginId,run,task,job,member,project};
  }
  function attributed(value,sessionId){const {pluginId,run,task,member,project}=value;return {schemaVersion:1,origin:'work-host-v1',pluginId,jobId:jobId(value),taskId:task.id,runId:run.id,memberId:member.id,nativeSessionId:sessionId,nativeParentId:run.nativeParentId??null,projectId:project.id,projectPath:project.canonicalPath,ownerScope:structuredClone(member.scope)};}
  const jobId=value=>value.job.id;
  async function register(value,located,{originalSourceId=null,beforeCommit,commitCheck}={}){
    const id='managed-'+hash(['claude',resolve(located.path)]).slice(0,24),workAttribution=attributed(value,located.nativeSessionId);
    const after=admission(value.pluginId,value.run.id);if(!same(value,after))throw fail('Persisted accounting source changed before registration','WORK_NATIVE_SOURCE_CHANGED');
    const second=await locate({dataRoot,pluginId:value.pluginId,run:after.run,nativeSessionId:located.nativeSessionId});
    if(second.status!=='located'||!same(second.proof,located.proof)||!samePath(second.path,located.path))throw fail('Native source changed before trusted registration','WORK_NATIVE_SOURCE_CHANGED');
    await beforeCommit?.();commitCheck?.();verifyCommitIdentity(second);
    const receipt=await onRegisterUsageSource({id,engine:'claude',path:located.path,jobId:jobId(value),taskId:value.task.id,runId:value.run.id,memberId:value.member.id,projectId:value.project.id,workspace:{id:value.project.id,path:value.project.canonicalPath},pluginId:value.pluginId,purpose:'work',nativeSessionId:located.nativeSessionId,nativeParentId:value.run.nativeParentId??null,workAttribution});
    if(receipt?.registered!==true||receipt.sourceId&&receipt.sourceId!==id)throw fail('Core monitor did not confirm source registration','WORK_NATIVE_SOURCE_REGISTRATION_FAILED');
    const result={status:'registered',registered:true,sourceId:id,engine:'claude',nativeSessionId:located.nativeSessionId,path:located.path,logPath:located.path,origin:'native-log',proof:located.proof,...originalSourceId?{originalSourceId,accountingOnly:true,oldSourcePreserved:true}: {}};
    audit({type:'work-native-usage-source',phase:'registered',sourceId:id,originalSourceId,runId:value.run.id,nativeSessionId:located.nativeSessionId,headerSha256:located.proof.headerSha256});return result;
  }
  async function resolveActive({job,context,payload}){
    allowed(payload,['runId','nativeSessionId']);if(!job||job.stopped||job.pluginId!==context.pluginId||!id(payload.runId)||!sid(payload.nativeSessionId))throw fail('Native log resolution requires its live admitted job');
    const value=admission(job.pluginId,payload.runId);if(value.run.jobId!==job.jobId||value.run.taskId!==job.taskId||!job.members?.some(member=>member.id===value.member.id&&equalScope(member.scope,value.run.scope)&&same(member.engineBindingSnapshot,value.run.bindingSnapshot)))throw fail('Native source belongs to another live member');
    if(!value.run.nativeSessionId)return {status:'pending',registered:false,nativeSessionId:payload.nativeSessionId,reason:'awaiting-persisted-native-session'};
    if(value.run.nativeSessionId!==payload.nativeSessionId)throw fail('Native source SID differs from the admitted run','WORK_NATIVE_SOURCE_IDENTITY');
    const key=job.pluginId+'\0'+payload.runId+'\0'+payload.nativeSessionId;if(inflight.has(key))return inflight.get(key);
    const commitCheck=()=>{if(job.stopped||!same(value,admission(job.pluginId,payload.runId)))throw fail('Native run stopped or changed during log resolution','WORK_NATIVE_SOURCE_CHANGED');};
    const operation=(async()=>{const located=await locate({dataRoot,pluginId:job.pluginId,run:value.run,nativeSessionId:payload.nativeSessionId});if(located.status==='pending'){await assertActive({job,context});commitCheck();const pendingSourceId=await capturePending(value);commitCheck();return {status:'pending',registered:false,nativeSessionId:payload.nativeSessionId,reason:located.reason,pendingSourceId};}return register(value,located,{beforeCommit:()=>assertActive({job,context}),commitCheck});})();inflight.set(key,operation);try{return await operation;}finally{inflight.delete(key);}
  }
  async function reconcile(args={}){
    allowed(args,['sourceId','dryRun']);if(!/^(?:managed-|pending-native-)[a-f0-9]{24}$/.test(args.sourceId??'')||args.dryRun!=null&&typeof args.dryRun!=='boolean')throw fail('Reconciliation requires one existing opaque Core accounting source ID');
    const source=await sourceRecord(args.sourceId),expected=source.workAttribution;
    if(source.tool!=='claude'||expected?.schemaVersion!==1||expected.origin!=='work-host-v1'||!/^dsh\.[a-f0-9]{16,64}$/.test(expected.pluginId??'')||!id(expected.runId))throw fail('Only captured Core Claude managed sources can be reconciled');
    const value=admission(expected.pluginId,expected.runId),actual=attributed(value,value.run.nativeSessionId);
    const mismatchedSource=source.pending?source.pendingProfileIdentityHash!==hash(workNativeProfileIdentity(value.run)):!isAbsolute(source.path??'')||basename(source.path)!==value.run.nativeSessionId+'.jsonl'||source.sourceId!=='managed-'+hash(['claude',resolve(source.path)]).slice(0,24);
    if(!sid(value.run.nativeSessionId)||!same(expected,actual)||mismatchedSource)throw fail('Protected source differs from the persisted native run','WORK_NATIVE_SOURCE_IDENTITY');
    if(!equalScope(currentOwner(),value.task.scope))throw fail('Accounting source belongs to another current task owner','WORK_SCOPE_DENIED');
    const stopped=await verifyStopped({dataRoot,run:value.run});
    if(!stopped.stopped&&!args.dryRun)return {...stopped,registered:false,accountingOnly:true,sourceId:source.sourceId};
    const located=await locate({dataRoot,pluginId:value.pluginId,run:value.run,nativeSessionId:value.run.nativeSessionId});
    if(!source.pending&&!inside(join(located.profileRoot,'projects'),source.path))throw fail('The original source belongs to another private profile','WORK_NATIVE_SOURCE_IDENTITY');
    if(located.status==='pending')return {status:'pending',registered:false,accountingOnly:true,sourceId:source.sourceId,reason:located.reason,stopProof:stopped};
    if(!same(await sourceRecord(source.sourceId),source)||!equalScope(currentOwner(),value.task.scope))throw fail('Managed source or viewer changed before reconciliation','WORK_NATIVE_SOURCE_CHANGED');
    if(args.dryRun)return {...located,accountingOnly:true,dryRun:true,registered:false,originalSourceId:source.sourceId,proposedSourceId:'managed-'+hash(['claude',resolve(located.path)]).slice(0,24),stopProof:stopped};
    const confirmed=await verifyStopped({dataRoot,run:value.run});if(!confirmed.stopped)return {...confirmed,registered:false,accountingOnly:true,sourceId:source.sourceId};
    const commitCheck=()=>{if(!equalScope(currentOwner(),value.task.scope)||!same(value,admission(value.pluginId,value.run.id)))throw fail('Current accounting owner or run changed before registration','WORK_NATIVE_SOURCE_CHANGED');};
    const beforeCommit=async()=>{if(!same(await sourceRecord(source.sourceId),source))throw fail('Protected source changed at the accounting commit boundary','WORK_NATIVE_SOURCE_CHANGED');};
    return {...await register(value,located,{originalSourceId:source.sourceId,beforeCommit,commitCheck}),stopProof:confirmed};
  }
  return {resolveActive,reconcile};
}
