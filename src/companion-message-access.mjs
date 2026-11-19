// The game and companion services can also be hosted with an in-memory store.
const collection=type=>type==='group'?'groups':'conversations';
const legacyRows=(state,type,id)=>state[collection(type)][id]?.messages??[];

export function recentMessages(store,state,type,id,limit=50,tx,options){
  if(!id)return [];
  const messages=tx?.messages??store.messages;
  return messages?messages.recent(type,id,limit,options):legacyRows(state,type,id).slice(-limit);
}

export function getMessage(store,state,type,id,messageId,tx,options){
  if(!id)return undefined;
  const messages=tx?.messages??store.messages;
  return messages?messages.get(type,id,messageId,options):legacyRows(state,type,id).find(row=>row.id===messageId);
}

export function updateMessage(state,type,id,messageId,edit,tx,options){
  if(!id)return undefined;
  if(tx?.messages)return tx.messages.update(type,id,messageId,edit,options);
  const row=legacyRows(state,type,id).find(row=>row.id===messageId);
  if(row)edit(row);
  return row;
}

export function appendMessage(state,type,id,message,tx,options){
  if(tx?.messages){
    const occurrenceId=tx.messages.append(type,id,message,options);
    delete state[collection(type)][id].messages;
    return occurrenceId;
  }
  else (state[collection(type)][id].messages??=[]).push(message);
}

export function countMessages(store,state,type,id,tx){
  if(!id)return 0;
  const messages=tx?.messages??store.messages;
  return messages?messages.count(type,id):legacyRows(state,type,id).length;
}

export async function queryMessages(store,state,type,id,options){
  if(!store.messages)return legacyRows(state,type,id);
  return store.messages.query({type,ownerId:id,...options});
}
