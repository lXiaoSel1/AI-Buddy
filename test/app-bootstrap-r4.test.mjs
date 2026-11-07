import test from 'node:test';
import assert from 'node:assert/strict';
import {createUpdateService} from '../src/update-service.mjs';

test('a healthy legacy installation checks, prepares and applies internally with one apply nonce reservation',async()=>{
  const id='a'.repeat(64),calls=[];let service;
  service=createUpdateService({version:'2.0.7',build:'legacy',supported:false,run:()=>assert.fail('legacy used registered manager'),bootstrapRun:async(op,ctx)=>{
    calls.push(op);
    if(op==='apply')assert.equal(service.permitsReservation(ctx.nonce),true);
    return {ok:true,stage:op==='check'?'available':op==='prepare'?'ready':'completed',selectionId:id,version:'2.0.8',migration:true};
  }});
  await service.action('bootstrap');
  assert.equal(service.view().phase,'available');
  await service.action('download');assert.equal(service.view().phase,'ready');
  await service.action('apply');assert.equal(service.view().phase,'completed');
  assert.deepEqual(calls,['check','prepare','apply']);
});

import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAppBootstrapBackend} from '../src/update-bootstrap-backend.mjs';
import {normalizedPipe} from '../src/installation-record.mjs';
import {releaseFixture} from './fixtures/app-update-r4.mjs';

