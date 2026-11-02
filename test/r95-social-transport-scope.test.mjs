import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSocialAccounts} from '../src/buddy-plugin-services/social-accounts.mjs';
import {createSocialTransport} from '../src/buddy-plugin-services/social-transport.mjs';
import {createSocialPluginBroker} from '../src/buddy-plugin-services/social-plugin-broker.mjs';

async function setup(t){
 const dataRoot=await mkdtemp(join(tmpdir(),'r95-qq-scope-')),accounts=createSocialAccounts({dataRoot}),closers=[];
 const account=accounts.save({pluginId:'@ai-buddy/qq-connect',accountId:'123',label:'Isolated test',httpUrl:'http://127.0.0.1:45678',webSocketUrl:'ws://127.0.0.1:45679'}),sockets=[];let sends=0;
 class Socket extends EventTarget{
  constructor(){super();sockets.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
  close(){this.closed=true;this.dispatchEvent(new Event('close'));}
  message(raw){const event=new Event('message');Object.defineProperty(event,'data',{value:JSON.stringify(raw)});this.dispatchEvent(event);}
 }
 const now=1700000000000,transport=createSocialTransport({dataRoot,accounts,WebSocketImpl:Socket,now:()=>now,fetchImpl:async(url)=>{const path=new URL(url).pathname;if(path==='/get_login_info')return Response.json({status:'ok',retcode:0,data:{user_id:123}});sends++;return Response.json({status:'ok',retcode:0,data:{message_id:456}});}});
 t.after(async()=>{for(const close of closers.reverse())await close();await transport.close();accounts.close();await rm(dataRoot,{recursive:true,force:true});});
 const scope={pluginId:'source-bound-qq',packageName:'@ai-buddy/qq-connect',characterId:'claude',personaId:'default',lifeId:'life-before',operationId:'operation-before',accountBindingId:account.accountId,bindingGeneration:account.generation};
 const opened=await transport.open({connectionRef:account.ref,accountId:account.accountId,newEventsOnly:true},scope);
 sockets[0].message({post_type:'message',message_type:'private',self_id:123,user_id:789,time:now/1000,message_id:1,message:[{type:'text',data:{text:'Message observed in the original life'}}]});
 const payload={connectionId:opened.connectionId,accountId:account.accountId,newEventsOnly:true,cursor:0,waitMs:0};
 return {dataRoot,transport,accounts,account,scope,opened,sockets,payload,closers,sends:()=>sends};
}

test('QQ connection events and inbound evidence cannot be rebound to another character, persona or life',async t=>{
 const f=await setup(t),first=await f.transport.events(f.payload,f.scope);assert.equal(first.events[0].message_id,1);assert.equal(f.transport.inbound(f.opened.connectionId,'1',f.scope).raw.message_id,1);
 for(const key of ['pluginId','packageName','characterId','personaId','lifeId','operationId','accountBindingId','bindingGeneration']){
  const changed={...f.scope,[key]:key==='bindingGeneration'?f.scope[key]+1:'changed-'+f.scope[key]};
  await assert.rejects(f.transport.events(f.payload,changed),{code:'SOCIAL_CONNECTION_SCOPE_DENIED'},'events: '+key);
  assert.throws(()=>f.transport.inbound(f.opened.connectionId,'1',changed),{code:'SOCIAL_CONNECTION_SCOPE_DENIED'},'inbound: '+key);
 }
});

test('QQ get_msg permits only an actual array/CQ reply, never an escaped literal or unrelated reply id',async t=>{
 const f=await setup(t),raw={post_type:'message',message_type:'private',self_id:123,user_id:789,time:1700000000,message_id:2,message:'[CQ:reply,id=42]hello'};
 f.sockets[0].message(raw);const scope={...f.scope,sourceMessageId:'2',conversationType:'private',peerId:'789'},request={connectionId:f.opened.connectionId,accountId:'123',action:'get_msg',params:{message_id:'42'}};
 await f.transport.request(request,scope);assert.equal(f.sends(),1);
 await assert.rejects(f.transport.request({...request,params:{message_id:'43'}},scope),{code:'QQ_QUOTE_SCOPE_DENIED'});assert.equal(f.sends(),1);
 f.sockets[0].message({...raw,message_id:3,message:'&#91;CQ:reply,id=42&#93;hello'});await assert.rejects(f.transport.request(request,{...scope,sourceMessageId:'3'}),{code:'QQ_QUOTE_SCOPE_DENIED'});assert.equal(f.sends(),1);
});

test('QQ sends reject an old connection after operator life changes before making a network write',async t=>{
 const f=await setup(t),request={connectionId:f.opened.connectionId,accountId:f.account.accountId,action:'send_private_msg',requestId:'isolated-reply-1',params:{user_id:789,message:[{type:'text',data:{text:'reply'}}]}};
 const scope={...f.scope,conversationType:'private',peerId:'789',sourceMessageId:'1',lifeId:'life-after',operationId:'operation-after'};
 await assert.rejects(f.transport.request(request,scope),{code:'SOCIAL_CONNECTION_SCOPE_DENIED'});assert.equal(f.sends(),0);
});

test('same plugin can safely close an old connection after a life change without reading its messages',async t=>{
 const f=await setup(t),changed={...f.scope,lifeId:'life-after',operationId:'operation-after'};
 await assert.rejects(f.transport.closeConnection(f.opened.connectionId,{...changed,pluginId:'other-plugin'}),{code:'SOCIAL_CONNECTION_SCOPE_DENIED'});
 assert.deepEqual(await f.transport.closeConnection(f.opened.connectionId,changed),{closed:true});assert.equal(f.sockets[0].closed,true);
 await assert.rejects(f.transport.events(f.payload,f.scope),{code:'SOCIAL_CONNECTION_CLOSED'});
});

test('QQ account generation changes revoke its existing socket and event queue',async t=>{
 const f=await setup(t);f.accounts.save({...f.account,label:'Updated account binding'});
 assert.equal(f.sockets[0].closed,true);await assert.rejects(f.transport.events(f.payload,f.scope),{code:'SOCIAL_CONNECTION_CLOSED'});
 assert.throws(()=>f.transport.inbound(f.opened.connectionId,'1',f.scope),{code:'SOCIAL_CONNECTION_CLOSED'});
});

test('QQ long poll rechecks current host authority after waiting before exposing the next message',async t=>{
 const f=await setup(t);let current=true,checked;
 const firstCheck=new Promise(resolve=>checked=resolve),pending=f.transport.events({...f.payload,cursor:1},f.scope,{check:async()=>{checked();if(!current)throw Object.assign(Error('Life changed'),{code:'SOCIAL_LIFE_CHANGED'});}});
 await firstCheck;await new Promise(setImmediate);current=false;
 f.sockets[0].message({post_type:'message',message_type:'private',self_id:123,user_id:789,time:1700000000,message_id:2,message:[{type:'text',data:{text:'Must not be returned after scope changes'}}]});
 await assert.rejects(pending,{code:'SOCIAL_LIFE_CHANGED'});
});

test('QQ broker invalidates an outstanding native event poll when the operator life changes',async t=>{
 const f=await setup(t);let next=0,checked;
 const current={...f.scope,connectionRef:'isolated-role-model',available:true};
 const core={socialProfile:()=>({...current}),socialHost:{registerContext:()=>({contextRef:'anchor-'+(++next),revoke(){}})},registerSocialDelivery:()=>({revoke(){}})};
 const bridge={issueContext:async()=>({contextToken:'context-'+next}),invoke:async()=>{throw Error('This polling test must not dispatch a model or work command');}};
 const broker=createSocialPluginBroker({dataRoot:f.dataRoot,accounts:f.accounts,transport:f.transport,bridge,getR95:()=>core,getProvider:()=>({state:{profiles:[]}})});f.closers.push(()=>broker.close());
 const identity={pluginId:f.scope.pluginId,packageName:f.scope.packageName};
 await broker.handlers['social.context.read']({identity,payload:{purpose:'qq-operator-bind',characterId:f.scope.characterId},context:{authority:{kind:'app'}}});
 const context=await broker.contextProvider({identity,method:'connections.events',payload:f.payload}),firstCheck=new Promise(resolve=>checked=resolve);
 const pending=broker.handlers['connections.events']({identity,context,payload:{...f.payload,cursor:1},check:async()=>{checked();}});
 await firstCheck;await new Promise(setImmediate);current.lifeId='life-after';current.operationId='operation-after';
 f.sockets[0].message({post_type:'message',message_type:'private',self_id:123,user_id:789,time:1700000000,message_id:2,message:[{type:'text',data:{text:'No new-life evidence may be minted from this old poll'}}]});
 await assert.rejects(pending,{code:'BUDDY_CONTEXT_STALE'});
});
