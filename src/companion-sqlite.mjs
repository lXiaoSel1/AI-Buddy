import {copyCompanionValue} from './companion-draft.mjs';
import {mealDialogue} from './meal-dialogue.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {decodeGalgameSentenceRanges,encodeGalgameSentenceRanges} from './galgame-expressions.mjs';

export const COMPANION_SCHEMA=3;
// These values identify the existing companion.json migration fence.
export const COMPANION_WRITER='r14-companion-sqlite-v2';
export const COMPANION_CAPABILITY='companion-message-rows-v2';
const sectionWriter='r16-companion-sqlite-v3';
const sectionCapability='companion-state-sections-v3';
const sectionCapabilities=JSON.stringify([COMPANION_CAPABILITY,sectionCapability]);
const stateSectionNames=['cards','conversations','lives'];
const stateSectionSchema="CREATE TABLE state_sections(name TEXT PRIMARY KEY CHECK(name IN ('cards','conversations','lives')),value TEXT) WITHOUT ROWID;";
const baseStateSelect='SELECT revision,value FROM state WHERE id=1';
const joinedStateSelect=[
  'SELECT state.revision,state.value,(SELECT count(*) FROM state_sections) AS sectionCount,',
  stateSectionNames.map(name=>name+'.name AS '+name+'Name,'+name+'.value AS '+name+'Value').join(','),
  'FROM state',
  ...stateSectionNames.map(name=>'LEFT JOIN state_sections AS '+name+' ON '+name+".name='"+name+"'"),
  'WHERE state.id=1'
].join(' ');

// The companion, economy and reward stores use NORMAL with no lock wait.
// Companion and economy maintenance workers run PASSIVE at idle or high
// water. Automatic checkpoints stay disabled on the user write connections.
export const companionWriterPragmas='PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0; PRAGMA journal_size_limit=8388608;';

const escapePrefix='\u001f';
const diskKey=value=>value.isWellFormed()&&!value.startsWith(escapePrefix)?value:escapePrefix+JSON.stringify(value);
export const originalKey=value=>value.startsWith(escapePrefix)?JSON.parse(value.slice(1)):value;

const schema=`
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS state(
    id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages(
    row_id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
    message_id TEXT NOT NULL, ordinal INTEGER NOT NULL, role TEXT, character_id TEXT,
    created_at INTEGER, status TEXT, body TEXT NOT NULL, emotion TEXT, emotion_ranges TEXT,
    extra_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_owner_order ON messages(owner_type,owner_id,ordinal,row_id);
  CREATE INDEX IF NOT EXISTS messages_private_time ON messages(owner_id,coalesce(created_at,0),ordinal,row_id) WHERE owner_type='private';
  CREATE TABLE IF NOT EXISTS message_owners(
    owner_type TEXT NOT NULL,owner_id TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,path TEXT,PRIMARY KEY(owner_type,owner_id)
  );
  CREATE TRIGGER IF NOT EXISTS messages_owner_insert AFTER INSERT ON messages BEGIN
    INSERT INTO message_owners(owner_type,owner_id,count) VALUES(new.owner_type,new.owner_id,1)
    ON CONFLICT(owner_type,owner_id) DO UPDATE SET count=count+1;
  END;
  CREATE TRIGGER IF NOT EXISTS messages_owner_delete AFTER DELETE ON messages BEGIN
    UPDATE message_owners SET count=count-1 WHERE owner_type=old.owner_type AND owner_id=old.owner_id;
  END;
  CREATE INDEX IF NOT EXISTS messages_owner_id ON messages(owner_type,owner_id,message_id,ordinal,row_id);
  CREATE INDEX IF NOT EXISTS messages_id ON messages(owner_type,message_id);
  CREATE INDEX IF NOT EXISTS messages_status ON messages(owner_type,status);
  CREATE INDEX IF NOT EXISTS messages_voice_submission ON messages(owner_type,owner_id,json_extract(extra_json,'$.extra.voiceSubmission.id'));
  CREATE TABLE IF NOT EXISTS record_owners(
    namespace TEXT NOT NULL,owner TEXT NOT NULL,array INTEGER NOT NULL,path TEXT NOT NULL,PRIMARY KEY(namespace,owner)
  );
  CREATE TABLE IF NOT EXISTS records(
    namespace TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL,
    ordinal INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,owner,key)
  );
  CREATE INDEX IF NOT EXISTS records_owner_order ON records(namespace,owner,ordinal);
  CREATE INDEX IF NOT EXISTS proactive_candidates_state ON records(owner,json_extract(value,'$.status'),ordinal)
    WHERE namespace='life.proactive.candidates';
  CREATE INDEX IF NOT EXISTS group_inputs_state ON records(owner,json_extract(value,'$.state'),ordinal)
    WHERE namespace='group.pendingUserInputs';
`;

const historyIndexSchema=`
  CREATE INDEX IF NOT EXISTS app_lines_scope ON records(owner,
    json_extract(value,'$.scope.lifeId'),
    json_extract(value,'$.scope.personaId'),json_extract(value,'$.scope.channel'),
    json_extract(value,'$.scope.conversationId'),json_extract(value,'$.at'),ordinal,key)
    WHERE namespace='life.r95.lines' AND json_extract(value,'$.status') IN ('awaiting-presentation','presented','read');
  CREATE INDEX IF NOT EXISTS app_lines_pending ON records(owner,
    json_extract(value,'$.scope.lifeId'),json_extract(value,'$.scope.operationId'),
    json_extract(value,'$.scope.personaId'),json_extract(value,'$.scope.channel'),
    json_extract(value,'$.scope.conversationId'),ordinal)
    WHERE namespace='life.r95.lines' AND json_extract(value,'$.status') IN ('awaiting-presentation','presented');
  CREATE INDEX IF NOT EXISTS group_photo_range ON records(owner,json_extract(value,'$.range.start'),json_extract(value,'$.range.end'),ordinal)
    WHERE namespace='group.photos';
`;

const recordIndexes=`
  CREATE INDEX IF NOT EXISTS evidence_source_kind ON records(owner,json_extract(value,'$.sourceKind'),ordinal)
    WHERE namespace='life.r95.evidence';
`;

export function monitorCompanionSql(audit,clock=()=>performance.now()){
  return (statement,execute)=>{
    const start=clock();
    try{return execute();}
    finally{
      const elapsedMs=clock()-start;
      if(elapsedMs>15)try{audit?.({type:'companion-slow-query',statement,elapsedMs});}catch{}
    }
  };
}

export function reportSlowCompanionTransaction(audit,event){
  if(event.elapsedMs>15)try{audit?.({type:'companion-slow-transaction',...event});}catch{}
}

export function companionTransaction(run,execute){
  run('begin',()=>execute.exec('BEGIN IMMEDIATE'));
  try{
    const result=execute.body();
    run('commit',()=>{
      if(execute.commitTrace)Atomics.store(execute.commitTrace,1,process.hrtime.bigint());
      execute.exec('COMMIT');
      if(execute.commitTrace)Atomics.store(execute.commitTrace,2,process.hrtime.bigint());
    });
    return result;
  }catch(error){
    try{run('rollback',()=>execute.exec('ROLLBACK'));}
    catch(rollbackError){throw new AggregateError([error,rollbackError],'Companion transaction rollback failed');}
    throw error;
  }
}

function withImportTempStore(run,db,write,{migration=false}={}){
  const previous=run('import.temp-store.read',()=>db.prepare('PRAGMA temp_store').get().temp_store);
  if(previous===2)return write();
  let failure;
  try{
    // Each message upsert and its owner trigger can open a statement
    // savepoint inside this atomic import. Only those scratch pages go into
    // memory; the companion transaction still uses its normal WAL.
    run('import.temp-store.memory',()=>db.exec('PRAGMA temp_store=MEMORY'));
    return write();
  }catch(error){failure=error;throw error;}
  finally{
    try{
      run('import.temp-store.restore',()=>{
        db.exec('PRAGMA temp_store='+previous);
        if(db.prepare('PRAGMA temp_store').get().temp_store!==previous)
          throw Error('Companion temporary journal setting did not match its original value');
      });
    }catch(restoreError){
      const operation=migration?'Companion migration seed':'Companion import';
      let message=failure
        ?operation+' failed and its temporary journal setting could not be restored'
        :operation+' committed, but its temporary journal setting could not be restored';
      if(migration){
        // The migration worker sends only the error message and code.
        if(failure)message+='. '+failure.message;
        message+='. '+restoreError.message;
      }else if(!failure)message+='; reopen the store';
      const error=failure
        ?new AggregateError([failure,restoreError],message,{cause:failure})
        :Error(message,{cause:restoreError});
      error.code='COMPANION_STORE_REOPEN_REQUIRED';
      throw error;
    }
  }
}

