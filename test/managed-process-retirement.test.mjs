import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,readFile,mkdir,readdir,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename,resolve,sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createManagedProcessSupervisor} from '../src/managed-process-supervisor.mjs';

// Controlled OS inventory/Job Object transport contracts. The separate Windows
// fixture verifies these behaviours with real owned processes and the pinned exe.
async function fixture(t,{tamper,exitCode=0,replyDelay=0,holdReceipt=false,terminalStage}={}){
  const directory=await mkdtemp(join(tmpdir(),'core14-guard-contract-')),guardPath=join(directory,'guard.bytes'),statePath=join(directory,'state.json');
  await writeFile(guardPath,'controlled guard image, not executable');
  const runtime=1000001,runA=1000002,runB=1000003;
  const rows=[{pid:process.pid,parentPid:0,creationTime:'10',exeRealPath:process.execPath},{pid:runtime,parentPid:process.pid,creationTime:'20',exeRealPath:process.execPath},{pid:runA,parentPid:runtime,creationTime:'30',exeRealPath:process.execPath},{pid:runB,parentPid:runtime,creationTime:'40',exeRealPath:process.execPath}];
  const children=new Map(),events=[];let sequence=0,writesAfterEnd=0;
  const remove=pid=>{const index=rows.findIndex(row=>row.pid===pid);if(index>=0)rows.splice(index,1);};
  const spawnImpl=(_path,args)=>{
    const rootPid=Number(args[2]),child=Object.assign(new EventEmitter(),{pid:1100000+(++sequence),exitCode:null,stdout:new EventEmitter(),stderr:new EventEmitter(),ends:0,active:1,queries:0,args});
    rows.push({pid:child.pid,parentPid:process.pid,creationTime:String(100+sequence),exeRealPath:process.execPath});
    child.stdin=Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false,write(line,callback){
      if(this.writableEnded){writesAfterEnd++;throw Error('write after end');}child.queries++;
      setTimeout(()=>{child.stdout.emit('data',Buffer.from(JSON.stringify({requestId:line.trim().slice(7),activeProcesses:child.active})+'\n'));callback?.();},replyDelay);
      return true;
    },end(){assert.equal(this.writableEnded,false,'guard pipe may only close once');this.writableEnded=true;child.ends++;
      void delay(replyDelay).then(async()=>{remove(rootPid);child.active=0;const receipt={schemaVersion:1,guardId:args[5],ownerPid:Number(args[0]),ownerCreationTime:args[1],rootPid,rootCreationTime:args[3],activeProcesses:0};child.writeReceipt=(path=args[4])=>writeFile(path,JSON.stringify(tamper?tamper(receipt):receipt));if(holdReceipt!==true&&holdReceipt!==rootPid)await child.writeReceipt();remove(child.pid);child.exitCode=exitCode;child.emit('exit',exitCode,null);if(terminalStage)child.stdout.emit('data',Buffer.from(JSON.stringify({...receipt,ready:false,guardStage:terminalStage})+'\n'));child.emit('close',exitCode,null);});
    }});
    children.set(rootPid,child);
    queueMicrotask(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({ready:true,ownerPid:process.pid,rootPid,killOnOwnerExit:true,breakawayAllowed:false})+'\n')));
    return child;
  };
  const create=()=>createManagedProcessSupervisor({guardPath,statePath,inspect:async pid=>structuredClone(pid==null?rows:rows.filter(row=>row.pid===pid)),spawnImpl,onState:e=>events.push(e)});
  const supervisor=create();
  t.after(async()=>{await supervisor.close().catch(()=>{});assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep)&&basename(directory).startsWith('core14-guard-contract-'));await rm(directory,{recursive:true,force:true});});
  await supervisor.registerRoot({runtimeId:'native',pid:runtime});
  const register=(jobId='job-a',runId='run-a',pid=runA)=>supervisor.register({jobId,runId,pid,nativeHostInstanceId:'native'});
  return {supervisor,register,create,children,events,rows,remove,runtime,runA,runB,directory,statePath,guardPath,writesAfterEnd:()=>writesAfterEnd};
}