async function legacy(t){
  const root=await mkdtemp(join(tmpdir(),'bootstrap-r4-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const record={schemaVersion:1,version:'2.0.7',build:'builds/legacy',runtime:'runtime/node',manager:'maintenance/2.0.5/AI Buddy Setup.exe',edition:'30fps',characters:['deepseek'],initialCharacter:'deepseek',packageHashes:{}};
  const pointer={version:'2.0.7',appVersion:'2.0.7',path:record.build,animationProfile:'30fps',runtime:{path:record.runtime}};
  await Promise.all([mkdir(join(root,record.build),{recursive:true}),mkdir(join(root,record.runtime),{recursive:true}),mkdir(join(root,'maintenance','2.0.5'),{recursive:true}),mkdir(join(root,'local','data-v003'),{recursive:true})]);
  await writeFile(join(root,record.manager),'legacy manager');await writeFile(join(root,'local','installation.json'),JSON.stringify(record));await writeFile(join(root,'local','current-build.json'),JSON.stringify(pointer));
  return {root,record,pointer,config:{root,build:join(root,record.build),dataRoot:join(root,'local','data-v003'),pipe:normalizedPipe(),version:'2.0.7',installation:record,pid:1234}};
}
function workerStart({wrongTarget=false,wrongPid=false,onStart=()=>{},waitForCancel=false}={}){
  return (path,args,options)=>{
    onStart(path,args,options);
    const script=`import {createHash} from 'node:crypto';import {createInterface} from 'node:readline';
const hash=x=>createHash('sha256').update(x).digest('hex');const lines=createInterface({input:process.stdin});let request;
lines.on('line',line=>{const r=JSON.parse(line);if(request){if(r.command==='cancel'){emit({type:'result',ok:false,code:'APP_UPDATE_CANCELLED'});process.exit(1);}return;}request=r;const s=r.source,v=r.release;
const id=hash(['AI-Buddy-App-Bootstrap-1',s.installationSha256,s.pointerSha256,v.version,v.installerSha256,v.manifestSha256,v.checksumsSha256,v.sourceCommit,v.tagObjectSha,String(v.bytes),hash(v.signedPayload),hash(v.signature)].join('\\n'));
function emit(event){console.log(JSON.stringify({protocol:1,nonce:r.nonce,processId:process.pid${wrongPid?'+1':''},...event}));}
globalThis.emit=emit;emit({type:'ready',version:${wrongTarget?"'99.0.0'":'v.version'},manifestSha256:v.manifestSha256,selectionId:id,appUpdateProtocol:1,appBootstrapProtocol:1});
${waitForCancel?"emit({type:'progress',phase:'waiting-safe-point',reasons:['chat']});":"emit({type:'result',ok:true,stage:'"+(args[0].endsWith('prepare')?'ready':'completed')+"',selectionId:id,version:v.version});process.exit(0);"}});`;
    return spawn(process.execPath,['--input-type=module','-e',script],{...options,detached:false});
  };
}

test('trusted bootstrap pins the source and runs a target worker with bound ready identity instead of the old manager',async t=>{
  const f=await legacy(t),release=releaseFixture();let launches=0;
  const backend=createAppBootstrapBackend({...f.config,releaseClient:release.client,start:workerStart({onStart:(path,args)=>{
    launches++;assert.match(path,/app-bootstrap-cache/);assert.ok(args[0].startsWith('--app-bootstrap-worker='));assert.equal(args[2],'--nonce='+'a'.repeat(64));
  }})});
  assert.equal((await backend.run('status',{nonce:'a'.repeat(64)})).stage,'bootstrap');
  const result=await backend.run('check',{nonce:'a'.repeat(64)});assert.equal(result.version,'2.0.8');
  assert.equal((await backend.run('prepare',{nonce:'a'.repeat(64),selectionId:result.selectionId})).stage,'ready');
  assert.equal((await backend.run('apply',{nonce:'a'.repeat(64),selectionId:result.selectionId})).stage,'completed');assert.equal(launches,2);
  const restored=createAppBootstrapBackend({...f.config,releaseClient:release.client,start:()=>assert.fail('status spawned')});
  assert.equal((await restored.run('status',{nonce:'a'.repeat(64)})).selectionId,result.selectionId);
});

test('public legacy pointer may omit its manifest digest while its registered manifest remains verified',async t=>{
  const f=await legacy(t),manifest=Buffer.from('{"appVersion":"2.0.7"}\n');
  f.record.manifestSha256=createHash('sha256').update(manifest).digest('hex');
  await mkdir(join(f.root,'local','install-manifests'),{recursive:true});
  await mkdir(join(f.root,'local','installer'),{recursive:true});
  const manifestPath=join(f.root,'local','install-manifests',f.record.manifestSha256+'.json');
  await writeFile(manifestPath,manifest);await writeFile(join(f.root,'local','installation.json'),JSON.stringify(f.record));
  const backend=createAppBootstrapBackend({...f.config});
  assert.equal((await backend.run('status',{nonce:'a'.repeat(64)})).stage,'bootstrap');
  for(const manifestSha256 of ['f'.repeat(64),null]){
    await writeFile(join(f.root,'local','current-build.json'),JSON.stringify({...f.pointer,manifestSha256}));
    await assert.rejects(backend.run('status',{nonce:'a'.repeat(64)}),{code:'APP_UPDATE_RECOVERY_REQUIRED'});
  }
  await writeFile(join(f.root,'local','current-build.json'),JSON.stringify(f.pointer));
  await writeFile(manifestPath,'changed manifest');
  await assert.rejects(backend.run('status',{nonce:'a'.repeat(64)}),{code:'APP_UPDATE_RECOVERY_REQUIRED'});
});

test('changed source, recovery journal, damaged manager and mismatched ready never enter migration',async t=>{
  for(const failure of ['source','journal','manager','target','pid']){
    const f=await legacy(t),release=releaseFixture();let launches=0;
    const backend=createAppBootstrapBackend({...f.config,releaseClient:release.client,start:workerStart({wrongTarget:failure==='target',wrongPid:failure==='pid',onStart:()=>launches++})});
    const found=await backend.run('check',{nonce:'a'.repeat(64)});
    if(failure==='source')await writeFile(join(f.root,'local','current-build.json'),JSON.stringify({...f.pointer,path:'builds/other'}));
    if(failure==='journal'){await mkdir(join(f.root,'local','installer'),{recursive:true});await writeFile(join(f.root,'local','installer','transaction.json'),JSON.stringify({phase:'recovery-required'}));}
    if(failure==='manager'){f.record.managerSha256=createHash('sha256').update('expected manager').digest('hex');await writeFile(join(f.root,'local','installation.json'),JSON.stringify(f.record));}
    await assert.rejects(backend.run('prepare',{nonce:'a'.repeat(64),selectionId:found.selectionId}),{code:['target','pid'].includes(failure)?'APP_UPDATE_PROTOCOL':'APP_UPDATE_RECOVERY_REQUIRED'});
    assert.equal(launches,['target','pid'].includes(failure)?1:0);
  }
});

test('bootstrap cancellation uses the live operation nonce and keeps the old pointer',async t=>{
  const f=await legacy(t),release=releaseFixture(),controller=new AbortController(),before=await readFile(join(f.root,'local','current-build.json'));
  const backend=createAppBootstrapBackend({...f.config,releaseClient:release.client,start:workerStart({waitForCancel:true})});
  const found=await backend.run('check',{nonce:'b'.repeat(64)});
  const result=await backend.run('prepare',{nonce:'b'.repeat(64),selectionId:found.selectionId,signal:controller.signal,onProgress:event=>{if(event.phase==='waiting-safe-point')controller.abort();}});
  assert.equal(result.code,'APP_UPDATE_CANCELLED');assert.deepEqual(await readFile(join(f.root,'local','current-build.json')),before);
});

test('startup recovery stays distinct from missing bootstrap capability and has no download retry',async()=>{
  const service=createUpdateService({version:'2.0.7',build:'bad',supported:false,recoveryRequired:true,run:()=>assert.fail('recovery ran'),bootstrapRun:()=>assert.fail('recovery migrated')});
  service.start();assert.equal(service.view().phase,'recovery-required');assert.equal(service.view().retryAction,null);
  await assert.rejects(service.action('bootstrap'),{code:'APP_UPDATE_INVALID_STATE'});service.close();
});
