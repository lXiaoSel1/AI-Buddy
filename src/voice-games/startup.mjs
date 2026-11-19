/** Publish a live companion host after its storage and pending CG facts are ready. */
export async function publishCompanionGameHost({markStorageReady,drainRewardFacts,cardGames,audit}){
 markStorageReady();
 const drain=await drainRewardFacts();
 // Rule registration shares the economy writer with CG reward delivery.
 // Queue it only after the outbox has finished its startup drain.
 void Promise.resolve().then(()=>cardGames.hostReady()).catch(error=>{
  if(error?.code==='GAME_INITIALIZATION_SUPERSEDED')return;
  try{audit({type:'card-games-host-ready-failed',code:error.code,message:error.message});}catch{}
 });
 return drain;
}
