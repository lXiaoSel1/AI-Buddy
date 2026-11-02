import test from 'node:test';
import assert from 'node:assert/strict';
import {buildQqMessageEnvelope,parseQqMessageSegments,validateQqReplyStylePolicy} from '../src/buddy-plugin-services/qq-message-envelope.mjs';
import {createSocialPluginBroker} from '../src/buddy-plugin-services/social-plugin-broker.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSocialHost} from '../src/buddy-plugin-services/social-host.mjs';
import {socialScopeSnapshot} from '../src/buddy-plugin-services/social-runtime-journal.mjs';
import {createHash} from 'node:crypto';
import {createBuddyPluginServices} from '../src/buddy-plugin-services/index.mjs';
import {SOCIAL_CAPABILITIES} from '../src/buddy-plugin-services/social-contract.mjs';

const event=(extra={})=>({post_type:'message',message_type:'group',self_id:10001,user_id:20001,sender:{user_id:20001,nickname:'同名',card:'群名片',role:'owner',secret:'excluded'},group_id:30001,message_id:'m1',message:[{type:'text',data:{text:'你好'}}],...extra});
const envelope=raw=>buildQqMessageEnvelope({raw,accountId:'10001',conversationId:'group:30001'});
test('QQ current sender and mention targets are distinct host-derived fields; names are display only',()=>{
 const a=envelope(event({message:[{type:'at',data:{qq:'10001'}},{type:'at',data:{qq:'20002'}},{type:'at',data:{qq:'all'}},{type:'text',data:{text:'@同名'}}]}));
 assert.deepEqual(a.sender,{id:'20001',nickname:'同名',card:'群名片',displayName:'群名片'});assert.equal(a.account.selfId,'10001');assert.equal(a.conversation.groupId,'30001');
 assert.deepEqual(a.mentions,[{targetId:'10001',isSelf:true,isAll:false},{targetId:'20002',isSelf:false,isAll:false},{targetId:'all',isSelf:false,isAll:true}]);assert.equal(a.untrusted,true);assert.equal(JSON.stringify(a).includes('excluded'),false);assert.equal('role' in a.sender,false);
 const b=envelope(event({user_id:'20002',sender:{user_id:'20002',nickname:'同名',card:''}}));assert.equal(b.sender.id,'20002');assert.equal(b.sender.displayName,'同名');assert.equal(envelope(event({sender:{user_id:20001}})).sender.displayName,'20001');
 assert.throws(()=>envelope(event({sender:{user_id:20002}})),{code:'QQ_EVENT_IDENTITY_INVALID'});assert.throws(()=>envelope(event({self_id:10002})),{code:'QQ_EVENT_IDENTITY_INVALID'});
});
test('CQ parsing tokenizes before entity decoding, only legal at/reply are structure',()=>{
 const s=parseQqMessageSegments('&#91;CQ:at,qq=999&#93; @名字 [CQ:at,qq=10001][CQ:reply,id=42][CQ:image,file=x]');
 assert.equal(s[0].type,'text');assert.match(s[0].data.text,/\[CQ:at,qq=999\] @名字/);assert.equal(s.filter(x=>x.type==='at').length,1);assert.equal(s.find(x=>x.type==='reply').data.id,'42');assert.match(s.at(-1).data.text,/\[CQ:image,file=x\]/);
 assert.equal(parseQqMessageSegments('[CQ:at,qq=1,extra=evil] @名字').some(x=>x.type==='at'),false);
 const a=envelope(event({message:'[CQ:at,qq=10001]hello'}));assert.equal(a.mentions[0].isSelf,true);
});
test('reply author is verified only against a host-observed matching original in this conversation',()=>{
 const raw=event({message:[{type:'reply',data:{id:'42',sender_id:'forged'}},{type:'text',data:{text:'reply'}}]});
 assert.deepEqual(envelope(raw).replyTo,{messageId:'42',resolution:'unresolved'});
 const original={message_id:'42',sender:{user_id:10001,nickname:'bot'},message_type:'group',group_id:30001,message:[{type:'text',data:{text:'original'}}]};
 const good=buildQqMessageEnvelope({raw,accountId:'10001',conversationId:'group:30001',verifiedReplies:[original]});assert.equal(good.replyTo.resolution,'verified');assert.equal(good.replyTo.senderId,'10001');assert.equal(good.replyTo.targetsSelf,true);assert.equal(good.replyTo.segments[0].text,'original');
 const wrong=buildQqMessageEnvelope({raw,accountId:'10001',conversationId:'group:30001',verifiedReplies:[{...original,group_id:30002}]});assert.equal(wrong.replyTo.resolution,'unresolved');
});
test('QQ reply policy accepts only the two enum fields and never identity material',()=>{
 assert.deepEqual(validateQqReplyStylePolicy(),{defaultStyle:'inherit',conversationStyle:'inherit'});
 assert.deepEqual(validateQqReplyStylePolicy({defaultStyle:'brief',conversationStyle:'detailed'}),{defaultStyle:'brief',conversationStyle:'detailed'});
 for(const p of [{defaultStyle:'verbose'},{conversationStyle:'owner'},{defaultStyle:'brief',senderId:'owner'},null])assert.throws(()=>validateQqReplyStylePolicy(p),{code:'QQ_REPLY_STYLE_INVALID'});
});
test('host broker ignores plugin identity, records frozen policy in journal and reuses a duplicate request',async t=>{
 const dataRoot=mkdtempSync(join(tmpdir(),'qq-envelope-broker-')),forwarded=[],account={ref:'account',accountId:'10001',generation:1,enabled:true},identity={pluginId:'qq-plugin',packageName:'@ai-buddy/qq-connect'},profile={characterId:'claude',personaId:'default',lifeId:'life',operationId:'op',connectionRef:'role',available:true},model={id:'role',kind:'custom',protocol:'responses',model:'synthetic'};
 // Enter through real operator admission, the host-observed QQ message and an
 // actual Core lease. Only the final provider response is synthetic.
 const host=createSocialHost({dataRoot,resolveLife:()=>({...profile}),model:async({payload})=>{forwarded.push({payload:structuredClone(payload)});return {requestId:'fake-request',text:'synthetic reply',usageAccounting:'core-model-router',replyStyle:'brief',replyStyleSource:'qq-default'};}});
 const bridge=createBuddyPluginServices({resolveContext:spec=>host.resolveContext(spec),hostServices:host.services});bridge.grants.set({pluginId:identity.pluginId,declared:SOCIAL_CAPABILITIES,granted:SOCIAL_CAPABILITIES});
 const core={socialHost:host,socialProfile:()=>({...profile}),socialCatalog:()=>[],owner:{owner:()=>null},registerSocialDelivery:()=>({revoke(){}})};
 const broker=createSocialPluginBroker({dataRoot,accounts:{get:()=>structuredClone(account),forPlugin:()=>structuredClone(account)},transport:{inbound:()=>({raw:event({time:1700000000})})},getR95:()=>core,getProvider:()=>({captureConnection:()=>structuredClone(model)}),bridge});
 t.after(async()=>{await broker.close();await bridge.close();host.close();rmSync(dataRoot,{recursive:true,force:true});});
 const read=payload=>broker.handlers['social.context.read']({identity,payload,context:{authority:{kind:'app',action:'takeover'}},check:async()=>{}});
 await read({purpose:'qq-operator-bind',characterId:'claude'});
 const context=await read({purpose:'qq-message',connectionId:'trusted-connection',sourceMessageId:'m1',accountId:'10001',senderId:'20001',conversationId:'group:30001',conversationType:'group',characterId:'claude',lifeId:'life',operationId:'op'});
 const row=await broker.contextProvider({identity,method:'activity.lease',payload:{contextToken:context.contextToken}}),lease=await broker.handlers['activity.lease']({identity,context:row,payload:{activityId:'envelope-attempt'},check:async()=>{}});
 const payload={contextToken:context.contextToken,...lease,requestId:'stable',purpose:'qq-reply',replyStylePolicy:{defaultStyle:'brief',conversationStyle:'inherit'},input:{senderId:'forged-owner',nickname:'forged'}};
 const call=async payload=>broker.handlers['models.request']({identity,context:await broker.contextProvider({identity,method:'models.request',payload}),payload,check:async()=>{}});
 const first=await call(payload),repeat=await call(structuredClone(payload));assert.equal(first.replyStyle,'brief');assert.equal(repeat.requestId,first.requestId);assert.equal(forwarded.length,1);const body=JSON.parse(forwarded[0].payload.messages[0].content);assert.equal(body.sender.id,'20001');assert.equal(body.sender.displayName,'群名片');assert.equal(JSON.stringify(body).includes('forged-owner'),false);assert.deepEqual(forwarded[0].payload.replyStylePolicy,payload.replyStylePolicy);
 await assert.rejects(call({...payload,replyStylePolicy:{defaultStyle:'detailed',conversationStyle:'inherit'}}),{code:'SOCIAL_MODEL_ID_CONFLICT'});assert.equal(forwarded.length,1);
 await assert.rejects(call({...payload,purpose:'social-search'}),{code:'QQ_REPLY_STYLE_SCOPE_DENIED'});
});
for(const [caseName,wireText,projected,ackStatus='sent'] of [
 ['exact','core expression',true],
 ['trusted first introduction','现在由GPT陪你聊天。\ncore expression',true],
 ['unrelated body','unrelated B',false],
 ['arbitrary prefix','prefix\ncore expression',false],
 ['arbitrary suffix','core expression suffix',false],
 ['quoted introduction','“现在由GPT陪你聊天。”\ncore expression',false],
 ['wrong name','现在由Other陪你聊天。\ncore expression',false],
 ['similar introduction','现在由GPT陪你聊天!\ncore expression',false],
 ['trusted intro with wrong body','现在由GPT陪你聊天。\nunrelated B',false],
 ['unconfirmed send','core expression',false,'unknown'],
])test('broker QQ expression projection: '+caseName,async t=>{
 const dataRoot=mkdtempSync(join(tmpdir(),'qq-expression-receipt-')),account={ref:'account',accountId:'10001',generation:1,enabled:true},identity={pluginId:'qq-plugin',packageName:'@ai-buddy/qq-connect'},profile={characterId:'claude',personaId:'default',lifeId:'life',operationId:'op',connectionRef:'role',available:true},adapters=new Map(),events=[],appends=[];let issued=0;
 const host=createSocialHost({dataRoot,resolveLife:row=>({...profile,sessionId:row.sessionId,contextRevision:1,connectionRefs:['role']})}),raw=event({time:1700000000}),observation={kind:'qq-send',requestId:'native-request',messageId:'native-sent',text:wireText};
 const core={socialHost:host,socialCatalog:()=>[{id:'claude',label:'GPT'}],socialProfile:()=>profile,owner:{owner:()=>null},registerSocialDelivery:spec=>{adapters.set(spec.channel,spec);return {revoke(){}};}};
 const broker=createSocialPluginBroker({dataRoot,accounts:{get:()=>account,forPlugin:()=>account},getR95:()=>core,getProvider:()=>({}),onEvent:(_identity,e)=>events.push(e),transport:{inbound:()=>({raw}),request:async()=>({status:ackStatus,messageId:ackStatus==='sent'?'native-sent':undefined,observationId:ackStatus==='sent'?'observation':undefined}),observation:()=>observation},bridge:{issueContext:async()=>({contextToken:'context-'+(++issued)}),invoke:async request=>{if(request.method==='activity.lease')return {leaseId:'delivery-lease',generation:1};if(request.method==='activity.check')return {valid:true};if(request.method==='activity.finish')return {finished:true};if(request.method==='experience.append'){appends.push(request.payload.eventRef);return {recorded:true};}throw Error('Unexpected '+request.method);}}});
 t.after(async()=>{await broker.close();host.close();rmSync(dataRoot,{recursive:true,force:true});});
 await broker.handlers['social.context.read']({identity,payload:{purpose:'qq-operator-bind',characterId:'claude'},context:{authority:{kind:'app'}}});
 const c=await broker.handlers['social.context.read']({identity,payload:{purpose:'qq-message',connectionId:'connection',accountId:'10001',senderId:'20001',conversationType:'group',conversationId:'group:30001',sourceMessageId:'m1',characterId:'claude',lifeId:'life',operationId:'op'},context:{}}),row=await broker.contextProvider({identity,method:'models.request',payload:{contextToken:c.contextToken}});
 const pending=adapters.get('qq-group').send({scope:socialScopeSnapshot(row),messageId:'social-line-one',candidateId:'candidate-one',text:'core expression',sourceRefs:['inbound-ref']}),rejected=ackStatus==='sent'?null:assert.rejects(pending,{code:'SOCIAL_DELIVERY_RESULT_UNKNOWN'});await new Promise(setImmediate);assert.equal(events.at(-1).type,'proactive.deliver');
 await broker.handlers['connections.request']({identity,context:row,payload:{leaseId:'delivery-lease',requestId:'native-request',action:'send_group_msg',params:{group_id:'30001',message:[{type:'text',data:{text:observation.text}}]}},check:async()=>{}});
 if(rejected){await rejected;assert.equal(row.outboundEvidenceRefs,undefined,'unconfirmed sends cannot create an expression anchor');return;}
 const receipt=await pending,actualRef=row.outboundEvidenceRefs.find(([id])=>id==='native-sent')[1],actual=host.readEvidence(identity.pluginId,actualRef);assert.equal(receipt.status,'sent');assert.equal(receipt.nativeMessageId,'native-sent');assert.equal(actual.text,wireText);if(projected){assert.equal(receipt.eventRef,actualRef);assert.equal(receipt.sourceHash,actual.sourceHash);assert.deepEqual(actual.evidenceRefs,[{id:'social-line-one',kind:'qq-expression-projection',sha256:createHash('sha256').update(JSON.stringify('core expression')).digest('hex'),candidateId:'candidate-one'}]);}else{assert.equal(receipt.eventRef,undefined);assert.equal(receipt.sourceHash,undefined);assert.deepEqual(actual.evidenceRefs,[],'a true send of B must never prove unsent A');}
 await broker.handlers['experience.append']({identity,context:row,payload:{deliveryState:'sent',providerRequestId:'native-request',sourceMessageId:'native-sent'}});assert.deepEqual(appends,[actualRef]);assert.equal(host.readEvidence(identity.pluginId,actualRef).sourceHash,actual.sourceHash,'later append reuses exact receipt instead of conflicting with first-introduction metadata');
});
