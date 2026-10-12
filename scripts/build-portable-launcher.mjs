import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
export function buildPortableLauncher(root,output,version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version){
 const framework=join(process.env.SystemRoot||'C:/Windows','Microsoft.NET/Framework64/v4.0.30319');
 const compiler=join(framework,'csc.exe');
 if(!existsSync(compiler))throw Error('The Windows .NET Framework C# compiler is required to build the portable launcher.');
 mkdirSync(dirname(output),{recursive:true});
 if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid launcher version');
 const temporary=mkdtempSync(join(tmpdir(),'ai-buddy-launcher-'));
 try{
  const metadata=join(temporary,'Version.cs');writeFileSync(metadata,`[assembly: System.Reflection.AssemblyVersion("${version}.0")]\n[assembly: System.Reflection.AssemblyFileVersion("${version}.0")]\n`);
  const result=spawnSync(compiler,['/nologo','/target:winexe','/platform:anycpu','/optimize+','/out:'+output,'/win32icon:'+join(root,'assets/branding/app.ico'),'/reference:'+join(framework,'System.Web.Extensions.dll'),'/reference:'+join(framework,'System.Windows.Forms.dll'),metadata,join(root,'scripts/portable-launcher.cs')],{encoding:'utf8',windowsHide:true});
  if(result.status!==0)throw Error(result.stderr||result.stdout||'Launcher compilation failed');
 }finally{
  if(resolve(temporary).startsWith(resolve(tmpdir())+'\\ai-buddy-launcher-'))rmSync(temporary,{recursive:true});
 }
 return output;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=resolve(import.meta.dirname,'..');console.log(buildPortableLauncher(root,resolve(process.argv[2]||join(root,'AI Buddy.exe'))));
}