function readStateRoot(row,sectioned){
  if(!row)throw Error('Missing companion database state');
  const state=JSON.parse(row.value);
  if(!state||typeof state!=='object'||Array.isArray(state))throw Error('Invalid companion database state');
  if(sectioned){
    if(row.sectionCount!==stateSectionNames.length||stateSectionNames.some(name=>row[name+'Name']!==name))
      throw Error('Missing or unexpected companion state section');
    if(stateSectionNames.some(name=>Object.hasOwn(state,name)))
      throw Error('Companion state root overlaps a section');
  }
  return state;
}

function composeCompanionState(row,sectioned){
  const state=readStateRoot(row,sectioned);
  if(sectioned)for(const name of stateSectionNames){
    const stored=row[name+'Value'];
    if(stored!==null)state[name]=JSON.parse(stored);
  }
  return {...state,revision:row.revision};
}

function serializeCompanionState({revision,...state}){
  const sections=stateSectionNames.map(name=>{
    // A NULL row means the property was absent from the logical JSON.
    const value=JSON.stringify(state[name])??null;
    delete state[name];
    return {name,value};
  });
  return {root:JSON.stringify(state),sections};
}

function stateSchemaVersion(db){
  return db.prepare('PRAGMA user_version').get().user_version;
}

export function assertCompanionSqliteCompatible(db,{allowLegacy=true}={}){
  const version=stateSchemaVersion(db),sectioned=version===COMPANION_SCHEMA;
  if(!sectioned&&(!allowLegacy||version!==2))throw Error('Unsupported companion database schema');
  const writer=db.prepare("SELECT value FROM meta WHERE key='minimumWriter'").get();
  if(writer?.value!==(sectioned?sectionWriter:COMPANION_WRITER))throw Error('Unsupported companion database writer');
  const capabilities=db.prepare("SELECT value FROM meta WHERE key='requiredCapabilities'").get();
  if(capabilities?.value!==(sectioned?sectionCapabilities:JSON.stringify([COMPANION_CAPABILITY])))throw Error('Unsupported companion database capabilities');
  if(sectioned)composeCompanionState(db.prepare(joinedStateSelect).get(),true);
  return version;
}

// Callers reading related rows use their existing read transaction. The base
// row and all sections themselves come from one SQLite statement.
export function readCompanionState(db){
  const version=stateSchemaVersion(db);
  if(version===2)return composeCompanionState(db.prepare(baseStateSelect).get(),false);
  if(version!==COMPANION_SCHEMA)throw Error('Unsupported companion database schema');
  return composeCompanionState(db.prepare(joinedStateSelect).get(),true);
}

export function upgradeCompanionStateSections(path,expectedMeta){
  if(expectedMeta.requiredCapabilities?.includes(sectionCapability))return;
  const db=new DatabaseSync(path);
  try{
    db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=NORMAL;');
    companionTransaction((_,run)=>run(),{exec:sql=>db.exec(sql),body:()=>{
      const version=assertCompanionSqliteCompatible(db);
      const meta=db.prepare('SELECT value FROM meta WHERE key=?');
      if(meta.get('verified')?.value!=='true'||
        meta.get('migrationId')?.value!==JSON.stringify(expectedMeta.migrationId)||
        meta.get('sourceSha256')?.value!==JSON.stringify(expectedMeta.sourceSha256))
        throw Error('Companion state section migration identity changed');
      if(version===COMPANION_SCHEMA)return;
      const current=composeCompanionState(db.prepare(baseStateSelect).get(),false);
      const {root,sections}=serializeCompanionState(current);
      db.exec(stateSectionSchema);
      const insert=db.prepare('INSERT INTO state_sections VALUES(?,?)');
      for(const {name,value} of sections)insert.run(name,value);
      const update=db.prepare('UPDATE state SET value=? WHERE id=1 AND revision=?').run(root,current.revision);
      if(update.changes!==1)throw Error('Companion database revision changed during section migration');
      const setMeta=db.prepare('UPDATE meta SET value=? WHERE key=?');
      setMeta.run(sectionWriter,'minimumWriter');
      setMeta.run(sectionCapabilities,'requiredCapabilities');
      db.exec('PRAGMA user_version='+COMPANION_SCHEMA);
    }});
  }finally{db.close();}
}

const seedMessageId=(type,ownerId,ordinal,id)=>createHash('sha256').update(JSON.stringify([type,ownerId,ordinal,id])).digest('hex');
export const ambiguousMessage=()=>Object.assign(Error('消息 ID 重复，请重新打开历史并选择具体记录'),{code:'COMPANION_MESSAGE_AMBIGUOUS'});

function encodeMessage(type,ownerId,ordinal,message,rowId){
  const {id,role,characterId,createdAt,status,text,emotion,...extra}=message;
  const preserved={};
  const column=(key,value,accept)=>{
    if(value===undefined)return null;
    if(accept(value))return value;
    preserved[key]=value;
    return null;
  };
  const ranges=encodeGalgameSentenceRanges(text,extra.emotionSentences);
  if(ranges)delete extra.emotionSentences;
  const string=value=>typeof value==='string'&&value.isWellFormed();
  return [
    rowId,type,diskKey(ownerId),diskKey(id),ordinal,
    column('role',role,string),column('characterId',characterId,string),
    column('createdAt',createdAt,Number.isFinite),column('status',status,string),
    column('text',text,string)??'',column('emotion',emotion,string),ranges,
    JSON.stringify({extra,preserved,hasText:text!==undefined})
  ];
}

export function decodeCompanionMessage(row){
  if(!row)return undefined;
  const {extra,preserved,hasText}=JSON.parse(row.extra_json);
  const message={id:originalKey(row.message_id),...extra};
  for(const [key,value] of Object.entries({role:row.role,characterId:row.character_id,createdAt:row.created_at,status:row.status,emotion:row.emotion})){
    if(value!==null)message[key]=value;
  }
  if(hasText)message.text=row.body;
  Object.assign(message,preserved);
  if(row.emotion_ranges!==null){
    const ranges=decodeGalgameSentenceRanges(message.text,row.emotion_ranges);
    if(!ranges)throw Error('Invalid companion sentence ranges');
    message.emotionSentences=ranges;
  }
  return message;
}

function messageView(row){
  return row?{...decodeCompanionMessage(row),occurrenceId:row.row_id}:undefined;
}
function messageMatch(rows){
  if(rows.length>1)throw ambiguousMessage();
  return rows[0];
}

function validOwner(type,ownerId){
  if(typeof type!=='string'||!type||typeof ownerId!=='string'||!ownerId)throw TypeError('Message owner is required');
}
function validLimit(limit){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw RangeError('Message query limit must be between 1 and 100');
}
function withoutVoiceReceipt({voicePresentation,voiceDelivery,...value}){
  return value;
}

function validMessage(message){
  if(!message||typeof message.id!=='string'||!message.id)throw TypeError('Message ID is required');
}

