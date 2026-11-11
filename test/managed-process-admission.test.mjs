import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createManagedProcessSupervisor} from '../src/managed-process-supervisor.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function fixture(t,{holdClose=false,holdReady=false}={}){
  const directory=await mkdtemp(join(tmpdir(),'core14-admission-contract-')),guardPath=join(directory,'guard.bytes');await writeFile(guardPath,'inert controlled guard image');
  const runtime=1000001,run=1000002,rows=[{pid:process.pid,parentPid:0,creationTime:'10',exeRealPath:process.execPath},{pid:runtime,parentPid:process.pid,creationTime:'20',exeRealPath:process.execPath},{pid:run,parentPid:runtime,creationTime:'30',exeRealPath:process.execPath}];
  const entered=deferred(),inventoryGate=deferred(),closeGate=deferred(),readyGate=deferred(),spawned=deferred(),children=[];let pauseInventory=false,readinessFault;
  const remove=pid=>{const index=rows.findIndex(row=>row.pid===pid);if(index>=0)rows.splice(index,1);};
  const inspect=async pid=>{if(pid==null&&pauseInventory){pauseInventory=false;entered.resolve();await inventoryGate.promise;}return structuredClone(readinessFault==='missing-helper'&&children.some(child=>child.pid===pid)?[]:pid==null?rows:rows.filter(row=>row.pid===pid));};
  const spawnImpl=(_path,args)=>{
    const child=Object.assign(new EventEmitter(),{pid:1100000+children.length,exitCode:null,stdout:new EventEmitter(),stderr:new EventEmitter(),ends:0});children.push(child);rows.push({pid:child.pid,parentPid:process.pid,creationTime:String(100+children.length),exeRealPath:process.execPath});
    child.stdin=Object.assign(new EventEmitter(),{writableEnded:false,destroyed:false,write(){throw Error('Admission contracts do not query Jobs');},end(){assert.equal(this.writableEnded,false);this.writableEnded=true;child.ends++;void(async()=>{if(holdClose)await closeGate.promise;remove(Number(args[2]));await writeFile(args[4],JSON.stringify({schemaVersion:1,guardId:args[5],ownerPid:Number(args[0]),ownerCreationTime:args[1],rootPid:Number(args[2]),rootCreationTime:args[3],activeProcesses:0}));remove(child.pid);child.exitCode=0;child.emit('exit',0,null);child.emit('close',0,null);})();}});
    const fault=readinessFault;spawned.resolve();void(async()=>{
      await Promise.resolve();if(holdReady)await readyGate.promise;
      if(fault==='never-assigned'||fault==='unverified-assignment'){
        remove(child.pid);child.exitCode=1;child.emit('exit',1,null);
        await Promise.resolve();
        child.stdout.emit('data',Buffer.from(JSON.stringify({ready:false,guardStage:'before-assignment',guardId:fault==='never-assigned'?args[5]:'wrong',ownerPid:Number(args[0]),ownerCreationTime:args[1],rootPid:Number(args[2]),rootCreationTime:args[3]})+'\n'));
        child.emit('close',1,null);return;
      }
      child.stdout.emit('data',Buffer.from(JSON.stringify(fault==='ready-false'?{ready:false,error:'Controlled readiness failure with child still live'}:{ready:true,ownerPid:fault==='wrong-owner'?process.pid+1:process.pid,rootPid:Number(args[2]),killOnOwnerExit:true,breakawayAllowed:false})+'\n'));
    })();return child;
  };
  const supervisor=createManagedProcessSupervisor({guardPath,statePath:join(directory,'state.json'),inspect,spawnImpl,onState:event=>{if(readinessFault==='post-ready-error'&&event.type==='guard-ready')throw Error('Controlled readiness publication failure');}});
  t.after(async()=>{inventoryGate.resolve();readyGate.resolve();closeGate.resolve();for(const child of children)if(child.exitCode==null&&!child.stdin.writableEnded)child.stdin.end('close\n');for(let n=0;n<100&&children.some(child=>child.exitCode==null);n++)await delay(5);await supervisor.close().catch(()=>{});assert.ok(resolve(directory).startsWith(resolve(tmpdir())));await rm(directory,{recursive:true,force:true});});
  return {supervisor,runtime,run,children,entered,inventoryGate,closeGate,readyGate,spawned,pause:()=>{pauseInventory=true;},fault:value=>{readinessFault=value;}};
}

for(const method of ['registerRoot','register','registerTaskRoot'])test(method+' cannot commit a guard after close completed during inventory',async t=>{
  const f=await fixture(t);if(method==='register')await f.supervisor.registerRoot({runtimeId:'native',pid:f.runtime});
  const initialSpawns=f.children.length;f.pause();
  const spec=method==='registerRoot'?{runtimeId:'native',pid:f.runtime}:method==='register'?{jobId:'job',runId:'run',pid:f.run,nativeHostInstanceId:'native'}:{jobId:'job',runId:'run',runtimeId:'task-tools',pid:f.runtime,expectedNodePath:process.execPath,expectedNodeHash:createHash('sha256').update(await readFile(process.execPath)).digest('hex')};
  const pending=f.supervisor[method](spec).then(value=>({status:'fulfilled',value}),error=>({status:'rejected',message:error.message}));await f.entered.promise;
  await f.supervisor.close();f.inventoryGate.resolve();const outcome=await pending;
  assert.equal(outcome.status,'rejected');assert.equal(f.children.length,initialSpawns);assert.equal(f.supervisor.snapshot().osGuards,0);assert.equal(f.supervisor.snapshot().managedRuntimes,0);
});

