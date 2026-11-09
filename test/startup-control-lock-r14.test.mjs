import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createLocalControlServer} from '../src/local-control.mjs';
const close=server=>server.listening?new Promise((yes,no)=>server.close(error=>error?no(error):yes())):Promise.resolve();
const listen=(server,pipe)=>new Promise((yes,no)=>{server.once('error',no);server.listen(pipe,yes);});
const claimControlPipe=(...args)=>import('../src/startup-control-lock.mjs').then(module=>module.claimControlPipe(...args));

test('main initialization waits for the real control pipe and never initializes while maintenance owns it',async()=>{
 const pipe='\\\\.\\pipe\\buddy-r14-startup-'+randomUUID(),maintenance=createServer(socket=>socket.destroy()),control=createLocalControlServer({onRequest:()=>({ok:true})});let initialized=0;const exits=[],dialogs=[],forwards=[];
 const source=readFileSync(new URL('../src/main.mjs',import.meta.url),'utf8'),marker='app.whenReady().then(async()=>{',start=source.indexOf(marker)+marker.length,end=source.indexOf('  deferredSaves.start();',start),preflight=source.slice(start,end);
 const handlerStart=source.indexOf("control.on('error',error=>{"),handlerEnd=source.indexOf('\n});',handlerStart)+5;
 new Function('control','pipe','requestLocalControl','app','audit',source.slice(handlerStart,handlerEnd))(control,pipe,async(...args)=>{forwards.push(args);return{};},{exit:code=>exits.push(code)},()=>{});
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor,startMain=new AsyncFunction('claimControlPipe','control','pipe','recoveryDispatched','bootFailure','dialog','app','initialize',preflight+'\nawait initialize();');
 const run=()=>startMain(claimControlPipe,control,pipe,false,null,{showMessageBox:async value=>dialogs.push(value)},{exit:code=>exits.push(code)},async()=>{initialized++;});
 try{await listen(maintenance,pipe);await run();assert.equal(initialized,0,'no provider/game/business initialization while the maintenance pipe is occupied');assert.deepEqual(exits,[1]);assert.deepEqual(forwards,[]);assert.equal(dialogs.length,1);assert.match(dialogs[0].message,/维护|占用/);
  await close(maintenance);await run();assert.equal(initialized,1);assert.equal(control.listening,true);
 }finally{await close(control);await close(maintenance);}
});
