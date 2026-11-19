import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {renameSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {messageInvalidator,scopeMatches,validateCachePayload} from './companion-cache-schema.mjs';

const {filename,retryMs}=workerData;
let nativeRecovery=workerData.nativeRecovery;
const retryDelays=[100,400,1000];
const retryGate=new Int32Array(new SharedArrayBuffer(4));
const primaryCode=error=>Number.isInteger(error.errcode)?error.errcode&255:null;
const isBusy=error=>[5,6].includes(primaryCode(error));
const isCorrupt=error=>[11,26].includes(primaryCode(error))||error.code==='COMPANION_CACHE_CORRUPT';
const failureKind=error=>isBusy(error)?'busy':isCorrupt(error)?'corrupt':'storage';
const audit=[];
let deferBusy=false;
let database,failures=0,retryAt=0,unavailable=workerData.unavailable,restoring=false,version=0;
const snapshots=new Map();
const knownApi=new Map();
const knownNative=new Map();

function remember(row){
 const current={stamp:{revision:row.revision,version:++version},row};
 knownApi.set(row.scope.key,current);
 return current.stamp;
}

function retry(run){
 for(let attempt=0;;attempt++){
  try{return run();}
  catch(error){
   if(!isBusy(error)||deferBusy||attempt===retryDelays.length)throw error;
   Atomics.wait(retryGate,0,0,retryDelays[attempt]);
  }
 }
}

function open(){
 const next=new DatabaseSync(filename);
 try{
  next.exec('PRAGMA busy_timeout=25; PRAGMA secure_delete=ON;');
  // Run before changing journal mode so a damaged database is retained as found.
  if(next.prepare('PRAGMA quick_check').all().some(row=>row.quick_check!=='ok'))
   throw Object.assign(Error('Cache database failed quick_check'),{code:'COMPANION_CACHE_CORRUPT'});
  next.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
   CREATE TABLE IF NOT EXISTS api_windows (
    scope_key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
    revision INTEGER NOT NULL, payload TEXT NOT NULL, persona_id TEXT, life_id TEXT
   );
   CREATE TABLE IF NOT EXISTS native_state (key TEXT PRIMARY KEY, payload TEXT NOT NULL);`);
  const columns=new Set(next.prepare('PRAGMA table_info(api_windows)').all().map(row=>row.name));
  for(const name of ['persona_id','life_id'])if(!columns.has(name))
   next.exec('ALTER TABLE api_windows ADD COLUMN '+name+' TEXT');
  return next;
 }catch(error){next.close();throw error;}
}

function rebuild(privacy,appliedPrivacy,native,appliedNative){
 database?.close();
 database=undefined;
 const evidence=filename+'.corrupt-'+randomUUID();
 for(const extension of ['','-wal','-shm','-journal']){
  try{renameSync(filename+extension,evidence+extension);}
  catch(error){if(extension===''||error.code!=='ENOENT')throw error;}
 }
 audit.push({type:'companion-cache-corrupt-database'});
 restoring=true;
 database=retry(open);
 restore(privacy,appliedPrivacy,native,appliedNative);
}

function restore(privacy,appliedPrivacy,native,appliedNative){
 const staged=[];
 const changedKeys=new Set(native.map(({key})=>key));
 transaction(()=>{
  const insert=windowInsert();
  for(const {row} of knownApi.values())insertWindow(insert,row);
  const upsert=nativeUpsert();
  for(const [key,value] of knownNative)if(!changedKeys.has(key))upsert.run(key,JSON.stringify(value));
  const removeNative=database.prepare('DELETE FROM native_state WHERE key=?');
  for(const {key,value,remove} of native){
   if(remove)removeNative.run(key);
   else upsert.run(key,JSON.stringify(value));
  }
  // Keep queued privacy effects in the same transaction as replay, so a
  // crash cannot leave a rebuilt copy of data that is pending removal.
  for(const operation of privacy.slice(appliedPrivacy.length)){
   applyPrivacy(operation,true);
   staged.push(operation.id);
  }
 });
 rememberNative(native);
 if(staged.length||native.some(change=>change.remove))checkpointPrivacy();
 restoring=false;
 appliedPrivacy.push(...staged);
 if(!appliedNative.length)for(const {key,id} of native)appliedNative.push({key,id});
}

function openWithRecovery(privacy,appliedPrivacy,native,appliedNative){
 try{
  database=retry(open);
  if(nativeRecovery?.length)nativeList();
 }catch(error){
  if(!isCorrupt(error))throw error;
  for(const [key,value] of nativeRecovery??[])knownNative.set(key,value);
  rebuild(privacy,appliedPrivacy,native,appliedNative);
 }
 nativeRecovery=undefined;
}

function transaction(run){
 return retry(()=>{
  database.exec('BEGIN IMMEDIATE');
  try{
   const result=run();
   database.exec('COMMIT');
   return result;
  }catch(error){
   try{database.exec('ROLLBACK');}catch{}
   throw error;
  }
 });
}

function checkpointPrivacy(){
 retry(()=>{
  if(database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy)
   throw Object.assign(Error('Cache checkpoint is busy'),{errcode:5});
 });
}

function decode(row){
 const {scope_key:key,character_id:characterId,conversation_id:conversationId,persona_id:personaId,life_id:lifeId}=row;
 const revision=Number(row.revision);
 if(![key,characterId,conversationId].every(value=>typeof value==='string'&&value.length)||
  ![personaId,lifeId].every(value=>value===null||typeof value==='string'&&value.length)||
  !Number.isSafeInteger(revision)||revision<1)throw Error('Invalid API window row');
 return {scope:{key,characterId,conversationId,personaId,lifeId},revision,payload:validateCachePayload(JSON.parse(row.payload))};
}

function readRows(repair){
 const malformed=[];
 const valid=[];
 const select=database.prepare('SELECT * FROM api_windows');
 select.setReadBigInts(true);
 for(const row of select.iterate()){
  let record;
  try{record=decode(row);}
  catch{
   malformed.push(row.scope_key);
   continue;
  }
  valid.push(record);
 }
 const result=repair(valid,malformed);
 for(let index=0;index<malformed.length;index++)audit.push({type:'companion-cache-bad-row'});
 return result;
}

function removeKeys(keys){
 const remove=database.prepare('DELETE FROM api_windows WHERE scope_key IS ?');
 for(const key of keys)remove.run(key);
}

function rowBase({scope,revision,payload}){
 const {key,conversationId,characterId,personaId=null,lifeId=null}=scope;
 return createHash('sha256').update(JSON.stringify([key,conversationId,characterId,personaId,lifeId,revision,payload])).digest('hex');
}

function park(clientId,keys){
 const snapshot=snapshots.get(clientId);
 if(!snapshot)return [];
 return keys.map(key=>{
  const current=knownApi.get(key);
  const base=snapshot.get(key)?.version===current?.stamp.version?(current?rowBase(current.row):null):false;
  return [key,base];
 });
}

function matchesBase(base,row){
 return base===null?!row:typeof base==='string'&&!!row&&rowBase(row)===base;
}

function bindParkedRows(clientId,rows){
 if(snapshots.has(clientId))return rows;
 const read=database.prepare('SELECT * FROM api_windows WHERE scope_key=?');
 read.setReadBigInts(true);
 const snapshot=new Map();
 const valid=rows.filter(({base,row:{scope:{key}}})=>{
  const raw=read.get(key);
  const reject=()=>{snapshot.set(key,{version:-1});return false;};
  let disk;
  if(raw)try{disk=decode(raw);}catch{return reject();}
  if(!matchesBase(base,disk))return reject();
  if(disk){
   const known=knownApi.get(key);
   snapshot.set(key,known&&rowBase(known.row)===base?known.stamp:remember(disk));
  }
  return true;
 });
 snapshots.set(clientId,snapshot);
 return valid;
}

function hydrate(clientId,privacy,repairDisk,readDisk,closedApi){
 const read=(valid,malformed)=>{
  const snapshot=new Map();
  for(const row of valid){
   const current=knownApi.get(row.scope.key);
   const same=current?.stamp.revision===row.revision&&JSON.stringify(current.row.payload)===JSON.stringify(row.payload);
   snapshot.set(row.scope.key,same?current.stamp:remember(row));
  }
  for(const key of knownApi.keys())if(!snapshot.has(key))knownApi.delete(key);
  snapshots.set(clientId,snapshot);
  if(repairDisk&&malformed.length){
   try{
    transaction(()=>removeKeys(malformed));
    checkpointPrivacy();
   }catch(error){
    audit.push({type:'companion-cache-bad-row-cleanup-failed',code:failureKind(error)});
   }
  }
  let visible=valid;
  for(const {op,args} of privacy){
   if(op==='clear')visible=visible.filter(row=>!scopeMatches(row.scope,args));
   else{
    const repair=messageInvalidator(args);
    visible=visible.map(row=>{
     const payload=repair(row.payload,row.scope.conversationId);
     return payload?{...row,revision:row.revision+1,payload}:row;
    });
   }
  }
  const adopted=[],owned=new Set();
  for(const {clientId:previousId,rows} of closedApi){
   const previous=snapshots.get(previousId);
   for(const {key,id,base} of rows){
    const initial=previous?previous.get(key)?.version===snapshot.get(key)?.version:
     readDisk&&matchesBase(base,knownApi.get(key)?.row);
    if(owned.has(key)||!initial)continue;
    owned.add(key);
    adopted.push({previousId,key,id});
   }
  }
  return {rows:visible,adopted};
 };
 return readDisk?readRows(read):read([...knownApi.values()].map(({row})=>row),[]);
}

function windowInsert(){
 return database.prepare(`INSERT OR IGNORE INTO api_windows
  (scope_key,conversation_id,character_id,revision,payload,persona_id,life_id) VALUES (?,?,?,?,?,?,?)`);
}

function insertWindow(insert,{scope,revision,payload}){
 const {key,conversationId,characterId,personaId=null,lifeId=null}=scope;
 return insert.run(key,conversationId,characterId,revision,JSON.stringify(payload),personaId,lifeId);
}

function flush(records,clientId){
 if(!records.length)return true;
 const snapshot=snapshots.get(clientId)??new Map();
 const committed=transaction(()=>{
  const insert=windowInsert();
  const update=database.prepare(`UPDATE api_windows SET revision=?,payload=?,persona_id=?,life_id=?
   WHERE scope_key=? AND revision=?`);
  return records.filter(row=>{
   const {scope,revision}=row;
   const {key,personaId=null,lifeId=null}=scope;
   let payload;
   try{payload=validateCachePayload(row.payload);}
   catch{audit.push({type:'companion-cache-bad-row'});return false;}
   const expected=snapshot.get(key);
   if(expected?.version!==knownApi.get(key)?.stamp.version)return false;
   return (expected===undefined
    ?insertWindow(insert,{scope,revision,payload})
    :update.run(revision,JSON.stringify(payload),personaId,lifeId,key,expected.revision)).changes===1;
  });
 });
 for(const row of committed)snapshot.set(row.scope.key,remember(row));
 snapshots.set(clientId,snapshot);
 return committed.length===records.length;
}

function clear(selector,replaying){
 const remove=()=>{
  const scopes=database.prepare('SELECT scope_key AS key,conversation_id AS conversationId,character_id AS characterId,persona_id AS personaId,life_id AS lifeId FROM api_windows').all();
  const keys=scopes.filter(scope=>scopeMatches(scope,selector)).map(scope=>scope.key);
  removeKeys(keys);
  return keys;
 };
 const rows=replaying?remove():transaction(remove);
 for(const key of rows){
  const previous=knownApi.get(key)?.stamp;
  for(const snapshot of snapshots.values())if(previous&&snapshot.get(key)===previous)snapshot.delete(key);
  knownApi.delete(key);
 }
 if(!replaying)checkpointPrivacy();
 return true;
}

function invalidate(messages,replaying){
 const repair=messageInvalidator(messages);
 const repairRows=()=>readRows((valid,malformed)=>{
  const update=database.prepare('UPDATE api_windows SET revision=?,payload=? WHERE scope_key=?');
  const updated=[];
  for(const {scope,revision,payload} of valid){
   const fixed=repair(payload,scope.conversationId);
   if(fixed){
    update.run(revision+1,JSON.stringify(fixed),scope.key);
    updated.push({scope,revision:revision+1,payload:fixed});
   }
  }
  removeKeys(malformed);
  return {updated,malformed};
 });
 const changes=replaying?repairRows():transaction(repairRows);
 for(const row of changes.updated){
  const key=row.scope.key;
  const previous=knownApi.get(key)?.stamp;
  const current=remember(row);
  for(const snapshot of snapshots.values())if(previous&&snapshot.get(key)===previous)snapshot.set(key,current);
 }
 for(const key of changes.malformed)knownApi.delete(key);
 if(!replaying)checkpointPrivacy();
 return true;
}

function applyPrivacy({op,args},replaying=false){
 if(op==='clear')clear(args,replaying);
 else invalidate(args,replaying);
}

function nativeRead(key){
 const row=database.prepare('SELECT payload FROM native_state WHERE key=?').get(key);
 if(!row){knownNative.delete(key);return null;}
 const value=JSON.parse(row.payload);
 knownNative.set(key,value);
 return value;
}
function nativeList(){
 const result=[];
 for(const row of database.prepare('SELECT key,payload FROM native_state ORDER BY key').all()){
  try{result.push({key:row.key,value:JSON.parse(row.payload)});}
  catch{audit.push({type:'companion-native-bad-row'});}
 }
 knownNative.clear();
 for(const {key,value} of result)knownNative.set(key,value);
 return result;
}
function nativeUpsert(){
 return database.prepare('INSERT INTO native_state(key,payload) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload');
}
function replayNative(changes){
 if(!changes.length)return;
 transaction(()=>{
  const update=nativeUpsert();
  const remove=database.prepare('DELETE FROM native_state WHERE key=?');
  for(const change of changes){
   if(change.remove)remove.run(change.key);
   else update.run(change.key,JSON.stringify(change.value));
  }
 });
 rememberNative(changes);
 if(changes.some(change=>change.remove))checkpointPrivacy();
}

function rememberNative(changes){
 for(const {key,value,remove} of changes){
  if(remove)knownNative.delete(key);
  else knownNative.set(key,value);
 }
}

const readOps=new Set(['hydrate','nativeRead','nativeList']);
function read(op,clientId,args,privacy,closedApi){
 const readable=!!database&&!restoring;
 if(op==='hydrate'){
  if(!database&&unavailable){
   const reader=new DatabaseSync(filename,{readOnly:true});
   database=reader;
   try{return hydrate(clientId,privacy,false,true,closedApi);}
   finally{database=undefined;reader.close();}
  }
  return hydrate(clientId,privacy,readable&&!failures&&!unavailable&&!privacy.length,readable,closedApi);
 }
 if(!readable)throw Object.assign(Error('Native cache disk view is unavailable'),{code:'COMPANION_CACHE_READ_UNAVAILABLE'});
 return op==='nativeRead'?nativeRead(args[0]):nativeList();
}

parentPort.on('message',({seq,op,clientId,args,work={}})=>{
 const {privacy=[],native=[],api=[],openClients=[],closedApi=[]}=work;
 const appliedPrivacy=[],appliedNative=[],appliedApi=[];
 const receipt={seq,appliedPrivacy,appliedNative,appliedApi};
 const reading=readOps.has(op);
 // The worker processes each request synchronously. A deferred native probe
 // takes one SQLite attempt and lets the host schedule replay if it is busy.
 deferBusy=op==='nativeProbe';
 try{
  let result;
  if(op==='close'){
   database?.close();
   database=undefined;
   parentPort.close();
  }else if(op==='release'){
   snapshots.delete(clientId);
  }else if(op==='park'){
   result=park(clientId,args);
  }else if(reading){
   // Reads leave the write failure counter and backoff deadline untouched.
   // Only an available database may be rebuilt from a corrupt read.
   const perform=()=>{
    if(!database&&!unavailable)openWithRecovery(privacy,appliedPrivacy,native,appliedNative);
    return read(op,clientId,args,privacy,closedApi);
   };
   try{result=perform();}
   catch(error){
    if(isCorrupt(error)&&!unavailable){
     rebuild(privacy,appliedPrivacy,native,appliedNative);
     result=perform();
    }else if(op==='hydrate'&&unavailable)result=hydrate(clientId,privacy,false,false,closedApi);
    else throw error;
   }
  }else{
   if(op!=='drain'&&retryAt>Date.now())throw Object.assign(Error('Cache persistence circuit open'),{code:'COMPANION_CACHE_CIRCUIT'});
   if(!database)openWithRecovery(privacy,appliedPrivacy,native,appliedNative);
   if(restoring)restore(privacy,appliedPrivacy,native,appliedNative);
   const perform=()=>{
    const batches=api.slice(appliedApi.length).map(batch=>({...batch,eligible:bindParkedRows(batch.clientId,batch.rows)}));
    for(const operation of privacy.slice(appliedPrivacy.length)){
     applyPrivacy(operation);
     appliedPrivacy.push(operation.id);
    }
    if(!appliedNative.length){
     replayNative(native);
     for(const {key,id} of native)appliedNative.push({key,id});
    }
    for(const {clientId,rows,eligible} of batches){
     const committed=flush(eligible.map(({row})=>row),clientId)&&eligible.length===rows.length;
     appliedApi.push({clientId,committed,ids:rows.map(({id,row})=>[row.scope.key,id])});
    }
    for(const owner of snapshots.keys())if(!openClients.includes(owner)){
     snapshots.delete(owner);
    }
    return op==='flush'?appliedApi.find(batch=>batch.clientId===clientId)?.committed??true:true;
   };
   try{result=perform();}
   catch(error){
    if(!isCorrupt(error))throw error;
    rebuild(privacy,appliedPrivacy,native,appliedNative);
    result=perform();
   }
   if(unavailable)audit.push({type:'companion-cache-durability-restored'});
   failures=0;
   retryAt=0;
   unavailable=false;
  }
  parentPort.postMessage({...receipt,ok:true,result,audit:audit.splice(0)});
 }catch(error){
  if(!(deferBusy&&isBusy(error))&&error.code!=='COMPANION_CACHE_CIRCUIT'&&op!=='close'&&op!=='release'){
   if(!reading&&++failures>=3)retryAt=Date.now()+retryMs;
   if((retryAt||!database)&&!unavailable){
    unavailable=true;
    audit.push({type:'companion-cache-memory-fallback',code:failureKind(error)});
   }
  }
  parentPort.postMessage({...receipt,ok:false,error:error.code??'COMPANION_CACHE_STORAGE',errorKind:failureKind(error),audit:audit.splice(0)});
 }
});
