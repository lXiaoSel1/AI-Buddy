import {createHash} from 'node:crypto';

const rootCollections=['events','interruptedInteractions','interruptedGroupSettlements','lifeArchives','relationshipProjections'];
const memoryCollections=['events','summaries','guides','core','branches','jobs','working','notices'];
const lifeCollections=['personalEvents','gameExperiences','workExperiences','socialExperiences'];
const r95Collections=['lines','evidence','moodEvaluations','moodReviewEvaluations','pendingMoodEventIds'];
const growthCollections=['history','observations','batches','evidenceUse','daily','failures'];

const recordKey=(value,ordinal)=>typeof value==='string'?value:value?.id??value?.messageId??value?.clientRequestId??String(ordinal);

const coverageNamespaces='memory.coverage.';
const coverageHeaders='memory.coverageHeader.';
const coverageBytesPerChunk=36*1024-3;
const coverageHash=bytes=>createHash('sha256').update(bytes).digest('hex');
const coverageOwner=(life,key,field,hash)=>JSON.stringify([life,key,field,hash]);

function partitionMemoryCoverage(memory,life,at,owners,rows){
  const seen=new Set();
  for(const [collection,fields] of [
    ['jobs',['cutoff']],
    ['summaries',['cutoff','eventIds','modelEventIds','segments']]
  ]){
    let ordinal=0;
    const headerNamespace=coverageHeaders+collection;
    for(const [key,record] of Object.entries(memory?.[collection]??{})){
      const coverage={};
      for(const field of fields){
        if(!Array.isArray(record?.[field]))continue;
        const value=record[field],bytes=Buffer.from(JSON.stringify(value)),hash=coverageHash(bytes);
        const owner=coverageOwner(life,key,field,hash),namespace=coverageNamespaces+field;
        const chunks=Math.ceil(bytes.length/coverageBytesPerChunk);
        coverage[field]={hash,count:value.length,chunks};
        delete record[field];
        if(seen.has(owner))continue;
        seen.add(owner);
        owners.push({namespace,owner,array:true,at:[...at,'coverage',key,field]});
        for(let index=0;index<chunks;index++){
          const start=index*coverageBytesPerChunk;
          rows.push({namespace,owner,key:String(index),ordinal:index,value:bytes.subarray(start,start+coverageBytesPerChunk).toString('base64')});
        }
      }
      if(!Object.keys(coverage).length)continue;
      if(ordinal===0)owners.push({namespace:headerNamespace,owner:life,array:false,at:[...at,collection]});
      rows.push({namespace:headerNamespace,owner:life,key,ordinal:ordinal++,value:{record,coverage}});
      delete memory[collection][key];
    }
  }
}

function restoreMemoryCoverage(state,owners,rowsByOwner){
  for(const {namespace,owner,at} of owners){
    if(!namespace.startsWith(coverageHeaders))continue;
    const holder=holderAt(state,at.slice(0,-1));
    if(!holder)continue;
    const entries=rowsByOwner.get(JSON.stringify([namespace,owner]));
    if(!entries?.length)continue;
    const collection=holder[at.at(-1)]??={};
    for(const {key,value:{record:header,coverage}} of entries){
      const record={...header};
      for(const [field,{hash,count,chunks}] of Object.entries(coverage)){
        const source=rowsByOwner.get(JSON.stringify([coverageNamespaces+field,coverageOwner(owner,key,field,hash)]))??[];
        if(source.length!==chunks||source.some((part,ordinal)=>part.ordinal!==ordinal||typeof part.value!=='string'))
          throw Error('Incomplete companion memory coverage');
        const bytes=Buffer.concat(source.map(part=>Buffer.from(part.value,'base64')));
        if(coverageHash(bytes)!==hash)throw Error('Corrupt companion memory coverage');
        const value=JSON.parse(bytes.toString('utf8'));
        if(!Array.isArray(value)||value.length!==count)throw Error('Invalid companion memory coverage');
        Object.defineProperty(record,field,{value,writable:true,configurable:true,enumerable:true});
      }
      Object.defineProperty(collection,key,{value:record,writable:true,configurable:true,enumerable:true});
    }
  }
}


