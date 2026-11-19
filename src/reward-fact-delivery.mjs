import {setImmediate} from 'node:timers/promises';

// ACK is deliberately separate from the durable wallet transaction. A stopped
// sender or a shutdown after commit leaves the whole batch available for
// idempotent redelivery; it must never replay model/tool operations.
export async function deliverRewardFacts({facts,ingest,recordUsage,acknowledge,isCurrent=()=>true,yieldTurn=()=>setImmediate()}={}){
 if(!Array.isArray(facts)||facts.length>200||Array.from(facts).some(fact=>!fact||!Number.isSafeInteger(fact.seq)||fact.seq<1))throw Error('Invalid reward delivery batch');
 await yieldTurn();
 if(!isCurrent())return {committed:false,acknowledged:false,count:0};
 const stale=Error('Reward sender changed before commit');
 const guard=()=>{if(!isCurrent())throw stale;};
 try{await ingest(facts,{trusted:true},{guard});}catch(error){if(error===stale)return {committed:false,acknowledged:false,count:0};throw error;}
 if(!isCurrent())return {committed:true,acknowledged:false,count:facts.length};
 for(const fact of facts)recordUsage({originId:fact.activityOriginId,requestKey:fact.canonicalRequestId,totalTokens:fact.totalTokens,live:fact.live===true&&!fact.baseline});
 await yieldTurn();
 if(!isCurrent())return {committed:true,acknowledged:false,count:facts.length};
 acknowledge(facts.map(fact=>fact.seq));
 return {committed:true,acknowledged:true,count:facts.length};
}
