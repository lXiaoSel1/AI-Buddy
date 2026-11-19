import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isAbsolute,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {NATIVE_WRITE_QUEUED} from './companion-cache-store.mjs';

const run=promisify(execFile);
const owner='ai-buddy-codex-app-server';
const validPid=pid=>Number.isSafeInteger(pid)&&pid>0;
const pathKey=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
const hasIdentity=row=>validPid(row?.pid)&&/^\d+$/.test(row.creationTime??'')&&
  typeof row.executable==='string'&&isAbsolute(row.executable)&&typeof row.ownerSid==='string'&&!!row.ownerSid;
const matches=(saved,seen)=>hasIdentity(saved)&&hasIdentity(seen)&&
  saved.pid===seen.pid&&saved.creationTime===seen.creationTime&&saved.ownerSid===seen.ownerSid&&saved.hostPid===seen.hostPid&&
  pathKey(saved.executable)===pathKey(seen.executable);

export async function codexBounded(work,timeoutMs,fallback){
  let timer;
  try{return await Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>resolve(fallback),Math.max(0,timeoutMs));})]);}
  finally{clearTimeout(timer);}
}

function windowsOsProcesses(){
  if(process.platform!=='win32')return null;
  const system32=join(process.env.SystemRoot??'C:\\Windows','System32');
  const powershell=join(system32,'WindowsPowerShell','v1.0','powershell.exe');
  const taskkill=join(system32,'taskkill.exe');
  const ps=(command,input,timeout)=>run(powershell,
    ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],
    {
      timeout,windowsHide:true,encoding:'utf8',maxBuffer:65536,
      env:{...process.env,AI_BUDDY_CODEX_PROCESS_INPUT:JSON.stringify(input)},
    });
  const snapshot=[
    "$ErrorActionPreference='Stop'",
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
    '$inputData=$env:AI_BUDDY_CODEX_PROCESS_INPUT | ConvertFrom-Json',
    '$p=Get-CimInstance Win32_Process -Filter ("ProcessId="+[int]$inputData.pid)',
    'if(!$p){if($inputData.taskkill){exit 5};exit 0}',
    '$sid=(Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid).Sid',
    '$birth=$p.CreationDate.ToUniversalTime().Ticks.ToString()',
  ].join(';');
  return {
    async inspect(pid,{timeoutMs=2400}={}){
      if(!validPid(pid))return null;
      const {stdout}=await ps(snapshot+
        ';[pscustomobject]@{pid=[int]$p.ProcessId;creationTime=$birth;executable=$p.ExecutablePath;ownerSid=$sid;hostPid=[int]$p.ParentProcessId}|ConvertTo-Json -Compress',
      {pid},timeoutMs);
      return stdout.trim()?JSON.parse(stdout):null;
    },
    async killTree(record,{timeoutMs=2400}={}){
      if(!hasIdentity(record)||!validPid(record.hostPid))return false;
      // Recheck ownership in the same invocation that terminates the tree.
      const guard='if($birth -ne $inputData.creationTime -or $sid -ne $inputData.ownerSid -or $p.ExecutablePath -ine $inputData.executable -or $p.ParentProcessId -ne $inputData.hostPid){exit 5}';
      const kill='& $inputData.taskkill /PID $inputData.pid /T /F | Out-Null;exit $LASTEXITCODE';
      await ps(snapshot+';'+guard+';'+kill,{...record,taskkill},timeoutMs);
      return true;
    },
  };
}

export class CodexOwnedProcesses {
  constructor(store,audit,osProcesses=windowsOsProcesses()){
    Object.assign(this,{store,audit,osProcesses});
    this.children=new WeakMap();
    this.protectedKeys=new Set();
    this.liveKeys=new Set();
  }

  register(child,binary){
    if(!this.osProcesses||!validPid(child.pid))return;
    const key='process:'+randomUUID();
    this.liveKeys.add(key);
    const registration=(async()=>{
      try{
        const seen=await this.osProcesses.inspect(child.pid,{timeoutMs:5000});
        if(!hasIdentity(seen)||seen.pid!==child.pid||seen.hostPid!==process.pid||
           pathKey(seen.executable)!==pathKey(binary))throw Error('Spawned process identity did not match');
        const record={...seen,owner};
        const result=await this.store.write(key,record);
        if(result===NATIVE_WRITE_QUEUED)this.audit({type:'codex-process-ownership-queued'});
        else if(result!==true)throw Error('Owned process record was not saved');
        return {key,record};
      }catch{
        this.liveKeys.delete(key);
        this.audit({type:'codex-process-ownership-unavailable'});
        return null;
      }
    })();
    this.children.set(child,registration);
    return key;
  }

  async recover(){
    if(!this.osProcesses)return;
    const rows=(await this.store.list()).filter(({key,value})=>key.startsWith('process:')&&value?.owner===owner);
    await Promise.all(rows.map(async({key,value:record})=>{
      if(this.liveKeys.has(key))return;
      this.protectedKeys.add(key);
      try{
        if(!hasIdentity(record)||!validPid(record.hostPid))throw Error('Incomplete app-server ownership record');
        const seen=await this.osProcesses.inspect(record.pid);
        if(seen&&!hasIdentity(seen))throw Error('Incomplete OS process identity');
        if(seen&&!matches(record,seen))this.audit({type:'codex-stale-process-skipped',reason:'identity-mismatch'});
        if(seen&&matches(record,seen)){
          const host=await this.osProcesses.inspect(record.hostPid);
          // The original parent may be a still-running AI Buddy window. Its
          // PID is considered reused only when it was created after the child.
          if(host&&(!/^\d+$/.test(host.creationTime??'')||BigInt(host.creationTime)<=BigInt(record.creationTime)))return;
          if(!await this.osProcesses.killTree(record))throw Error('App-server process tree stop was unconfirmed');
        }
        await this.store.remove(key);
        this.protectedKeys.delete(key);
      }catch{
        this.audit({type:'codex-stale-process-skipped',reason:'ownership-unverified'});
      }
    }));
  }

  async ownedRecord(child){
    return await this.children.get(child);
  }

  async forget(child){
    const owned=await this.ownedRecord(child);
    if(!owned)return;
    this.liveKeys.delete(owned.key);
    await this.store.remove(owned.key).catch(()=>this.audit({type:'codex-process-record-remove-failed'}));
  }

  async killTree(child,timeoutMs){
    const deadline=Date.now()+timeoutMs;
    const owned=await codexBounded(this.ownedRecord(child),Math.max(0,timeoutMs-2400),null);
    if(!owned||timeoutMs<=0)return false;
    const remaining=deadline-Date.now();
    if(remaining<=0)return false;
    try{return await codexBounded(this.osProcesses.killTree(owned.record,{timeoutMs:remaining}),remaining,false);}
    catch{this.audit({type:'codex-process-tree-stop-unconfirmed'});return false;}
  }
}
