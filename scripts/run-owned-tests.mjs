import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';

const KIND='ai-buddy-owned-test-root-v1';
const PREFIX='ai-buddy-owned-test-r1-';
const MAX_LOG_BYTES=16*1024*1024;
const RENAME_DELAYS_MS=[0,25,75,150,300];
const RETENTION_DEFAULTS={maxRetainedRoots:8,maxRetainedBytes:512*1024*1024,maxSharedBytes:2*1024*1024*1024,maxEntries:100000};
const RETENTION_FILE='owned-retention-v1.json';
const fault=(message,code)=>Object.assign(Error(message),{code});

/** Resolve only: callers may inspect the default without allocating a folder.
 * The finite ancestor walk always stops at a filesystem root. */
export function resolveOwnedTestTempBase({sourceRoot,env=process.env,systemTemp=os.tmpdir(),maxAncestors=32}={}){
 if(env.AI_BUDDY_TEST_TEMP_BASE!=null){if(typeof env.AI_BUDDY_TEST_TEMP_BASE!=='string'||!path.isAbsolute(env.AI_BUDDY_TEST_TEMP_BASE))throw fault('Test temporary override must be an absolute path','OWNED_TEST_TEMP_INVALID');return path.resolve(env.AI_BUDDY_TEST_TEMP_BASE);}
 if(!sourceRoot||!Number.isSafeInteger(maxAncestors)||maxAncestors<1||maxAncestors>64)throw fault('Invalid bounded project lookup','OWNED_TEST_TEMP_INVALID');
 let current=path.resolve(sourceRoot);
 for(let n=0;n<maxAncestors;n++){
  try{if(fs.statSync(path.join(current,'AGENTS.md')).isFile()&&fs.statSync(path.join(current,'integration')).isDirectory())return path.join(current,'integration','ab-tests');}catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
  const parent=path.dirname(current);if(parent===current)break;current=parent;
 }
 return path.join(path.resolve(systemTemp),'ab-tests');
}
function noLinkedAncestors(value){for(let current=path.resolve(value);;current=path.dirname(current)){try{if(fs.lstatSync(current).isSymbolicLink())throw fault('Owned test path contains a link: '+current,'OWNED_TEST_RETENTION_UNVERIFIED');}catch(error){if(error.code!=='ENOENT')throw error;}if(current===path.dirname(current))break;}}
function shortRootBudget(parent){
 // Keep a 96-character reserve for nested SQLite/account fixtures, below the
 // legacy 248-character directory boundary used by several native libraries.
 if(process.platform==='win32'&&path.join(parent,PREFIX+'XXXXXX').length+96>248)throw fault('Test path leaves insufficient space for nested SQLite files; select a short AI_BUDDY_TEST_TEMP_BASE','OWNED_TEST_PATH_TOO_LONG');
}
function readBoundedJson(file,maximum=2*1024*1024){noLinkedAncestors(file);const info=fs.lstatSync(file);if(!info.isFile()||info.size>maximum)throw fault('Invalid retained test metadata: '+file,'OWNED_TEST_RETENTION_UNVERIFIED');try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw fault('Unreadable retained test metadata: '+file,'OWNED_TEST_RETENTION_UNVERIFIED');}}
function retentionLimits(value={}){const limits={...RETENTION_DEFAULTS,...value};for(const [key,n]of Object.entries(limits))if(!Object.hasOwn(RETENTION_DEFAULTS,key)||!Number.isSafeInteger(n)||n<1)throw fault('Invalid retention budget: '+key,'OWNED_TEST_BUDGET_INVALID');return limits;}
function validateRetained(root,parent,source=null){
 try{
  assert(path.basename(root).startsWith(PREFIX));assert.equal(normalized(path.dirname(root)),normalized(parent));noLinkedAncestors(root);assert.equal(normalized(fs.realpathSync(root)),normalized(root));assert(fs.lstatSync(root).isDirectory());
  const marker=readBoundedJson(path.join(root,'.owner.json'),65536);assert.equal(marker.kind,KIND);assert.equal(typeof marker.runId,'string');assert(/^[a-f0-9-]{36}$/.test(marker.runId));assert.equal(normalized(path.resolve(marker.root)),normalized(root));assert(path.isAbsolute(marker.sourceRoot));assert.deepEqual(marker.rootIdentity,identity(root));assert(Number.isSafeInteger(marker.ownerPid)&&marker.ownerPid>0);if(source)assert.equal(normalized(marker.sourceRoot),normalized(source));return marker;
 }catch(cause){throw fault('Retained root ownership could not be verified; left untouched: '+root+' ('+cause.message+')','OWNED_TEST_RETENTION_UNVERIFIED');}
}
async function acquireRunLease(key){
 const hash=createHash('sha256').update(key).digest('hex').slice(0,32);
 const endpoint=process.platform==='win32'?'\\\\.\\pipe\\ai-buddy-owned-tests-'+hash:path.join(os.tmpdir(),'ab-owned-'+hash+'.sock');
 const server=net.createServer(socket=>socket.destroy());
 try{await new Promise((yes,no)=>{server.once('error',no);server.listen(endpoint,yes);});}
 catch(cause){throw fault('Another owned test run holds this source or temporary parent; no child started ('+cause.code+')','OWNED_TEST_RUN_BUSY');}
 return ()=>new Promise(resolve=>server.close(resolve));
}
function prepareRetention(source,receipts,tempParent,configured){
 const limits=retentionLimits(configured),file=path.join(receipts,RETENTION_FILE);let index;
 try{index=readBoundedJson(file);}catch(error){if(error.code!=='ENOENT')throw error;index={schemaVersion:1,sourceRoot:source,runs:{}};}
 if(index.schemaVersion!==1||typeof index.sourceRoot!=='string'||normalized(index.sourceRoot)!==normalized(source)||!index.runs||typeof index.runs!=='object'||Array.isArray(index.runs)||Object.keys(index.runs).length>2048)throw fault('Retention index belongs to another source or is invalid; retained','OWNED_TEST_RETENTION_UNVERIFIED');
 const names=fs.readdirSync(tempParent,{withFileTypes:true});if(names.length>4096)throw fault('Managed temporary parent exceeds bounded scan limit; no child started','OWNED_TEST_BUDGET_EXCEEDED');
 const roots=new Map();let sharedBytes=0,ownBytes=0,ownRoots=0,remaining=limits.maxEntries;
 // Only immediate, exact owned-prefix roots are measured. Other files and
 // other sources are never cleaned, moved, or rewritten.
 for(const entry of names)if(entry.name.startsWith(PREFIX)){
  const root=path.join(tempParent,entry.name),marker=validateRetained(root,tempParent),usage=inspectOwnedTree(root,{maxEntries:remaining});remaining-=usage.entries;sharedBytes+=usage.bytes;roots.set(root,{marker,usage});
  if(normalized(marker.sourceRoot)===normalized(source)){
   ownRoots++;ownBytes+=usage.bytes;
   if(!index.runs[marker.runId])index.runs[marker.runId]={root,owner:marker,receipt:null,state:'untracked-retained',startedAt:marker.createdAt};
  }
 }
 for(const [runId,row]of Object.entries(index.runs)){
  if(!row||typeof row.root!=='string'||!row.owner||row.owner.runId!==runId||typeof row.state!=='string')throw fault('Invalid retention row; evidence retained','OWNED_TEST_RETENTION_UNVERIFIED');
  if(fs.existsSync(row.root)){
   // An explicit override may select a new parent. Recheck only the exact old
   // indexed root; never enumerate its parent or silently forgive its budget.
   if(!path.isAbsolute(row.root)||normalized(row.root)!==normalized(path.resolve(row.owner.root)))throw fault('Retained run moved from its recorded root','OWNED_TEST_RETENTION_UNVERIFIED');
   const known=roots.get(row.root),marker=known?.marker??validateRetained(row.root,path.dirname(row.root),source);if(normalized(marker.sourceRoot)!==normalized(source)||marker.runId!==runId||JSON.stringify(marker.rootIdentity)!==JSON.stringify(row.owner.rootIdentity))throw fault('Retained run identity changed','OWNED_TEST_RETENTION_UNVERIFIED');
   if(!known){const usage=inspectOwnedTree(row.root,{maxEntries:remaining});remaining-=usage.entries;ownRoots++;ownBytes+=usage.bytes;}
  }else if(row.state!=='passed-cleaned')row.state='missing-retained';
 }
 const write=()=>{index.updatedAt=new Date().toISOString();const retired=Object.entries(index.runs).filter(([,row])=>row.state==='passed-cleaned'||row.state==='missing-retained').sort((a,b)=>String(b[1].endedAt??b[1].startedAt).localeCompare(String(a[1].endedAt??a[1].startedAt)));for(const [key]of retired.slice(128))delete index.runs[key];updateJson(file,index);};
 write();
 if(ownRoots>=limits.maxRetainedRoots||ownBytes>=limits.maxRetainedBytes||sharedBytes>=limits.maxSharedBytes){const error=fault('Owned test retention budget reached; preserve evidence and resolve named retained runs before starting another child','OWNED_TEST_BUDGET_EXCEEDED');error.retention={index:file,ownRoots,ownBytes,sharedBytes,limits};throw error;}
 return {file,limits,record(result){index.runs[result.runId]={root:result.root,owner:result.owner,receipt:result.receipt,state:result.status,startedAt:result.startedAt,endedAt:result.endedAt??null,child:result.child??null};write();}};
}