test('natural root and Job Object zero retire the guard and retain a durable exact stop receipt',async t=>{
  const f=await fixture(t),record=await f.register(),child=f.children.get(f.runA);f.remove(f.runA);child.active=0;
  const proof=await f.supervisor.awaitStopped({jobId:'job-a',runId:'run-a',timeoutMs:0});
  assert.equal(proof.stopped,true);assert.equal(proof.osActiveProcesses,0);assert.equal(child.ends,1);assert.equal(f.supervisor.snapshot().osGuards,1);
  const receipt=JSON.parse(await readFile(record.guardProof.receiptPath,'utf8')),stored=JSON.parse(await readFile(f.statePath,'utf8')).records[0];
  assert.equal(receipt.guardId,record.guardProof.guardId);assert.equal(receipt.rootCreationTime,record.creationTime);assert.deepEqual(stored.stoppedProof,receipt);
  for(let n=0;n<3;n++)assert.equal((await f.supervisor.awaitStopped({jobId:'job-a',timeoutMs:0})).stopped,true);
  assert.equal(child.ends,1);assert.equal(f.events.filter(e=>e.type==='guard-retired'&&e.key.startsWith('run:')).length,1);
  const recovered=f.create();assert.equal((await recovered.status({jobId:'job-a'})).stopped,true);await recovered.close();
});

test('root PID absent while a detached descendant remains never retires or releases the run',async t=>{
  const f=await fixture(t);await f.register();const child=f.children.get(f.runA);f.remove(f.runA);child.active=1;
  const running=await f.supervisor.awaitStopped({jobId:'job-a',timeoutMs:0});assert.equal(running.stopped,false);assert.equal(running.osActiveProcesses,1);assert.equal(child.ends,0);
  child.active=0;assert.equal((await f.supervisor.awaitStopped({jobId:'job-a',timeoutMs:0})).stopped,true);assert.equal(child.ends,1);
});

test('a still-observed exact root birth cannot be retired on an inconsistent Job zero reply',async t=>{
  const f=await fixture(t);await f.register();const child=f.children.get(f.runA);child.active=0;
  const proof=await f.supervisor.status({jobId:'job-a'});assert.equal(proof.stopped,false);assert.equal(child.ends,0);assert.equal(proof.unconfirmed[0].reason,'root-still-observed');
});

test('parallel status, awaitStopped, stopOwned and close share one close without writes after end',async t=>{
  const f=await fixture(t,{replyDelay:5});await f.register();const child=f.children.get(f.runA);f.remove(f.runA);child.active=0;
  const values=await Promise.all([...Array.from({length:12},(_,n)=>n%2?f.supervisor.status({jobId:'job-a'}):f.supervisor.awaitStopped({jobId:'job-a',timeoutMs:0})),f.supervisor.stopOwned({jobId:'job-a',timeoutMs:0}),f.supervisor.close(),f.supervisor.close()]);
  assert.ok(values.slice(0,13).every(v=>v.stopped));assert.equal(child.ends,1);assert.equal(f.supervisor.snapshot().osGuards,0);assert.equal(f.writesAfterEnd(),0);
});

test('retiring one job/run leaves another active run and Native runtime guards intact',async t=>{
  const f=await fixture(t);await f.register();await f.register('job-b','run-b',f.runB);const a=f.children.get(f.runA),b=f.children.get(f.runB);f.remove(f.runA);a.active=0;
  assert.equal((await f.supervisor.status({jobId:'job-a',runId:'run-a'})).stopped,true);assert.equal(a.ends,1);assert.equal(b.ends,0);assert.equal(f.children.get(f.runtime).ends,0);assert.equal(f.supervisor.snapshot().osGuards,2);
  assert.equal((await f.supervisor.status({jobId:'job-b'})).stopped,false);
});

