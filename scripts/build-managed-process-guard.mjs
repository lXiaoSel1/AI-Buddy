import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
export function buildManagedProcessGuard(root,out){
  if(process.platform!=='win32')return null;
  const framework=join(process.env.SystemRoot??'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  if(!existsSync(framework))throw Error('Managed process guard compiler is unavailable');
  mkdirSync(out,{recursive:true});const target=join(resolve(out),'managed-process-guard.exe');
  const result=spawnSync(framework,['/nologo','/target:exe','/optimize+','/out:'+target,join(resolve(root),'src','managed-process-guard.cs')],{encoding:'utf8',windowsHide:true});
  if(result.status!==0)throw Error('Managed process guard build failed: '+result.stdout+result.stderr);
  return target;
}
