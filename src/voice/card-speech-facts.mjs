// Inputs come from the host economy immediately after a successful commit.
// Only public presentation facts leave this adapter; private hands never do.
const fixedKinds=new Set(['allin','trips']);
function scopeFor(table,player){
  if(!player||player.kind!=='ai')return null;
  const scope={channel:'card-table',tableId:table.id,handId:table.state.handId,
    characterId:player.characterId,personaId:player.personaId,lifeId:player.lifeId,operationId:player.operationId};
  return Object.values(scope).every(value=>typeof value==='string'&&value)?scope:null;
}
export function committedCardSpeechFacts(table,action){
  const result=[{type:'scope-update',tableId:table.id,handId:table.state.handId,status:table.status}];
  if(!action)return result;
  const ai=table.players.filter(player=>player.kind==='ai'),actor=id=>ai.find(player=>player.id===id);
  const events=(table.presentation?.events??[]).filter(event=>fixedKinds.has(event.kind));
  const played=table.state.type==='doudizhu'&&action.type==='play'?table.state.history?.at(-1):null;
  if(played?.type==='play'&&played.actorId===action.actorId&&played.pattern==='triple')events.push({id:table.id+':triple:'+table.version,kind:'triple',actorId:action.actorId});
  for(const event of events){const scope=scopeFor(table,actor(event.actorId));if(scope)result.push({eventId:event.id,kind:event.kind,scope});}
  const speech=table.presentation?.lastSpeech;
  // A fixed call replaces the action's optional banter in audio, avoiding an
  // All-in call twice. Both original facts remain in the game text/history.
  if(speech&&!events.some(event=>event.actorId===speech.actorId)){
    const scope=scopeFor(table,ai.find(player=>player.characterId===speech.characterId));
    if(scope)result.push({eventId:speech.id,kind:'lastSpeech',text:speech.text,scope});
  }
  return result;
}
export function committedTableChatFact(table,player,message){
  const scope=scopeFor(table,player);
  return scope&&typeof message.id==='string'&&typeof message.text==='string'?{eventId:message.id,kind:'table-chat',text:message.text,scope}:null;
}
