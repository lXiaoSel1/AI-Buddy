// Camera state is display-only: never use it to decide presence, API routing or rewards.
export function stageCapacity(width){return width>=900?4:width>=660?3:2;}
export function stableMembers(group){return [...new Set([...(group?.stageOrder??[]),...(group?.memberIds??[])])].filter(id=>group.memberIds.includes(id));}
export function stageWindow(order,capacity,target,previous=[]){
 const count=Math.min(capacity,order.length),index=order.indexOf(target);
 if(previous.length===count&&previous.every(id=>order.includes(id))&&(!target||previous.includes(target)))return previous;
 const start=Math.max(0,Math.min(order.length-count,index<0?0:index-Math.floor((count-1)/2)));
 return order.slice(start,start+count);
}
export const GROUP_EMOTIONS=['normal','cheerful','shy','serious','confused','angry','frightened','exasperated','starry'];
// The nameplate supplies the speaker. Strip only that speaker's leading labels;
// never remove names elsewhere in dialogue or rewrite the stored source text.
export function groupDialogueText(value,speakerName){
 const original=String(value??''),name=String(speakerName??'').trim();if(!name)return original;
 let body=original.trimStart(),changed=false;
 while(body.slice(0,name.length).toLowerCase()===name.toLowerCase()){
  const rest=body.slice(name.length).trimStart();if(!/^[：:]/.test(rest))break;
  body=rest.slice(1).trimStart();changed=true;
 }
 return changed&&body.trim()?body:original;
}
export function replyEmotion(text,tag,{speakerName}={}){
 if(GROUP_EMOTIONS.includes(tag))return {emotion:tag,emotionSource:'structured'};
 // Some models wrap their entire own line as Name:「...」. Only unwrap a
 // prefix matching the captured speaker; quotations of others stay excluded.
 const original=String(text??'').trim();let body=groupDialogueText(original,speakerName),ownLine=body!==original;
 if(ownLine){const pairs={'「':'」','『':'』','“':'”','"':'"'};if(pairs[body[0]]&&body.at(-1)===pairs[body[0]])body=body.slice(1,-1);}
 const clean=body.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|^\s*>.*$/gm,' ').replace(/(?:不(?=生气|开心|高兴|害羞|困惑|愤怒|害怕)|不要|别|没有|不是|不再|并不|一点也不|别再)[^，。！？\n]{0,12}/g,' ').replace(/\b(?:not|never|don't|do not|isn't|wasn't)\b[^.!?\n]{0,50}/gi,' ');
 const rules=[['starry',/星星眼|两眼放光|眼睛发亮|starry.?eyed|eyes? sparkle/i],['frightened',/吓一跳|吓到了|受惊|惊恐|startled|frightened|terrified/i],['angry',/生气|愤怒|气鼓鼓|气死|angry|furious|irritated/i],['shy',/害羞|脸红|羞涩|blush|shy|embarrassed/i],['exasperated',/无奈|叹气|唉[，。…]|exasperated|sigh/i],['confused',/困惑|不明白|疑惑|confused|puzzled/i],['serious',/认真|严肃|专注|坚定|serious|focused|determined/i],['cheerful',/开心|高兴|快乐|太棒了|笑起来|happy|delighted|wonderful|cheerful/i]];
 const found=rules.filter(([,pattern])=>pattern.test(clean));return found.length===1?{emotion:found[0][0],emotionSource:'keyword'}:{emotion:'normal',emotionSource:'fallback'};
}
