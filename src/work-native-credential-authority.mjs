import {createHash,randomUUID} from 'node:crypto';
import {lstat,realpath,open} from 'node:fs/promises';
import {resolve,join,dirname,isAbsolute} from 'node:path';
import {constants} from 'node:fs';

const fail=(message,code='WORK_NATIVE_CREDENTIAL_PROOF')=>Object.assign(Error(message),{code});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
const hash=value=>createHash('sha256').update(Buffer.isBuffer(value)||typeof value==='string'?value:canonical(value)).digest('hex');
const same=(a,b)=>canonical(a)===canonical(b);
const samePath=(a,b)=>(process.platform==='win32'?resolve(a).toLowerCase():resolve(a))===(process.platform==='win32'?resolve(b).toLowerCase():resolve(b));
const scopeFields=['characterId','personaId','lifeId','operationId'];
const equalScope=(a,b)=>scopeFields.every(key=>typeof a?.[key]==='string'&&a[key]===b?.[key]);
const id=value=>typeof value==='string'&&value.length>0&&value.length<=500&&!value.includes('\0');
const jid=job=>job?.jobId??job?.id;
const rid=run=>run?.runId??run?.id;
const keys=(value,allowed)=>{if(!plain(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fail('Unsupported native credential control body');};
async function noLinks(path){let cursor=resolve(path);for(;;){try{if((await lstat(cursor)).isSymbolicLink())throw fail('Native profile metadata cannot use linked paths','WORK_NATIVE_CREDENTIAL_LINK');}catch(error){if(error.code!=='ENOENT')throw error;}const parent=dirname(cursor);if(parent===cursor)return;cursor=parent;}}
const statIdentity=info=>['dev','ino','nlink','size','mtimeNs','ctimeNs'].map(key=>String(info[key])).join(':');
async function ownerMetadata(file,{allowMissing=false}={}){
  await noLinks(file);let before;try{before=await lstat(file,{bigint:true});}catch(error){if(allowMissing&&error.code==='ENOENT')return null;throw error;}
  if(!before.isFile()||before.nlink!==1n||before.size>1048576n)throw fail('Native owner file must be a bounded regular file with one link','WORK_NATIVE_CREDENTIAL_LINK');
  const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const opened=await handle.stat({bigint:true});if(statIdentity(opened)!==statIdentity(before))throw fail('Native owner file changed while opening');const bytes=await handle.readFile(),after=await handle.stat({bigint:true}),pathAfter=await lstat(file,{bigint:true});if(statIdentity(opened)!==statIdentity(after)||statIdentity(after)!==statIdentity(pathAfter))throw fail('Native owner file changed while reading');let identity;try{identity=JSON.parse(bytes.toString('utf8'));}catch{throw fail('Native owner file is not valid JSON');}return {identity,identityHash:hash(identity),fileHash:hash(bytes)};}finally{await handle.close();}
}
function expectedIdentity(run){const binding=run.bindingSnapshot;return {scope:run.scope,taskId:run.taskId,memberId:run.memberId,bindingFingerprint:binding.fingerprint,bindingSnapshot:binding,engine:binding.engine,projectId:run.project?.id??null,projectRootIdentity:run.project?.rootIdentity??null,workspace:{id:run.workspace.id,path:resolve(run.workspace.path)}};}
const processesFor=(job,runId)=>{const rows=job.nativeProcesses?.get?.(runId);return Array.isArray(rows)?rows:rows instanceof Map?[...rows.values()]:plain(rows)&&rows.pid?[rows]:[];};
const validProcess=process=>Number.isSafeInteger(process?.pid)&&process.pid>0&&id(process.creationTime)&&/^[a-f0-9]{64}$/.test(process.exeSha256??'')&&process.registered===true&&process.guardReady===true&&process.guardProof?.ready===true&&process.guardProof.rootPid===process.pid&&process.guardProof.rootCreationTime===process.creationTime;

/** Private Core authority. It reads only AI-BUDDY-BINDING.json metadata and
 * never global credentials, private credential bodies or model text. */
export function createWorkNativeCredentialAuthority({getRun,getJob,profileRootFor,supervisor,assertLive,verifyApproval,onProof=()=>{}}={}){
  if([getRun,getJob,profileRootFor,assertLive,verifyApproval].some(callback=>typeof callback!=='function')||!supervisor?.awaitStopped||!supervisor?.inspectOwned)throw TypeError('Private run, profile, approval and OS authority callbacks are required');
  const leases=new Map(),initializations=new Map(),byRun=new Map();let closed=false;
  function rememberLease(job,run,context,payload){
    const runId=rid(run),key=context.pluginId+'\0'+jid(job)+'\0'+runId,issued=job.nativeCredentialLeases?.get?.(runId),prior=leases.get(key);
    if(!issued||!id(issued.leaseId)||!id(issued.sourceKey)||!Number.isSafeInteger(issued.generation)||issued.generation<1||!['access-only','exclusive-refresh'].includes(issued.mode)||payload.leaseId&&payload.leaseId!==issued.leaseId)throw fail('No exact Core-issued credential lease belongs to this run','WORK_NATIVE_CREDENTIAL_LEASE');
    if(prior&&(prior.leaseId!==issued.leaseId||prior.sourceKey!==issued.sourceKey||prior.mode!==issued.mode||issued.generation<prior.generation||prior.bindingFingerprint!==run.bindingSnapshot.fingerprint))throw fail('Native credential custody cannot change owner, source or generation','WORK_NATIVE_CREDENTIAL_OWNER');
    const record=prior??{key,pluginId:context.pluginId,jobId:jid(job),runId,leaseId:issued.leaseId,sourceKey:issued.sourceKey,mode:issued.mode,bindingFingerprint:run.bindingSnapshot.fingerprint,nativeStarted:false,job,run:structuredClone(run)};
    record.generation=issued.generation;record.issued={...issued};record.job=job;record.nativeStarted ||=job.nativeSpawnAdmitted?.has?.(runId)===true||processesFor(job,runId).some(process=>process.processRole!=='inert-engine-launcher');leases.set(key,record);return record;
  }
  async function resolveAdmission({operation,job:inputJob,context,payload},cleanup=false){
    if(!plain(context)||!id(context.pluginId)||!plain(payload)||!id(payload.jobId)||!id(payload.runId)||payload.engine!=='claude'||!plain(payload.binding)||payload.binding.engine!=='claude'||payload.binding.accountRef!=='native:claude-default'||context.jobId&&context.jobId!==payload.jobId||jid(inputJob)!==payload.jobId)throw fail('Native credential operation does not match its Core job','WORK_NATIVE_CREDENTIAL_OWNER');
    const key=context.pluginId+'\0'+payload.jobId+'\0'+payload.runId,captured=leases.get(key),currentJob=await getJob({jobId:payload.jobId,pluginId:context.pluginId}),job=currentJob??(cleanup?captured?.job:null);
    if(!job||job.pluginId!==context.pluginId||jid(job)!==payload.jobId||!cleanup&&job.stopped)throw fail('Native credential job is not admitted','WORK_JOB_ADMISSION_REQUIRED');
    const run=await getRun({pluginId:context.pluginId,jobId:payload.jobId,runId:payload.runId})??(cleanup?captured?.run:null),member=run&&job.members?.find(value=>value.id===run.memberId);
    if(!run||rid(run)!==payload.runId||run.jobId!==jid(job)||run.taskId!==job.taskId||!member||!equalScope(run.scope,member.scope)||!same(run.bindingSnapshot,member.engineBindingSnapshot)||!same(payload.binding,run.bindingSnapshot)||!id(run.bindingSnapshot.fingerprint)||run.bindingSnapshot.engine!=='claude'||!run.workspace?.id||!isAbsolute(run.workspace.path??''))throw fail('Native credential run or binding changed','WORK_NATIVE_CREDENTIAL_OWNER');
    if(!cleanup){if(closed)throw fail('Native credential authority has closed');await assertLive({operation,job,run,context});if(job.phase==='execution')await verifyApproval({job,run,context});else if(job.phase!=='planning')throw fail('Unknown native credential execution phase');}
    const record=rememberLease(job,run,context,payload);if(cleanup&&captured&&captured.leaseId!==record.leaseId)throw fail('Cleanup cannot adopt another credential owner');if(!cleanup&&(record.closedAuthority||record.issued.status!=='active'))throw fail('A retired native credential lease cannot be reopened','WORK_NATIVE_CREDENTIAL_LEASE_CLOSED');return {job,run,context,record};
  }
  async function profile(admission,payload,{allowMissing=false}={}){
    const {job,run,context,record}=admission,base=await profileRootFor({job,run,context});if(!isAbsolute(base??''))throw fail('Expected private engine profile base is unavailable');await noLinks(base);const baseReal=await realpath(base),identity=expectedIdentity(run),identityHash=hash(identity),home=resolve(baseReal,'claude',identityHash);
    // profileFor can receive the Windows 8.3 spelling of this trusted base.
    // Accept only that derived spelling or its canonical spelling; never use a
    // caller-selected path as the source of identity or file reads.
    const baseSpellingHome=resolve(base,'claude',identityHash);
    if(payload.profileRoot!=null&&(!isAbsolute(payload.profileRoot)||!samePath(payload.profileRoot,home)&&!samePath(payload.profileRoot,baseSpellingHome)))throw fail('Credential body cannot choose a different private profile');
    await noLinks(home);const owner=await ownerMetadata(join(home,'AI-BUDDY-BINDING.json'),{allowMissing});
    if(owner&&(!same(owner.identity,identity)||owner.identityHash!==identityHash))throw fail('Actual owner file differs from the complete persisted run identity','WORK_NATIVE_CREDENTIAL_PROFILE');
    if(owner&&record.ownerFileHash&&record.ownerFileHash!==owner.fileHash)throw fail('Bound native owner metadata changed','WORK_NATIVE_CREDENTIAL_PROFILE');
    if(owner){const physical=await realpath(home);if(!samePath(physical,home))throw fail('Native profile resolved outside its expected path','WORK_NATIVE_CREDENTIAL_LINK');record.ownerFileHash=owner.fileHash;}
    return {profileRoot:home,profileIdentityHash:identityHash,ownerFileHash:owner?.fileHash??null,profileObserved:!!owner};
  }
  async function observedProcesses(admission){
    const {job,run}=admission,rows=processesFor(job,rid(run)),native=rows.filter(process=>process.processRole==='native-engine-child'&&validProcess(process)),wrappers=rows.filter(process=>process.processRole==='inert-engine-launcher'&&validProcess(process));
    if(native.length!==1||!wrappers.length)throw fail('Actual Core-registered native CLI and launcher proof are required');
    const cli=native[0],wrapper=wrappers.find(process=>process.pid===cli.parentPid);if(!wrapper||[wrapper,cli].some(process=>process.jobId!==jid(job)||process.runId!==rid(run)||process.nativeHostInstanceId!==job.nativeHostInstanceId)||cli.exeSha256!==run.bindingSnapshot.hostRuntime?.executableSha256)throw fail('Native process proof differs from its captured executable, run or parent');
    const actualWrapper=await supervisor.inspectOwned({runtimeId:job.nativeHostInstanceId,pid:wrapper.pid});if(actualWrapper.pid!==wrapper.pid||actualWrapper.parentPid!==wrapper.parentPid||actualWrapper.creationTime!==wrapper.creationTime||actualWrapper.exeSha256!==wrapper.exeSha256||!samePath(actualWrapper.exeRealPath,wrapper.exeRealPath))throw fail('Native launcher identity changed before SDK initialization');
    const actual=await supervisor.inspectOwned({runtimeId:job.nativeHostInstanceId,pid:cli.pid});if(actual.pid!==cli.pid||actual.parentPid!==wrapper.pid||actual.creationTime!==cli.creationTime||actual.exeSha256!==cli.exeSha256||!samePath(actual.exeRealPath,cli.exeRealPath))throw fail('Native CLI identity changed before SDK initialization');
    const expected=run.bindingSnapshot.hostRuntime?.binaryPath;if(expected&&!samePath(await realpath(expected),actual.exeRealPath))throw fail('Native CLI path differs from its approved binding');
    return [wrapper,cli].map(process=>({pid:process.pid,parentPid:process.parentPid,creationTime:process.creationTime,exeSha256:process.exeSha256,processRole:process.processRole,guardId:process.guardProof.guardId}));
  }
  async function initialization({job,context,payload}){
    keys(payload,['engine','jobId','runId','binding','nativeSessionId','nativeInitialization']);const control=payload.nativeInitialization;keys(control,['kind','sdkVersion','cliVersion','hooksApplied','credentialProtocol','requestedModel','modelEvidence']);
    if(!plain(payload.binding)||control.kind!=='claude-agent-sdk-control-initialize'||control.sdkVersion!=='0.3.296'||control.cliVersion!=='2.1.296'||control.hooksApplied!==true||control.credentialProtocol!==1||control.requestedModel!==payload.binding.model||control.modelEvidence!=='explicit-sdk-option-awaiting-native-init'||!id(payload.nativeSessionId))throw fail('Only the pinned native SDK control initialization is admitted');
    const admission=await resolveAdmission({operation:'native.initialization',job,context,payload}),{run,record}=admission;if(record.issued.profileBound!==true)throw fail('Native initialization requires a successfully bound Core credential profile');
    if(!/(?:^|\D)2\.1\.296(?:\D|$)/.test(run.bindingSnapshot.hostRuntime?.nativeVersion??''))throw fail('Captured CLI version differs from native SDK control initialization');
    if(run.nativeSessionId&&run.nativeSessionId!==payload.nativeSessionId)throw fail('Native initialization changed the persisted session');const metadata=await profile(admission,payload),processes=await observedProcesses(admission);record.nativeStarted=true;
    const previous=byRun.get(record.key);if(previous){const proof=initializations.get(previous);if(!same(proof.processes,processes)||proof.ownerFileHash!==metadata.ownerFileHash||proof.nativeSessionId!==payload.nativeSessionId)throw fail('This run already attested another native initialization');return {nativeInitializationProofRef:previous};}
    const proofRef='native-init:'+randomUUID(),proof={kind:'native-sdk-control-initialization',proofRef,pluginId:record.pluginId,jobId:record.jobId,runId:record.runId,leaseId:record.leaseId,sourceKey:record.sourceKey,bindingFingerprint:record.bindingFingerprint,...metadata,processes,nativeSessionId:payload.nativeSessionId,nativeSessionEvidence:run.nativeSessionId?'persisted-session-matched':'driver-requested-awaiting-native-system-init',nativeInitialization:structuredClone(control),modelConfirmed:false,createdAt:Date.now()};
    await onProof(structuredClone(proof));initializations.set(proofRef,proof);byRun.set(record.key,proofRef);return {nativeInitializationProofRef:proofRef};
  }
  async function credentialAuthority({operation,job,context,payload}){
    keys(payload,['leaseId','jobId','runId','engine','binding','profileRoot','phase','nativeInitializationProofRef','proofRef']);if(!['native.credentials.bind','native.credentials.update','native.credentials.release'].includes(operation))throw fail('Unknown native credential operation');
    if(operation!=='native.credentials.release'&&!id(payload.leaseId))throw fail('An exact Core-issued credential lease ID is required','WORK_NATIVE_CREDENTIAL_LEASE');
    if(payload.proofRef&&payload.nativeInitializationProofRef&&payload.proofRef!==payload.nativeInitializationProofRef)throw fail('Conflicting native initialization references');
    const cleanup=operation==='native.credentials.release'||operation==='native.credentials.update'&&payload.phase==='closed',admission=await resolveAdmission({operation,job,context,payload},cleanup),{record,run}=admission;
    if(operation==='native.credentials.bind'){
      if(payload.phase!=null&&payload.phase!=='pre-spawn'||record.nativeStarted)throw fail('Native credential binding must precede any admitted CLI launch');const metadata=await profile(admission,payload);return {allowed:true,stage:'pre-spawn',...metadata,nativeStarted:false,proofRef:'native-bind:'+record.leaseId};
    }
    if(cleanup){
      if(record.closedAuthority)return structuredClone(record.closedAuthority);const rows=processesFor(admission.job,rid(run));record.nativeStarted ||=admission.job.nativeSpawnAdmitted?.has?.(rid(run))===true||rows.some(process=>process.processRole!=='inert-engine-launcher');
      const stopped=await supervisor.awaitStopped({jobId:record.jobId,runId:record.runId,timeoutMs:5000});if(stopped.stopped!==true||stopped.osActiveProcesses!==0||record.nativeStarted&&!(stopped.registered>0))throw fail('Native credential close requires real owned subtree stop proof','WORK_PROCESS_STOP_UNCONFIRMED');
      const metadata=await profile(admission,payload,{allowMissing:!record.nativeStarted&&record.issued.profileBound!==true}),proofRef='native-stop:'+randomUUID(),authority={allowed:true,stage:'closed',...metadata,nativeStarted:record.nativeStarted,owned:record.nativeStarted||stopped.registered>0,stopped:true,ownedChildrenStopped:true,osActiveProcesses:0,proofRef};
      await onProof({kind:'native-credential-stop',proofRef,pluginId:record.pluginId,jobId:record.jobId,runId:record.runId,leaseId:record.leaseId,sourceKey:record.sourceKey,nativeStarted:record.nativeStarted,profileIdentityHash:metadata.profileIdentityHash,ownerFileHash:metadata.ownerFileHash,stopped:true,ownedChildrenStopped:true,osActiveProcesses:0,registered:stopped.registered??0});record.closedAuthority=authority;return structuredClone(authority);
    }
    if(operation!=='native.credentials.update'||!['initialized','checkpoint'].includes(payload.phase))throw fail('Credential updates require an explicit initialized or checkpoint phase');
    const proof=initializations.get(payload.proofRef??payload.nativeInitializationProofRef);if(!proof||proof.pluginId!==record.pluginId||proof.jobId!==record.jobId||proof.runId!==record.runId||proof.leaseId!==record.leaseId||proof.sourceKey!==record.sourceKey||proof.bindingFingerprint!==record.bindingFingerprint)throw fail('Native initialization reference does not belong to this credential owner');
    const metadata=await profile(admission,payload);if(metadata.ownerFileHash!==proof.ownerFileHash)throw fail('Initialized native profile metadata changed');await observedProcesses(admission);record.nativeStarted=true;return {allowed:true,stage:payload.phase,...metadata,nativeStarted:true,owned:true,initializationObserved:true,proofRef:proof.proofRef};
  }
  return {initialization,credentialAuthority,snapshot:()=>({closed,credentialOwners:leases.size,initializations:initializations.size}),close(){closed=true;}};
}
