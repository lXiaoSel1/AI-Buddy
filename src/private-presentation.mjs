export function privatePresentationKey({sessionId,companion}={}){
 const message=companion?.messages?.at(-1),characterId=companion?.activeCharacterId??companion?.characterId;
 if(!companion?.activeConversationId||!message?.id)return null;
 const token=message.lifeToken,lifeId=token?.lifeId??message.lifeId??companion.characters?.find(row=>row.id===characterId)?.life?.id;
 return JSON.stringify([sessionId,companion.activeConversationId,companion.activePersonaId??companion.personaId,characterId,lifeId,token?.operationId,message.id,message.requestId]);
}

// A render may refresh callbacks, but only a changed presentation target or
// visibility/audio state starts another attempt. Sent requests survive cleanup.
export function createPrivatePresentation({schedule=requestAnimationFrame,cancel=cancelAnimationFrame}={}){
 const inFlight=new Map();let current=null,signature=null,generation=0,frame=null;
 function cancelFrame(){if(frame!==null){cancel(frame);frame=null;}}
 function update(input){
  const message=input.companion?.messages?.at(-1),key=privatePresentationKey(input),eligible=!!key&&!input.companion?.activeGroupId&&message.role==='assistant'&&(message.presentation==='pending'||message.presentation==='presented'&&message.presentationSettlementPending===true);
  const next=JSON.stringify([key,eligible,!!input.visible,!!input.waiting]);current={...input,key};
  if(signature===next)return;signature=next;generation++;cancelFrame();
  if(!eligible||!input.visible||input.waiting||inFlight.has(key))return;
  const captured=generation;
  frame=schedule(()=>{
   frame=null;
   if(captured!==generation||!current?.visible||current.isVisible?.()===false)return;
   const task=Promise.resolve().then(()=>input.present({conversationId:input.companion.activeConversationId,id:message.id}));
   inFlight.set(key,task);
   void task.then(result=>{
    if(result?.presentationDeferred||result?.ok===false||!result?.view||captured!==generation||current?.key!==key||!current.visible||current.isVisible?.()===false||privatePresentationKey({sessionId:input.sessionId,companion:result.view.companion})!==key)return;
    current.apply(result.view,key);
   }).catch(()=>{}).finally(()=>{if(inFlight.get(key)!==task)return;inFlight.delete(key);if(captured!==generation&&current?.key===key&&current.visible&&!current.waiting){signature=null;update(current);}});
  });
 }
 function leave(){current=null;signature=null;generation++;cancelFrame();}
 return {update,leave};
}