function normalized(p){return process.platform==='win32'?p.toLowerCase():p;}
function inside(parent,child){const a=normalized(path.resolve(parent)),b=normalized(path.resolve(child));return b.startsWith(a+path.sep);}
function identity(p){const s=fs.lstatSync(p,{bigint:true});return {dev:String(s.dev),ino:String(s.ino)};}
function jsonFile(p,value){fs.writeFileSync(p,JSON.stringify(value,null,2)+'\n',{flag:'wx'});}
function updateJson(p,value){
 const tmp=p+'.'+randomUUID()+'.tmp';
 fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
 let lastError;
 for(const delay of RENAME_DELAYS_MS){
  if(delay)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,delay);
  try{fs.renameSync(tmp,p);return;}
  catch(error){
   lastError=error;
   if(process.platform!=='win32'||!['EPERM','EBUSY'].includes(error.code))break;
  }
 }
 try{fs.unlinkSync(tmp);}catch{}
 const failure=new Error('Atomic receipt update failed after bounded retries: '+String(lastError));
 failure.code=lastError?.code;
 failure.cause=lastError;
 throw failure;
}
function inspectOwnedTree(root,{maxEntries=RETENTION_DEFAULTS.maxEntries}={}){
 const pending=[{path:root,depth:0}],usage={measured:true,bytes:0,files:0,directories:1,links:0,entries:0};
 while(pending.length){
  const {path:dir,depth}=pending.pop();if(depth>64)throw fault('Owned test tree exceeds depth budget','OWNED_TEST_BUDGET_EXCEEDED');
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
   if(++usage.entries>maxEntries)throw fault('Owned test tree exceeds bounded inspection budget','OWNED_TEST_BUDGET_EXCEEDED');
   const item=path.join(dir,entry.name),st=fs.lstatSync(item);
   if(st.isSymbolicLink()||entry.isSymbolicLink()){usage.links++;continue;}
   if(st.isDirectory()){
    if(!inside(root,item))throw Error('Test item left owned root: '+item);
    usage.directories++;
    pending.push({path:item,depth:depth+1});
   }else if(st.isFile()){usage.files++;usage.bytes+=st.size;}
   else throw Error('Unsupported test item inside owned root: '+item);
  }
 }
 return usage;
}
function removeOwnedTree(root){
 function removeDirectory(dir){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
   const item=path.join(dir,entry.name),st=fs.lstatSync(item);
   if(st.isSymbolicLink())fs.unlinkSync(item);
   else if(st.isDirectory())removeDirectory(item);
   else if(st.isFile())fs.unlinkSync(item);
   else throw Error('Unsupported owned test item during cleanup: '+item);
  }
  fs.rmdirSync(dir);
 }
 removeDirectory(root);
}
function assertOwnedRoot(root,tempParent,owner){
 assert(path.isAbsolute(root),'Owned test root must be absolute');
 assert.equal(path.basename(root).startsWith(PREFIX),true,'Owned test root prefix differs');
 assert.equal(normalized(path.dirname(root)),normalized(tempParent),'Owned test root parent differs');
 assert.equal(normalized(fs.realpathSync(root)),normalized(root),'Owned test root was redirected');
 const st=fs.lstatSync(root);
 assert(st.isDirectory()&&!st.isSymbolicLink(),'Owned test root is not a plain directory');
 const marker=JSON.parse(fs.readFileSync(path.join(root,'.owner.json'),'utf8'));
 assert.equal(marker.kind,KIND);
 assert.equal(marker.runId,owner.runId);
 assert.equal(marker.ownerPid,process.pid);
 assert.equal(normalized(marker.root),normalized(root));
 assert.deepEqual(identity(root),owner.rootIdentity);
 assert.deepEqual(marker.rootIdentity,owner.rootIdentity);
 return inspectOwnedTree(root);
}
function retainedUsage(root,tempParent,owner){
 try{return assertOwnedRoot(root,tempParent,owner);}
 catch(error){return {measured:false,reason:compactError(error)};}
}
function testSelection(sourceRoot,files,selectionRoots){
 const roots=(selectionRoots?.length?selectionRoots:['test']).map(item=>{
  const root=fs.realpathSync(path.resolve(sourceRoot,item));
  if(!inside(sourceRoot,root)||!fs.statSync(root).isDirectory())throw Error('Test folder is outside source: '+item);
  return root;
 });
 const requested=files?.length?files:fs.readdirSync(roots[0]).filter(n=>n.endsWith('.test.mjs')).sort();
 if(!requested.length)throw Error('No test files selected');
 return requested.map(item=>{
  const file=path.isAbsolute(item)?path.resolve(item):path.resolve(roots[0],item);
  if(!roots.some(root=>inside(root,file))||!file.endsWith('.test.mjs'))throw Error('Test file outside selected folders: '+item);
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink())throw Error('Test file is not a regular file: '+item);
  if(normalized(fs.realpathSync(file))!==normalized(file))throw Error('Test file was redirected: '+item);
  return file;
 });
}
function capture(stream,logPath){
 const fd=fs.openSync(logPath,'wx'),hash=createHash('sha256');
 let bytes=0,written=0,error=null;
 stream.on('data',chunk=>{
  if(error){bytes+=chunk.length;return;}
  try{
   bytes+=chunk.length;
   hash.update(chunk);
   const allowed=Math.min(chunk.length,MAX_LOG_BYTES-written);
   if(allowed>0){fs.writeSync(fd,chunk,0,allowed);written+=allowed;}
  }catch(e){error=e;}
 });
 return {finish(){
  fs.closeSync(fd);
  return {path:logPath,bytes,written,truncated:bytes>written,sha256:hash.digest('hex'),error:error?String(error):null};
 }};
}
function compactError(e){return e?{name:e.name||'Error',message:String(e.message||e),code:e.code||null}:null;}

