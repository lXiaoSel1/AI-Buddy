import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createSocialAccounts} from '../src/buddy-plugin-services/social-accounts.mjs';
import {createSocialTransport} from '../src/buddy-plugin-services/social-transport.mjs';

async function fixture(t,prefix=''){
 const parent=resolve(process.env.AI_BUDDY_TEST_ROOT??join(tmpdir(),'buddy-social-transport'));await mkdir(parent,{recursive:true});
 const dataRoot=await mkdtemp(join(parent,'transport-')),accounts=createSocialAccounts({dataRoot});
 const account=accounts.save({pluginId:'@ai-buddy/qq-connect',accountId:'123',label:'Isolated transport test',httpUrl:'http://127.0.0.1:45678'+prefix,webSocketUrl:'ws://127.0.0.1:45679'}),sockets=[],requests=[];
 class Socket extends EventTarget{
  constructor(){super();sockets.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
  close(){this.closed=true;this.dispatchEvent(new Event('close'));}
  message(messageId,segments=[{type:'text',data:{text:'Isolated event'}}]){const event=new Event('message');Object.defineProperty(event,'data',{value:JSON.stringify({post_type:'message',message_type:'private',self_id:123,user_id:789,time:1700000000,message_id:messageId,message:segments})});this.dispatchEvent(event);}
 }
 const transport=createSocialTransport({dataRoot,accounts,WebSocketImpl:Socket,now:()=>1700000000000,fetchImpl:async(url,init)=>{requests.push({path:new URL(url).pathname,body:JSON.parse(init.body)});return Response.json({status:'ok',retcode:0,data:new URL(url).pathname.endsWith('/get_login_info')?{user_id:123}:{message_id:456}});}});
 t.after(async()=>{await transport.close();accounts.close();assert.ok(resolve(dataRoot).startsWith(parent+sep));await rm(dataRoot,{recursive:true,force:true});});
 const scope={pluginId:'source-qq',packageName:'@ai-buddy/qq-connect',characterId:'whale',personaId:'persona',lifeId:'life',operationId:'operation',accountBindingId:'123',bindingGeneration:account.generation};
 const opened=await transport.open({connectionRef:account.ref,accountId:'123',newEventsOnly:true},scope);
 return {transport,account,scope,opened,sockets,requests,payload:{connectionId:opened.connectionId,accountId:'123',newEventsOnly:true,waitMs:0}};
}

test('AUDIT QQ consuming over 1000 events does not exhaust the outstanding buffer',async t=>{
 const f=await fixture(t);let cursor=0;
 for(let n=1;n<=1005;n++){
  f.sockets[0].message(n);const next=await f.transport.events({...f.payload,cursor,ackCursor:cursor},f.scope);
  assert.equal(next.events.length,1);assert.equal(next.events[0].message_id,n);
  assert.equal(f.transport.inbound(f.opened.connectionId,String(n),f.scope).raw.message_id,n,'Current unacknowledged event remains available as evidence');cursor=next.cursor;
 }
 assert.notEqual(f.sockets[0].closed,true);
});

test('AUDIT QQ fetched events retain evidence until an explicit processed acknowledgement',async t=>{
 const f=await fixture(t);f.sockets[0].message(1);const first=await f.transport.events(f.payload,f.scope);
 await f.transport.events({...f.payload,cursor:first.cursor},f.scope);
 assert.equal(f.transport.inbound(f.opened.connectionId,'1',f.scope).raw.message_id,1);
 await assert.rejects(f.transport.events({...f.payload,cursor:1,ackCursor:2},f.scope),{code:'QQ_EVENT_ACK_INVALID'});
 await f.transport.events({...f.payload,cursor:1,ackCursor:1},f.scope);
 assert.throws(()=>f.transport.inbound(f.opened.connectionId,'1',f.scope),{code:'QQ_NATIVE_EVENT_MISSING'});
 await assert.rejects(f.transport.events({...f.payload,cursor:0},f.scope),{code:'QQ_EVENT_CURSOR_EXPIRED'});
});

test('AUDIT QQ actual outstanding overflow remains a failure',async t=>{
 const f=await fixture(t);for(let n=1;n<=1001;n++)f.sockets[0].message(n);
 assert.equal(f.sockets[0].closed,true);await assert.rejects(f.transport.events(f.payload,f.scope),{code:'SOCIAL_CONNECTION_CLOSED'});
});

for(const prefix of ['','/','/api','/api/'])test('AUDIT QQ formal transport retains configured endpoint prefix '+JSON.stringify(prefix),async t=>{
 const f=await fixture(t,prefix),base=prefix.replace(/\/$/,'');
 assert.equal(f.requests[0].path,base+'/get_login_info');
 f.sockets[0].message(1,[{type:'reply',data:{id:'original'}}]);
 const privateScope={...f.scope,conversationType:'private',peerId:'789',sourceMessageId:'1'};
 await f.transport.request({connectionId:f.opened.connectionId,accountId:'123',action:'get_msg',params:{message_id:'original'}},privateScope);
 for(const type of ['private','group'])await f.transport.request({connectionId:f.opened.connectionId,accountId:'123',action:'send_'+type+'_msg',requestId:'send-'+type,params:{[type==='private'?'user_id':'group_id']:'789',message:[{type:'text',data:{text:'No real network'}}]}},{...privateScope,conversationType:type});
 assert.deepEqual(f.requests.map(v=>v.path),['get_login_info','get_msg','send_private_msg','send_group_msg'].map(action=>base+'/'+action));
});
