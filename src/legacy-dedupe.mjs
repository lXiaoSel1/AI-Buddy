import {createHash} from 'node:crypto';

// T3: legacy lines that earlier versions copied into several conversations (B12).
// A copy is a run of legacy messages whose speakers and text, in order, already
// appear among the earlier legacy messages of the same character and life. Message
// ids are ignored: every copy got a fresh random id. The earliest copy is kept.
const lineKey=message=>message.role+'\u0000'+message.text;
const sha=value=>createHash('sha256').update(value).digest('hex');

// Longest run keys[from..] that occurs contiguously in seen; returns {length,at}.
function longestMatch(seen,keys,from){
 let best={length:0,at:-1};
 for(let at=0;at<seen.length;at++){if(seen[at].key!==keys[from])continue;let length=1;while(from+length<keys.length&&at+length<seen.length&&seen[at+length].key===keys[from+length])length++;if(length>best.length)best={length,at};}
 return best;
}

export function planLegacyDedupe(state){
 const groups=new Map();
 for(const conversation of Object.values(state.conversations??{}))if(conversation.messages?.some(m=>m.legacy===true)){const key=conversation.characterId+'\u0000'+(conversation.lifeId??'');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(conversation);}
 const removals=[],characters={};
 for(const conversations of groups.values()){
  conversations.sort((a,b)=>(a.createdAt??0)-(b.createdAt??0)||String(a.id).localeCompare(String(b.id)));
  const seen=[];
  for(const conversation of conversations){
   const runs=[];let run=null;
   for(const message of conversation.messages){if(message.legacy===true&&typeof message.text==='string'){if(!run)runs.push(run=[]);run.push(message);}else run=null;}
   const removed=[],kept=[];
   for(const rows of runs){
    const keys=rows.map(lineKey);
    for(let index=0;index<keys.length;){
     const match=longestMatch(seen,keys,index);
     // One equal line alone is not a copy: the engine can write the same line twice.
     if(match.length>=2){for(let k=0;k<match.length;k++)removed.push({messageId:rows[index+k].id,keptConversationId:seen[match.at+k].conversationId,keptMessageId:seen[match.at+k].messageId});index+=match.length;}
     else{kept.push(rows[index]);index++;}
    }
   }
   for(const message of kept)seen.push({key:lineKey(message),conversationId:conversation.id,messageId:message.id});
   if(removed.length){
    removals.push({conversationId:conversation.id,characterId:conversation.characterId,lifeId:conversation.lifeId??null,messages:removed});
    const row=characters[conversation.characterId]??={duplicates:0,conversations:0};row.duplicates+=removed.length;row.conversations++;
   }
  }
 }
 // The id changes whenever any touched conversation changes, so a stale plan is refused.
 const fingerprint=removals.map(row=>[row.conversationId,sha(state.conversations[row.conversationId].messages.map(m=>m.id+'\u0000'+lineKey(m)).join('\n'))]);
 const planId=sha(JSON.stringify({task:'legacy-dedupe',removals,fingerprint})).slice(0,32);
 return {task:'legacy-dedupe',planId,total:removals.reduce((sum,row)=>sum+row.messages.length,0),characters,removals};
}

// Applies a plan to a state inside store.mutate. The plan is recomputed and must match.
export function applyLegacyDedupe(state,planId){
 const plan=planLegacyDedupe(state);
 if(plan.planId!==planId)throw Object.assign(Error('清理计划已经变化，请重新预演后再确认'),{code:'MAINTENANCE_PLAN_CHANGED'});
 for(const row of plan.removals){
  const conversation=state.conversations[row.conversationId],drop=new Set(row.messages.map(m=>m.messageId));
  conversation.messages=conversation.messages.filter(m=>!drop.has(m.id));
  // Memory events of a removed copy point at the event of the copy that stays.
  const events=state.lives?.[row.characterId]?.memory?.events??{},eventOf=(conversationId,messageId)=>Object.values(events).find(e=>e.source?.id===conversationId&&e.source?.messageId===messageId);
  for(const m of row.messages)for(const event of Object.values(events))if(event.source?.id===row.conversationId&&event.source?.messageId===m.messageId)event.duplicateOf=eventOf(m.keptConversationId,m.keptMessageId)?.id??m.keptConversationId+'/'+m.keptMessageId;
 }
 return plan;
}