for(const field of ['guardId','ownerPid','ownerCreationTime','rootPid','rootCreationTime','activeProcesses'])test('a durable receipt with changed '+field+' never confirms the run stopped',async t=>{
  const f=await fixture(t,{tamper:value=>({...value,[field]:typeof value[field]==='number'?value[field]+1:'wrong'})});await f.register();f.remove(f.runA);f.children.get(f.runA).active=0;
  const proof=await f.supervisor.awaitStopped({jobId:'job-a',timeoutMs:0});assert.equal(proof.stopped,false);assert.equal(proof.unconfirmed.length,1);assert.equal(f.supervisor.snapshot().osGuards,2);
  await assert.rejects(f.supervisor.stopOwned({jobId:'job-a',timeoutMs:0}));
});

test('guard failure and guard image drift retain uncertainty instead of accepting root disappearance',async t=>{
  for(const mode of ['exit','image']){const f=await fixture(t,{exitCode:mode==='exit'?1:0});await f.register();f.remove(f.runA);f.children.get(f.runA).active=0;if(mode==='image')await writeFile(f.guardPath,'changed image');
    assert.equal((await f.supervisor.status({jobId:'job-a'})).stopped,false);assert.equal(f.supervisor.snapshot().osGuards,2);
  }
});

test('runtime releaseRoot is idempotent with concurrent close and preserves exact durable identity',async t=>{
  const f=await fixture(t,{replyDelay:3});const values=await Promise.all([f.supervisor.releaseRoot({runtimeId:'native'}),f.supervisor.releaseRoot({runtimeId:'native'}),f.supervisor.close()]);
  assert.equal(values[0].stopped,true);assert.deepEqual(values[0],values[1]);assert.equal(f.children.get(f.runtime).ends,1);assert.equal(f.supervisor.snapshot().osGuards,0);
});

test('runtime release can recheck a temporarily unavailable receipt without closing the guard twice',async t=>{
  const f=await fixture(t,{holdReceipt:true}),child=f.children.get(f.runtime);
  const release=()=>f.supervisor.releaseRoot({runtimeId:'native'});
  await assert.rejects(release,{code:'ENOENT'});
  assert.throws(()=>f.supervisor.rootCustody({runtimeId:'native',pid:f.runtime,creationTime:'20'}),{code:'WORK_PROCESS_GUARD_UNAVAILABLE'});
  await child.writeReceipt();
  const proof=await release();
  assert.equal(proof.stopped,true);assert.equal(proof.pid,f.runtime);
  assert.deepEqual(await release(),proof);assert.equal(child.ends,1);
});

test('global close retires independent guards and only retries the one missing its receipt',async t=>{
  const f=await fixture(t,{holdReceipt:1000001});
  await f.supervisor.registerRoot({runtimeId:'other',pid:f.runA});
  const blocked=f.children.get(f.runtime),independent=f.children.get(f.runA);
  await assert.rejects(f.supervisor.close(),{code:'ENOENT'});
  assert.equal(blocked.ends,1);
  assert.equal(independent.ends,1);
  assert.equal(f.supervisor.snapshot().osGuards,1);
  assert.equal((await f.supervisor.releaseRoot({runtimeId:'other'})).stopped,true);
  await assert.rejects(f.supervisor.registerRoot({runtimeId:'another',pid:f.runB}),{code:'WORK_PROCESS_ADMISSION_CLOSED'});
  await blocked.writeReceipt();
  await Promise.all([f.supervisor.close(),f.supervisor.close()]);
  assert.equal((await f.supervisor.releaseRoot({runtimeId:'native'})).stopped,true);
  assert.equal(blocked.ends,1);
  assert.equal(independent.ends,1);
  assert.equal(f.supervisor.snapshot().osGuards,0);
});

test('a QQ zero-observed native failure can recheck only an exact final stop receipt',async t=>{
  const f=await fixture(t,{exitCode:1,holdReceipt:1000002,terminalStage:'receipt-persist'});
  const runtimeId='qq:receipt-recheck';
  await f.supervisor.registerRoot({runtimeId,pid:f.runA});
  const child=f.children.get(f.runA),release=()=>f.supervisor.releaseRoot({runtimeId});
  const expected={code:'WORK_PROCESS_STOP_UNCONFIRMED',guardStage:'receipt-persist'};
  await assert.rejects(release(),expected);
  await child.writeReceipt(child.args[4]+'.pending');
  await assert.rejects(release(),expected);
  await child.writeReceipt();
  const proof=await release();
  assert.equal(proof.stopped,true);
  assert.equal(proof.osActiveProcesses,0);
  assert.equal(child.ends,1);
  assert.deepEqual(await release(),proof);
});

