import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNativeSocialFacade} from '../src/buddy-plugin-services/native-social-facade.mjs';
import {createSocialAccounts,localEndpoint} from '../src/buddy-plugin-services/social-accounts.mjs';
import {biliRequestPolicy,createSocialTransport} from '../src/buddy-plugin-services/social-transport.mjs';
import {openNativeSocialClient} from '../src/dsh-platform/native-bridge-host.mjs';
import {createSocialRuntimeJournal} from '../src/buddy-plugin-services/social-runtime-journal.mjs';
import {socialUIRequestAdmissible} from '../src/dsh-platform/backend.mjs';
import {socialAccountPayload} from '../src/social-accounts-ui.mjs';
import {DatabaseSync} from 'node:sqlite';

const identity={pluginId:'source-bound-qq',packageName:'@ai-buddy/qq-connect',exactVersion:'0.1.0-dev.3',sourceDigest:'1'.repeat(64)};
const origin={runtimeId:'runtime',profileId:'profile',pid:123};
async function directory(t){const path=await mkdtemp(join(tmpdir(),'joint-social-'));return path;}
test('native social facade binds exact process/package and advertises only implemented handlers',async t=>{
 const dataRoot=await directory(t);let enabled=true,generation=1;
 const host=createNativeSocialFacade({dataRoot,contract:{hash:'hash',methods:['social.context.read','models.request']},handlers:{'social.context.read':async({context})=>context},authorizeUI:async({request})=>request.cookie==='valid',resolveGrant:async()=>({...identity,enabled,generation,granted:['social.context.read']}),contextProvider:async({authority})=>authority});
 t.after(async()=>{await host.close();await rm(dataRoot,{recursive:true,force:true});});const opened=await host.open({identity,origin,contractHash:'hash'});
 assert.deepEqual(opened.description.capabilities,['social.context.read']);assert.deepEqual(opened.description.missingCapabilities,['models.request']);
 await assert.rejects(host.open({identity,origin,contractHash:'forged'}),{code:'SOCIAL_CONTRACT_MISMATCH'});
 const request={sessionToken:opened.sessionToken,method:'authorize',payload:{request:{cookie:'valid'},action:'settings.save'}};
 await assert.rejects(host.dispatch(request,{...origin,pid:124}),{code:'SOCIAL_RUNTIME_SCOPE_DENIED'});
 await assert.rejects(host.dispatch({...request,payload:{request:{cookie:'invalid'}}},origin),{code:'TRUSTED_UI_PRINCIPAL_REQUIRED'});
 const principal=await host.dispatch(request,origin);
 const result=await host.dispatch({sessionToken:opened.sessionToken,method:'social.context.read',payload:{principal}},origin);assert.equal(result.kind,'app');
 await assert.rejects(host.dispatch({sessionToken:opened.sessionToken,method:'social.context.read',payload:{principal:{contextToken:'body-forged'}}},origin),{code:'TRUSTED_UI_PRINCIPAL_REQUIRED'});
 enabled=false;await assert.rejects(host.dispatch({sessionToken:opened.sessionToken,method:'social.context.read'},origin),{code:'BUDDY_CAPABILITY_DENIED'});
});
test('native client cancellation drains host event poll before close',async()=>{
 let pending=0,closed=0;const invoke=async({method},options={})=>{
  if(method==='open')return {sessionToken:'opaque',dataDirectory:'test-only',description:{pluginId:'p'}};
  if(method==='events'){pending++;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{pending--;reject(Object.assign(Error('cancelled'),{code:'ABORT_ERR'}));},{once:true}));}
  if(method==='close'){assert.equal(pending,0);closed++;return {closed:true};}
 };
 const client=await openNativeSocialClient({pluginId:'p',contractHash:'c'},invoke);await client.subscribeEvents({pluginId:'p',contractHash:'c'},()=>{});await Promise.all([client.close(),client.close()]);assert.equal(closed,1);
});
test('managed accounts expose metadata only and preserve secrets when editing labels',async t=>{
 const dataRoot=await directory(t),cipher={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s).map(x=>x^97),decryptString:b=>Buffer.from(b).map(x=>x^97).toString()};
 const store=createSocialAccounts({dataRoot,crypto:cipher});t.after(async()=>{store.close();await rm(dataRoot,{recursive:true,force:true});});
 const first=store.save({pluginId:identity.packageName,accountId:'123',label:'local QQ',httpUrl:'http://127.0.0.1:45678',webSocketUrl:'ws://127.0.0.1:45679',secret:{accessToken:'fixture-secret'}});
 assert.ok(!JSON.stringify(store.list()).includes('fixture-secret'));assert.equal(store.secret(first.ref).accessToken,'fixture-secret');
 const second=store.save({...first,label:'renamed'});assert.equal(second.generation,2);assert.equal(store.secret(first.ref).accessToken,'fixture-secret');
 assert.throws(()=>store.save({...first,httpUrl:'http://attacker.example'}),{code:'SOCIAL_ENDPOINT_DENIED'});
 assert.throws(()=>localEndpoint('http://127.0.0.1@attacker.example',['http:']),{code:'SOCIAL_ENDPOINT_DENIED'});
 assert.throws(()=>store.save({...first,secret:{arbitrary:'x'}}),{code:'SOCIAL_SECRET_INVALID'});
 const bytes=await readFile(join(dataRoot,'social-core/accounts-v1.sqlite'));assert.ok(!bytes.includes(Buffer.from('fixture-secret')));
});
test('Bili transport allowlist rejects credential redirection, unrelated APIs and anonymous writes',()=>{
 const account={ref:'bili'};
 for(const url of ['https://api.bilibili.com.evil/x/web-interface/view','http://api.bilibili.com/x/web-interface/view','https://127.0.0.1/x/web-interface/view','https://api.bilibili.com/x/arbitrary'])assert.throws(()=>biliRequestPolicy({url},account),/DENIED/);
 assert.throws(()=>biliRequestPolicy({url:'https://i0.hdslb.com/a.json',credentialBinding:{connectionRef:'bili'}},account),/DENIED/);
 assert.throws(()=>biliRequestPolicy({url:'https://api.bilibili.com/x/v2/reply/add',method:'POST',anonymousReadOnly:true},account),/DENIED/);
 assert.equal(biliRequestPolicy({url:'https://api.bilibili.com/x/web-interface/view?bvid=BVfixture'},account).method,'GET');
});
test('Bili host observes bounded response bytes and never replays an unknown write',async t=>{
 const dataRoot=await directory(t),accounts=createSocialAccounts({dataRoot}),a=accounts.save({pluginId:'@ai-buddy/bilibili-companion',accountId:'1',label:'fixture'});let calls=0;
 const transport=createSocialTransport({dataRoot,accounts,fetchImpl:async(_url,options)=>{calls++;assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,undefined);if(options.method==='POST')throw Error('connection lost after accepted write');return Response.json({code:0,data:{title:'observed'}});}});
 t.after(async()=>{await transport.close();accounts.close();await rm(dataRoot,{recursive:true,force:true});});
 const scope={pluginId:'bili',conversationId:'activity'};
 const response=await transport.request({platform:'bilibili',connectionRef:a.ref,accountId:'1',url:'https://api.bilibili.com/x/web-interface/view'},scope);
 assert.equal(transport.observation(response.observationId).body,response.body);
 const post={platform:'bilibili',connectionRef:a.ref,accountId:'1',url:'https://api.bilibili.com/x/v2/reply/add',method:'POST',form:{message:'test'},idempotencyKey:'send1'};
 assert.equal((await transport.request(post,scope)).status,'unknown');assert.equal((await transport.request(post,scope)).status,'unknown');assert.equal(calls,2);
 await assert.rejects(transport.request({...post,form:{message:'different'}},scope),{code:'SOCIAL_SEND_ID_CONFLICT'});
});
test('native UI authorization accepts the pinned DSH internal URL only with the original listener Host and rejects cross-site requests',()=>{
 const origin='http://127.0.0.1:12345',path='/plugins/qq/manage',base={method:'POST',url:'http://dsh.internal'+path,headers:{host:'127.0.0.1:12345',origin,cookie:'test-cookie','content-type':'application/json'}};
 assert.equal(socialUIRequestAdmissible(base,origin,path),true);
 for(const headers of [{host:'127.0.0.1:12346'},{origin:'https://evil.example'},{'sec-fetch-site':'cross-site'},{'content-type':'text/plain'},{cookie:''}])assert.equal(socialUIRequestAdmissible({...base,headers:{...base.headers,...headers}},origin,path),false);
 assert.equal(socialUIRequestAdmissible({...base,url:'http://evil.example'+path},origin,path),false);
 assert.equal(socialUIRequestAdmissible({...base,url:'http://dsh.internal/other'},origin,path),false);
});
test('model journal preserves unknown results across restart, completed results reuse the actual accounting identity, changed input cannot replay',async t=>{
 const dataRoot=await directory(t);let journal=createSocialRuntimeJournal({dataRoot}),calls=0;
 t.after(async()=>{await journal.close();await rm(dataRoot,{recursive:true,force:true});});
 const unknown={id:'uncertain',input:{text:'original'},scope:{pluginId:'p',lifeId:'life'}};
 await assert.rejects(journal.model(unknown,async()=>{calls++;throw Error('lost result');}),/lost result/);
 await journal.close();journal=createSocialRuntimeJournal({dataRoot});
 await assert.rejects(journal.model(unknown,async()=>{calls++;}),{code:'SOCIAL_MODEL_RESULT_UNKNOWN'});assert.equal(calls,1);
 await assert.rejects(journal.model({...unknown,input:{text:'changed'}},async()=>{}),{code:'SOCIAL_MODEL_ID_CONFLICT'});
 const completed={...unknown,id:'complete'},result=await journal.model(completed,async()=>({requestId:'core-request-id',text:'observed'}));
 await journal.close();journal=createSocialRuntimeJournal({dataRoot});
 assert.deepEqual(await journal.model(completed,async()=>{throw Error('must not call');}),result);assert.equal(journal.result('core-request-id').scope.lifeId,'life');
});
test('managed-account form leaves secrets absent when unchanged and backend prevents ambiguous active account binding',async t=>{
 const form={pluginId:'@ai-buddy/qq-connect',label:'local',accountId:'1',httpUrl:'http://127.0.0.1:3000',webSocketUrl:'ws://127.0.0.1:3001'};
 assert.equal(Object.hasOwn(socialAccountPayload(form,''),'secret'),false);assert.deepEqual(socialAccountPayload(form,'fixture').secret,{accessToken:'fixture'});
 const dataRoot=await directory(t),accounts=createSocialAccounts({dataRoot});t.after(async()=>{accounts.close();await rm(dataRoot,{recursive:true,force:true});});
 const first=accounts.save(form);assert.throws(()=>accounts.save({...form,accountId:'2'}),{code:'SOCIAL_ACCOUNT_ALREADY_ACTIVE'});
 accounts.save({...first,enabled:false});assert.equal(accounts.save({...form,accountId:'2'}).accountId,'2');
});
test('unknown accounts schema is rejected before any schema or credential changes',async t=>{
 const dataRoot=await directory(t);let accounts=createSocialAccounts({dataRoot});accounts.close();const path=join(dataRoot,'social-core','accounts-v1.sqlite'),db=new DatabaseSync(path);
 db.exec("UPDATE meta SET value='99' WHERE key='schemaVersion'");db.close();const before=await readFile(path);
 assert.throws(()=>createSocialAccounts({dataRoot}),/Unsupported R95 database schema/);assert.deepEqual(await readFile(path),before);await rm(dataRoot,{recursive:true,force:true});
});
