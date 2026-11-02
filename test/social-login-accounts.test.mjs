import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSocialAccounts} from '../src/buddy-plugin-services/social-accounts.mjs';
const crypto={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()};
test('verified replacement is atomic, old credential survives, same account retains reference on re-login',async t=>{
 const root=await mkdtemp(join(tmpdir(),'social-login-accounts-'));const accounts=createSocialAccounts({dataRoot:root,crypto});t.after(async()=>{accounts.close();await rm(root,{recursive:true,force:true});});
 const first=accounts.save({pluginId:'@ai-buddy/bilibili-companion',accountId:'123',label:'Old',secret:{cookie:'old'}});
 assert.throws(()=>accounts.commitLogin({pluginId:first.pluginId,accountId:'456',label:'New',secret:{invalid:'bad'}}));assert.equal(accounts.get(first.ref).enabled,true);
 let changed=[];accounts.subscribe(row=>changed.push({row,active:accounts.list().filter(a=>a.enabled).length}));
 const next=accounts.commitLogin({pluginId:first.pluginId,accountId:'456',label:'New',secret:{cookie:'new'}});assert.notEqual(next.ref,first.ref);assert.equal(accounts.get(first.ref).enabled,false);assert.equal(accounts.secret(first.ref).cookie,'old');assert.ok(changed.every(row=>row.active===1));
 const again=accounts.commitLogin({pluginId:first.pluginId,accountId:'456',label:'Renamed',secret:{cookie:'newest'}});assert.equal(again.ref,next.ref);assert.equal(accounts.list().length,2);
 accounts.close();const reopened=createSocialAccounts({dataRoot:root,crypto});assert.equal(reopened.get(next.ref).label,'Renamed');reopened.close();
});

test('QQ profile and encrypted credential are committed together and manual input cannot replace the profile',async t=>{
 const root=await mkdtemp(join(tmpdir(),'social-login-binding-'));const accounts=createSocialAccounts({dataRoot:root,crypto});t.after(async()=>{accounts.close();await rm(root,{recursive:true,force:true});});
 const base={pluginId:'@ai-buddy/qq-connect',accountId:'123',label:'QQ',secret:{accessToken:'token'},httpUrl:'http://127.0.0.1:1',webSocketUrl:'ws://127.0.0.1:2'};
 assert.throws(()=>accounts.commitLogin({...base,resourceId:'../../bad'}),{code:'QQ_PRIVATE_PROFILE_REQUIRED'});assert.equal(accounts.list().length,0);
 const id='12345678-1234-1234-1234-123456789012',account=accounts.commitLogin({...base,resourceId:id});assert.equal(account.managedProfileId,id);assert.equal(account.activityApprovalRequired,true);
 accounts.save({...account,managedProfileId:'forged'});assert.equal(accounts.get(account.ref).managedProfileId,id);accounts.approveActivities(account.ref);assert.equal(accounts.get(account.ref).activityApprovalRequired,false);
});