export function readCompanionSqliteSnapshot(path,scope={}){
  return withCompanionRead(path,db=>{
    const state=readCompanionState(db);
    const meta=Object.fromEntries(db.prepare('SELECT key,value FROM meta WHERE key<>?').all('minimumWriter').map(row=>[row.key,JSON.parse(row.value)]));
    const ownerRows=db.prepare('SELECT owner_type,owner_id,path FROM message_owners ORDER BY owner_type,owner_id').all();
    const recordOwnerRows=db.prepare('SELECT * FROM record_owners').all();
    const toOwner=row=>({type:row.owner_type,ownerId:originalKey(row.owner_id),...(row.path?{at:JSON.parse(row.path)}:{})});
    const toRecordOwner=row=>({namespace:row.namespace,owner:originalKey(row.owner),array:!!row.array,at:JSON.parse(row.path)});
    const toMessage=row=>({type:row.owner_type,ownerId:originalKey(row.owner_id),ordinal:row.ordinal,message:decodeCompanionMessage(row)});
    const toRecord=row=>({namespace:row.namespace,owner:originalKey(row.owner),key:originalKey(row.key),ordinal:row.ordinal,value:JSON.parse(row.value)});
    if(!scope.characterId&&!scope.transaction&&!scope.portable){
      const rows=db.prepare('SELECT * FROM messages ORDER BY owner_type,owner_id,ordinal,row_id').all().map(toMessage);
      const recordRows=db.prepare('SELECT * FROM records ORDER BY namespace,owner,ordinal').all().map(toRecord);
      return {state,rows,owners:ownerRows.map(toOwner),recordRows,recordOwners:recordOwnerRows.map(toRecordOwner),meta};
    }
    const target=scope.characterId,transaction=scope.transaction,portable=scope.portable;
    const conversations=new Set(Object.values(state.conversations??{}).filter(row=>
      target?row.characterId===target&&row.lifeId===state.lives?.[target]?.id:
      portable?!portable.groupId&&(!portable.ownerId||portable.ownerId===row.id):false).map(row=>row.id));
    const groups=new Set(portable?Object.keys(state.groups??{}).filter(id=>portable.groupId?id===portable.groupId:!portable.ownerId):[]);
    const witnessed=new Map();
    if(target){
      const intervals=db.prepare("SELECT key,value FROM records WHERE namespace='life.groupIntervals' AND owner=?");
      for(const row of intervals.all(diskKey(target)))witnessed.set(originalKey(row.key),JSON.parse(row.value));
      for(const [id,rows] of Object.entries(state.lives?.[target]?.groupIntervals??{}))if(!witnessed.has(id))witnessed.set(id,rows);
      for(const [id,rows] of witnessed)if(rows?.length)groups.add(id);
    }
    const messageInScope=owner=>{
      if(owner.type==='private')return conversations.has(owner.ownerId);
      if(owner.type==='group')return groups.has(owner.ownerId);
      if(transaction)return owner.at?.[0]==='lifeTransaction';
      return !!target&&owner.at?.[0]==='lives'&&owner.at[1]===target;
    };
    const recordInScope=owner=>{
      if(transaction)return owner.at[0]==='lifeTransaction';
      if(target)return owner.at[0]==='lives'&&owner.at[1]===target;
      return owner.at[0]==='groups'&&groups.has(owner.at[1]);
    };
    const owners=ownerRows.map(toOwner).filter(messageInScope),recordOwners=recordOwnerRows.map(toRecordOwner).filter(recordInScope);
    const messages=db.prepare('SELECT * FROM messages WHERE owner_type=? AND owner_id=? ORDER BY ordinal,row_id');
    const records=db.prepare('SELECT * FROM records WHERE namespace=? AND owner=? ORDER BY ordinal,key');
    const rows=owners.flatMap(owner=>{
      const decoded=messages.all(owner.type,diskKey(owner.ownerId)).map(toMessage);
      if(!target||owner.type!=='group')return decoded;
      const intervals=witnessed.get(owner.ownerId)??[],seen=new Set(),duplicateMessageSeqs=[];
      const visible=decoded.filter(({message})=>{
        const duplicate=seen.has(message.id);
        seen.add(message.id);
        const allowed=intervals.some(interval=>message.seq>=interval.start&&(interval.end===null||message.seq<=interval.end));
        if(allowed&&duplicate)duplicateMessageSeqs.push(message.seq);
        return allowed;
      });
      if(duplicateMessageSeqs.length)state.groups[owner.ownerId].duplicateMessageSeqs=duplicateMessageSeqs;
      return visible;
    });
    const recordRows=recordOwners.flatMap(owner=>records.all(owner.namespace,diskKey(owner.owner)).map(toRecord));
    if(transaction)return {state:{lifeTransaction:state.lifeTransaction,revision:state.revision},rows,owners,recordRows,recordOwners,meta};
    const selected={
      ...state,
      conversations:Object.fromEntries([...conversations].map(id=>[id,state.conversations[id]])),
      groups:Object.fromEntries([...groups].filter(id=>state.groups[id]).map(id=>[id,state.groups[id]]))
    };
    if(target){selected.lives={[target]:state.lives?.[target]};delete selected.lifeTransaction;}
    return {state:selected,rows,owners,recordRows,recordOwners,meta};
  });
}

export function ensureCompanionHistoryIndexes(path){
  const names=['app_lines_scope','app_lines_pending','group_photo_range'];
  const missing=withCompanionRead(path,db=>{
    const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?");
    return names.some(name=>!exists.get(name));
  });
  if(!missing)return;
  const db=new DatabaseSync(path);
  try{db.exec(companionWriterPragmas+historyIndexSchema);}finally{db.close();}
}

export function readCompanionSqliteMetadata(path){
  const db=new DatabaseSync(path,{readOnly:true});
  try{return withCompanionRead(db,()=>{
    assertCompanionSqliteCompatible(db);
    return Object.fromEntries(db.prepare('SELECT key,value FROM meta WHERE key<>?').all('minimumWriter').map(row=>[row.key,JSON.parse(row.value)]));
  });}finally{db.close();}
}

function messageContains(body,extraJson,query){
  if(body)return Number(body.toLocaleLowerCase().includes(query));
  const original=JSON.parse(extraJson).preserved?.text;
  return Number(typeof original==='string'&&original.toLocaleLowerCase().includes(query));
}

const appLineScope=`namespace='life.r95.lines' AND owner=?
  AND json_extract(value,'$.scope.lifeId')=?
  AND json_extract(value,'$.scope.personaId')=? AND json_extract(value,'$.scope.channel')=?
  AND json_extract(value,'$.scope.conversationId')=?`;
const appLineBindings=scope=>[diskKey(scope.characterId),scope.lifeId,scope.personaId,scope.channel,scope.conversationId];

function speechHistoryFilter(owner,life,query){
  const predicate=[appLineScope,"json_extract(value,'$.status') IN ('awaiting-presentation','presented','read')",
    "json_type(value,'$.at') IN ('integer','real')","json_type(value,'$.text')='text'","json_type(value,'$.messageId')='text'"];
  const bindings=appLineBindings({characterId:owner.characterId,lifeId:life.id,personaId:owner.personaId,channel:'app-private',conversationId:owner.id});
  if(query){predicate.push("companion_contains(json_extract(value,'$.text'),'{}',?)");bindings.push(query);}
  return {predicate,bindings};
}

function speechHistoryRows(db,{owner,life,query,before,limit}){
  if(!life||owner.lifeId!==life.id)return {rows:[],total:0};
  const {predicate,bindings}=speechHistoryFilter(owner,life,query);
  const {total}=db.prepare('SELECT count(*) AS total FROM records WHERE '+predicate.join(' AND ')).get(...bindings);
  if(!total)return {rows:[],total};
  if(before){predicate.push("(json_extract(value,'$.at'),ordinal,'speech:'||key)<(?,?,?)");bindings.push(before.createdAt,before.ordinal,before.rowId);}
  const rows=db.prepare(`SELECT key,ordinal,value FROM records WHERE ${predicate.join(' AND ')}
    ORDER BY json_extract(value,'$.at') DESC,ordinal DESC,key DESC LIMIT ?`).all(...bindings,limit+1).map(row=>{
    const line=JSON.parse(row.value);
    return {createdAt:line.at,ordinal:row.ordinal,rowId:'speech:'+row.key,line};
  });
  return {rows,total};
}

function privateMealRows(db,state,owner,language,query){
  const id=diskKey(owner.id),evidence=db.prepare(`
    SELECT value FROM records WHERE namespace='life.r95.evidence' AND owner=?
      AND json_extract(value,'$.sourceKind')='meal'
      AND json_extract(value,'$.scope.channel')='app-private'
      AND json_extract(value,'$.scope.personaId')=?
      AND json_extract(value,'$.scope.conversationId')=?
    ORDER BY ordinal
  `).all(diskKey(owner.characterId),owner.personaId,owner.id).map(row=>JSON.parse(row.value));
  const hidden=db.prepare("SELECT 1 FROM messages WHERE owner_type='private' AND owner_id=? AND message_id=?");
  return mealDialogue(state,owner,language,evidence).filter(row=>
    (!query||row.text.toLocaleLowerCase().includes(query))&&!hidden.get(id,diskKey(row.id)));
}

function privateHistoryWithAnnotations(db,ownerId,{limit,before,search,revision,language,state}){
  const owner=state.conversations?.[ownerId];
  if(!owner)return null;
  const id=diskKey(ownerId),query=search.trim().toLocaleLowerCase();
  const meals=privateMealRows(db,state,owner,language,query)
    .map(row=>({ordinal:-1,rowId:'meal:'+diskKey(row.id),createdAt:row.createdAt,message:row}));
  if(before&&!Number.isFinite(before.createdAt))return null;
  const speech=speechHistoryRows(db,{owner,life:state.lives?.[owner.characterId],query,before,limit});
  if(!meals.length&&!speech.total&&!Number.isFinite(before?.createdAt))return null;
  const filters=["owner_type='private'","owner_id=?"],bindings=[id];
  if(query){filters.push('companion_contains(body,extra_json,?)');bindings.push(query);}
  const {total}=db.prepare('SELECT count(*) AS total FROM messages WHERE '+filters.join(' AND ')).get(...bindings);
  if(before){
    filters.push('(coalesce(created_at,0),ordinal,row_id)<(?,?,?)');
    bindings.push(before.createdAt,before.ordinal,before.rowId);
  }
  const rows=db.prepare('SELECT * FROM messages WHERE '+filters.join(' AND ')+' ORDER BY coalesce(created_at,0) DESC,ordinal DESC,row_id DESC LIMIT ?')
    .all(...bindings,limit+1).map(row=>({ordinal:row.ordinal,rowId:row.row_id,createdAt:row.created_at??0,message:messageView(row)}));
  const order=(left,right)=>left.createdAt-right.createdAt||left.ordinal-right.ordinal||(left.rowId<right.rowId?-1:left.rowId>right.rowId?1:0);
  const beforeRows=before?meals.filter(row=>order(row,before)<0):meals;
  const selected=[...rows,...beforeRows,...speech.rows].sort(order).slice(-(limit+1));
  const hasMore=selected.length>limit,page=selected.slice(-limit),first=page[0];
  const nextUser=db.prepare(`
    SELECT * FROM messages WHERE owner_type='private' AND owner_id=? AND role='user'
      AND coalesce(created_at,0)>=?
    ORDER BY coalesce(created_at,0),ordinal,row_id LIMIT 1
  `);
  const messages=page.map(row=>{
    if(!row.line)return row.message;
    const line=row.line,reply=line.status==='read'?decodeCompanionMessage(nextUser.get(id,line.at))?.text??null:null;
    return {id:'speech:'+line.messageId,role:'narrator',text:line.text,createdAt:line.at,characterId:owner.characterId,personaId:owner.personaId,
      historySpeech:{line,reply,read:line.status==='read'}};
  });
  return {
    revision,messages,totalCount:total+meals.length+speech.total,hasMore,
    nextBefore:hasMore?{createdAt:first.createdAt,ordinal:first.ordinal,rowId:first.rowId}:null
  };
}

