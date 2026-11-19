import {createHash} from 'node:crypto';
import {codexHistoryHash,codexInjectItems} from './codex-thread-wire.mjs';
import {t} from './i18n.mjs';
import {NATIVE_WRITE_QUEUED} from './companion-cache-store.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const threadKey=id=>'thread:'+id;
const scopeFields=['characterId','lifeId','operationId','personaId','conversationId'];
const selectorFields=['connectionId',...scopeFields];
const requestError=code=>Object.assign(new Error(code),{code});
const missingRollout=error=>/no rollout found|rollout (?:was )?not found/i.test(error.message);
const identityFor=(scope,connectionId)=>({
  connectionId:connectionId??scope.connectionId??null,
  ...Object.fromEntries(scopeFields.map(key=>[key,scope[key]??null])),
});

export class CodexPrivateThreads {
  constructor(store,audit){
    Object.assign(this,{store,audit});
    this.loaded=new Map();
    this.operations=new Map();
    this.retirementVersion=0;
    this.hasRetiredWork=false;
  }

  serial(threadId,operation){
    const previous=this.operations.get(threadId)??Promise.resolve();
    const current=previous.catch(()=>{}).then(operation).finally(()=>{
      if(this.operations.get(threadId)===current)this.operations.delete(threadId);
    });
    this.operations.set(threadId,current);
    return current;
  }

  async list({requireSnapshot=false}={}){
    return (await this.store.list({requireSnapshot})).filter(({key,value})=>
      key.startsWith('thread:')&&key===threadKey(value?.threadId)&&typeof value?.threadId==='string'&&!!value.scope
    ).map(({value})=>value);
  }

  async save(record){
    const result=await this.store.write(threadKey(record.threadId),record,{deferBusy:true});
    if(result!==true&&result!==NATIVE_WRITE_QUEUED)throw requestError('CODEX_NATIVE_STATE_WRITE');
    if(record.state==='delete-pending'){
      this.retirementVersion++;
      this.hasRetiredWork=true;
    }
  }

  async frozenAutoEffort(native,connectionId,model,buildFields){
    if(!native.scope)return null;
    const key=digest(identityFor(native.scope,connectionId));
    const record=(await this.list()).find(record=>record.state==='confirmed'&&record.scopeKey===key&&
      record.model===model&&record.autoEffort&&record.lastMessageId===(native.parentMessageId??null)&&
      record.historyHash===native.historyHash&&typeof record.effort==='string'&&
      record.requestFieldsHash===digest(buildFields(record.effort)));
    return record?.effort??null;
  }

