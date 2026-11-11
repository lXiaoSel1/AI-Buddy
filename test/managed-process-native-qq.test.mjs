import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildManagedProcessGuard} from '../scripts/build-managed-process-guard.mjs';
import {windowsGuardProcessSnapshot} from '../src/managed-process-supervisor.mjs';

test('Windows guard separates never-assigned from failure to persist a zero-process receipt',{
  skip:process.platform!=='win32',timeout:20000
},async t=>{
  const root=await mkdtemp(join(tmpdir(),'buddy-qq-native-guard-'));
  const children=[];
  function start(file,args){
    const child=spawn(file,args,{windowsHide:true,stdio:['pipe','pipe','ignore']});
    const closed=once(child,'close');
    children.push({child,closed});
    return {child,closed};
  }
  t.after(async()=>{
    for(const {child,closed} of children){
      if(child.exitCode===null&&!child.stdin.destroyed)child.stdin.end();
      await closed;
    }
    assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));
    await rm(root,{recursive:true,force:true});
  });
  const guardExe=buildManagedProcessGuard(resolve(import.meta.dirname,'..'),root);
  const runtime=start(process.execPath,['-e','process.stdin.resume()']);
  await once(runtime.child,'spawn');
  const [owner]=await windowsGuardProcessSnapshot(guardExe,process.pid);
  const [target]=await windowsGuardProcessSnapshot(guardExe,runtime.child.pid);
  const receiptPath=join(root,'receipt.json');

  function guardFor(rootBirth){
    const guardId=randomUUID();
    const guard=start(guardExe,[String(owner.pid),owner.creationTime,String(target.pid),rootBirth,receiptPath,guardId]);
    const messages=[];
    const lines=createInterface({input:guard.child.stdout});
    lines.on('line',line=>messages.push(JSON.parse(line)));
    return {...guard,guardId,messages,lines};
  }

  const wrongBirth=String(BigInt(target.creationTime)+1n);
  const unassigned=guardFor(wrongBirth);
  assert.equal((await unassigned.closed)[0],1);
  assert.equal(runtime.child.exitCode,null);
  assert.deepEqual(unassigned.messages.map(({ready,guardStage})=>({ready,guardStage})),[{ready:false,guardStage:'before-assignment'}]);
  assert.equal(unassigned.messages[0].guardId,unassigned.guardId);
  assert.equal(unassigned.messages[0].rootCreationTime,wrongBirth);

  await writeFile(receiptPath,'occupied');
  const assigned=guardFor(target.creationTime);
  const [readyLine]=await once(assigned.lines,'line');
  assert.equal(JSON.parse(readyLine).ready,true);
  assigned.child.stdin.end('close\n');
  assert.equal((await assigned.closed)[0],1);
  await runtime.closed;
  const terminal=assigned.messages.at(-1);
  assert.equal(terminal.guardStage,'receipt-persist');
  assert.equal(terminal.guardId,assigned.guardId);
  assert.equal(terminal.rootCreationTime,target.creationTime);
  assert.equal(await readFile(receiptPath,'utf8'),'occupied');
  const pending=JSON.parse(await readFile(receiptPath+'.pending','utf8'));
  assert.equal(pending.guardId,assigned.guardId);
  assert.equal(pending.activeProcesses,0);
});
