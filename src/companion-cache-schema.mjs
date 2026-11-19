const isString=value=>typeof value==='string'&&value.length>0;
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const isAnchor=value=>isString(value?.id)&&isHash(value.hash)&&
 (value.occurrenceId===undefined||isString(value.occurrenceId))&&
 (value.rank===undefined||Number.isSafeInteger(value.rank)&&value.rank>=0);
const isDependency=value=>isString(value?.id)&&isHash(value.hash)&&
 (value.ownerId===undefined||isString(value.ownerId)&&isString(value.messageId));
const isMessage=value=>['user','assistant'].includes(value?.role)&&
 value.source?.kind===(value.role==='user'?'user':'model')&&
 Array.isArray(value.content)&&value.content.length>0&&value.content.every(part=>part?.type==='text'&&typeof part.text==='string');
const isEntry=value=>isMessage(value?.message)&&
 (value.dependencies===undefined||Array.isArray(value.dependencies)&&value.dependencies.every(isDependency))&&
 (value.memoryHashes===undefined||value.memoryHashes&&typeof value.memoryHashes==='object'&&
  !Array.isArray(value.memoryHashes)&&Object.values(value.memoryHashes).every(isHash))&&
 (value.memoryBaseline===undefined||value.memoryBaseline===true)&&
 (value.incomplete===undefined||value.incomplete===true)&&
 (value.clipped===undefined||value.clipped===true);

function isCommittedEntry(value){
 if(!isEntry(value))return false;
 if(value.memoryBaseline===true)return Array.isArray(value.anchors)&&value.anchors.every(isAnchor);
 if(value.summary===true||value.incomplete===true&&value.anchor===undefined)
  return Array.isArray(value.anchors)&&value.anchors.length>0&&value.anchors.every(isAnchor);
 return isAnchor(value.anchor);
}

export function validateCachePayload(value){
 if(value?.version!==1||!isString(value.sessionUuid)||!isHash(value.instructionsHash)||
  !Array.isArray(value.entries)||!value.entries.every(isCommittedEntry)||
  !(value.parent===null||isAnchor(value.parent))||
  !(value.pending===undefined||isString(value.pending?.requestId)&&isEntry(value.pending.current))||
  !(value.compactionAttempt===undefined||isHash(value.compactionAttempt))||
  !(value.wireSystemMode===undefined||['plain','available','unavailable'].includes(value.wireSystemMode))||
  !(value.replayWirePrefix===undefined||typeof value.replayWirePrefix==='boolean')||
  !(value.compactionState===undefined||value.compactionState&&typeof value.compactionState==='object'&&
   !Array.isArray(value.compactionState)&&Object.values(value.compactionState).every(
    number=>Number.isSafeInteger(number)&&number>=0)))throw Error('Invalid API window record');
 return value;
}

export function scopeMatches(scope,{characterId,conversationId,personaId,lifeId,legacyConversationIds=[]}){
 if(characterId!==undefined&&scope.characterId!==characterId)return false;
 if(conversationId!==undefined&&scope.conversationId!==conversationId)return false;
 if(personaId!==undefined&&(scope.personaId==null
  ?!legacyConversationIds.includes(scope.conversationId):scope.personaId!==personaId))return false;
 if(lifeId!==undefined&&(scope.lifeId==null
  ?!legacyConversationIds.includes(scope.conversationId):scope.lifeId!==lifeId))return false;
 return true;
}

export function messageInvalidator(messages){
 const changes=new Set(messages.map(({ownerId,id})=>JSON.stringify([ownerId,id])));
 return (value,ownerId)=>{
  function affected(entry){
   return (entry.anchors??[]).some(anchor=>changes.has(JSON.stringify([ownerId,anchor.id])))||
    (entry.anchor&&changes.has(JSON.stringify([ownerId,entry.anchor.id])))||
    (entry.dependencies??[]).some(source=>changes.has(JSON.stringify([source.ownerId,source.messageId])));
  }
  const first=value.entries.findIndex(affected);
  if(first<0&&!(value.pending&&affected(value.pending.current)))return null;
  const {pending,compactionAttempt,...kept}=value;
  return {...kept,entries:first<0?value.entries:value.entries.slice(0,first),parent:null};
 };
}