test('QQ cleanup can publish a fully flushed receipt after its native publication failed',async t=>{
  const f=await fixture(t,{exitCode:1,holdReceipt:1000002,terminalStage:'receipt-publish'});
  const runtimeId='qq:publication-retry';
  await f.supervisor.registerRoot({runtimeId,pid:f.runA});
  const child=f.children.get(f.runA),release=()=>f.supervisor.releaseRoot({runtimeId});
  await assert.rejects(release(),{code:'WORK_PROCESS_STOP_UNCONFIRMED'});
  await child.writeReceipt(child.args[4]+'.pending');
  await writeFile(child.args[4],'blocked by another writer',{flag:'wx'});
  await assert.rejects(release(),{code:'WORK_PROCESS_STOP_UNCONFIRMED',guardStage:'receipt-publish'});
  assert.equal(await readFile(child.args[4],'utf8'),'blocked by another writer');
  await unlink(child.args[4]);
  const proof=await release();
  assert.equal(proof.stopped,true);
  assert.equal(proof.osActiveProcesses,0);
  assert.equal(JSON.parse(await readFile(proof.receiptPath,'utf8')).guardId,proof.guardId);
  assert.deepEqual(await release(),proof);
  assert.equal(child.ends,1);
});

test('unverified shutdown and non-QQ paths still reject a nonzero guard exit with a final file',async t=>{
  for(const [runtimeId,terminalStage] of [['qq:stop-unverified','assigned'],['work-runtime','receipt-committed']]){
    const f=await fixture(t,{exitCode:1,terminalStage});
    await f.supervisor.registerRoot({runtimeId,pid:f.runA});
    await assert.rejects(f.supervisor.releaseRoot({runtimeId}),{code:'WORK_PROCESS_STOP_UNCONFIRMED',guardStage:terminalStage});
  }
});

test('successful new-born admission invalidates only that runtime prior release receipt',async t=>{
  for(const reusedPid of [false,true]){
    const f=await fixture(t),first=await f.supervisor.releaseRoot({runtimeId:'native'});
    const pid=reusedPid?f.runtime:1000009,birth='900';
    f.rows.push({pid,parentPid:process.pid,creationTime:birth,exeRealPath:process.execPath});
    const admitted=await f.supervisor.registerRoot({runtimeId:'native',pid});assert.equal(admitted.creationTime,birth);
    const second=await f.supervisor.releaseRoot({runtimeId:'native'});assert.equal(second.pid,pid);assert.notEqual(second.guardId,first.guardId);
    const receipt=JSON.parse(await readFile(second.receiptPath,'utf8'));assert.equal(receipt.rootCreationTime,birth);assert.equal(f.children.get(pid).ends,1);
    assert.deepEqual(await f.supervisor.releaseRoot({runtimeId:'native'}),second);
  }
});

test('a new root cannot replace the same runtime while its old guard release is still in flight',async t=>{
  const f=await fixture(t,{replyDelay:30}),first=f.supervisor.releaseRoot({runtimeId:'native'}),pid=1000010;
  f.rows.push({pid,parentPid:process.pid,creationTime:'901',exeRealPath:process.execPath});
  await assert.rejects(f.supervisor.registerRoot({runtimeId:'native',pid}),error=>error.code==='WORK_PROCESS_GUARD_UNAVAILABLE'||/identity changed/.test(error.message));
  const old=await first,admitted=await f.supervisor.registerRoot({runtimeId:'native',pid});assert.equal(admitted.creationTime,'901');
  const current=await f.supervisor.releaseRoot({runtimeId:'native'});assert.equal(current.pid,pid);assert.notEqual(current.guardId,old.guardId);assert.deepEqual(await f.supervisor.releaseRoot({runtimeId:'native'}),current);
});

