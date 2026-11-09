import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {windowsProcessSnapshot} from './managed-process-supervisor.mjs';
const sessionId=randomUUID();let ownBirth;
async function birth(pid){if(process.platform==='win32')return (await windowsProcessSnapshot(pid)).find(row=>row.pid===pid)?.creationTime??null;if(process.platform==='linux'){try{const text=await readFile('/proc/'+pid+'/stat','utf8');return text.slice(text.lastIndexOf(')')+2).split(' ')[19];}catch(error){if(error.code==='ENOENT')return null;throw error;}}throw Error('Process birth identity is unavailable on this platform');}
export async function processLockOwner(){ownBirth??=birth(process.pid);const creationTime=await ownBirth;if(!creationTime)throw Error('Current process birth identity could not be verified');return {pid:process.pid,creationTime,sessionId};}
export async function processLockAlive(owner){if(!Number.isSafeInteger(owner?.pid)||owner.pid<1)throw Error('Invalid process lock identity');try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')return false;if(error.code!=='EPERM')throw error;}if(!owner.creationTime)return true;try{const actual=await birth(owner.pid);return actual==null||actual===owner.creationTime;}catch{return true;}}
