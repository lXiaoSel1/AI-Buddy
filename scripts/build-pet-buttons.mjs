import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
export function buildPetButtons(root,out){
 const compiler=join(process.env.SystemRoot||'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
 const result=spawnSync(compiler,['/nologo','/target:exe','/platform:anycpu','/optimize+','/out:'+join(out,'pet-buttons.exe'),join(root,'scripts/pet-buttons.cs')],{windowsHide:true,encoding:'utf8'});
 if(result.error||result.status!==0)throw Error(result.error?.message||result.stdout||result.stderr||'Button helper compilation failed');
}