test('concurrent recovery never accepts an old cached zero without its durable receipt',async t=>{
  const f=await fixture(t);const record=await f.register();f.remove(f.runA);await writeFile(f.statePath,JSON.stringify({version:1,records:[{...record,stoppedProof:{guardId:record.guardProof.guardId,activeProcesses:0}}]}));
  const recovered=f.create(),values=await Promise.all(Array.from({length:10},()=>recovered.status({jobId:'job-a'})));
  assert.ok(values.every(v=>v.registered===1&&!v.stopped&&v.unconfirmed.length===1));await recovered.close();
});

async function coldFixture(t,body){
  const directory=await mkdtemp(join(tmpdir(),'core16-cold-close-')),data=join(directory,'data'),statePath=join(data,'work-host','owned-processes.json');await mkdir(data);
  if(body!==undefined){await mkdir(join(data,'work-host'));await writeFile(statePath,body);await writeFile(join(data,'keep.txt'),'existing user evidence must remain byte exact\n');}
  let inspections=0,spawns=0;
  const supervisor=createManagedProcessSupervisor({guardPath:join(directory,'never-executed.exe'),statePath,inspect:async()=>{inspections++;return [];},spawnImpl:()=>{spawns++;throw Error('Cold close must never create a native process');}});
  async function snapshot(){const rows=[];async function visit(path,prefix=''){for(const entry of await readdir(path,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isDirectory()){rows.push({path:name,directory:true});await visit(join(path,entry.name),name+'/');}else rows.push({path:name,bytes:await readFile(join(path,entry.name),'hex')});}}await visit(data);return rows.sort((a,b)=>a.path.localeCompare(b.path));}
  t.after(async()=>{await supervisor.close().catch(()=>{});assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep)&&basename(directory).startsWith('core16-cold-close-'));await rm(directory,{recursive:true,force:true});});
  return {supervisor,snapshot,inspections:()=>inspections,spawns:()=>spawns};
}

for(const readMissingFirst of [false,true])test('cold missing state stays untouched after '+(readMissingFirst?'status read then ':'')+'concurrent close',async t=>{
  const f=await coldFixture(t),before=await f.snapshot();if(readMissingFirst)assert.equal((await f.supervisor.status()).registered,0);
  await Promise.all([f.supervisor.close(),f.supervisor.close()]);await f.supervisor.close();assert.deepEqual(await f.snapshot(),before);assert.equal(f.spawns(),0);assert.equal(f.inspections(),readMissingFirst?1:0);
});

for(const nonempty of [false,true])for(const readFirst of [false,true])test('cold '+(nonempty?'nonempty':'empty')+' persisted state keeps exact bytes through '+(readFirst?'status then ':'')+'close while loading records',async t=>{
  const records=nonempty?[{id:'old',jobId:'old-job',runId:'old-run',nativeHostInstanceId:'old-native',pid:424242,parentPid:1,creationTime:'20',exeRealPath:process.execPath,guardProof:{},preservedField:'do not rewrite'}]:[];
  const body=JSON.stringify({version:1,records,unknownTopLevelEvidence:'preserve the old raw state, including whitespace'},null,3)+'\n\n',f=await coldFixture(t,body),before=await f.snapshot();
  if(readFirst){const value=await f.supervisor.status();assert.equal(value.registered,records.length);if(nonempty)assert.equal(value.stopped,false);}
  await f.supervisor.close();assert.equal(f.supervisor.snapshot().registeredProcesses,records.length,'close must really load persisted records instead of bypassing audit');assert.deepEqual(await f.snapshot(),before);assert.equal(f.spawns(),0);assert.equal(f.inspections(),readFirst?1:0);
});

for(const body of ['{"version":1, broken}\n','{"version":1,"records":42}\n'])test('cold corrupt persisted state rejects close and retains all original evidence',async t=>{
  const f=await coldFixture(t,body),before=await f.snapshot();await assert.rejects(f.supervisor.close());await assert.rejects(f.supervisor.close());assert.deepEqual(await f.snapshot(),before);assert.equal(f.spawns(),0);assert.equal(f.inspections(),0);
});