export const groupAutoNamespace=name=>'group.autoEvidence.'+name;
export const groupAutoOwner=(groupId,sessionId)=>JSON.stringify([groupId,sessionId]);
export const groupAutoPath=(groupId,sessionId,name)=>sessionId===null
  ? ['groups',groupId,'autoAuthorizations']
  : ['groups',groupId,'autoEvidence',sessionId,name];

export function partitionGroupAutoEvidence(state){
  const recordOwners=[],recordRows=[];
  function extract(holder,groupId,sessionId,name){
    const values=holder?.[name];
    if(!values||typeof values!=='object'||Array.isArray(values))return;
    const namespace=groupAutoNamespace(name),owner=groupAutoOwner(groupId,sessionId);
    recordOwners.push({namespace,owner,array:false,at:groupAutoPath(groupId,sessionId,name)});
    Object.entries(values).forEach(([key,value],ordinal)=>recordRows.push({namespace,owner,key,ordinal,value}));
    delete holder[name];
  }
  for(const [groupId,group] of Object.entries(state.groups??{})){
    extract(group,groupId,null,'autoAuthorizations');
    const sessions=[group.auto,...(group.autoHistory??[])].filter(row=>typeof row?.id==='string');
    for(const session of sessions){
      if(sessions.some(row=>row!==session&&row.id===session.id))continue;
      for(const name of ['completed','retiredRequests'])extract(session,groupId,session.id,name);
    }
  }
  return {state,recordOwners,recordRows};
}


export function partitionCompanionData(source,{chunkMemoryCoverage=true}={}){
  const state=structuredClone(source),rows=[],owners=[],recordRows=[],recordOwners=[];
  if(state.schema!==1){
    const auto=partitionGroupAutoEvidence(state);
    recordOwners.push(...auto.recordOwners);
    recordRows.push(...auto.recordRows);
  }
  function record(holder,key,namespace,owner,at){
    const value=holder?.[key];
    if(!value||typeof value!=='object')return;
    const array=Array.isArray(value);
    recordOwners.push({namespace,owner,array,at:[...at,key]});
    const used=new Set();
    for(const [ordinal,[original,item]] of Object.entries(value).entries()){
      let key=array?String(recordKey(item,ordinal)):original;
      while(used.has(key))key='\u001f'+key;
      used.add(key);
      recordRows.push({namespace,owner,key,ordinal,value:item});
    }
    delete holder[key];
  }
  function chat(type,ownerId,owner,at){
    if(!Array.isArray(owner?.messages))return;
    owners.push({type,ownerId,at});
    owner.messages.forEach((message,ordinal)=>rows.push({type,ownerId,ordinal,message}));
    delete owner.messages;
  }
  function evidence(entries,type,rootId,at){
    for(const [index,owner] of Object.entries(entries??[])){
      const ownerId=JSON.stringify([rootId,index]),path=[...at,index];
      chat(type,ownerId,owner,path);
      record(owner,'duplicateMessageSeqs',type+'.duplicateMessageSeqs',ownerId,path);
    }
  }
  function life(holder,id,at){
    for(const key of lifeCollections)record(holder,key,'life.'+key,id,at);
    record(holder,'groupIntervals','life.groupIntervals',id,at);
    if(chunkMemoryCoverage)partitionMemoryCoverage(holder.memory,id,[...at,'memory'],recordOwners,recordRows);
    for(const key of memoryCollections)record(holder.memory,key,'memory.'+key,id,[...at,'memory']);
    for(const key of r95Collections)record(holder.r95,key,'life.r95.'+key,id,[...at,'r95']);
    for(const key of ['candidates','sourceKeys'])record(holder.r95?.proactive,key,'life.proactive.'+key,id,[...at,'r95','proactive']);
    record(holder.r95?.attention,'events','life.attention.events',id,[...at,'r95','attention']);
    for(const key of growthCollections)record(holder.growth,key,'growth.'+key,id,[...at,'growth']);
    record(holder.growth?.preferences,'evidenceUseByTrait','growth.preferences.evidenceUseByTrait',id,[...at,'growth','preferences']);
    for(const [key,trait] of Object.entries(holder.growth?.preferences?.traits??{})){
      for(const name of ['evidence','counterEvidence','versions'])record(trait,name,'growth.trait.'+name,JSON.stringify([id,key]),[...at,'growth','preferences','traits',key]);
    }
    record(holder.growth?.preferences,'traits','growth.preferences.traits',id,[...at,'growth','preferences']);
  }
  for(const key of rootCollections)record(state,key,'root.'+key,'',[]);
  for(const [id,holder] of Object.entries(state.legacyImports??{})){
    if(holder&&typeof holder==='object')record(state.legacyImports,id,'legacyImports',id,['legacyImports']);
  }
  record(state.r95,'proactiveDeliveryReceipts','root.r95.proactiveDeliveryReceipts','',['r95']);
  for(const [id,owner] of Object.entries(state.conversations??{}))chat('private',id,owner,['conversations',id]);
  for(const [id,owner] of Object.entries(state.groups??{})){
    chat('group',id,owner,['groups',id]);
    for(const key of ['pendingUserInputs','submissions','photos'])record(owner,key,'group.'+key,id,['groups',id]);
    for(const member of Object.keys(owner.intervals??{}))record(owner.intervals,member,'group.intervals',JSON.stringify([id,member]),['groups',id,'intervals']);

  }
  for(const [id,current] of Object.entries(state.lives??{})){
    const at=['lives',id];
    life(current,id,at);
    evidence(current.restoredGroupEvidence,'life-group',id,[...at,'restoredGroupEvidence']);
  }
  const transaction=state.lifeTransaction,target=transaction?.target;
  if(target){
    const at=['lifeTransaction','target'];
    evidence(target.conversations,'transaction-private',transaction.id,[...at,'conversations']);
    evidence(target.groupEvidence,'transaction-group',transaction.id,[...at,'groupEvidence']);
    if(target.life){
      life(target.life,'transaction:'+transaction.id,[...at,'life']);
      evidence(target.life.restoredGroupEvidence,'transaction-life-group',transaction.id,[...at,'life','restoredGroupEvidence']);
    }
  }
  return {state,rows,owners,recordRows,recordOwners};
}

