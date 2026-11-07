import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAppUpdateBackend} from '../src/update-backend-client.mjs';
import {normalizedPipe} from '../src/installation-record.mjs';
import {createUpdateReservation} from '../src/update-reservation.mjs';
import {createUpdateService} from '../src/update-service.mjs';

test('a reservation drains existing work and rejects new work before granting quit', async () => {
  let finish;
  const gate=createUpdateReservation();
  const work=gate.run('chat',()=>new Promise(resolve=>{finish=resolve;}));
  assert.deepEqual(gate.reserve('mine').reasons,[{capability:'chat'}]);
  assert.throws(()=>gate.run('plugin',()=>assert.fail('new work ran')), {code:'APP_UPDATE_RESERVED'});
  assert.equal(gate.release('other'),false);
  assert.equal(gate.commit('mine').busy,true);
  finish();await work;
  assert.equal(gate.commit('mine').ok,true);
  assert.equal(gate.release('mine'),false);
  assert.equal(gate.active(),true);
});

test('failed and expired reservations release admission without granting stale quit',()=>{
  let now=0;
  const gate=createUpdateReservation({now:()=>now,reservationMs:10});
  assert.equal(gate.reserve('mine').ok,true);
  now=11;
  assert.equal(gate.commit('mine').ok,false);
  assert.equal(gate.run('import',()=>42),42);
  assert.equal(gate.reserve('other').ok,true);
  assert.equal(gate.release('other'),true);
  assert.equal(gate.active(),false);
});

test('checks pin the target, download cannot commit, and only live apply authorizes a reservation',async()=>{
  const selectionId='a'.repeat(64),calls=[];
  let service;
  service=createUpdateService({version:'2.0.7',build:'test',supported:true,run:async (op,ctx)=>{
    calls.push([op,ctx.selectionId]);
    if(op==='check')return {ok:true,stage:'available',version:'2.0.8',selectionId,installerBytes:40};
    assert.equal(ctx.selectionId,selectionId);
    if(op==='prepare')return {ok:true,stage:'ready',version:'2.0.8',selectionId,downloadBytes:90};
    assert.equal(service.permitsReservation(ctx.nonce),true);
    assert.equal(service.permitsReservation('foreign'),false);
    return {ok:true,stage:'completed',version:'2.0.8',selectionId};
  }});
  await assert.rejects(service.action('apply'),{code:'APP_UPDATE_INVALID_STATE'});
  await service.action('check');
  assert.equal(service.view().phase,'available');
  await service.action('download');
  assert.equal(service.view().phase,'ready');
  await service.action('apply');
  assert.equal(service.view().phase,'completed');
  assert.deepEqual(calls,[['check',undefined],['prepare',selectionId],['apply',selectionId]]);
});

test('failed check preserves rate-limit reason and permits a later manual retry',async()=>{
  let now=0,attempts=0;
  const service=createUpdateService({version:'2.0.7',build:'test',supported:true,now:()=>now,run:async()=>++attempts===1?{ok:false,code:'APP_UPDATE_RATE_LIMITED',retryAfterMs:10000}:{ok:true,stage:'current'}});
  await service.action('check');
  assert.equal(service.view().phase,'error');
  assert.equal(service.view().error,'APP_UPDATE_RATE_LIMITED');
  await service.action('check');assert.equal(attempts,1);
  now=10001;
  await service.action('check');assert.equal(service.view().phase,'current');
});

test('cancel releases a staged attempt without authorizing a second operation',async()=>{
  const selectionId='b'.repeat(64);
  const service=createUpdateService({version:'2.0.7',build:'test',supported:true,run:async (op,{signal})=>{
    if(op==='check')return {ok:true,stage:'available',version:'2.0.8',selectionId};
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    return {ok:false,code:'APP_UPDATE_CANCELLED'};
  }});
  await service.action('check');
  const pending=service.action('download');
  await assert.rejects(service.action('check'),{code:'APP_UPDATE_BUSY'});
  await service.action('cancel');await pending;
  assert.equal(service.view().phase,'available');
});

test('startup status disables new update operations until the persisted receipt is read',async()=>{
  let release;
  const result=new Promise(resolve=>{release=resolve;});
  const service=createUpdateService({version:'2.0.7',build:'test',supported:true,run:()=>result});
  service.start();
  assert.equal(service.view().phase,'initializing');
  await assert.rejects(service.action('check'),{code:'APP_UPDATE_BUSY'});
  release({ok:true,stage:'idle'});
  await result;await Promise.resolve();
  assert.equal(service.view().phase,'idle');
  service.close();
});

test('incompatible rollback requires recovery without offering a retry',async()=>{
  const selectionId='c'.repeat(64);
  const service=createUpdateService({version:'2.0.7',build:'test',supported:true,run:async op=>{
    if(op==='apply')return {ok:false,code:'APP_UPDATE_RECOVERY_REQUIRED'};
    return {ok:true,stage:op==='prepare'?'ready':'available',version:'2.0.8',selectionId};
  }});
  await service.action('check');await service.action('download');await service.action('apply');
  assert.equal(service.view().phase,'recovery-required');
  assert.equal(service.view().error,'APP_UPDATE_RECOVERY_REQUIRED');
  assert.equal(service.view().retryAction,null);
  await assert.rejects(service.action('apply'),{code:'APP_UPDATE_INVALID_STATE'});
});

test('a modified installed manager is rejected before process creation',async t=>{
  const root=await mkdtemp(join(tmpdir(),'app-update-identity-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const build=join(root,'builds','candidate'),dataRoot=join(root,'local','data-v003'),version='2.0.7';
  const record={version,build:'builds/candidate',edition:'30fps',manifestSha256:'e'.repeat(64),manager:`maintenance/${version}/AI Buddy Setup.exe`,managerProtocol:1,managerSha256:createHash('sha256').update('approved').digest('hex')};
  await mkdir(dataRoot,{recursive:true});await mkdir(join(root,'maintenance',version),{recursive:true});
  await writeFile(join(root,record.manager),'replaced');
  await writeFile(join(root,'local','installation.json'),JSON.stringify(record));
  await writeFile(join(root,'local','current-build.json'),JSON.stringify({appVersion:version,path:record.build,animationProfile:'30fps'}));
  const backend=createAppUpdateBackend({root,build,dataRoot,version,pipe:normalizedPipe(),installation:record,start:()=>assert.fail('unexpected process start')});
  assert.equal(backend.supported,true);
  await assert.rejects(backend.run('check',{nonce:'b'.repeat(64)}),{code:'APP_UPDATE_MANAGER_UNTRUSTED'});
});