export function readCompanionHistory(path,type,ownerId,{limit=50,before,search='',favorites=false,language='zh-CN'}={}){
  validOwner(type,ownerId);
  validLimit(limit);
  if(before!==undefined&&before!==null&&(!Number.isSafeInteger(before.ordinal)||typeof before.rowId!=='string'))throw Error('Invalid history cursor');
  if(typeof search!=='string'||search.length>500||typeof favorites!=='boolean')throw Error('Invalid history filter');
  return withCompanionRead(path,db=>{
    const state=readCompanionState(db),revision=state.revision;
    if(type==='private'&&!favorites){
      const merged=privateHistoryWithAnnotations(db,ownerId,{limit,before,search,revision,language,state});
      if(merged)return merged;
    }
    const where=['owner_type=?','owner_id=?'];
    if(type==='group')where.push("status IS NOT 'pending-presentation'");
    const bindings=[type,diskKey(ownerId)];
    if(search.trim()){
      where.push('companion_contains(body,extra_json,?)');
      bindings.push(search.trim().toLocaleLowerCase());
    }
    if(favorites)where.push("json_extract(extra_json,'$.extra.favorite')=1");
    const filter=where.join(' AND ');
    const {totalCount}=db.prepare('SELECT count(*) AS totalCount FROM messages WHERE '+filter).get(...bindings);
    if(before){
      where.push('(ordinal,row_id)<(?,?)');
      bindings.push(before.ordinal,before.rowId);
    }
    const raw=db.prepare('SELECT * FROM messages WHERE '+where.join(' AND ')+' ORDER BY ordinal DESC,row_id DESC LIMIT ?').all(...bindings,limit+1);
    const hasMore=raw.length>limit,page=raw.slice(0,limit),last=page.at(-1);
    return {revision,messages:page.reverse().map(messageView),totalCount,hasMore,nextBefore:hasMore?{ordinal:last.ordinal,rowId:last.row_id}:null};
  });
}

export function openCompanionReader(path){
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    db.exec('PRAGMA busy_timeout=0;');
    withCompanionRead(db,assertCompanionSqliteCompatible);
    db.function('companion_contains',messageContains);
    return db;
  }catch(error){db.close();throw error;}
}

export function withCompanionRead(path,read){
  const ownsConnection=typeof path==='string';
  const db=ownsConnection?openCompanionReader(path):path;
  try{
    db.exec('BEGIN');
    try{
      const result=read(db);
      db.exec('COMMIT');
      return result;
    }catch(error){db.exec('ROLLBACK');throw error;}
  }finally{if(ownsConnection)db.close();}
}

export function queryCompanionMessages(path,{type,ownerId,ids,status,fromSeq,toSeq,role,limit,withOwners=false,pendingOnly=false}={}){
  return withCompanionRead(path,db=>{
    const where=[],params=[];
    for(const [field,value] of [['owner_type',type],['owner_id',ownerId===undefined?undefined:diskKey(ownerId)],['status',status],['role',role]]){
      if(value!==undefined){where.push(field+'=?');params.push(value);}
    }
    if(ids){
      if(!ids.length)return [];
      where.push('message_id IN ('+ids.map(()=>'?').join(',')+')');
      params.push(...ids.map(diskKey));
    }
    for(const [operator,value] of [['>=',fromSeq],['<=',toSeq]]){
      if(value!==undefined){where.push("CAST(json_extract(extra_json,'$.extra.seq') AS INTEGER)"+operator+'?');params.push(value);}
    }
    if(pendingOnly)where.push("(status IN ('pending','pending-presentation','generating','draft') OR json_extract(extra_json,'$.extra.presentation')='pending')");
    const ordering=limit?'ordinal DESC,row_id DESC':'ordinal,row_id';
    let sql='SELECT * FROM messages'+(where.length?' WHERE '+where.join(' AND '):'')+' ORDER BY '+ordering;
    if(limit){sql+=' LIMIT ?';params.push(limit);}
    const rows=db.prepare(sql).all(...params);
    return (limit?rows.reverse():rows).map(row=>withOwners?{ownerId:originalKey(row.owner_id),occurrenceId:row.row_id,message:decodeCompanionMessage(row)}:decodeCompanionMessage(row));
  });
}

export function readPrivateStartupRows(path,after){
  return withCompanionRead(path,db=>{
    const rows=db.prepare(`
      SELECT * FROM messages WHERE owner_type='private' AND (owner_id,ordinal,row_id)>(?,?,?)
        AND (status='pending' OR json_extract(extra_json,'$.extra.lifeId') IS NULL
          OR created_at IS NULL OR created_at=0
          OR role='assistant' AND json_extract(extra_json,'$.extra.presentation') IS NULL)
      ORDER BY owner_id,ordinal,row_id LIMIT 100
    `).all(...(after??['',-1,'']));
    const last=rows.at(-1);
    return {
      rows:rows.map(row=>({ownerId:originalKey(row.owner_id),occurrenceId:row.row_id,message:decodeCompanionMessage(row)})),
      next:rows.length===100?[last.owner_id,last.ordinal,last.row_id]:null
    };
  });
}

export function readGroupReplySource(path,{groupId,characterId,throughSeq}){
  return withCompanionRead(path,db=>{
    const member=db.prepare("SELECT value FROM records WHERE namespace='group.intervals' AND owner=? ORDER BY ordinal,key").all(diskKey(JSON.stringify([groupId,characterId])));
    const known=db.prepare("SELECT value FROM records WHERE namespace='life.groupIntervals' AND owner=? AND key=?").get(diskKey(characterId),diskKey(groupId));
    const intervals=member.map(row=>JSON.parse(row.value));
    const row=known&&db.prepare(`
      SELECT * FROM messages
      WHERE owner_type='group' AND owner_id=? AND role='user'
        AND CAST(json_extract(extra_json,'$.extra.seq') AS INTEGER)<=?
        AND EXISTS (
          SELECT 1 FROM json_each(?) AS witness
          WHERE CAST(json_extract(extra_json,'$.extra.seq') AS INTEGER)>=json_extract(witness.value,'$.start')
          AND (json_extract(witness.value,'$.end') IS NULL OR CAST(json_extract(extra_json,'$.extra.seq') AS INTEGER)<=json_extract(witness.value,'$.end'))
        )
      ORDER BY ordinal DESC,row_id DESC LIMIT 1
    `).get(diskKey(groupId),throughSeq,known.value);
    return {message:decodeCompanionMessage(row),intervals};
  });
}

export function searchCompanionOwners(path,type,query,language='zh-CN'){
  if(typeof query!=='string'||query.length>500)throw Error('Invalid history search');
  return withCompanionRead(path,db=>{
    db.function('companion_contains',messageContains);
    const text=query.trim().toLocaleLowerCase();
    const matching=new Set(db.prepare('SELECT DISTINCT owner_id FROM messages WHERE owner_type=? AND companion_contains(body,extra_json,?)')
      .all(type,text).map(row=>originalKey(row.owner_id)));
    if(type==='private'){
      const state=readCompanionState(db);
      for(const owner of Object.values(state.conversations??{})){
        if(matching.has(owner.id))continue;
        const life=state.lives?.[owner.characterId];
        if(!life||life.id!==owner.lifeId)continue;
        const {predicate,bindings}=speechHistoryFilter(owner,life,text);
        const speech=db.prepare('SELECT 1 FROM records WHERE '+predicate.join(' AND ')+' LIMIT 1').get(...bindings);
        if(speech||privateMealRows(db,state,owner,language,text).length)matching.add(owner.id);
      }
    }
    return [...matching];
  });
}

