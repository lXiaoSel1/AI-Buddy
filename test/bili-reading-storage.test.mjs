import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,renameSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {writeBiliReadingAtomic} from '../src/buddy-plugin-services/bili-reading-storage.mjs';

function fixture(t){const dir=mkdtempSync(join(tmpdir(),'bili-atomic-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'reading.json');writeFileSync(path,'old complete receipt');return {dir,path};}
test('sharing retry publishes the same fsynced temporary bytes without removing the old checkpoint',t=>{const {dir,path}=fixture(t),temporary=[],waits=[];let attempts=0;writeBiliReadingAtomic(path,'new exact receipt',{platform:'win32',wait:ms=>waits.push(ms),replace:(source,dest)=>{temporary.push(source);assert.equal(readFileSync(source,'utf8'),'new exact receipt');assert.equal(readFileSync(dest,'utf8'),'old complete receipt');if(++attempts<4)throw Object.assign(Error('Held by reader'),{code:'EPERM'});renameSync(source,dest);}});assert.equal(attempts,4);assert.equal(new Set(temporary).size,1);assert.deepEqual(waits,[20,40,80]);assert.equal(readFileSync(path,'utf8'),'new exact receipt');assert.deepEqual(readdirSync(dir),['reading.json']);});
test('permanent sharing failure is bounded and retains the previous durable checkpoint',t=>{const {dir,path}=fixture(t);let attempts=0,clock=0;assert.throws(()=>writeBiliReadingAtomic(path,'never published',{platform:'win32',now:()=>clock,wait:ms=>{clock+=ms;},budgetMs:150,replace:()=>{attempts++;throw Object.assign(Error('Still locked'),{code:'EACCES'});}}),{code:'EACCES'});assert.equal(attempts,4);assert.equal(readFileSync(path,'utf8'),'old complete receipt');assert.deepEqual(readdirSync(dir),['reading.json']);});
test('non-sharing filesystem errors are not retried',t=>{const {path}=fixture(t);let attempts=0;assert.throws(()=>writeBiliReadingAtomic(path,'candidate',{platform:'win32',wait:()=>assert.fail('Must not wait'),replace:()=>{attempts++;throw Object.assign(Error('Disk failure'),{code:'ENOSPC'});}}),{code:'ENOSPC'});assert.equal(attempts,1);assert.equal(readFileSync(path,'utf8'),'old complete receipt');});
test('real Windows reader without delete sharing releases its lock and the exact receipt is published',{skip:process.platform!=='win32',timeout:15000},async t=>{
 const {path}=fixture(t);
 // Hold the real OS lock until the writer observes its sharing failure. A fixed
 // unlock timer can expire before the parent is scheduled to attempt the rename.
 const script="$h=[System.IO.File]::Open($env:TASK_BILI_LOCK_TARGET,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read);try{[Console]::Out.WriteLine('LOCKED');[Console]::Out.Flush();if([Console]::In.ReadLine() -ne 'RELEASE'){throw 'Missing release handshake'}}finally{$h.Dispose()}";
 const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,shell:false,env:{...process.env,TASK_BILI_LOCK_TARGET:path},stdio:['pipe','pipe','pipe']});
 let output='',errors='',releaseSent=false;
 const release=()=>{if(releaseSent)return;releaseSent=true;if(!child.stdin.destroyed)child.stdin.end('RELEASE\n');};
 child.stdin.on('error',error=>{errors+=' stdin: '+error.message;});
 child.stderr.on('data',b=>{errors+=b;});
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('Lock helper failed: '+errors)));});
 t.after(()=>{release();child.kill();});
 try{
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Lock helper did not acquire the target: '+errors)),10000);
   child.stdout.on('data',b=>{output+=b;if(output.includes('LOCKED')){clearTimeout(timer);resolve();}});
   exited.then(()=>{if(!output.includes('LOCKED')){clearTimeout(timer);reject(Error('Lock helper exited before acquiring the target: '+errors));}},error=>{clearTimeout(timer);reject(error);});
  });
  let attempts=0,sharingFailures=0;
  writeBiliReadingAtomic(path,'receipt after a real shared-reader lock',{replace:(a,b)=>{
   attempts++;
   try{renameSync(a,b);}catch(error){
    if(['EPERM','EACCES','EBUSY'].includes(error.code)){sharingFailures++;release();}
    throw error;
   }
  }});
  assert.ok(sharingFailures>0,'must observe a real sharing violation before releasing the helper handle');
  assert.ok(attempts>1,'the atomic writer must retry the real failed rename');
  assert.equal(readFileSync(path,'utf8'),'receipt after a real shared-reader lock');
 }finally{release();await exited;}
});