export function ownedTestCommand(sourceRoot,selected){
 const source=path.resolve(sourceRoot),files=selected.map(file=>{const relative=path.relative(source,file);if(!relative||path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))throw Error('Test command input is outside source');return relative;});
 return ['--test','--test-reporter=tap',...files];
}

export async function runOwnedTests({sourceRoot,testFiles,selectionRoots,receiptDirectory,tempBase,nodeExecutable=process.execPath,signal,retentionLimits:configuredLimits}={}){
 const source=fs.realpathSync(path.resolve(sourceRoot)),selected=testSelection(source,testFiles,selectionRoots);
 const receipts=path.resolve(receiptDirectory);
 noLinkedAncestors(receipts);fs.mkdirSync(receipts,{recursive:true});
 const requestedTemp=tempBase??resolveOwnedTestTempBase({sourceRoot:source});if(!path.isAbsolute(requestedTemp))throw fault('Owned temporary base must be absolute','OWNED_TEST_TEMP_INVALID');shortRootBudget(path.resolve(requestedTemp));noLinkedAncestors(requestedTemp);fs.mkdirSync(requestedTemp,{recursive:true});
 const tempParent=fs.realpathSync(path.resolve(requestedTemp));shortRootBudget(tempParent);
 if(!fs.statSync(tempParent).isDirectory())throw Error('Temporary parent is not a directory');
 const releaseSource=await acquireRunLease('source:'+normalized(source));let releaseParent;
 try{
 releaseParent=await acquireRunLease('parent:'+normalized(tempParent));
 const retention=prepareRetention(source,receipts,tempParent,configuredLimits);
 const root=fs.mkdtempSync(path.join(tempParent,PREFIX)),runId=randomUUID(),now=new Date().toISOString();
 const owner={kind:KIND,runId,ownerPid:process.pid,ownerBirthUtcApprox:new Date(Date.now()-process.uptime()*1000).toISOString(),ownerBirthSource:'node process.uptime',root,rootIdentity:identity(root),sourceRoot:source,createdAt:now};
 const marker=path.join(root,'.owner.json'),receipt=path.join(receipts,runId+'.json');
 jsonFile(marker,owner);
 const result={schemaVersion:1,kind:'ai-buddy-owned-test-run',runId,status:'starting',sourceRoot:source,testFiles:selected,root,owner,receipt,startedAt:now,nodeExecutable,command:ownedTestCommand(source,selected),logs:null,child:null,cleanup:null};
 jsonFile(receipt,result);
 retention.record(result);
 const logPaths={stdout:path.join(receipts,runId+'.stdout.tap'),stderr:path.join(receipts,runId+'.stderr.log')};
 let child=null,abortListener=null,spawnError=null,exitCode=null,exitSignal=null,stdout=null,stderr=null,exitPromise=null;
 try{
  updateJson(receipt,{...result,status:'launching'});
  const childEnv={...process.env,TEMP:root,TMP:root,TMPDIR:root,AI_BUDDY_PLUGIN_TEST_ROOT:root,AI_BUDDY_WORK_TEST_ROOT:root};
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;
  child=spawn(nodeExecutable,result.command,{cwd:source,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env:childEnv});
  result.child={pid:child.pid||null,spawnedAt:new Date().toISOString()};
  exitPromise=new Promise(resolve=>{
   child.once('error',e=>{spawnError=e;});
   child.once('close',(code,sig)=>{exitCode=code;exitSignal=sig;resolve();});
  });
  stdout=capture(child.stdout,logPaths.stdout);stderr=capture(child.stderr,logPaths.stderr);
  if(signal){
   abortListener=()=>{result.cancelRequestedAt=new Date().toISOString();if(child.pid)child.kill('SIGTERM');};
   signal.addEventListener('abort',abortListener,{once:true});
   if(signal.aborted)abortListener();
  }
  updateJson(receipt,{...result,status:'running'});
  retention.record({...result,status:'running'});
  await exitPromise;
 }catch(error){
  spawnError=error;
  if(child&&exitPromise){
   if(child.pid)try{child.kill('SIGTERM');}catch{}
   await exitPromise;
  }
 }
 finally{if(signal&&abortListener)signal.removeEventListener('abort',abortListener);}
 let logs;
 try{logs={stdout:stdout?.finish()||null,stderr:stderr?.finish()||null};}
 catch(error){spawnError=spawnError||error;logs={stdout:null,stderr:null,finishError:compactError(error)};}
 result.logs=logs;
 result.child={...result.child,exitCode,exitSignal,error:compactError(spawnError)};
 result.endedAt=new Date().toISOString();
 const failed=exitCode!==0||!!spawnError||!!result.cancelRequestedAt||logs.finishError||logs.stdout?.truncated||logs.stderr?.truncated||logs.stdout?.error||logs.stderr?.error;
 if(failed){
  result.status=result.cancelRequestedAt?'cancelled-retained':'failed-retained';
  result.cleanup={attempted:false,retainedRoot:root,reason:'failed, cancelled or incomplete test evidence',retainedUsage:retainedUsage(root,tempParent,owner)};
  updateJson(receipt,result);
  retention.record(result);
  return result;
 }
 result.status='passed-cleanup-pending';
 updateJson(receipt,result);
 try{
  assertOwnedRoot(root,tempParent,owner);
  removeOwnedTree(root);
  if(fs.existsSync(root))throw Error('Owned test root still exists after cleanup');
  result.status='passed-cleaned';
  result.cleanup={attempted:true,cleaned:true,root};
 }catch(error){
  result.status='cleanup-failed-retained';
  result.cleanup={attempted:true,cleaned:false,retainedRoot:root,error:compactError(error),retainedUsage:retainedUsage(root,tempParent,owner)};
 }
 updateJson(receipt,result);
 retention.record(result);
 return result;
 }finally{if(releaseParent)await releaseParent();await releaseSource();}
}

