const fail=code=>Object.assign(Error(code),{code});
const scalar=value=>typeof value==='string'?value:Number.isSafeInteger(value)?String(value):'';
const id=value=>/^[1-9]\d{0,19}$/.test(value);
const messageId=value=>{const s=scalar(value);return s&&s.length<=128&&!/[\s\u0000-\u001f\u007f]/u.test(s)?s:null;};
const text=(value,max=100000)=>typeof value==='string'?value.slice(0,max):'';
const name=value=>text(value,256).replace(/[\u0000-\u001f\u007f]/gu,' ').trim();
const decode=value=>value.replace(/&#44;/g,',').replace(/&#91;/g,'[').replace(/&#93;/g,']').replace(/&amp;/g,'&');
// Tokenize first: escaped literal CQ must never become a structural mention/reply.
export function parseQqMessageSegments(value){
 if(Array.isArray(value)){if(value.length>128)throw fail('QQ_MESSAGE_TOO_LARGE');return value;}
 if(typeof value!=='string'||value.length>200000)throw fail('QQ_MESSAGE_INVALID');
 const result=[];let start=0;const plain=s=>{if(s)result.push({type:'text',data:{text:decode(s)}});};
 for(const m of value.matchAll(/\[CQ:(?:at|reply),[^\[\]]*\]/g)){
  const at=/^\[CQ:at,qq=(all|[1-9]\d{0,19})\]$/.exec(m[0]),reply=/^\[CQ:reply,id=([^,\[\]]{1,128})\]$/.exec(m[0]);
  const rid=reply&&messageId(decode(reply[1]));if(!at&&!rid)continue;
  plain(value.slice(start,m.index));result.push(at?{type:'at',data:{qq:at[1]}}:{type:'reply',data:{id:rid}});start=m.index+m[0].length;
 }
 plain(value.slice(start));if(result.length>128)throw fail('QQ_MESSAGE_TOO_LARGE');return result;
}
function project(segments){return segments.map(s=>{
 const d=s?.data??{},type=s?.type;
 if(type==='text')return {type,text:text(d.text)};
 if(type==='at'){const targetId=scalar(d.qq);return {type,targetId:id(targetId)||targetId==='all'?targetId:null};}
 if(type==='reply')return {type,messageId:messageId(d.id)};
 if(type==='image'||type==='mface')return {type,mediaRef:{file:text(d.file,4096),url:text(d.url,4096),summary:text(d.summary,512)}};
 if(type==='face')return {type,id:scalar(d.id)};
 if(type==='json'||type==='xml')return {type,text:text(d.data,32768)};
 return {type:'unsupported',originalType:text(type,64)};
});}
export function validateQqReplyStylePolicy(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['defaultStyle','conversationStyle'].includes(k)))throw fail('QQ_REPLY_STYLE_INVALID');
 const result={defaultStyle:value.defaultStyle??'inherit',conversationStyle:value.conversationStyle??'inherit'};
 if(Object.values(result).some(v=>!['inherit','brief','natural','detailed'].includes(v)))throw fail('QQ_REPLY_STYLE_INVALID');return result;
}
export function buildQqMessageEnvelope({raw,accountId,conversationId,verifiedReplies=[]}){
 const senderId=scalar(raw?.user_id??raw?.sender?.user_id),selfId=scalar(raw?.self_id),type=raw?.message_type,peerId=type==='group'?scalar(raw.group_id):senderId;
 if(!id(selfId)||selfId!==accountId||!id(senderId)||senderId===selfId||!['private','group'].includes(type)||!id(peerId)||conversationId!==type+':'+peerId||raw.sender?.user_id!=null&&scalar(raw.sender.user_id)!==senderId)throw fail('QQ_EVENT_IDENTITY_INVALID');
 const sourceMessageId=messageId(raw.message_id);if(!sourceMessageId)throw fail('QQ_MESSAGE_ID_REQUIRED');
 const nickname=name(raw.sender?.nickname),card=name(raw.sender?.card),segments=project(parseQqMessageSegments(raw.message));
 const mentions=segments.filter(s=>s.type==='at'&&s.targetId).map(s=>({targetId:s.targetId,isSelf:s.targetId===selfId,isAll:s.targetId==='all'}));
 const reply=segments.find(s=>s.type==='reply'&&s.messageId);let replyTo=reply?{messageId:reply.messageId,resolution:'unresolved'}:null;
 for(const result of reply?verifiedReplies:[]){
  const original=result?.status==='ok'?result.data:result,originalSender=scalar(original?.sender?.user_id??original?.senderId);
  const sameConversation=type==='group'?scalar(original?.group_id)===peerId:original?.message_type==='private'&&scalar(original?.target_id??original?.peerId)===peerId;
  if(messageId(original?.message_id??original?.messageId)!==reply.messageId||!id(originalSender)||!sameConversation||original?.self_id!=null&&scalar(original.self_id)!==selfId)continue;
  try{replyTo={messageId:reply.messageId,resolution:'verified',senderId:originalSender,targetsSelf:originalSender===selfId,segments:project(parseQqMessageSegments(original.message))};break;}catch{}
 }
 return {schemaVersion:1,kind:'qq-message',account:{selfId},conversation:{type,id:conversationId,...(type==='group'?{groupId:peerId}:{})},sourceMessageId,sender:{id:senderId,...(nickname?{nickname}:{}),...(card?{card}:{}),displayName:card||nickname||senderId},segments,mentions,replyTo,untrusted:true};
}
