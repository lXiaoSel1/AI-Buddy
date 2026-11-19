import {copyCompanionValue} from './companion-draft.mjs';
import {groupAutoNamespace,groupAutoOwner,groupAutoPath} from './companion-partitions.mjs';

export const rootRecord=(store,state,name,key,tx)=>{
  const records=tx?.records??store.records;
  return records?records.get('root.'+name,'',key):state[name]?.[key];
};

export function saveRootRecord(state,name,key,value,tx){
  if(tx?.records)tx.records.put('root.'+name,'',key,value,{at:[name]});
  else (state[name]??={})[key]=value;
}

export function removeRootRecord(state,name,key,tx){
  if(tx?.records)tx.records.delete('root.'+name,'',key);
  else if(state[name])delete state[name][key];
}

export function groupRecord(store,state,group,name,key,tx){
  const records=tx?.records??store.records;
  if(records)return records.get('group.'+name,group,key);
  const owner=state.groups[group]?.[name];
  return Array.isArray(owner)?owner.find(row=>row.clientRequestId===key):owner?.[key];
}

export function saveGroupRecord(state,group,name,key,value,tx,{array=false}={}){
  if(tx?.records)tx.records.put('group.'+name,group,key,value,{array,at:['groups',group,name]});
  else{
    const owner=state.groups[group][name]??=(array?[]:{});
    if(array){
      const index=owner.findIndex(row=>row.clientRequestId===key);
      if(index<0)owner.push(value);
      else owner[index]=value;
    }else owner[key]=value;
  }
}

export function lifeRecord(store,state,character,namespace,path,key,tx){
  const records=tx?.records??store.records;
  if(records)return records.get(namespace,character,key);
  const collection=path.reduce((value,field)=>value?.[field],state.lives?.[character]);
  return Array.isArray(collection)?collection.find(row=>(row.id??row.messageId)===key):collection?.[key];
}

export function saveLifeRecord(state,character,namespace,path,key,value,tx,{array=false}={}){
  if(tx?.records){tx.records.put(namespace,character,key,value,{array,at:['lives',character,...path]});return;}
  const holder=path.slice(0,-1).reduce((target,field)=>target[field]??={},state.lives[character]);
  const records=holder[path.at(-1)]??=(array?[]:{});
  if(!array){records[key]=value;return;}
  const index=records.findIndex(row=>(row.id??row.messageId)===key);
  if(index<0)records.push(value);
  else records[index]=value;
}

export function listLifeRecords(store,state,character,namespace,path,limit=100){
  if(store.records)return store.records.recent(namespace,character,limit).map(row=>row.value);
  const value=path.reduce((holder,key)=>holder?.[key],state.lives?.[character]);
  return Array.isArray(value)?value:Object.values(value??{});
}

export function editLifeRecord(store,state,character,namespace,path,key,edit,tx,options){
  const current=lifeRecord(store,state,character,namespace,path,key,tx);
  if(!current)return undefined;
  edit(current);
  saveLifeRecord(state,character,namespace,path,key,current,tx,options);
  return current;
}

export function groupAutoRecord(store,holder,groupId,sessionId,name,key,tx){
  const records=tx?.records??store.records;
  return records?.get(groupAutoNamespace(name),groupAutoOwner(groupId,sessionId),key)??holder?.[name]?.[key];
}

export function groupAutoRecords(store,holder,groupId,sessionId,name,tx){
  if(!store.records)return holder?.[name];
  const namespace=groupAutoNamespace(name),owner=groupAutoOwner(groupId,sessionId);
  if(tx?.records.hasOwner(namespace,owner))return tx.records.object(namespace,owner);
  if(store.records.hasOwner(namespace,owner))return store.records.object(namespace,owner);
  return holder?.[name];
}

export function saveGroupAutoRecord(store,holder,groupId,sessionId,name,key,value,tx,evict){
  if(!tx?.records){(holder[name]??={})[key]=value;return;}
  const namespace=groupAutoNamespace(name),owner=groupAutoOwner(groupId,sessionId);
  const descriptor={at:groupAutoPath(groupId,sessionId,name)};
  if(evict&&!tx.records.has(namespace,owner,key)){
    const excess=store.records.count(namespace,owner)+1-evict.limit;
    if(excess>0){
      const older=store.records.oldest(namespace,owner,Math.min(excess,100));
      tx.archiveEvidence(older.map(row=>({namespace:evict.namespace,id:row.key,value:row.value})));
      for(const row of older)tx.records.delete(namespace,owner,row.key);
    }
  }
  tx.records.put(namespace,owner,key,value,descriptor);
}

export function copyGroupAutoSession(store,groupId,auto,tx){
  if(!auto)return null;
  const result=copyCompanionValue(auto);
  if(!store.records)return result;
  for(const name of ['completed','retiredRequests']){
    const rows=groupAutoRecords(store,auto,groupId,auto.id,name,tx);
    if(rows!==undefined)result[name]=rows;
  }
  return result;
}


const autoSessionFields=['id','status','mode','roundLimit','members','roundIndex','opportunityIndex','endedAt','endedReason'];
const autoPendingFields=['requestId','characterId','status','roundIndex'];
const autoCompletedFields=['characterId','status','roundIndex','opportunityIndex'];
function autoProgressFields(value,fields){
  const result={};
  for(const key of fields)if(Object.hasOwn(value,key))result[key]=copyCompanionValue(value[key]);
  return result;
}

export function copyGroupAutoProgress(store,groupId,auto){
  if(!auto)return null;
  const result=autoProgressFields(auto,autoSessionFields);
  if(Object.hasOwn(auto,'pending')){
    const pending=auto.pending;
    result.pending=pending&&typeof pending==='object'?autoProgressFields(pending,autoPendingFields):pending;
  }
  const records=store.records;
  if(records?.autoCompletedProgress){
    const completed=records.autoCompletedProgress(groupAutoOwner(groupId,auto.id));
    if(completed!==undefined){result.completed=completed;return result;}
  }
  const completed=records?.autoCompletedProgress?auto.completed:groupAutoRecords(store,auto,groupId,auto.id,'completed');
  if(completed!==undefined){
    const project=row=>Array.isArray(row)?[]:row&&typeof row==='object'?autoProgressFields(row,autoCompletedFields):row;
    result.completed=completed&&typeof completed==='object'
      ?Object.fromEntries(Object.entries(completed).map(([id,row])=>[id,project(row)]))
      :completed;
  }
  return result;
}
