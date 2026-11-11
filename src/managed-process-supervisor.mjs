import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,mkdir,realpath,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join,dirname,relative,resolve,isAbsolute,sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {writeAtomic} from './atomic-write.mjs';

const runFile=promisify(execFile),fail=(message,code='WORK_PROCESS_DENIED')=>Object.assign(Error(message),{code});
const integer=value=>Number.isSafeInteger(value)&&value>0;
const systemEnv=()=>Object.fromEntries(['SystemRoot','WINDIR','ComSpec','TEMP','TMP','PATH'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
export async function windowsProcessSnapshot(pid=null){
  if(process.platform!=='win32')throw fail('This process proof requires Windows','WORK_PROCESS_PLATFORM_UNSUPPORTED');
  if(pid!=null&&!integer(pid))throw fail('Invalid process identity');
  const filter=pid==null?'':" -Filter 'ProcessId="+pid+"'";
  const script="$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$workRows=@(Get-CimInstance Win32_Process"+filter+" | ForEach-Object {try{$workProc=Get-Process -Id $_.ProcessId -ErrorAction Stop;[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;creationTime=$workProc.StartTime.ToUniversalTime().Ticks.ToString();exeRealPath=$_.ExecutablePath}}catch{}});ConvertTo-Json -InputObject $workRows -Compress";
  const {stdout}=await runFile(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,env:systemEnv(),timeout:30000,maxBuffer:8*1024*1024});
  const rows=JSON.parse(stdout.replace(/^\uFEFF/,'').trim()||'[]');return Array.isArray(rows)?rows:[rows];
}
export async function windowsGuardProcessSnapshot(guardPath,pid=null){
  if(process.platform!=='win32')throw fail('This process proof requires Windows','WORK_PROCESS_PLATFORM_UNSUPPORTED');
  if(!isAbsolute(guardPath??'')||pid!=null&&!integer(pid))throw fail('Invalid native process snapshot request');
  const {stdout}=await runFile(guardPath,['--snapshot',...(pid==null?[]:[String(pid)])],{encoding:'utf8',windowsHide:true,env:systemEnv(),timeout:30000,maxBuffer:8*1024*1024});
  const rows=JSON.parse(stdout.replace(/^\uFEFF/,'').trim()||'null');
  if(!Array.isArray(rows)||rows.some(row=>!integer(row.pid)||!Number.isSafeInteger(row.parentPid)||row.parentPid<0||!/^\d+$/.test(row.creationTime??'')||!isAbsolute(row.exeRealPath??'')))throw fail('Native process snapshot returned invalid identity data','WORK_PROCESS_INSPECT_FAILED');
  return rows;
}
async function fileHash(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
function descends(pid,ancestor,rows){const index=new Map(rows.map(r=>[r.pid,r])),seen=new Set();let row=index.get(pid);while(row&&!seen.has(row.pid)){if(row.pid===ancestor)return true;seen.add(row.pid);const parent=index.get(row.parentPid);if(parent&&/^\d+$/.test(parent.creationTime??'')&&/^\d+$/.test(row.creationTime??'')&&BigInt(parent.creationTime)>BigInt(row.creationTime))return false;row=parent;}return false;}
/** Pure process ownership and OS job supervision, without any work engine. */
export function createManagedProcessSupervisor({guardPath,statePath,inspect,spawnImpl=spawn,onState=()=>{}}={}){
  const roots=new Map(),records=new Map(),guards=new Map(),releasedRoots=new Map();let loaded=false,loading,closed=false,closing,admissionEpoch=0,mutationTail=Promise.resolve();
  function beginAdmission(){const epoch=admissionEpoch;checkAdmission(epoch);return epoch;}
  function checkAdmission(epoch){if(closed||closing||epoch!==admissionEpoch)throw fail('Process admission was fenced by supervisor shutdown','WORK_PROCESS_ADMISSION_CLOSED');}
  function mutate(operation){const result=mutationTail.then(operation,operation);mutationTail=result.catch(()=>{});return result;}
  function reusableGuard(key){const value=guards.get(key);if(value&&(value.admitting||value.admissionError||value.proof?.ready!==true||value.retirement||value.child.exitCode!=null||value.child.stdin.destroyed||value.child.stdin.writableEnded))throw fail('OS guard is unverified, failed, admitting, retiring or closed; a fresh ownership proof is required','WORK_PROCESS_GUARD_UNAVAILABLE');return value;}
  const inspectImpl=inspect??(pid=>windowsGuardProcessSnapshot(guardPath,pid));let ownerIdentity;
  async function timed(stage,pid,operation){const startedAt=Date.now(),start=performance.now();try{const value=await operation();onState({type:'process-inspection',stage,...pid==null?{}:{pid},mode:inspect?'injected':'native-guard',startedAt,finishedAt:Date.now(),durationMs:performance.now()-start,ok:true,...Array.isArray(value)?{rowCount:value.length}:{}});return value;}catch(error){onState({type:'process-inspection',stage,...pid==null?{}:{pid},mode:inspect?'injected':'native-guard',startedAt,finishedAt:Date.now(),durationMs:performance.now()-start,ok:false,code:error.code??'WORK_PROCESS_INSPECT_FAILED'});throw error;}}
  const inspectNow=(pid=null)=>timed(pid==null?'inventory':'identity',pid,()=>inspectImpl(pid));
  function insideProofPath(path){const rel=relative(join(dirname(statePath),'guard-receipts'),resolve(path));return !!rel&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep)&&/^[a-f0-9-]{36}\.json$/.test(rel);}
  async function load(){if(loaded)return;if(loading)return loading;loading=(async()=>{try{const raw=JSON.parse(await readFile(statePath,'utf8'));for(const row of raw.records??[])records.set(row.id,row);}catch(e){if(e.code!=='ENOENT')throw e;}loaded=true;})();try{await loading;}finally{loading=null;}}
  async function persist(){await mkdir(dirname(statePath),{recursive:true});writeAtomic(statePath,JSON.stringify({version:1,records:[...records.values()]},null,2));}
  const identityQueries=new Map();
  async function identity(pid){if(identityQueries.has(pid))return structuredClone(await identityQueries.get(pid));const query=(async()=>{const row=(await inspectNow(pid)).find(r=>r.pid===pid);if(!row)return null;if(!row.creationTime||!row.exeRealPath)throw fail('Process identity cannot be proven');return {...row,exeRealPath:await realpath(row.exeRealPath)};})();identityQueries.set(pid,query);try{return structuredClone(await query);}finally{if(identityQueries.get(pid)===query)identityQueries.delete(pid);}}
  // Custody is valid only alongside the caller's fresh reply on the admitted
  // ChildProcess IPC channel. It never authorizes spawn, restore or shutdown.
  function rootCustody({runtimeId,pid,creationTime}={}){checkAdmission(admissionEpoch);const root=roots.get(runtimeId),guard=reusableGuard('runtime:'+runtimeId);if(!root||!guard||root.pid!==pid||root.creationTime!==creationTime||guard.identity.pid!==pid||guard.identity.creationTime!==creationTime)throw fail('The admitted runtime guard is no longer current','WORK_PROCESS_GUARD_UNAVAILABLE');return {...root,runtimeId,guardId:guard.proof.guardId};}
  function currentOwner(){if(!ownerIdentity){ownerIdentity=timed('owner-birth',process.pid,async()=>{const value=await identity(process.pid);if(!value)throw fail('Application owner identity is unavailable');return value;});ownerIdentity.catch(()=>{ownerIdentity=null;});}return ownerIdentity;}
  async function confirmTarget(row){const actual=await identity(row.pid);if(!actual||actual.creationTime!==row.creationTime||actual.parentPid!==row.parentPid)throw fail('Process identity changed while verifying its ancestry');return actual;}
  async function ownerMatches(rows){const owner=await currentOwner(),current=rows.find(row=>row.pid===process.pid);if(!owner||current?.creationTime!==owner.creationTime)throw fail('Application owner identity changed');return owner;}
  async function guard(key,row,epoch){
    checkAdmission(epoch);const previous=reusableGuard(key);if(previous){if(previous.identity.pid!==row.pid||previous.identity.creationTime!==row.creationTime)throw fail('Managed process identity changed');return previous.proof;}
    const owner=await currentOwner();if(!owner)throw fail('Application owner identity is unavailable');
    const guardId=randomUUID(),receiptPath=join(dirname(statePath),'guard-receipts',guardId+'.json');await mkdir(dirname(receiptPath),{recursive:true});
    const guardExePath=await realpath(guardPath),guardExeSha256=await timed('guard-image-hash',null,()=>fileHash(guardPath));
    // The serial mutation owns this spawn/commit boundary. close() fences its
    // epoch synchronously, then waits for this mutation to publish its guard.
    checkAdmission(epoch);
    const child=spawnImpl(guardPath,[String(process.pid),owner.creationTime,String(row.pid),row.creationTime,receiptPath,guardId],{windowsHide:true,env:systemEnv(),stdio:['pipe','pipe','pipe']});
    const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));}),requests=new Map();let tail='',readyResolve,readyReject;
    const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
    const timer=setTimeout(()=>readyReject(fail('Process guard did not become ready','WORK_PROCESS_GUARD_FAILED')),15000);
    child.once('error',e=>{clearTimeout(timer);readyReject(e);});
    child.stdout.on('data',b=>{tail+=b.toString();let at;while((at=tail.indexOf('\n'))>=0){const line=tail.slice(0,at);tail=tail.slice(at+1);try{const value=JSON.parse(line);if(value.requestId){const pending=requests.get(value.requestId);if(pending){requests.delete(value.requestId);clearTimeout(pending.timer);pending.resolve(value);}}else if(value.ready===true){clearTimeout(timer);readyResolve({...value,guardPid:child.pid});}else if(value.ready===false){clearTimeout(timer);readyReject(fail(value.error??'Process guard failed','WORK_PROCESS_GUARD_FAILED'));}}catch(e){readyReject(e);}}});
    const rejectQueries=error=>{for(const value of requests.values()){clearTimeout(value.timer);value.reject(error);}requests.clear();};
    child.stdin.on?.('error',error=>rejectQueries(error));
    exited.then(()=>{clearTimeout(timer);readyReject(fail('Process guard exited before readiness','WORK_PROCESS_GUARD_FAILED'));rejectQueries(fail('Process guard exited during query','WORK_PROCESS_GUARD_FAILED'));},error=>{clearTimeout(timer);readyReject(error);rejectQueries(error);});
    const admissionStart=performance.now(),value={child,exited,identity:row,proof:{guardId,receiptPath,ownerPid:process.pid,ownerCreationTime:owner.creationTime,rootPid:row.pid,rootCreationTime:row.creationTime,guardPid:child.pid,guardExePath,guardExeSha256},requests,admitting:true};
    // Even failed readiness leaves a known child for close() to stop/prove;
    // never allow an in-flight native spawn to disappear from supervision.
    guards.set(key,value);
    try{const rawProof=await timed('guard-admission',row.pid,()=>ready),helper=await identity(child.pid);
      if(rawProof.ownerPid!==process.pid||rawProof.rootPid!==row.pid||rawProof.killOnOwnerExit!==true||rawProof.breakawayAllowed!==false)throw fail('OS guard readiness returned another ownership identity','WORK_PROCESS_GUARD_FAILED');
      if(!helper||typeof helper.creationTime!=='string'||!/^\d+$/.test(helper.creationTime))throw fail('OS guard helper birth is not actually observed','WORK_PROCESS_GUARD_FAILED');
      const proof={...rawProof,...value.proof,guardCreationTime:helper.creationTime};value.proof=proof;value.admitting=false;onState({type:'guard-ready',key,admissionDurationMs:performance.now()-admissionStart,...proof});return proof;
    }catch(error){value.admitting=false;value.admissionError=error;throw error;}
  }
  async function stopReceipt(proof,row){
    if(!proof?.guardId||!proof.receiptPath||!insideProofPath(proof.receiptPath))throw fail('Missing durable OS guard stop receipt','WORK_PROCESS_STOP_UNCONFIRMED');
    const receipt=JSON.parse(await readFile(proof.receiptPath,'utf8'));
    if(receipt.schemaVersion!==1||receipt.guardId!==proof.guardId||receipt.ownerPid!==proof.ownerPid||receipt.ownerCreationTime!==proof.ownerCreationTime||receipt.rootPid!==row.pid||receipt.rootCreationTime!==row.creationTime||receipt.activeProcesses!==0||await fileHash(proof.guardExePath)!==proof.guardExeSha256)throw fail('OS guard stop receipt does not match its guarded identity','WORK_PROCESS_STOP_UNCONFIRMED');
    return receipt;
  }
  function queryGuard(owned){
    if(owned.retirement)return owned.retirement.then(receipt=>({activeProcesses:0,receipt}));
    if(owned.query)return owned.query;
    const requestId=randomUUID();
    const request=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{owned.requests.delete(requestId);reject(fail('OS ownership query timed out','WORK_PROCESS_STOP_UNCONFIRMED'));},5000);
      const rejected=error=>{clearTimeout(timer);owned.requests.delete(requestId);reject(error);};
      owned.requests.set(requestId,{resolve,reject:rejected,timer});
      try{if(owned.child.stdin.destroyed||owned.child.stdin.writableEnded)throw fail('OS guard control channel is closed','WORK_PROCESS_STOP_UNCONFIRMED');owned.child.stdin.write('status:'+requestId+'\n',error=>{if(error)rejected(error);});}catch(error){rejected(error);}
    });
    owned.query=request.then(reply=>{if(!Number.isSafeInteger(reply.activeProcesses)||reply.activeProcesses<0)throw fail('OS guard returned an invalid active process count','WORK_PROCESS_STOP_UNCONFIRMED');return reply;}).finally(()=>{owned.query=null;});
    return owned.query;
  }
  function retireGuard(key,owned){
    const retryReceipt=owned.retryStopReceipt;
    if(owned.retirement&&!retryReceipt)return owned.retirement;
    owned.retryStopReceipt=false;
    // Publish the shared promise before yielding. New queries join retirement;
    // pending queries drain before the single close command ends the pipe.
    owned.retirement=Promise.resolve().then(async()=>{
      if(!retryReceipt){
        if(owned.query)await owned.query.catch(()=>{});
        if(owned.child.exitCode==null&&!owned.child.stdin.destroyed&&!owned.child.stdin.writableEnded)owned.child.stdin.end('close\n');
        const exit=await owned.exited;
        if(exit.code!==0)throw fail('OS guard could not confirm shutdown','WORK_PROCESS_STOP_UNCONFIRMED');
      }
      let receipt;
      try{receipt=await stopReceipt(owned.proof,owned.identity);}
      catch(cause){
        // Keep custody revoked. A later release may reread the same proof
        // after a filesystem error, without reopening the guard's control pipe.
        owned.retryStopReceipt=['ENOENT','EACCES','EPERM','EBUSY'].includes(cause?.code);
        throw cause;
      }
      if(guards.get(key)===owned)guards.delete(key);
      onState({type:'guard-retired',key,guardId:owned.proof.guardId,guardPid:owned.proof.guardPid,receiptPath:owned.proof.receiptPath,activeProcesses:0});
      return receipt;
    });
    return owned.retirement;
  }
  async function registerRoot({runtimeId,pid}){
    const epoch=beginAdmission();await load();checkAdmission(epoch);if(typeof runtimeId!=='string'||!integer(pid)||pid===process.pid)throw fail('Invalid managed native runtime');
    reusableGuard('runtime:'+runtimeId);
    const rows=await inspectNow(),row=rows.find(r=>r.pid===pid);await ownerMatches(rows);if(!row||!descends(pid,process.pid,rows))throw fail('Runtime is not owned by this application');
    checkAdmission(epoch);return mutate(async()=>{checkAdmission(epoch);reusableGuard('runtime:'+runtimeId);
      const fresh=await inspectNow(),current=fresh.find(r=>r.pid===pid);await ownerMatches(fresh);checkAdmission(epoch);
      if(!current||current.creationTime!==row.creationTime||!descends(pid,process.pid,fresh))throw fail('Runtime identity changed before admission');
      const actual=await confirmTarget(current);checkAdmission(epoch);const proof=await guard('runtime:'+runtimeId,actual,epoch);checkAdmission(epoch);
      roots.set(runtimeId,actual);releasedRoots.delete(runtimeId);return {...actual,...proof,runtimeId};
    });
  }
  async function releaseRoot({runtimeId}={}){
    return mutate(async()=>{
    if(releasedRoots.has(runtimeId))return structuredClone(releasedRoots.get(runtimeId));
    const root=roots.get(runtimeId),key='runtime:'+runtimeId,owned=guards.get(key);if(!root||!owned||owned.identity.creationTime!==root.creationTime)throw fail('Native runtime has no current OS ownership guard','WORK_PROCESS_STOP_UNCONFIRMED');
    await retireGuard(key,owned);const proof=owned.proof;
    const result={released:true,runtimeId,pid:root.pid,stopped:true,osActiveProcesses:0,guardId:proof.guardId,receiptPath:proof.receiptPath};if(roots.get(runtimeId)===root){roots.delete(runtimeId);releasedRoots.set(runtimeId,result);}return structuredClone(result);
    });
  }
  async function register(spec){
    const epoch=beginAdmission();await load();checkAdmission(epoch);if(!spec.jobId||!spec.runId||!integer(spec.pid))throw fail('Invalid owned process registration');
    const root=roots.get(spec.nativeHostInstanceId);if(!root)throw fail('Native runtime has no OS ownership guard');
    const rows=await inspectNow(),currentRoot=rows.find(r=>r.pid===root.pid),row=rows.find(r=>r.pid===spec.pid);
    if(!row||currentRoot?.creationTime!==root.creationTime||!descends(spec.pid,root.pid,rows)||spec.pid===root.pid)throw fail('Process is not a current managed runtime descendant');
    checkAdmission(epoch);return mutate(async()=>{checkAdmission(epoch);if(roots.get(spec.nativeHostInstanceId)!==root)throw fail('Managed runtime changed before process admission');
    const fresh=await inspectNow(),freshRoot=fresh.find(r=>r.pid===root.pid),current=fresh.find(r=>r.pid===spec.pid);checkAdmission(epoch);
    if(!current||current.creationTime!==row.creationTime||freshRoot?.creationTime!==root.creationTime||!descends(spec.pid,root.pid,fresh))throw fail('Process identity changed before admission');
    const actual=await confirmTarget(current),digest=await timed('target-image-hash',spec.pid,()=>fileHash(actual.exeRealPath));checkAdmission(epoch);
    if(spec.creationTime&&String(spec.creationTime)!==actual.creationTime||spec.exeRealPath&&(await realpath(spec.exeRealPath))!==actual.exeRealPath||spec.exeSha256&&spec.exeSha256!==digest||spec.parentPid&&spec.parentPid!==actual.parentPid)throw fail('Owned process proof does not match the actual process');
    const key=[spec.jobId,spec.runId,spec.pid,actual.creationTime].join(':'),proof=await guard('run:'+key,actual,epoch);checkAdmission(epoch);
    const record={id:key,jobId:spec.jobId,runId:spec.runId,nativeHostInstanceId:spec.nativeHostInstanceId,...actual,exeSha256:digest,registeredAt:Date.now(),guardProof:proof};records.set(key,record);await persist();return {registered:true,guardReady:true,...record};
    });
  }
  // Core-only admission for an inert task tool Host. Plugin-facing register()
  // continues to reject its runtime root as a native engine descendant.
  async function registerTaskRoot(spec){
    const epoch=beginAdmission();await load();checkAdmission(epoch);if(!spec.jobId||!spec.runId||typeof spec.runtimeId!=='string'||!integer(spec.pid)||!isAbsolute(spec.expectedNodePath??'')||!/^[a-f0-9]{64}$/.test(spec.expectedNodeHash??''))throw fail('Invalid task tool runtime admission');
    const rows=await inspectNow(),row=rows.find(value=>value.pid===spec.pid);await ownerMatches(rows);if(!row||spec.pid===process.pid||!descends(spec.pid,process.pid,rows))throw fail('Task tool runtime is not owned by this application');
    checkAdmission(epoch);return mutate(async()=>{checkAdmission(epoch);const fresh=await inspectNow(),current=fresh.find(r=>r.pid===spec.pid);await ownerMatches(fresh);checkAdmission(epoch);
    if(!current||current.creationTime!==row.creationTime||!descends(spec.pid,process.pid,fresh))throw fail('Task tool runtime identity changed before admission');
    const actual=await confirmTarget(current),digest=await timed('target-image-hash',spec.pid,()=>fileHash(actual.exeRealPath));if(actual.exeRealPath!==await realpath(spec.expectedNodePath)||digest!==spec.expectedNodeHash)throw fail('Task tool runtime differs from its verified Node component');checkAdmission(epoch);
    const key=[spec.jobId,spec.runId,spec.runtimeId,spec.pid,actual.creationTime].join(':'),proof=await guard('run:'+key,actual,epoch);checkAdmission(epoch);const record={id:key,kind:'task-tool-host',jobId:spec.jobId,runId:spec.runId,nativeHostInstanceId:spec.runtimeId,...actual,exeSha256:digest,registeredAt:Date.now(),guardProof:proof};
    roots.set(spec.runtimeId,actual);records.set(key,record);await persist();return {registered:true,guardReady:true,...record};
    });
  }
  async function status({jobId,runId,runtimeId}={}){
    await load();const rows=await inspectNow(),index=new Map(rows.map(r=>[r.pid,r])),selected=[...records.values()].filter(r=>(!jobId||r.jobId===jobId)&&(!runId||r.runId===runId)&&(!runtimeId||r.nativeHostInstanceId===runtimeId));
    const alive=selected.filter(r=>index.get(r.pid)?.creationTime===r.creationTime).map(r=>({pid:r.pid,runId:r.runId,creationTime:r.creationTime}));
    let osActive=0,changed=false;const unconfirmed=[];
    for(const row of selected){const key='run:'+row.id,guarded=guards.get(key);try{
      let receipt;
      if(guarded){const reply=await queryGuard(guarded);osActive+=reply.activeProcesses;
        if(reply.activeProcesses!==0)continue;
        // Root disappearance alone cannot prove detached descendants stopped.
        // Job Object zero plus the exact root birth absent permits retirement.
        if(index.get(row.pid)?.creationTime===row.creationTime){unconfirmed.push({pid:row.pid,runId:row.runId,reason:'root-still-observed'});continue;}
        receipt=reply.receipt??await retireGuard(key,guarded);
      }else receipt=await stopReceipt(row.guardProof,row);
      if(JSON.stringify(row.stoppedProof)!==JSON.stringify(receipt)){row.stoppedProof=receipt;changed=true;}
    }catch(error){unconfirmed.push({pid:row.pid,runId:row.runId,reason:'missing-owned-descendant-stop-proof',code:error.code??'WORK_PROCESS_STOP_UNCONFIRMED'});}}
    if(changed)await persist();return {stopped:alive.length===0&&osActive===0&&!unconfirmed.length,alive,unconfirmed,osActiveProcesses:osActive,registered:selected.length};
  }
  async function awaitStopped(spec={}){const end=Date.now()+Math.min(30000,Math.max(0,spec.timeoutMs??5000));for(;;){const value=await status(spec);if(value.stopped||Date.now()>=end)return value;await delay(200);}}
  async function stopOwned(spec={}){
    await load();for(const row of records.values())if((!spec.jobId||row.jobId===spec.jobId)&&(!spec.runId||row.runId===spec.runId)&&(!spec.runtimeId||row.nativeHostInstanceId===spec.runtimeId)){const key='run:'+row.id,guarded=guards.get(key);if(guarded)await retireGuard(key,guarded);else{const current=await identity(row.pid);if(current&&current.creationTime===row.creationTime)throw fail('A live process has no current OS ownership handle; manual inspection is required','WORK_PROCESS_STOP_UNCONFIRMED');}}
    const proof=await awaitStopped(spec);if(!proof.stopped)throw fail('Owned processes have not stopped','WORK_PROCESS_STOP_UNCONFIRMED');await persist();return proof;
  }
  async function close(){if(closed)return;if(closing)return closing;admissionEpoch++;closing=mutate(async()=>{await load();for(const[key,value]of guards)await retireGuard(key,value);roots.clear();closed=true;});return closing;}
  async function inspectOwned({runtimeId,pid}={}){await load();if(closed||!integer(pid))throw fail('Invalid owned process inspection');const root=roots.get(runtimeId);if(!root||pid===root.pid)throw fail('Native runtime is not currently owned');const direct=guards.get('runtime:'+runtimeId),task=[...records.values()].find(row=>row.kind==='task-tool-host'&&row.nativeHostInstanceId===runtimeId&&row.pid===root.pid&&row.creationTime===root.creationTime),owned=direct??(task&&guards.get('run:'+task.id));if(!owned||owned.child.exitCode!==null||owned.identity.creationTime!==root.creationTime)throw fail('Native runtime OS guard is unavailable','WORK_PROCESS_STOP_UNCONFIRMED');const rows=await inspectNow(),current=rows.find(row=>row.pid===root.pid),target=rows.find(row=>row.pid===pid);if(!target||current?.creationTime!==root.creationTime||!descends(pid,root.pid,rows))throw fail('Process is not a current owned runtime descendant');const actual=await confirmTarget(target);return {...actual,exeSha256:await timed('target-image-hash',pid,()=>fileHash(actual.exeRealPath))};}
  return {registerRoot,releaseRoot,registerTaskRoot,register,inspectOwned,status,awaitStopped,stopOwned,close,identity,rootCustody,snapshot:()=>({managedRuntimes:roots.size,registeredProcesses:records.size,osGuards:guards.size,inspectionMode:inspect?'injected':'native-guard'})};
}