function holderAt(state,path){
  return path.reduce((value,key)=>value&&Object.hasOwn(value,key)?value[key]:undefined,state);
}

export function materializeCompanionData(snapshot){
  const {state,rows,owners,recordRows,recordOwners}=snapshot;
  const collections=new Map();
  for(const {type,ownerId,at} of owners){
    const holder=holderAt(state,at??(type==='private'?['conversations',ownerId]:['groups',ownerId]));
    if(!holder)continue;
    holder.messages=[];
    collections.set(JSON.stringify([type,ownerId]),holder.messages);
  }
  for(const {type,ownerId,message} of rows)collections.get(JSON.stringify([type,ownerId]))?.push(message);
  const grouped=new Map();
  for(const row of recordRows){
    const key=JSON.stringify([row.namespace,row.owner]);
    if(!grouped.has(key))grouped.set(key,[]);
    grouped.get(key).push(row);
  }
  const sorted=[...recordOwners].sort((a,b)=>a.at.length-b.at.length);
  for(const {namespace,owner,array,at} of sorted){
    if(namespace.startsWith(coverageNamespaces)||namespace.startsWith(coverageHeaders))continue;
    let holder=holderAt(state,at.slice(0,-1));
    if(namespace.startsWith('group.autoEvidence.')&&at[2]==='autoEvidence'){
      const group=state.groups?.[at[1]],sessionId=at[3];
      holder=group?.auto?.id===sessionId?group.auto:group?.autoHistory?.find(session=>session.id===sessionId);
    }
    if(!holder)continue;
    const value=array?[]:{};
    for(const row of grouped.get(JSON.stringify([namespace,owner]))??[]){
      if(array)value.push(row.value);
      else Object.defineProperty(value,row.key,{value:row.value,writable:true,configurable:true,enumerable:true});
    }
    Object.defineProperty(holder,at.at(-1),{value,writable:true,configurable:true,enumerable:true});
  }
  restoreMemoryCoverage(state,sorted,grouped);
  return state;
}