function parse(argv){
 const parsed={testFiles:[]};
 for(const arg of argv){
  if(arg.startsWith('--source='))parsed.sourceRoot=arg.slice(9);
  else if(arg.startsWith('--receipts='))parsed.receiptDirectory=arg.slice(11);
  else if(arg.startsWith('--test-file='))parsed.testFiles.push(arg.slice(12));
  else throw Error('Unknown argument: '+arg);
 }
 if(!parsed.sourceRoot||!parsed.receiptDirectory)throw Error('Required: --source=<absolute> --receipts=<absolute>');
 if(!path.isAbsolute(parsed.sourceRoot)||!path.isAbsolute(parsed.receiptDirectory))throw Error('Source and receipts must be absolute paths');
 return parsed;
}
async function main(){
 const controller=new AbortController();
 const interrupt=()=>controller.abort();
 process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
 try{
  const result=await runOwnedTests({...parse(process.argv.slice(2)),signal:controller.signal});
  console.log(JSON.stringify({status:result.status,receipt:result.receipt,exitCode:result.child?.exitCode,testFiles:result.testFiles.length,root:result.root}));
  if(result.status!=='passed-cleaned')process.exitCode=1;
 }catch(error){console.error(JSON.stringify({status:'runner-failed',error:compactError(error)}));process.exitCode=1;}
 finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
