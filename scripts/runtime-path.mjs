import {resolve,join,sep} from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
export function runtimeInfo(root,manifest={}){
 const path=resolve(root,manifest.runtime?.path||'runtime/electron-44.6.0'),executable=manifest.runtime?.executable||'electron.exe';
 if(!path.toLowerCase().startsWith(resolve(root,'runtime').toLowerCase()+sep)||/[\\/]/.test(executable))throw Error('Invalid runtime manifest');
 return {path,executable,exe:join(path,executable)};
}
export function runtimeExecutable(root,manifest,verify=true){const value=runtimeInfo(root,manifest);if(!existsSync(value.exe))throw Error('AI Buddy运行包缺失：'+value.exe);if(verify&&manifest?.runtime?.sha256&&createHash('sha256').update(readFileSync(value.exe)).digest('hex')!==manifest.runtime.sha256)throw Error('AI Buddy运行文件校验失败');return value.exe;}
