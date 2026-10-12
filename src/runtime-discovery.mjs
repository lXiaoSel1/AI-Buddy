import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
export function codexBinary({root,env=process.env,explicit}){
 if(explicit)return explicit;
 let recorded;try{recorded=JSON.parse(readFileSync(join(root,'local/receipts/runtime-paths.json'),'utf8')).codex;}catch{}
 const appdata=env.APPDATA||join(env.USERPROFILE||'','AppData','Roaming');
 const candidates=[recorded,join(appdata,'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'),...(env.PATH||'').split(';').filter(Boolean).map(dir=>join(dir,'codex.exe'))];
 return candidates.find(path=>path&&existsSync(path))||'codex';
}
