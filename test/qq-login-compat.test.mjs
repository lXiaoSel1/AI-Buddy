import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,utimes,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import http from 'node:http';
import {createQqLoginRuntime} from '../src/qq-login-runtime.mjs';
import {inspectQqCache} from '../src/qq-owned-cache.mjs';
import {createSocialLogin} from '../src/social-login.mjs';
async function root(t){const value=await mkdtemp(join(tmpdir(),'buddy-qr-'));t.after(()=>rm(value,{recursive:true,force:true}));return value;}
test('manual OneBot contact lookup needs no managed component and is scoped to the selected account',{timeout:12000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'buddy-qr-'));let release;let account={ref:'manual',platform:'qq',accountId:'123',enabled:true,generation:1};const calls=[];
 const server=http.createServer((req,res)=>{calls.push(req.url);assert.equal(req.headers.authorization,'Bearer private');res.setHeader('Connection','close');const reply=()=>res.end(JSON.stringify({status:'ok',retcode:0,data:req.url==='/api/get_login_info'?{user_id:123}:req.url==='/api/get_friend_list'?[{user_id:456,nickname:'Friend'}]:[{group_id:789,group_name:'Group'}]}));if(release&&req.url.endsWith('get_group_list'))release(reply);else reply();});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 account={...account,httpUrl:'http://127.0.0.1:'+server.address().port+'/api',webSocketUrl:'ws://127.0.0.1:1'};
 const driver=createQqLoginRuntime({dataRoot:directory,build:directory,accounts:{get:()=>account,secret:()=>({accessToken:'private'})},component:{ensure:()=>assert.fail('manual connection must not start a component'),info:()=>({})}});t.after(async()=>{await driver.close();await rm(directory,{recursive:true,force:true});});
 const value=await driver.contacts('manual');assert.deepEqual(value.contacts,[{id:'456',label:'Friend'}]);assert.equal(value.groups[0].id,'789');assert.equal(calls.length,3);
 release=reply=>{account={...account,generation:2};reply();};await assert.rejects(driver.contacts('manual'),{code:'SOCIAL_ACCOUNT_CHANGED'});
});
test('owned cache pruning removes expired cache, preserves account data and refuses junction traversal',async t=>{
 const directory=await root(t),profile=join(directory,'profile');await mkdir(join(profile,'w/cache'),{recursive:true});await mkdir(join(profile,'h/.config/QQ'),{recursive:true});await writeFile(join(profile,'w/cache/old'),'cache');await utimes(join(profile,'w/cache/old'),new Date(0),new Date(0));await writeFile(join(profile,'h/.config/QQ/history.db'),'saved');
 assert.equal((await inspectQqCache(profile,{prune:true})).removedBytes,5);assert.equal(await readFile(join(profile,'h/.config/QQ/history.db'),'utf8'),'saved');
 const external=join(directory,'other');await mkdir(external);await writeFile(join(external,'keep'),'outside');await symlink(external,join(profile,'t'),'junction');await assert.rejects(inspectQqCache(profile,{prune:true}),{code:'QQ_CACHE_LINK_DENIED'});assert.equal(await readFile(join(external,'keep'),'utf8'),'outside');
});

test('QQ rescan exposes startup and cleanup errors, then waits for the original runtime to be released',async t=>{
 const directory=await root(t),accounts={list:()=>[],commitLogin:()=>assert.fail('No account is confirmed in this fixture')};
 const spawned=[],releases=[];let cleanupAvailable=false;
 const driver=createQqLoginRuntime({dataRoot:directory,build:directory,accounts,component:{ensure:async()=>directory},
  spawnImpl(){
   const child=new EventEmitter();child.pid=1000000+spawned.length;child.connected=true;
   child.send=(_message,callback)=>{callback();child.connected=false;child.emit('exit',0,null);};
   spawned.push(child.pid);return child;
  },
  supervisor:{async registerRoot(){},async releaseRoot({runtimeId}){
   releases.push(runtimeId);
   if(!cleanupAvailable)throw Object.assign(Error('private receipt path'),{code:'EBUSY'});
  },async close(){}},
  async listenerInspector(){if(spawned.length===1)throw Object.assign(Error('private listener detail'),{code:'QQ_LISTENER_OWNER_MISMATCH'});},
  async fetchImpl(url){
   const data=new URL(url).pathname==='/api/auth/login'?{Credential:'fixture'}:{isLogin:false,qrcodeurl:'https://qq.com/fixture'};
   return Response.json({code:0,data});
  },
 });
 const login=createSocialLogin({accounts,drivers:{qq:driver}});
 async function waitForPhase(phase){
  for(let i=0;i<400;i++){
   const state=login.status('qq');if(state.phase===phase)return state;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail(`Timed out waiting for ${phase}`);
 }
 try{
  const initial=login.start('qq'),failed=await waitForPhase('failed');
  assert.equal(failed.errorCode,'SOCIAL_LOGIN_STOP_PENDING');
  assert.equal(failed.startErrorCode,'QQ_LISTENER_OWNER_MISMATCH');
  assert.equal(failed.cleanupErrorCode,'EBUSY');
  assert.doesNotMatch(JSON.stringify(failed),/private/);
  assert.deepEqual(releases,Array(2).fill(`qq:${initial.attemptId}`));
  cleanupAvailable=true;login.start('qq');
  const waiting=await waitForPhase('waiting-qr');
  assert.notEqual(waiting.attemptId,initial.attemptId);assert.ok(waiting.qr);
  assert.equal(spawned.length,2);assert.deepEqual(releases,Array(3).fill(`qq:${initial.attemptId}`));
 }finally{cleanupAvailable=true;await login.close();}
});