test('same runtime/PID/birth registration rejects immediately while its guard is retiring',async t=>{
  const f=await fixture(t,{holdClose:true});await f.supervisor.registerRoot({runtimeId:'same',pid:f.runtime});const release=f.supervisor.releaseRoot({runtimeId:'same'});
  for(let n=0;n<100&&!f.children[0].ends;n++)await delay(1);assert.equal(f.children[0].ends,1);
  const outcome=await Promise.race([f.supervisor.registerRoot({runtimeId:'same',pid:f.runtime}).then(value=>({status:'fulfilled',value}),error=>({status:'rejected',message:error.message})),delay(200).then(()=>({status:'blocked'}))]);
  f.closeGate.resolve();await release;assert.equal(outcome.status,'rejected');assert.equal(f.children.length,1);assert.equal(f.supervisor.snapshot().osGuards,0);assert.equal(f.supervisor.snapshot().managedRuntimes,0);
});

test('close fences a spawned admission, waits for its guard, and closes it without returning a live proof',async t=>{
  const f=await fixture(t,{holdReady:true}),admission=f.supervisor.registerRoot({runtimeId:'pending',pid:f.runtime}).then(value=>({status:'fulfilled',value}),error=>({status:'rejected',message:error.message}));
  await f.spawned.promise;let closed=false;const close=f.supervisor.close().then(()=>{closed=true;});await delay(10);assert.equal(closed,false);
  f.readyGate.resolve();const outcome=await admission;await close;assert.equal(outcome.status,'rejected');assert.equal(f.children[0].ends,1);assert.equal(f.supervisor.snapshot().osGuards,0);
});

for(const method of ['registerRoot','register'])for(const fault of ['ready-false','wrong-owner','missing-helper','post-ready-error'])test(method+' failed guard '+fault+' cannot become authority on retry and remains cleanable',async t=>{
  const f=await fixture(t);if(method==='register')await f.supervisor.registerRoot({runtimeId:'native',pid:f.runtime});const initial=f.children.length;f.fault(fault);
  const spec=method==='registerRoot'?{runtimeId:'native',pid:f.runtime}:{jobId:'job',runId:'run',pid:f.run,nativeHostInstanceId:'native'};
  const invoke=()=>f.supervisor[method](spec).then(value=>({status:'fulfilled',value}),error=>({status:'rejected',message:error.message}));
  const first=await invoke(),second=await invoke();assert.equal(first.status,'rejected');assert.equal(second.status,'rejected');assert.equal(f.children.length,initial+1);
  assert.equal(f.children.at(-1).exitCode,null);assert.equal(f.children.at(-1).stdin.writableEnded,false);await f.supervisor.close();assert.equal(f.children.at(-1).ends,1);assert.equal(f.supervisor.snapshot().osGuards,0);
});

test('an inert QQ attempt can retire its assigned guard even when root admission failed',async t=>{
  const f=await fixture(t),runtimeId='qq:partial';
  f.fault('missing-helper');
  await assert.rejects(f.supervisor.registerRoot({runtimeId,pid:f.runtime}),{code:'WORK_PROCESS_GUARD_FAILED'});
  await assert.rejects(f.supervisor.releaseRoot({runtimeId}),{code:'WORK_PROCESS_STOP_UNCONFIRMED'});
  const proof=await f.supervisor.releaseRoot({runtimeId,allowUnassigned:true});
  assert.equal(proof.stopped,true);
  assert.equal(proof.osActiveProcesses,0);
  assert.equal(proof.pid,f.runtime);
  assert.equal(f.children[0].ends,1);
  assert.deepEqual(await f.supervisor.releaseRoot({runtimeId,allowUnassigned:true}),proof);
  assert.equal(f.supervisor.snapshot().osGuards,0);
});

test('releasing an inert QQ attempt fences registration before any guard can launch',async t=>{
  const f=await fixture(t),runtimeId='qq:no-guard';
  f.pause();
  const registering=f.supervisor.registerRoot({runtimeId,pid:f.runtime});
  const rejected=assert.rejects(registering,{code:'WORK_PROCESS_ADMISSION_CLOSED'});
  await f.entered.promise;
  const proof=await f.supervisor.releaseRoot({runtimeId,allowUnassigned:true});
  assert.equal(proof.stopped,true);
  assert.equal(proof.unassigned,true);
  assert.equal(proof.osActiveProcesses,undefined);
  await assert.rejects(f.supervisor.releaseRoot({runtimeId}),{code:'WORK_PROCESS_STOP_UNCONFIRMED'});
  f.inventoryGate.resolve();
  await rejected;
  assert.equal(f.children.length,0);
  await assert.rejects(f.supervisor.registerRoot({runtimeId,pid:f.runtime}),{code:'WORK_PROCESS_ADMISSION_CLOSED'});
});

test('an inert QQ attempt requires an exact native before-assignment outcome even if it arrives after exit',async t=>{
  for(const fault of ['never-assigned','unverified-assignment']){
    const f=await fixture(t),runtimeId='qq:'+fault;f.fault(fault);
    await assert.rejects(f.supervisor.registerRoot({runtimeId,pid:f.runtime}),{code:'WORK_PROCESS_GUARD_FAILED'});
    const release=()=>f.supervisor.releaseRoot({runtimeId,allowUnassigned:true});
    if(fault==='never-assigned'){
      const proof=await release();
      assert.equal(proof.unassigned,true);
      assert.equal(proof.osActiveProcesses,undefined);
      assert.equal(f.supervisor.snapshot().osGuards,0);
    }else{
      await assert.rejects(release(),{code:'WORK_PROCESS_STOP_UNCONFIRMED'});
      assert.equal(f.supervisor.snapshot().osGuards,1);
    }
  }
});