  async prepare(client,native,fields,messages,connectionId,autoEffort){
    const {scope,historyHash,parentMessageId,requestId}=native;
    if(!scope||!scope.characterId||!scope.lifeId||!scope.personaId||!scope.conversationId||
       typeof requestId!=='string'||!requestId||messages.at(-1)?.role!=='user'||
       historyHash!==codexHistoryHash(messages.slice(0,-1)))throw requestError('CODEX_NATIVE_WINDOW_INVALID');
    const identity=identityFor(scope,connectionId);
    const instructionsHash=digest([fields.thread.baseInstructions,fields.thread.developerInstructions]);
    const requestFieldsHash=digest(fields);
    const scopeKey=digest(identity);
    const candidates=(await this.list({requireSnapshot:true})).filter(record=>record.state!=='delete-pending'&&(record.scope.conversationId===identity.conversationId||
      record.scope.characterId===identity.characterId&&
      ['lifeId','operationId','personaId'].some(key=>record.scope[key]!==identity[key])));
    const canResume=record=>record?.state==='confirmed'&&record.scopeKey===scopeKey&&
      record.lastMessageId===(parentMessageId??null)&&record.historyHash===historyHash&&
      record.instructionsHash===instructionsHash&&record.requestFieldsHash===requestFieldsHash;
    const match=candidates.find(canResume);
    const replaced=candidates.filter(record=>record!==match);
    const archived=await Promise.all(replaced.map(record=>this.archive(this.loaded.get(record.threadId)?.client??client,record.threadId,'delete-pending')));
    if(archived.includes(false))throw requestError('CODEX_NATIVE_ARCHIVE_PENDING');
    const create=async(sendFullWindow=false)=>{
      const {thread}=(await client.request('thread/start',fields.thread,client.handshakeTimeoutMs))??{};
      if(typeof thread?.id!=='string'||!thread.id)throw requestError('CODEX_NATIVE_THREAD_INVALID');
      if(thread.ephemeral===true){
        await client.request('thread/unsubscribe',{threadId:thread.id},Math.min(client.handshakeTimeoutMs,2000)).catch(()=>{});
        throw requestError('CODEX_NATIVE_UNEXPECTED_EPHEMERAL');
      }
      let active;
      try{
        active=await this.serial(thread.id,()=>this.register(client,thread,threadFields,sendFullWindow));
      }catch(error){
        await client.request('thread/archive',{threadId:thread.id},Math.min(client.handshakeTimeoutMs,2000)).catch(()=>{});
        throw error;
      }
      await client.request('thread/name/set',{threadId:thread.id,name:t('AI 酱 · 自动管理')},client.handshakeTimeoutMs)
        .catch(()=>this.audit({type:'codex-native-name-failed'}));
      return active;
    };
    const threadFields={
      scope:identity,scopeKey,instructionsHash,requestFieldsHash,requestId,
      model:fields.turn.model,effort:fields.turn.effort,autoEffort,
    };
    const resumed=match&&await this.serial(match.threadId,async()=>{
      const current=await this.store.read(threadKey(match.threadId));
      if(!canResume(current))throw requestError('CODEX_NATIVE_THREAD_CHANGED');
      const loaded=this.loaded.get(match.threadId);
      if(loaded&&(loaded.client!==client||loaded.child!==client.child)){
        if(!await this.archiveRecord(loaded.client,match.threadId))throw requestError('CODEX_NATIVE_ARCHIVE_PENDING');
        current.archived=true;
      }
      const warm=!current.archived&&loaded?.client===client&&loaded.child===client.child;
      if(warm)client.clock.clearTimeout(loaded.timer);
      const thread=warm?loaded.thread:await this.resume(client,current,fields.thread);
      if(!thread)return null;
      try{
        return await this.register(client,thread,{...current,...threadFields});
      }catch(error){
        await this.archiveRecord(client,match.threadId,'delete-pending',true).catch(()=>{});
        throw error;
      }
    });
    if(resumed)return resumed;
    const active=await create();
    const retained=messages.slice(0,-1);
    if(retained.length){
      try{
        await client.request('thread/inject_items',{threadId:active.thread.id,items:codexInjectItems(retained)},client.handshakeTimeoutMs);
      }catch{
        // The injection might have applied before an acknowledgement was lost.
        // Start from an empty thread before submitting the first model turn.
        this.audit({type:'codex-native-inject-fallback'});
        if(!await this.archive(client,active.thread.id,'delete-pending'))throw requestError('CODEX_NATIVE_ARCHIVE_PENDING');
        return create(true);
      }
    }
    return active;
  }

  async register(client,thread,fields,sendFullWindow=false){
    const record={
      ...fields,threadId:thread.id,state:'submitting',archived:false,
      rolloutPath:thread.path??fields.rolloutPath??null,ownerProcessKey:client.ownerProcessKey??null,
    };
    const active={client,child:client.child,thread,record,sendFullWindow};
    await this.save(record);
    this.loaded.set(thread.id,active);
    return active;
  }

