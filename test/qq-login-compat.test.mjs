import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,utimes,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {createQqLoginRuntime} from '../src/qq-login-runtime.mjs';
import {inspectQqCache} from '../src/qq-owned-cache.mjs';
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
