// The host owns durable preferences; ModelRouter.close() only stops the runtime.
// Both entry points use the host's serialized settings queue, never the router's
// lifecycle setter as a persistence hook. No connection/model request is made.
export function createChatPreferences({provider,read,write,apply,serialize=run=>run(),audit=()=>{}}){
 function enable(value,{allowUnavailable=false}={}){
  try{provider.setEnabled(value);}
  catch(error){
   if(!allowUnavailable)throw error;
   provider.setEnabled(false);
   audit({type:'chat-restore-unavailable',message:error.message});
  }
  return provider.status();
 }
 return {
  restore(){return enable(read().chatEnabled===true,{allowUnavailable:true});},
  save(patch,{allowUnavailable=false}={}){return serialize(async()=>{
   const previous=read(),next={...previous,...patch},wasEnabled=provider.enabled;
   // Validate before publishing a manual enable. This decrypts locally only.
   if(next.chatEnabled&&!allowUnavailable)provider.materialize(provider.selected());
   // A failed write leaves the entire prior preferences/runtime intact.
   await write(next);
   apply(next);
   try{return enable(next.chatEnabled===true,{allowUnavailable});}
   catch(error){
    // The selected configuration can change while the snapshot is publishing.
    apply(previous);
    if(provider.enabled!==wasEnabled)enable(wasEnabled,{allowUnavailable:true});
    try{await write(previous);}catch(rollback){audit({type:'chat-preference-rollback-failed',message:rollback.message});error.rollbackError=rollback;}
    throw error;
   }
  });}
 };
}
