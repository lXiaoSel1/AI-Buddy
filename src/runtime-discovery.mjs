import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {t} from './i18n.mjs';

export const codexHome=(env=process.env)=>env.CODEX_HOME||join(env.USERPROFILE||env.HOME||homedir(),'.codex');
const file=path=>{try{return !!path&&statSync(path).isFile();}catch{return false;}};
function directories(path){try{return readdirSync(path,{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>join(path,x.name)).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs||b.localeCompare(a));}catch{return [];}}
function npmCandidates(base,arch){const target=arch==='arm64'?'aarch64-pc-windows-msvc':'x86_64-pc-windows-msvc',platform=arch==='arm64'?'arm64':'x64';return [join(base,'node_modules/@openai/codex/node_modules/@openai/codex-win32-'+platform+'/vendor',target,'bin/codex.exe'),join(base,'node_modules/@openai/codex/node_modules/@openai/codex-win32-'+platform+'/vendor',target,'codex/codex.exe'),join(base,'node_modules/@openai/codex/vendor',target,'codex/codex.exe')];}
function installedCandidates(folder){return [join(folder,'app/resources/codex.exe'),join(folder,'resources/codex.exe')];}
export function codexBinary({root,env=process.env,explicit,arch=process.arch,registeredInstallations=[]}={}){
 const chosen=explicit||env.AI_BUDDY_CODEX_PATH;
 if(chosen)return isAbsolute(chosen)&&file(chosen)&&/\.exe$/i.test(chosen)?chosen:null;
 const home=env.USERPROFILE||env.HOME||homedir(),local=env.LOCALAPPDATA||join(home,'AppData/Local'),roaming=env.APPDATA||join(home,'AppData/Roaming');
 const desktop=join(local,'OpenAI/Codex/bin');
 let recorded;try{recorded=root&&JSON.parse(readFileSync(join(root,'local/receipts/runtime-paths.json'),'utf8')).codex;}catch{}
 const paths=(env.PATH||env.Path||'').split(';').map(p=>p.trim().replace(/^"|"$/g,'')).filter(Boolean);
 const candidates=[...registeredInstallations.flatMap(installedCandidates),...directories(desktop).map(dir=>join(dir,'codex.exe')),
  ...[join(local,'Programs/Codex'),join(local,'Programs/OpenAI/Codex'),join(local,'Codex'),...(env.ProgramFiles?[join(env.ProgramFiles,'Codex')]:[])].flatMap(installedCandidates),
  ...paths.filter(isAbsolute).map(dir=>join(dir,'codex.exe')),...npmCandidates(join(roaming,'npm'),arch),...paths.filter(isAbsolute).flatMap(dir=>npmCandidates(dir,arch)),recorded];
 return candidates.find(path=>path&&isAbsolute(path)&&file(path))||null;
}
// Query the current user's registered app only, never scan WindowsApps recursively.
export function registeredCodexInstallations(env=process.env){
 const command="$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -ExpandProperty InstallLocation) | ConvertTo-Json -Compress";
 return new Promise(resolve=>execFile(join(env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{env,windowsHide:true,timeout:6000,maxBuffer:65536,encoding:'utf8'},(error,output)=>{if(error)return resolve([]);try{const value=JSON.parse(output.replace(/^\uFEFF/,''));resolve((Array.isArray(value)?value:[value]).filter(v=>typeof v==='string'&&isAbsolute(v)));}catch{resolve([]);}}));
}
export function codexRuntimeError(error){
 const message=error?.code==='EACCES'||error?.code==='EPERM'?'Codex 程序无法访问，请检查 Windows 权限或安全软件。':error?.code==='ENOENT'||error?.code==='CODEX_NOT_FOUND'?'未找到 Codex 程序。请先安装并打开 Codex 桌面端，再点击测试连接；自定义安装可设置 AI_BUDDY_CODEX_PATH 指向 codex.exe。':'Codex 启动失败，请更新并打开 Codex 桌面端后重试。';
 return Object.assign(new Error(t(message)),{code:error?.code||'CODEX_START_FAILED'});
}
export async function resolveCodexBinary(options={}){
 const local=codexBinary(options);if(local)return local;
 const env=options.env||process.env;
 if(!options.explicit&&!env.AI_BUDDY_CODEX_PATH){const registered=await (options.discoverRegistered||registeredCodexInstallations)(env),found=codexBinary({...options,registeredInstallations:registered});if(found)return found;}
 throw codexRuntimeError({code:'CODEX_NOT_FOUND'});
}