export function readPendingMood(path,characterId,scope){
  return withCompanionRead(path,db=>{
    const character=diskKey(characterId);
    const source="FROM records AS pending JOIN records AS evidence ON evidence.namespace='life.r95.evidence' AND evidence.owner=pending.owner AND evidence.key=pending.key WHERE pending.namespace='life.r95.pendingMoodEventIds' AND pending.owner=?";
    if(!scope)return db.prepare("SELECT DISTINCT json_extract(evidence.value,'$.scope') AS scope "+source).all(character).flatMap(row=>row.scope?[JSON.parse(row.scope)]:[]);
    return db.prepare(`SELECT pending.value ${source}
      AND json_extract(evidence.value,'$.scope.personaId')=?
      AND json_extract(evidence.value,'$.scope.channel')=?
      AND json_extract(evidence.value,'$.scope.conversationId')=?
      ORDER BY pending.ordinal LIMIT 100
    `).all(character,scope.personaId,scope.channel,scope.conversationId).map(row=>JSON.parse(row.value));
  });
}

export function readGroupSavedPhoto(path,groupId,range,characterIds){
  return withCompanionRead(path,db=>{
    const row=db.prepare(`
      SELECT value FROM records WHERE namespace='group.photos' AND owner=?
        AND json_extract(value,'$.range.start')=? AND json_extract(value,'$.range.end')=?
        AND json_array_length(value,'$.characterIds')=?
        AND NOT EXISTS (SELECT 1 FROM json_each(records.value,'$.characterIds') AS member
          WHERE member.value NOT IN (SELECT value FROM json_each(?)))
      ORDER BY ordinal DESC LIMIT 1
    `).get(diskKey(groupId),range.start,range.end,characterIds.length,JSON.stringify(characterIds));
    return row?JSON.parse(row.value):null;
  });
}

export function queryCompanionRecords(path,namespace,owner,{limit,field,value,values}={}){
  if(limit!==undefined)validLimit(limit);
  return withCompanionRead(path,db=>{
    const parameters=[namespace,diskKey(owner)],clauses=['namespace=?','owner=?'];
    if(field!==undefined){
      if(!/^[a-zA-Z][a-zA-Z0-9.]*$/.test(field))throw Error('Invalid record filter');
      const expression="json_extract(value,'$."+field+"')";
      if(values!==undefined){
        if(!Array.isArray(values)||values.length<1||values.length>20)throw Error('Invalid record filter values');
        clauses.push(expression+' IN ('+values.map(()=>'?').join(',')+')');
        parameters.push(...values);
      }else{clauses.push(expression+'=?');parameters.push(value);}
    }
    if(limit)parameters.push(limit);
    const sql='SELECT key,value FROM records WHERE '+clauses.join(' AND ')+' ORDER BY ordinal'+(limit?' DESC LIMIT ?':'');
    const rows=db.prepare(sql).all(...parameters);
    return (limit?rows.reverse():rows).map(row=>({key:originalKey(row.key),value:JSON.parse(row.value)}));
  });
}

export function readPreparedCompanionMemoryCommit(path,{namespace,owner,key}){
  return withCompanionRead(path,db=>{
    const {revision}=db.prepare('SELECT revision FROM state WHERE id=1').get();
    const source=db.prepare("SELECT value FROM meta WHERE key='memorySourceRevision'").get();
    const row=db.prepare('SELECT value FROM records WHERE namespace=? AND owner=? AND key=?')
      .get(namespace,diskKey(owner),diskKey(key));
    return {revision,memorySourceRevision:Number(source?.value??0),
      sha256:row&&createHash('sha256').update(row.value).digest('hex')};
  });
}


