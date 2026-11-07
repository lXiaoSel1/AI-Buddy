// Read-only host-boundary probe. Root is the only test runner for this batch.
// Actual main IPC handler + actual reservation; Electron/downstream game are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createUpdateReservation} from '../src/update-reservation.mjs';

const main=await readFile(new URL('../src/main.mjs',import.meta.url),'utf8');
const start=main.indexOf("ipcMain.handle('game:action',");
const end=main.indexOf("ipcMain.handle('pet:story-feedback'",start);
assert(start>=0&&end>start,'actual game IPC extraction anchors must exist');
const gateDeclarations=['gameReads','gameStops'].map(name=>{
  const line=main.split(/\r?\n/).find(line=>line.startsWith(`const ${name}=`));
  assert(line,`actual ${name} declaration must exist`);
  return line;
}).join('\n');

function fixture(){
  let handler;
  const calls=[];
  const reservation=createUpdateReservation();
  const context={
    ipcMain:{handle:(channel,callback)=>{assert.equal(channel,'game:action');handler=callback;}},
    updateReservation:reservation,importBarrier:false,startupFailure:null,
    provider:{enabled:true},gameRequests:0,activityClock:{busy:new Set()},panel:null,
    game:{action:async(action,args)=>{calls.push({action,args});return {ok:true};}},
    assertImportIdle:()=>{},measureDesktopDiagnostic:(_name,run)=>run(),
    petEvent:()=>{},feedback:()=>{},userStopped:()=>false,
  };
  vm.runInNewContext(gateDeclarations+'\n'+main.slice(start,end),context,{filename:'actual-main-game-handler.mjs'});
  reservation.reserve('synthetic-update-owner');
  return {call:(action,args={})=>handler({sender:{}},action,args),calls,reservation};
}

test('control: existing private cancel reaches the game during an update reservation',async()=>{
  const f=fixture();
  await f.call('companion-chat-cancel');
  assert.equal(f.calls.length,1);
});

for(const action of ['auto-pause','auto-stop'])test(`actual nested ${action} remains reachable while update drains`,async()=>{
  const f=fixture();
  await f.call('companion-r95',{action,args:{groupId:'synthetic-group'}});
  assert.equal(f.calls.length,1,'the actual cancellation command must reach the existing operation');
});

test('control: starting new Auto remains rejected while an update reserves admission',async()=>{
  const f=fixture();
  await assert.rejects(f.call('companion-r95',{action:'auto-start',args:{groupId:'synthetic-group'}}),{code:'APP_UPDATE_RESERVED'});
  assert.equal(f.calls.length,0);
});
