import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
function compile(root,out,name){
 const compiler=join(process.env.SystemRoot||'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
 const result=spawnSync(compiler,['/nologo','/target:exe','/platform:anycpu','/optimize+','/out:'+join(out,name+'.exe'),join(root,'scripts',name+'.cs')],{windowsHide:true,encoding:'utf8'});
 if(result.error||result.status!==0)throw Error(result.error?.message||result.stdout||result.stderr||`${name} compilation failed`);
}
export const buildPetButtons=(root,out)=>compile(root,out,'pet-buttons');
export const buildPetFullscreen=(root,out)=>compile(root,out,'pet-fullscreen');
