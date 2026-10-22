import {writeFileSync,openSync,fsyncSync,closeSync,renameSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

// Writes a new temporary file, syncs it and renames it over target, so readers see
// the old or the new content, never a partial one. A failed attempt removes its
// temporary file.
export function writeAtomic(target,data){
 const temp=target+'.'+randomUUID()+'.partial';
 try{writeFileSync(temp,data,{flag:'wx'});const fd=openSync(temp,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,target);}
 catch(error){rmSync(temp,{force:true});throw error;}
}
