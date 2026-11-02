import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';

// App-owned first instruction of a task-only Node PID. No upstream module,
// plugin, provider or user configuration is imported before the OS guard admits
// this exact process identity. This file is copied beside the application shim.
const CHANNEL='ai-buddy-dsh-platform-v1';
const [nonce,entry,...args]=process.argv.slice(2);
if(typeof process.send!=='function'||!process.connected||!/^[a-f0-9-]{36}$/.test(nonce??'')||!isAbsolute(entry??''))throw Error('DSH_BOOTSTRAP_CONFIGURATION_REQUIRED');
let admitted=false;
const timer=setTimeout(()=>process.exit(71),120000);
process.on('disconnect',()=>{if(!admitted)process.exit(0);});
const admit=async message=>{
  if(admitted||message?.channel!==CHANNEL||message.kind!=='bootstrap-admit'||message.nonce!==nonce)return;
  admitted=true;clearTimeout(timer);process.off('message',admit);
  process.argv=[process.execPath,entry,...args];
  try{await import(pathToFileURL(entry).href);}
  catch(error){process.send?.({channel:CHANNEL,kind:'bootstrap-error',error:{code:error.code??'DSH_BOOTSTRAP_FAILED',message:error.message}});process.exitCode=1;process.disconnect?.();}
};
process.on('message',admit);
process.send({channel:CHANNEL,kind:'bootstrap-ready',pid:process.pid});
