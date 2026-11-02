// Suggestions now commit independently after the foreground reply. Do not
// acknowledge presentation or create a model request merely to wait for them.
export async function waitForReplyChoices(game,{conversationId,timeoutMs=5000}={}){
  const until=Date.now()+timeoutMs;let last;
  while(Date.now()<until){
    last=await game.action('view');const state=last.companion,id=conversationId??state?.activeConversationId,row=state?.conversations?.find(value=>value.id===id);
    if(row?.choicesStatus==='ready'&&row.choicesFor===state?.messages?.at(-1)?.id&&row.choices?.length)return last;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw Error('Reply choices did not become ready for the committed message: '+JSON.stringify({conversationId,choices:last?.choices,conversations:last?.companion?.conversations?.map(value=>({id:value.id,status:value.choicesStatus,for:value.choicesFor}))}));
}
