import {spawn} from 'node:child_process';
export function createPetButtonObserver({path,onState,onError=()=>{},spawnImpl=spawn,enabled=process.platform==='win32'}){
 let child=null,id=null,buffer='',closed=false;
 const fault=error=>{if(!closed)onError(error);};
 if(enabled){child=spawnImpl(path,[],{windowsHide:true,stdio:['pipe','pipe','ignore']});child.on('error',fault);child.stdin.on('error',fault);child.stdout.on('data',bytes=>{buffer+=bytes;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);const split=line.lastIndexOf('|'),key=line.slice(0,split),mask=Number(line.slice(split+1));if(key===id&&Number.isInteger(mask)&&mask>=0&&mask<=7)onState({gestureId:key,buttons:mask&3,escape:!!(mask&4)});}if(buffer.length>1024)buffer='';});child.on('exit',()=>{child=null;if(id&&!closed)fault(Error('Pet input helper exited during a gesture'));});}
 return {start(next){id=next;child?.stdin.write(next+'\n');},stop(){id=null;child?.stdin.write('\n');},close(){closed=true;id=null;child?.stdin.end();}};
}