export function openCompanionDatabase(path,{initial,metadata={},seed,seedOwners,seedRecords,seedRecordOwners,audit,clock=()=>performance.now()}={}){
  const run=monitorCompanionSql(audit,clock);
  if(initial!==undefined)mkdirSync(dirname(path),{recursive:true});
  if(initial===undefined){
    const reader=run('open-read-only',()=>new DatabaseSync(path,{readOnly:true}));
    try{run('validate',()=>withCompanionRead(reader,db=>assertCompanionSqliteCompatible(db,{allowLegacy:false})));}finally{run('close-read-only',()=>reader.close());}
  }
  const db=run('open',()=>new DatabaseSync(path,{readOnly:false,enableForeignKeyConstraints:true}));
  try{
    run('configure',()=>db.exec(companionWriterPragmas));
    if(initial!==undefined){
      const initialize=()=>companionTransaction(run,{exec:sql=>db.exec(sql),body:()=>{
        run('create-schema',()=>db.exec(schema+stateSectionSchema+recordIndexes+historyIndexSchema));
        run('set-schema',()=>db.exec('PRAGMA user_version='+COMPANION_SCHEMA));
        run('set-writer',()=>db.prepare("INSERT INTO meta VALUES('minimumWriter',?)").run(sectionWriter));
        run('set-creation-metadata',()=>{
          const insert=db.prepare('INSERT INTO meta VALUES(?,?)');
          insert.run('requiredCapabilities',sectionCapabilities);
          for(const [key,value] of Object.entries(metadata))insert.run(key,JSON.stringify(value));
        });
        const {revision=0}=initial,{root,sections}=serializeCompanionState(initial);
        run('initialize-state',()=>db.prepare('INSERT INTO state VALUES (1,?,?)').run(revision,root));
        run('initialize-state-sections',()=>{
          const insert=db.prepare('INSERT INTO state_sections VALUES(?,?)');
          for(const {name,value} of sections)insert.run(name,value);
        });
        if(seedOwners)run('initialize-message-owners',()=>{
          const insert=db.prepare('INSERT INTO message_owners(owner_type,owner_id,path) VALUES(?,?,?)');
          for(const {type,ownerId,at} of seedOwners)insert.run(type,diskKey(ownerId),at?JSON.stringify(at):null);
        });
        if(seedRecords||seedRecordOwners)run('initialize-records',()=>{
          const insertOwner=db.prepare('INSERT INTO record_owners VALUES(?,?,?,?)'),insert=db.prepare('INSERT INTO records VALUES(?,?,?,?,?)');
          for(const {namespace,owner,array,at} of seedRecordOwners??[])insertOwner.run(namespace,diskKey(owner),Number(array),JSON.stringify(at));
          for(const {namespace,owner,key,ordinal,value} of seedRecords??[])insert.run(namespace,diskKey(owner),diskKey(key),ordinal,JSON.stringify(value));
        });
        if(seed)run('initialize-messages',()=>{
          const insert=db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
          for(const {type,ownerId,ordinal,message} of seed)insert.run(...encodeMessage(type,ownerId,ordinal,message,seedMessageId(type,ownerId,ordinal,message.id)));
        });
      }});
      if(seed?.length)withImportTempStore(run,db,initialize,{migration:true});
      else initialize();
    }
    const prepare=(name,sql)=>{
      const stmt=run(name+'.prepare',()=>db.prepare(sql));
      return {
        get:(...args)=>run(name,()=>stmt.get(...args)),
        all:(...args)=>run(name,()=>stmt.all(...args)),
        run:(...args)=>run(name,()=>stmt.run(...args))
      };
    };
    const statements={
      getState:prepare('state.get',joinedStateSelect),
      getRevision:prepare('state.get-revision','SELECT revision FROM state WHERE id=1'),
      changeSection:prepare('state.section-update','UPDATE state_sections SET value=? WHERE name=?'),
      getMemoryRevision:prepare('memory-source.read',"SELECT value FROM meta WHERE key='memorySourceRevision'"),
      setMemoryRevision:prepare('memory-source.advance',"INSERT INTO meta VALUES('memorySourceRevision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
      changeState:prepare('state.update','UPDATE state SET revision=?,value=? WHERE id=1 AND revision=?'),
      changeRevision:prepare('state.revision','UPDATE state SET revision=? WHERE id=1 AND revision=?'),
      get:prepare('messages.get','SELECT * FROM messages WHERE owner_type=? AND owner_id=? AND message_id=? ORDER BY ordinal,row_id LIMIT ?'),
      byOccurrence:prepare('messages.by-occurrence','SELECT * FROM messages WHERE row_id=? AND owner_type=? AND owner_id=?'),
      count:prepare('messages.count','SELECT count FROM message_owners WHERE owner_type=? AND owner_id=?'),
      byId:prepare('messages.by-id','SELECT * FROM messages WHERE owner_type=? AND message_id=? LIMIT 2'),
      byVoice:prepare('messages.by-voice-submission',"SELECT * FROM messages WHERE owner_type=? AND owner_id=? AND json_extract(extra_json,'$.extra.voiceSubmission.id')=? LIMIT 2"),
      groupAt:prepare('messages.group-at-sequence',"SELECT * FROM messages WHERE owner_type='group' AND owner_id=? AND message_id=? AND json_extract(extra_json,'$.extra.seq')=? LIMIT 2"),
      recent:prepare('messages.recent','SELECT * FROM messages WHERE owner_type=? AND owner_id=? ORDER BY ordinal DESC,row_id DESC LIMIT ?'),
      maxOrdinal:prepare('messages.max-order','SELECT ordinal FROM messages WHERE owner_type=? AND owner_id=? ORDER BY ordinal DESC,row_id DESC LIMIT 1'),
      upsert:prepare('messages.write',`
        INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(row_id) DO UPDATE SET ordinal=excluded.ordinal,role=excluded.role,
          character_id=excluded.character_id,created_at=excluded.created_at,status=excluded.status,
          body=excluded.body,emotion=excluded.emotion,emotion_ranges=excluded.emotion_ranges,extra_json=excluded.extra_json
      `),
      remove:prepare('messages.delete','DELETE FROM messages WHERE row_id=? AND owner_type=? AND owner_id=?'),

      getRecordOwner:prepare('records.owner','SELECT 1 FROM record_owners WHERE namespace=? AND owner=?'),
      getRecord:prepare('records.get','SELECT ordinal,value FROM records WHERE namespace=? AND owner=? AND key=?'),
      recordCount:prepare('records.count','SELECT count(*) AS count FROM records WHERE namespace=? AND owner=?'),
      traitEvidenceCount:prepare('growth.trait.evidence-count',"SELECT count(*) AS count FROM records WHERE namespace='growth.trait.evidence' AND owner=?"),
      pendingAppLines:prepare('social-lines.pending',`SELECT value FROM records WHERE ${appLineScope}
        AND json_extract(value,'$.scope.operationId')=?
        AND json_extract(value,'$.status') IN ('awaiting-presentation','presented') ORDER BY ordinal LIMIT ?`),
      proactiveHas:prepare('proactive.has-status',"SELECT 1 FROM records WHERE namespace='life.proactive.candidates' AND owner=? AND json_extract(value,'$.status') IN (SELECT value FROM json_each(?)) LIMIT 1"),
      mealEvidence:prepare('evidence.meals',"SELECT key,value FROM records WHERE namespace='life.r95.evidence' AND owner=? AND json_extract(value,'$.sourceKind')='meal' ORDER BY ordinal DESC LIMIT ?"),
      queuedInputs:prepare('groups.queued-inputs',"SELECT key,value FROM records WHERE namespace='group.pendingUserInputs' AND owner=? AND json_extract(value,'$.state')='queued' ORDER BY ordinal DESC LIMIT ?"),
      recordPage:prepare('records.filtered-recent',"SELECT key,value FROM records WHERE namespace=? AND owner=? AND json_extract(value,?)=? ORDER BY ordinal DESC LIMIT ?"),
      autoCompletedProgress:prepare('auto.completed-progress',`
        SELECT r.key,CASE json_type(r.value)
          WHEN 'object' THEN (
            SELECT json_group_object(field.key,r.value -> field.fullkey)
            FROM json_each(r.value) AS field
            WHERE field.key IN ('characterId','status','roundIndex','opportunityIndex')
          )
          WHEN 'array' THEN '[]'
          ELSE r.value
        END AS progress
        FROM record_owners AS o
        LEFT JOIN records AS r ON r.namespace=o.namespace AND r.owner=o.owner
        WHERE o.namespace='group.autoEvidence.completed' AND o.owner=?
        ORDER BY r.ordinal,r.key
      `),
      allRecords:prepare('records.values','SELECT key,ordinal,value FROM records WHERE namespace=? AND owner=? ORDER BY ordinal,key'),
      oldestRecords:prepare('records.oldest','SELECT key,value FROM records WHERE namespace=? AND owner=? ORDER BY ordinal LIMIT ?'),
      recentRecords:prepare('records.recent','SELECT key,value FROM records WHERE namespace=? AND owner=? ORDER BY ordinal DESC LIMIT ?'),
      maxRecordOrdinal:prepare('records.max-order','SELECT ordinal FROM records WHERE namespace=? AND owner=? ORDER BY ordinal DESC LIMIT 1'),
      defineRecords:prepare('records.define','INSERT OR IGNORE INTO record_owners VALUES (?,?,?,?)'),
      upsertRecord:prepare('records.write','INSERT INTO records VALUES (?,?,?,?,?) ON CONFLICT(namespace,owner,key) DO UPDATE SET value=excluded.value,ordinal=excluded.ordinal'),
      removeRecord:prepare('records.delete','DELETE FROM records WHERE namespace=? AND owner=? AND key=?'),
      clearRecords:prepare('records.clear','DELETE FROM records WHERE namespace=? AND owner=?'),
      removeRecordOwner:prepare('records.remove-owner','DELETE FROM record_owners WHERE namespace=? AND owner=?'),
      recordOwnersBelow:prepare('records.owners-by-path','SELECT namespace,owner FROM record_owners WHERE path=? OR substr(path,1,length(?))=?'),
      messageOwnersBelow:prepare('messages.owners-by-path','SELECT owner_type,owner_id FROM message_owners WHERE path=? OR substr(path,1,length(?))=?'),
      defineOwner:prepare('messages.define-owner','INSERT OR IGNORE INTO message_owners(owner_type,owner_id,path) VALUES(?,?,?)'),
      removeOwnerRows:prepare('messages.delete-owner-rows','DELETE FROM messages WHERE owner_type=? AND owner_id=?'),
      removeOwner:prepare('messages.delete-owner','DELETE FROM message_owners WHERE owner_type=? AND owner_id=?'),
      moveMessages:prepare('messages.move-owner','UPDATE messages SET owner_type=?,owner_id=? WHERE owner_type=? AND owner_id=?'),
      moveMessageOwner:prepare('messages.move-owner-path','UPDATE message_owners SET owner_type=?,owner_id=?,path=? WHERE owner_type=? AND owner_id=?'),
      moveRecords:prepare('records.move-owner','UPDATE records SET namespace=?,owner=? WHERE namespace=? AND owner=?'),
      moveRecordOwner:prepare('records.move-owner-path','UPDATE record_owners SET namespace=?,owner=?,path=? WHERE namespace=? AND owner=?')
    };
    const messages={
      get(type,ownerId,id,{occurrenceId}={}){
        validOwner(type,ownerId);
        if(typeof id!=='string')return undefined;
        const row=occurrenceId===undefined
          ?messageMatch(statements.get.all(type,diskKey(ownerId),diskKey(id),2))
          :statements.byOccurrence.get(occurrenceId,type,diskKey(ownerId));
        return row?.message_id===diskKey(id)?decodeCompanionMessage(row):undefined;
      },
      locate(type,id){return statements.byId.all(type,diskKey(id)).map(row=>({ownerId:originalKey(row.owner_id),occurrenceId:row.row_id,message:decodeCompanionMessage(row)}));},
      voiceSubmission(type,ownerId,id){return decodeCompanionMessage(messageMatch(statements.byVoice.all(type,diskKey(ownerId),id)));},
      groupAt(ownerId,id,seq){return decodeCompanionMessage(messageMatch(statements.groupAt.all(diskKey(ownerId),diskKey(id),seq)));},
      recent(type,ownerId,limit=50,{occurrences=false}={}){
        validOwner(type,ownerId);
        validLimit(limit);
        return statements.recent.all(type,diskKey(ownerId),limit).reverse().map(occurrences?messageView:decodeCompanionMessage);
      },
      count(type,ownerId){validOwner(type,ownerId);return statements.count.get(type,diskKey(ownerId))?.count??0;}
    };

    const readRecord=(namespace,owner,key)=>{
      const row=statements.getRecord.get(namespace,diskKey(owner),diskKey(key));
      return row?{ordinal:row.ordinal,value:JSON.parse(row.value)}:undefined;
    };
    const records={
      get(namespace,owner,key){return readRecord(namespace,owner,key)?.value;},
      hasOwner(namespace,owner){return !!statements.getRecordOwner.get(namespace,diskKey(owner));},
      pendingAppLines(scope,limit=100){
        validLimit(limit);
        return statements.pendingAppLines.all(...appLineBindings(scope),scope.operationId,limit).map(row=>JSON.parse(row.value));
      },
      hasProactiveStatus(owner,statuses){return !!statements.proactiveHas.get(diskKey(owner),JSON.stringify(statuses));},
      hasData(namespace,owner){return !!statements.recentRecords.get(namespace,diskKey(owner),1);},
      growthRecords(character,limit=20){
        validLimit(limit);
        const recent=namespace=>statements.recentRecords.all(namespace,diskKey(character),limit).reverse();
        const list=namespace=>recent(namespace).map(row=>JSON.parse(row.value));
        const map=namespace=>Object.fromEntries(recent(namespace).map(row=>[originalKey(row.key),JSON.parse(row.value)]));
        const traits=map('growth.preferences.traits');
        for(const [key,trait] of Object.entries(traits))trait.evidenceCount=statements.traitEvidenceCount.get(diskKey(JSON.stringify([character,key]))).count;
        return {
          history:list('growth.history'),observations:map('growth.observations'),batches:map('growth.batches'),
          failures:list('growth.failures'),preferences:{traits}
        };
      },
      has(namespace,owner,key){return readRecord(namespace,owner,key)!==undefined;},
      count(namespace,owner){return statements.recordCount.get(namespace,diskKey(owner))?.count??0;},
      recentWhere(namespace,owner,field,value,limit=25){
        validLimit(limit);
        if(!/^[a-zA-Z][a-zA-Z0-9.]*$/.test(field))throw Error('Invalid record filter');
        const id=diskKey(owner);
        const rows=namespace==='life.r95.evidence'&&field==='sourceKind'&&value==='meal'?statements.mealEvidence.all(id,limit):
          namespace==='group.pendingUserInputs'&&field==='state'&&value==='queued'?statements.queuedInputs.all(id,limit):
          statements.recordPage.all(namespace,id,'$.'+field,value,limit);
        return rows.reverse().map(row=>({key:originalKey(row.key),value:JSON.parse(row.value)}));
      },
      autoCompletedProgress(owner){
        const rows=statements.autoCompletedProgress.all(diskKey(owner));
        if(!rows.length)return undefined;
        if(rows[0].key===null)return {};
        return Object.fromEntries(rows.map(row=>[originalKey(row.key),JSON.parse(row.progress)]));
      },
      object(namespace,owner){
        return Object.fromEntries(statements.allRecords.all(namespace,diskKey(owner)).map(row=>[originalKey(row.key),JSON.parse(row.value)]));
      },
      oldest(namespace,owner,limit=1){
        validLimit(limit);
        return statements.oldestRecords.all(namespace,diskKey(owner),limit).map(row=>({key:originalKey(row.key),value:JSON.parse(row.value)}));
      },
      recent(namespace,owner,limit=25){
        validLimit(limit);
        return statements.recentRecords.all(namespace,diskKey(owner),limit).reverse().map(row=>({key:originalKey(row.key),value:JSON.parse(row.value)}));
      }
    };
    function updateState(next,currentRevision,changed){
      if(!changed)return statements.changeRevision.run(next.revision,currentRevision);
      const current=statements.getState.get();
      readStateRoot(current,true);
      const {root,sections}=serializeCompanionState(next);
      const revision=next.revision;
      const result=root===current.value?statements.changeRevision.run(revision,currentRevision):
        statements.changeState.run(revision,root,currentRevision);
      if(result.changes===1)for(const {name,value} of sections){
        if(value!==current[name+'Value']&&statements.changeSection.run(value,name).changes!==1)
          throw Error('Companion state section changed');
      }
      return result;
    }
    function stage(plan){
      const {owners=new Map(),messageMoves=[],recordMoves=[]}=plan??{};let rowsWritten=0;
      const slot=(type,ownerId)=>{
        validOwner(type,ownerId);
        const key=JSON.stringify([type,ownerId]);
        if(!owners.has(key))owners.set(key,{type,ownerId,rows:new Map(),deleted:false,nextOrdinal:null,path:null});
        return owners.get(key);
      };
      const storedRow=raw=>raw&&{rowId:raw.row_id,ordinal:raw.ordinal,message:decodeCompanionMessage(raw),stored:true};
      const byOccurrence=(owner,rowId)=>{
        if(owner.rows.has(rowId))return owner.rows.get(rowId)??undefined;
        if(owner.deleted)return undefined;
        return storedRow(statements.byOccurrence.get(rowId,owner.type,diskKey(owner.ownerId)));
      };
      const matches=(owner,id)=>{
        if(typeof id!=='string')return [];
        const result=owner.deleted?[]:statements.get.all(owner.type,diskKey(owner.ownerId),diskKey(id),owner.rows.size+2)
          .filter(row=>!owner.rows.has(row.row_id)).map(storedRow);
        for(const row of owner.rows.values())if(row?.message.id===id)result.push(row);
        return result;
      };
      const lookup=(owner,id,occurrenceId)=>{
        if(occurrenceId===undefined)return messageMatch(matches(owner,id));
        const row=byOccurrence(owner,occurrenceId);
        return row?.message.id===id?row:undefined;
      };
      const txMessages={
        get(type,ownerId,id,{occurrenceId}={}){return copyCompanionValue(lookup(slot(type,ownerId),id,occurrenceId)?.message);},
        recent(type,ownerId,limit=50,{occurrences=false}={}){
          validLimit(limit);
          const owner=slot(type,ownerId),rows=new Map();
          if(!owner.deleted)for(const raw of statements.recent.all(type,diskKey(ownerId),limit+owner.rows.size))rows.set(raw.row_id,storedRow(raw));
          for(const [id,value] of owner.rows)value?rows.set(id,value):rows.delete(id);
          return [...rows.values()].sort((a,b)=>a.ordinal-b.ordinal).slice(-limit).map(row=>occurrences?{...copyCompanionValue(row.message),occurrenceId:row.rowId}:copyCompanionValue(row.message));
        },
        count(type,ownerId){
          const owner=slot(type,ownerId);let count=owner.deleted?0:messages.count(type,ownerId);
          for(const [rowId,row] of owner.rows){
            const had=!owner.deleted&&statements.byOccurrence.get(rowId,type,diskKey(ownerId));
            if(!had&&row)count++;
            if(had&&!row)count--;
          }
          return count;
        },
        define(type,ownerId,at){
          slot(type,ownerId).path=at;
        },
        append(type,ownerId,message,{preserveDuplicate=false}={}){
          validMessage(message);
          const owner=slot(type,ownerId);
          if(!preserveDuplicate&&matches(owner,message.id).length)throw Error('Duplicate message ID for this owner');
          if(owner.nextOrdinal===null)owner.nextOrdinal=owner.deleted?0:(statements.maxOrdinal.get(type,diskKey(ownerId))?.ordinal??-1)+1;
          const rowId=randomUUID();
          owner.rows.set(rowId,{rowId,ordinal:owner.nextOrdinal++,message:copyCompanionValue(message),memoryChanged:true});
          return rowId;
        },
        update(type,ownerId,id,edit,{occurrenceId}={}){
          const owner=slot(type,ownerId),previous=lookup(owner,id,occurrenceId);
          if(!previous)return undefined;
          const message=copyCompanionValue(previous.message);
          edit(message);
          if(message.id!==id)throw Error('A message ID cannot change');
          if(!isDeepStrictEqual(message,previous.message)){
            const memoryChanged=previous.memoryChanged||!isDeepStrictEqual(withoutVoiceReceipt(message),withoutVoiceReceipt(previous.message));
            owner.rows.set(previous.rowId,{...previous,message,memoryChanged});
          }
          return copyCompanionValue(message);
        },
        delete(type,ownerId,id,{occurrenceId}={}){
          const owner=slot(type,ownerId),previous=lookup(owner,id,occurrenceId);
          if(!previous)return false;
          if(previous.stored)owner.rows.set(previous.rowId,null);
          else owner.rows.delete(previous.rowId);
          return true;
        },
        deleteOwner(type,ownerId){
          const owner=slot(type,ownerId);
          owner.deleted=true;
          owner.path=null;
          owner.rows.clear();
          owner.nextOrdinal=null;
        }
      };

      const recordStages=plan?.recordStages??new Map();
      const recordSlot=(namespace,owner)=>{
        const id=JSON.stringify([namespace,owner]);
        if(!recordStages.has(id))recordStages.set(id,{namespace,owner,rows:new Map(),descriptor:null,cleared:false,removed:false,nextOrdinal:null});
        return recordStages.get(id);
      };
      const findRecord=(slot,key)=>slot.rows.has(key)?slot.rows.get(key)??undefined:slot.cleared?undefined:readRecord(slot.namespace,slot.owner,key);
      function recordEntries(namespace,owner){
          const stage=recordSlot(namespace,owner),id=diskKey(owner);
          if(!stage.descriptor&&(stage.removed||!statements.getRecordOwner.get(namespace,id)))return undefined;
          const rows=new Map();
          if(!stage.cleared)for(const row of statements.allRecords.all(namespace,id))rows.set(originalKey(row.key),{ordinal:row.ordinal,value:JSON.parse(row.value)});
          for(const [key,row] of stage.rows){if(row)rows.set(key,row);else rows.delete(key);}
          return [...rows].sort(([,a],[,b])=>a.ordinal-b.ordinal).map(([key,row])=>[key,copyCompanionValue(row.value)]);
      }
      const txRecords={
        get(namespace,owner,key){return copyCompanionValue(findRecord(recordSlot(namespace,owner),key)?.value);},
        hasOwner(namespace,owner){const slot=recordSlot(namespace,owner);return !!(slot.descriptor||!slot.removed&&records.hasOwner(namespace,owner));},
        values(namespace,owner){return recordEntries(namespace,owner)?.map(([,value])=>value);},
        object(namespace,owner){return Object.fromEntries(recordEntries(namespace,owner)??[]);},
        has(namespace,owner,key){return findRecord(recordSlot(namespace,owner),key)!==undefined;},
        define(namespace,owner,{array=false,at}){
          const slot=recordSlot(namespace,owner);
          if((slot.removed||!statements.getRecordOwner.get(namespace,diskKey(owner)))&&!slot.descriptor)slot.descriptor={array,at};
        },
        put(namespace,owner,key,value,descriptor){
          const slot=recordSlot(namespace,owner);
          if(descriptor)txRecords.define(namespace,owner,descriptor);
          const previous=findRecord(slot,key),next=copyCompanionValue(value);
          if(previous&&isDeepStrictEqual(previous.value,next))return;
          if(slot.nextOrdinal===null)slot.nextOrdinal=slot.cleared?0:(statements.maxRecordOrdinal.get(namespace,diskKey(owner))?.ordinal??-1)+1;
          const memoryChanged=namespace!=='life.r95.lines'||!previous||previous.memoryChanged||
            !isDeepStrictEqual(withoutVoiceReceipt(next),withoutVoiceReceipt(previous.value));
          slot.rows.set(key,{ordinal:previous?.ordinal??slot.nextOrdinal++,value:next,memoryChanged});
        },
        delete(namespace,owner,key){
          const slot=recordSlot(namespace,owner);
          if(findRecord(slot,key))slot.rows.set(key,null);
        },
        removeOwner(namespace,owner){
          txRecords.clear(namespace,owner);
          recordSlot(namespace,owner).removed=true;
        },
        removeEmptyOwner(namespace,owner){
          const slot=recordSlot(namespace,owner);
          if(statements.recordCount.get(namespace,diskKey(owner)).count!==[...slot.rows.values()].filter(row=>row===null).length)
            throw Error('Cannot remove a nonempty companion record owner');
          slot.removed=true;
        },
        clear(namespace,owner){
          const slot=recordSlot(namespace,owner);
          slot.rows.clear();slot.cleared=true;slot.nextOrdinal=null;
        }
      };
      function deletePartitions(at){
        if(!Array.isArray(at)||at.length===0)throw Error('A companion partition path is required');
        const exact=JSON.stringify(at),prefix=exact.slice(0,-1)+',';
        for(const row of statements.messageOwnersBelow.all(exact,prefix,prefix))txMessages.deleteOwner(row.owner_type,originalKey(row.owner_id));
        for(const row of statements.recordOwnersBelow.all(exact,prefix,prefix))txRecords.removeOwner(row.namespace,originalKey(row.owner));
      }
      return {
        api:{messages:txMessages,records:txRecords,deletePartitions,
          moveMessages(from,to){messageMoves.push({from,to});},
          moveRecords(from,to){recordMoves.push({from,to});}
        },
        get memoryChanged(){
          if(messageMoves.length||recordMoves.length||[...owners.values()].some(owner=>!owner.type.startsWith('transaction-')&&(owner.deleted||[...owner.rows.values()].some(row=>!row||row.memoryChanged))))return true;
          return [...recordStages.values()].some(slot=>(slot.cleared||[...slot.rows.values()].some(row=>!row||row.memoryChanged))
            &&(/^(?:memory\.|growth\.|life\.(?:groupIntervals|personalEvents|gameExperiences|workExperiences|socialExperiences|r95\.lines)$)/.test(slot.namespace)||slot.namespace==='group.intervals'));
        },
        get changed(){return messageMoves.length>0||recordMoves.length>0||[...owners.values()].some(owner=>owner.deleted||owner.rows.size>0||owner.path)||[...recordStages.values()].some(slot=>slot.descriptor||slot.removed||slot.cleared||slot.rows.size);},
        get rowsWritten(){return rowsWritten;},
        plan:()=>({owners,recordStages,messageMoves,recordMoves}),
        write(){
          const write=(statement,...args)=>{rowsWritten+=Number(statement.run(...args).changes);};
          for(const {namespace,owner,rows,descriptor,cleared,removed} of recordStages.values()){
            if(cleared)write(statements.clearRecords,namespace,diskKey(owner));
            if(removed)write(statements.removeRecordOwner,namespace,diskKey(owner));
            if(descriptor)write(statements.defineRecords,namespace,diskKey(owner),Number(descriptor.array),JSON.stringify(descriptor.at));
            for(const [key,entry] of rows){
              if(entry)write(statements.upsertRecord,namespace,diskKey(owner),diskKey(key),entry.ordinal,JSON.stringify(entry.value));
              else write(statements.removeRecord,namespace,diskKey(owner),diskKey(key));
            }
          }
          for(const {type,ownerId,rows,deleted,path} of owners.values()){
            if(deleted){
              write(statements.removeOwnerRows,type,diskKey(ownerId));
              write(statements.removeOwner,type,diskKey(ownerId));
            }
            if(path)write(statements.defineOwner,type,diskKey(ownerId),JSON.stringify(path));
            for(const [id,value] of rows){
              if(value)write(statements.upsert,...encodeMessage(type,ownerId,value.ordinal,value.message,id));
              else write(statements.remove,id,type,diskKey(ownerId));
            }
          }
          for(const {from,to} of messageMoves){
            const source=[from.type,diskKey(from.ownerId)],target=[to.type,diskKey(to.ownerId)];
            if(!statements.count.get(...source)||statements.count.get(...target))
              throw Error('Companion message move owner missing or occupied');
            write(statements.moveMessages,...target,...source);
            write(statements.moveMessageOwner,...target,JSON.stringify(to.at),...source);
          }
          for(const {from,to} of recordMoves){
            const source=[from.namespace,diskKey(from.owner)],target=[to.namespace,diskKey(to.owner)];
            if(!statements.getRecordOwner.get(...source)||statements.getRecordOwner.get(...target))
              throw Error('Companion record move owner missing or occupied');
            write(statements.moveRecords,...target,...source);
            write(statements.moveRecordOwner,...target,JSON.stringify(to.at),...source);
          }
        }
      };
    }
    return {
      messages,records,stage,
      pinReadSnapshot(){
        run('snapshot.begin',()=>db.exec('BEGIN'));
        try{statements.getRevision.get();}
        catch(error){db.exec('ROLLBACK');throw error;}
        return ()=>run('snapshot.end',()=>db.exec('COMMIT'));
      },
      upgradeLegacyState(upgrade){
        const state=composeCompanionState(statements.getState.get(),true);
        if(state.schema!==1)return false;
        const {revision,...body}=state;
        companionTransaction(run,{exec:sql=>db.exec(sql),body:()=>{
          const update=updateState({...upgrade(body),revision},revision,true);
          if(update.changes!==1)throw Error('Companion database revision changed during schema upgrade');
        }});
        return true;
      },
      markVerified(){
        companionTransaction(run,{exec:sql=>db.exec(sql),body:()=>run('migration.verified',()=>db.prepare("UPDATE meta SET value='true' WHERE key='verified'").run())});
      },
      load(){
        return composeCompanionState(statements.getState.get(),true);
      },
      readRevision(){return statements.getRevision.get()?.revision;},
      memorySourceRevision(){
        return Number(statements.getMemoryRevision.get()?.value??0);
      },
      commit(staged,next,currentRevision,writeState,writeMemoryRevision,operation,commitTrace){
        const start=clock();
        try{
          const write=()=>companionTransaction(run,{exec:sql=>db.exec(sql),commitTrace,body:()=>{
            const result=updateState(next,currentRevision,writeState);
            if(result.changes!==1)throw Error('Companion database revision changed');
            staged.write();
            if(writeMemoryRevision)statements.setMemoryRevision.run(String(next.revision));
          }});
          return operation==='conversation-import'?withImportTempStore(run,db,write):write();
        }finally{reportSlowCompanionTransaction(audit,{operation,rows:staged.rowsWritten,elapsedMs:clock()-start});}
      },
      checkpoint({truncate=true}={}){
        const {busy,log,checkpointed}=run('checkpoint',()=>db.prepare(truncate?'PRAGMA wal_checkpoint(TRUNCATE)':'PRAGMA wal_checkpoint(PASSIVE)').get());
        return {status:busy||checkpointed<log?'busy':truncate?'truncated':'checkpointed',log,checkpointed};
      },
      close(){run('close',()=>db.close());}
    };
  }catch(error){
    db.close();
    throw error;
  }
}
