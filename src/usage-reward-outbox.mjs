/** Durable, canonical facts only. Delivery ACK is separate from wallet commit. */
export class UsageRewardOutbox{
 constructor(repository,{now=Date.now}={}){
  this.db=repository.db;this.now=now;
  this.db.exec(`CREATE TABLE IF NOT EXISTS reward_requests(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,total REAL,body TEXT NOT NULL);CREATE TABLE IF NOT EXISTS reward_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,UNIQUE(id,revision));`);
  this.enabledAt=repository.meta('r95RewardEnabledAt');if(this.enabledAt==null){this.enabledAt=now();repository.meta('r95RewardEnabledAt',this.enabledAt);}
 }
 observe(row,{live=false}={}){
  const amount=row.usage?.total;if(!Number.isSafeInteger(amount)||amount<0||row.rewardManagedBy==='cg-job'||row.billable===false||row.accounting==='child-detail'||row.mirror===true)return;
  const id=row.canonicalRequestId??[row.tool??row.provider,row.nativeSessionId??row.sessionId,row.nativeRequestId??row.requestId].join(':');
  if(!row.requestId&&!row.nativeRequestId||!row.sessionId&&!row.nativeSessionId)return;
  const old=this.db.prepare('SELECT * FROM reward_requests WHERE id=?').get(id),previous=old&&JSON.parse(old.body);
  const occurredAt=Number.isFinite(row.occurredAt)?row.occurredAt:Date.parse(row.timestamp),baseline=old?previous.baseline&&live!==true:live!==true||!Number.isFinite(occurredAt)||occurredAt<this.enabledAt;
  const body={canonicalRequestId:id,totalTokens:amount,sourceId:row.sourceId??null,occurredAt:Number.isFinite(occurredAt)?occurredAt:null,baseline,live:live===true,activityOriginId:row.activityOriginId??null,purpose:row.purpose??'unknown',...(row.scope?{scope:row.scope}:{})};
  if(old&&old.total===amount)return;const revision=(old?.revision??0)+1;body.revision=revision;
  this.db.prepare('INSERT INTO reward_requests VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,total=excluded.total,body=excluded.body').run(id,revision,amount,JSON.stringify(body));
  this.db.prepare('INSERT INTO reward_outbox(id,revision,body) VALUES(?,?,?)').run(id,revision,JSON.stringify(body));
 }
 pending(limit=200){return this.db.prepare('SELECT seq,body FROM reward_outbox ORDER BY seq LIMIT ?').all(Math.max(1,Math.min(1000,limit))).map(row=>({seq:row.seq,...JSON.parse(row.body)}));}
 ack(sequences){
  if(!Array.isArray(sequences))throw Error('Invalid reward outbox ACK');
  // Snapshot and validate the entire request before entering SQLite, including
  // sparse array slots. Repeated/already-acknowledged IDs remain harmless.
  const values=Array.from(sequences);for(const seq of values)if(!Number.isSafeInteger(seq)||seq<1)throw Error('Invalid reward outbox ACK');
  if(!values.length)return;
  this.db.exec('SAVEPOINT reward_outbox_ack');
  try{
   const remove=this.db.prepare('DELETE FROM reward_outbox WHERE seq=?');
   for(const seq of new Set(values))remove.run(seq);
   this.db.exec('RELEASE reward_outbox_ack');
  }catch(error){
   try{this.db.exec('ROLLBACK TO reward_outbox_ack');this.db.exec('RELEASE reward_outbox_ack');}catch(rollbackError){error.rollbackError=rollbackError;}
   throw error;
  }
 }
 baseline(){return this.db.prepare('SELECT body FROM reward_requests ORDER BY id').iterate();}
}