  async resume(client,record,fields){
    const {threadId}=record;
    let finishClosed;
    const closed=new Promise(resolve=>{finishClosed=resolve;});
    const listener=message=>{
      if(message.method==='thread/closed'&&message.params?.threadId===threadId)finishClosed(true);
      if(message.method==='provider/error')finishClosed(false);
    };
    client.notifications.add(listener);
    const timeout=Math.min(client.handshakeTimeoutMs,10000);
    const call=()=>client.request('thread/resume',{...fields,threadId,excludeTurns:true},timeout);
    const unarchive=()=>client.request('thread/unarchive',{threadId},timeout);
    let timer;
    try{
      if(record.archived){
        await unarchive().catch(error=>{if(!/not archived/i.test(error.message))throw error;});
      }
      let result;
      try{result=await call();}
      catch(error){
        if(/is archived/i.test(error.message)){await unarchive();result=await call();}
        else if(/is closing/i.test(error.message)){
          const ready=await Promise.race([closed,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),timeout);})]);
          if(!ready)throw error;
          result=await call();
        }else throw error;
      }
      if(result?.thread?.id!==threadId)throw requestError('CODEX_NATIVE_RESUME_ID_MISMATCH');
      return result.thread;
    }catch(error){
      this.audit({type:'codex-native-resume-failed',code:missingRollout(error)?'CODEX_NATIVE_ROLLOUT_MISSING':error.code??'CODEX_NATIVE_RESUME_FAILED'});
      if(!await this.archiveRecord(client,threadId,'delete-pending',true))throw requestError('CODEX_NATIVE_ARCHIVE_PENDING');
      return null;
    }finally{
      clearTimeout(timer);
      client.notifications.delete(listener);
    }
  }

  archive(client,threadId,state){
    return this.serial(threadId,()=>this.archiveRecord(client,threadId,state));
  }

  async archiveRecord(client,threadId,state,force=false){
    const rpcChild=client.child;
    let record=await this.store.read(threadKey(threadId));
    if(!record)return true;
    if(state&&record.state!==state&&record.state!=='delete-pending'){record={...record,state};await this.save(record);}
    let archived=record.archived&&!force;
    const active=this.loaded.get(threadId);
    if(active)active.client.clock.clearTimeout(active.timer);
    if(!archived){
      try{
        if(!rpcChild||client.child!==rpcChild)throw requestError('CODEX_PROCESS_CHANGED');
        await client.request('thread/archive',{threadId},Math.min(client.handshakeTimeoutMs,2000));
        archived=true;
      }catch(error){
        archived=/already archived/i.test(error.message)||missingRollout(error);
        if(!archived)this.audit({type:'codex-native-archive-pending',code:error.code??'CODEX_NATIVE_ARCHIVE_FAILED'});
      }
    }
    const latest=await this.store.read(threadKey(threadId));
    if(latest)await this.save({...latest,archived});
    if(archived&&active&&this.loaded.get(threadId)===active){
      this.loaded.delete(threadId);
      if(this.isRetired(latest))active.client.onRetiredThreadReleased(active.child);
    }else if(active&&active.client.child===active.child)this.scheduleArchive(active);
    active?.client.refreshIdle();
    return archived;
  }

  async archiveLoaded(client){
    const ids=[...this.loaded].filter(([,active])=>active.client===client&&active.child===client.child).map(([id])=>id);
    await Promise.allSettled(ids.map(id=>this.archive(client,id)));
  }

  hasLoaded(client){
    return [...this.loaded.values()].some(active=>active.client===client&&active.child===client.child);
  }

  detach(client,child){
    for(const [id,active] of this.loaded){
      if(active.client!==client||active.child!==child)continue;
      client.clock.clearTimeout(active.timer);
      this.loaded.delete(id);
    }
  }

  available(record,protectedKeys){
    return !this.loaded.has(record.threadId)&&!this.operations.has(record.threadId)&&!protectedKeys.has(record.ownerProcessKey);
  }

  async recover(client,protectedKeys){
    const stale=(await this.list()).filter(record=>!record.archived&&record.state!=='delete-pending'&&this.available(record,protectedKeys));
    await Promise.allSettled(stale.map(({threadId})=>{
      if(this.operations.has(threadId))return;
      return this.serial(threadId,async()=>{
        const record=await this.store.read(threadKey(threadId));
        if(record&&!record.archived&&record.state!=='delete-pending'&&!this.loaded.has(threadId)&&!protectedKeys.has(record.ownerProcessKey)){
          await this.archiveRecord(client,threadId,record.state==='confirmed'?'confirmed':'delete-pending');
        }
      });
    }));
  }

  async needsRecovery(protectedKeys){
    return (await this.list()).some(record=>!record.archived&&record.state!=='delete-pending'&&this.available(record,protectedKeys));
  }

  async needsDelete(protectedKeys){
    return (await this.list()).some(record=>this.isRetired(record)&&this.available(record,protectedKeys));
  }

  isRetired(record){
    return record?.state==='delete-pending'||record?.state==='discarded';
  }

  async deleteBatch(client,protectedKeys,canContinue){
    if(this.deletingBatch)return;
    this.deletingBatch=true;
    try{
      const all=(await this.list()).filter(record=>this.isRetired(record)&&this.available(record,protectedKeys));
      const cursor=all.findIndex(record=>record.threadId===this.lastDeleteAttempt)+1;
      const batch=[...all.slice(cursor),...all.slice(0,cursor)].slice(0,4);
      for(const {threadId} of batch){
        if(!canContinue())break;
        if(this.operations.has(threadId))continue;
        this.lastDeleteAttempt=threadId;
        await this.serial(threadId,async()=>{
          const record=await this.store.read(threadKey(threadId));
          if(!canContinue()||!this.isRetired(record)||this.loaded.has(threadId)||protectedKeys.has(record.ownerProcessKey))return;
          if(record.state==='discarded')await this.save({...record,state:'delete-pending'});
          await this.deleteRecord(client,threadId,Math.min(client.handshakeTimeoutMs,2000));
        });
      }
      const version=this.retirementVersion;
      const remaining=(await this.list()).some(record=>this.isRetired(record));
      if(version===this.retirementVersion)this.hasRetiredWork=remaining;
    }finally{this.deletingBatch=false;}
  }

  async select(selector){
    const fields=selectorFields.filter(field=>typeof selector?.[field]==='string'&&selector[field]);
    const legacyIds=Array.isArray(selector?.legacyConversationIds)?selector.legacyConversationIds:[];
    if(!fields.length&&!legacyIds.length)throw requestError('CODEX_NATIVE_SCOPE_REQUIRED');
    return (await this.list()).filter(record=>
      fields.length>0&&fields.every(field=>record.scope[field]===selector[field])||
      legacyIds.includes(record.scope.conversationId));
  }

  async markDelete(records){
    let marked=0;
    for(const {threadId} of records)marked+=await this.serial(threadId,async()=>{
      const record=await this.store.read(threadKey(threadId));
      if(!record||this.isRetired(record))return 0;
      await this.save({...record,state:'delete-pending'});
      return 1;
    });
    return marked;
  }

  deleteMarked(client,threadId){
    return this.serial(threadId,()=>this.deleteRecord(client,threadId));
  }

  async deleteRecord(client,threadId,timeout){
    const record=await this.store.read(threadKey(threadId));
    if(!this.isRetired(record))return true;
    const active=this.loaded.get(threadId);
    const owner=active?.client??client;
    if(active)active.client.clock.clearTimeout(active.timer);
    try{
      await owner.request('thread/delete',{threadId},timeout);
    }catch(error){
      if(!missingRollout(error)){
        this.audit({type:'codex-native-delete-pending',code:error.code??'CODEX_NATIVE_DELETE_FAILED'});
        if(active&&active.client.child===active.child)this.scheduleArchive(active);
        return false;
      }
    }
    this.loaded.delete(threadId);
    active?.client.refreshIdle();
    try{
      if(await this.store.remove(threadKey(threadId))!==false)return true;
      this.audit({type:'codex-native-delete-pending',code:'COMPANION_CACHE_CLEANUP_QUEUED'});
    }catch(error){
      this.audit({type:'codex-native-delete-pending',code:error.code??'CODEX_NATIVE_DELETE_FAILED'});
    }
    return false;
  }

  scheduleArchive(active){
    const {client,record}=active;
    client.clock.clearTimeout(active.timer);
    active.timer=client.clock.setTimeout(()=>{
      void this.serial(record.threadId,()=>{
        if(this.loaded.get(record.threadId)===active)return this.archiveRecord(client,record.threadId);
      }).catch(()=>this.audit({type:'codex-native-archive-pending'}));
    },client.threadIdleMs);
    active.timer?.unref?.();
  }

  async complete(active,messages,assistantText){
    const {threadId,requestId}=active.record;
    const historyHash=codexHistoryHash([...messages,{role:'assistant',content:assistantText}]);
    return this.serial(threadId,async()=>{
      const current=await this.store.read(threadKey(threadId));
      if(current?.requestId!==requestId||!['submitting','delete-pending'].includes(current.state))throw requestError('CODEX_NATIVE_THREAD_CHANGED');
      const confirmable=current.state==='submitting';
      if(confirmable)await this.save({...current,state:'awaiting-host-commit',historyHash});
      if(this.loaded.get(threadId)===active)this.scheduleArchive(active);
      return confirmable;
    });
  }

  async commit(requestId,{lastMessageId,historyHash}={}){
    if(typeof lastMessageId!=='string'||!lastMessageId)return false;
    const record=(await this.list()).find(row=>row.requestId===requestId&&row.state==='awaiting-host-commit');
    if(!record)return false;
    const {threadId}=record;
    return this.serial(threadId,async()=>{
      const current=await this.store.read(threadKey(threadId));
      if(current?.requestId!==requestId||current.state!=='awaiting-host-commit')return false;
      if(historyHash!==undefined&&historyHash!==current.historyHash){
        await this.discardRecord(current);
        return false;
      }
      await this.save({...current,lastMessageId,state:'confirmed'});
      return true;
    });
  }

  async discard(requestId){
    const record=(await this.list()).find(row=>row.requestId===requestId&&['submitting','awaiting-host-commit'].includes(row.state));
    if(!record)return false;
    const {threadId}=record;
    return this.serial(threadId,async()=>{
      const current=await this.store.read(threadKey(threadId));
      if(current?.requestId!==requestId||!['submitting','awaiting-host-commit'].includes(current.state))return false;
      await this.discardRecord(current);
      return true;
    });
  }
  async discardRecord(record){
    const active=this.loaded.get(record.threadId);
    if(active)await this.archiveRecord(active.client,record.threadId,'delete-pending');
    else await this.save({...record,state:'delete-pending'});
  }
}
