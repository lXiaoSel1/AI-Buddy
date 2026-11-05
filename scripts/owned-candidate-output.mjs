import * as fs from 'node:fs';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertFreshCandidateOutput} from './media-baseline-validation.mjs';

const assert=(ok,message)=>{if(!ok)throw Error(message);};
const RENAME_RETRY_MS=process.platform==='win32'?[0,50,150,300,600,1200,2400,4000]:[0,50,150,300,600];
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const inside=(root,path)=>{const rel=relative(root,path);return rel&&rel!=='..'&&!rel.startsWith('../')&&!rel.startsWith('..\\')&&!isAbsolute(rel);};
function inspectTree(root){
 const pending=[root];
 while(pending.length){const dir=pending.pop();for(const name of fs.readdirSync(dir)){const path=join(dir,name),info=fs.lstatSync(path);assert(inside(root,path),'Build staging child escaped root');assert(!info.isSymbolicLink(),'Linked build staging child blocks cleanup: '+path);if(info.isDirectory())pending.push(path);else assert(info.isFile(),'Unexpected build staging entry: '+path);}}
}
export function createOwnedCandidateOutput(buildsRoot,outputName,{rename=fs.renameSync}={}){
 assert(/^[a-zA-Z0-9_-]+$/.test(outputName),'Output must be a single candidate directory name');
 const requestedRoot=resolve(buildsRoot);
 fs.mkdirSync(requestedRoot,{recursive:true});
 assert(!fs.lstatSync(requestedRoot).isSymbolicLink(),'Builds root is a link');
 const root=fs.realpathSync.native(requestedRoot),finalPath=join(root,outputName);
 assertFreshCandidateOutput(finalPath);
 const stagePath=join(root,'.'+outputName+'.stage-'+randomUUID());
 assertFreshCandidateOutput(stagePath);
 fs.mkdirSync(stagePath);
 const identity=fs.lstatSync(stagePath),marker={kind:'ai-buddy-owned-candidate-stage',stagePath,finalPath,nonce:randomUUID(),identity:{dev:identity.dev,ino:identity.ino}};
 fs.writeFileSync(join(stagePath,'.build-owner.json'),JSON.stringify(marker)+'\n',{flag:'wx'});
 let state='open';
 function verify(){
  assert(state==='open','Candidate stage is no longer open');
  assert(dirname(stagePath)===root&&inside(root,stagePath),'Build stage escaped owned root');
  const actual=fs.lstatSync(stagePath),saved=JSON.parse(fs.readFileSync(join(stagePath,'.build-owner.json'),'utf8'));
  assert(actual.isDirectory()&&!actual.isSymbolicLink()&&fs.realpathSync.native(stagePath)===stagePath&&same(actual,identity),'Build stage identity changed');
  assert(saved.kind===marker.kind&&saved.stagePath===stagePath&&saved.finalPath===finalPath&&saved.nonce===marker.nonce&&same(saved.identity,identity),'Build stage marker changed');
  inspectTree(stagePath);
 }
 return {
  stagePath,finalPath,
  commit(){
   verify();assertFreshCandidateOutput(finalPath);fs.unlinkSync(join(stagePath,'.build-owner.json'));
   try{
    for(let i=0;i<RENAME_RETRY_MS.length;i++){
     if(RENAME_RETRY_MS[i])Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,RENAME_RETRY_MS[i]);
     assertFreshCandidateOutput(finalPath);
     assert(same(fs.lstatSync(stagePath),identity),'Build stage identity changed during rename retry');
     try{rename(stagePath,finalPath);state='committed';return finalPath;}
     catch(error){if(!['EPERM','EBUSY'].includes(error.code)||i===RENAME_RETRY_MS.length-1)throw error;}
    }
   }catch(error){fs.writeFileSync(join(stagePath,'.build-owner.json'),JSON.stringify(marker)+'\n',{flag:'wx'});throw error;}
  },
  abort(){verify();fs.rmSync(stagePath,{recursive:true,force:false,maxRetries:3,retryDelay:150});assert(!fs.existsSync(stagePath),'Build stage remains after abort');state='aborted';}
 };
}
