import {writeFileSync,openSync,fsyncSync,closeSync,renameSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';

const sharing=new Set(['EPERM','EACCES','EBUSY']);
const waitArray=new Int32Array(new SharedArrayBuffer(4));
// Same publication rule as chat-request-store: retry only the rename of these
// exact fsynced bytes. Never remove the destination or replay the model request.
// Synchronous claim/finish callers return only after their receipt is durable.
export function writeBiliReadingAtomic(target,content,{replace=renameSync,platform=process.platform,wait=ms=>Atomics.wait(waitArray,0,0,ms),now=Date.now,waits=[20,40,80,160,320,640,1000],budgetMs=2500}={}){
 if(!isAbsolute(target))throw Object.assign(Error('Absolute reading checkpoint required'),{code:'BILI_FULL_DIRECTORY_REQUIRED'});
 const temporary=target+'.'+randomUUID()+'.partial',deadline=now()+budgetMs;let published=false;
 try{writeFileSync(temporary,content,{flag:'wx'});const fd=openSync(temporary,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}
  for(let attempt=0;;attempt++){try{replace(temporary,target);published=true;break;}catch(error){const delay=waits[attempt];if(platform!=='win32'||!sharing.has(error.code)||delay===undefined||now()+delay>deadline)throw error;wait(delay);if(now()>=deadline)throw error;}}
  return {published:true,bytes:Buffer.byteLength(content)};
 }finally{if(!published)try{rmSync(temporary,{force:true});}catch{}}
}
