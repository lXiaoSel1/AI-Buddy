import {execFile} from 'node:child_process';
import {join} from 'node:path';
import {promisify} from 'node:util';
const execute=promisify(execFile),fail=code=>Object.assign(Error(code),{code});
/** Verify the actual Windows TCP listener before sending a management secret. */
export async function assertOwnedListener(pid,ports){
 if(process.platform!=='win32'||!Number.isSafeInteger(pid)||pid<1||!Array.isArray(ports)||!ports.length||ports.some(p=>!Number.isSafeInteger(p)||p<1||p>65535))throw fail('QQ_LISTENER_IDENTITY_INVALID');
 const command=`$ErrorActionPreference='Stop'; $rows=@(Get-NetTCPConnection -State Listen -LocalPort ${ports.join(',')} -ErrorAction SilentlyContinue); $rows | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress`;
 let stdout;try{({stdout}=await execute(join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:8000,maxBuffer:64*1024}));}catch{throw fail('QQ_LISTENER_CHECK_FAILED');}
 let rows;try{const value=JSON.parse(stdout||'[]');rows=Array.isArray(value)?value:[value];}catch{throw fail('QQ_LISTENER_CHECK_FAILED');}
 for(const port of ports){const matching=rows.filter(r=>r.LocalPort===port);if(!matching.length)throw fail('QQ_LISTENER_NOT_READY');if(matching.some(row=>row.OwningProcess!==pid||!['127.0.0.1','::1'].includes(row.LocalAddress)))throw fail('QQ_LISTENER_OWNER_MISMATCH');}
 return {verified:true,pid,ports:[...ports]};
}
