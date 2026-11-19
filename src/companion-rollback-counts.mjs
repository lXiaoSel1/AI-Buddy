import {originalKey,withCompanionRead} from './companion-sqlite.mjs';

export function readCompanionRollbackCounts(path){
 return withCompanionRead(path,db=>{
  const ownerCounts=db.prepare(`
    SELECT owners.owner_type,owners.owner_id,count(messages.row_id) AS total
    FROM message_owners AS owners
    LEFT JOIN messages ON messages.owner_type=owners.owner_type AND messages.owner_id=owners.owner_id
    WHERE owners.owner_type IN ('private','group')
    GROUP BY owners.owner_type,owners.owner_id
    ORDER BY owners.owner_type,owners.owner_id
  `).all().map(row=>({type:row.owner_type,ownerId:originalKey(row.owner_id),sqliteCount:row.total}));
  const {activeMessageCount}=db.prepare("SELECT count(*) AS activeMessageCount FROM messages WHERE owner_type IN ('private','group')").get();
  const {totalMessageCount}=db.prepare('SELECT count(*) AS totalMessageCount FROM messages').get();
  return {activeMessageCount,totalMessageCount,ownerCounts};
 });
}

export function verifyCompanionRollbackCounts(census,exported){
 const arrays=new Map();
 for(const [type,owners] of [['private',exported.conversations],['group',exported.groups]]){
  for(const [id,owner] of Object.entries(owners??{})){
   if(Array.isArray(owner?.messages))arrays.set(JSON.stringify([type,id]),owner.messages.length);
  }
 }
 let jsonTotal=0;
 const ownerCounts=census.ownerCounts.map(({type,ownerId,sqliteCount})=>{
  const key=JSON.stringify([type,ownerId]),jsonCount=arrays.get(key);
  if(!Number.isSafeInteger(sqliteCount)||sqliteCount<0||jsonCount!==sqliteCount)throw Error('Rollback owner message count mismatch');
  arrays.delete(key);jsonTotal+=jsonCount;
  return {type,ownerId,sqliteCount,jsonCount};
 });
 if(arrays.size)throw Error('Rollback owner message count mismatch');
 if(jsonTotal!==census.activeMessageCount)throw Error('Rollback total message count mismatch');
 return {activeMessageCount:jsonTotal,ownerCounts};
}
