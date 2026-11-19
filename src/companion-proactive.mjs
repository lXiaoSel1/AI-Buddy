import {lifeRecord,saveLifeRecord} from './companion-record-access.mjs';
import {copyCompanionValue} from './companion-draft.mjs';
import {randomUUID} from 'node:crypto';
import {assertSocialScope,r95LifeState,sameSocialScope,socialError} from './companion-presentation-state.mjs';
import {attentionAvailability} from './companion-attention.mjs';

const copy=value=>copyCompanionValue(value);
export const DEFAULT_SOCIAL_SETTINGS=Object.freeze({proactive:false,selfTalk:false,auto:false});
const supported=new Set(['greeting','share','selftalk','report']);
const settingFor=kind=>kind==='selftalk'?'selfTalk':'proactive';
export function socialSettings(state){return {...DEFAULT_SOCIAL_SETTINGS,...state.r95?.settings};}
export function createProactiveService({store,now=()=>Date.now(),getActiveContext=()=>null,getRuntimeState=()=>({}),generate,emit=async()=>{},getEvidence=async()=>[],minimumRetryMs=30000}={}){
 const running=new Map(),controllers=new Map();let closed=false;
 const candidatePath=['r95','proactive','candidates'],sourcePath=['r95','proactive','sourceKeys'];
 const candidateFrom=(state,character,id,tx)=>lifeRecord(store,state,character,'life.proactive.candidates',candidatePath,id,tx);
 const saveCandidate=(state,character,id,value,tx)=>saveLifeRecord(state,character,'life.proactive.candidates',candidatePath,id,value,tx);
 async function candidateRows(character,statuses,options={}){
  if(!store.records)return Object.values(store.state.lives?.[character]?.r95?.proactive?.candidates??{}).filter(row=>!statuses||statuses.includes(row.status));
  if(!statuses)return (await store.records.query('life.proactive.candidates',character,options)).map(row=>row.value);
  if(store.records.hasProactiveStatus?.(character,statuses)===false)return [];
  const matches=await store.records.query('life.proactive.candidates',character,{...options,field:'status',values:statuses});
  return matches.map(row=>row.value);
 }
 function candidates(state,scope){return r95LifeState(state,scope).proactive??={schemaVersion:1,unanswered:0};}
 function candidate(id){for(const [characterId,life]of Object.entries(store.state.lives??{})){const row=candidateFrom(store.state,characterId,id);if(row)return {row,scope:{...row.scope,characterId}};}throw socialError('PROACTIVE_NOT_FOUND','主动候选不存在');}
 function admission(row){
  if(closed)return {ok:false,reason:'closing'};
  try{assertSocialScope(store.state,row.scope);}catch{return {ok:false,reason:'stale-life'};}
  const settings=socialSettings(store.state),runtime=getRuntimeState(row.scope)??{},availability=attentionAvailability(store.state,now());
  if(!settings[settingFor(row.kind)]&&row.kind!=='report')return {ok:false,reason:'disabled'};
  const appChannel=['app','app-private','app-group'].includes(row.scope.channel??'app');
  if(appChannel&&!sameSocialScope(getActiveContext(),row.scope))return {ok:false,reason:'not-current-character'};
  if(!appChannel&&runtime.activityAllowed!==true)return {ok:false,reason:'activity-not-authorized'};
  if(runtime.activityAllowed===false||runtime.cancelled===true)return {ok:false,reason:'activity-revoked'};
  if(availability.doNotDisturb)return {ok:false,reason:'do-not-disturb'};
  if(runtime.typing||runtime.waitingForReply||runtime.presenting||runtime.audioPlaying||runtime.awaitingUserAnswer||runtime.canPresent===false)return {ok:false,reason:'presentation-barrier'};
  if(row.expiresAt&&now()>=row.expiresAt)return {ok:false,reason:'expired'};
  return {ok:true,runtime,availability,mode:['sleep-enter','asleep'].includes(runtime.sleepPhase)?'dream':'awake'};
 }
 async function update(id,fn){const {scope}=candidate(id);return store.mutate((state,tx)=>{const rows=candidates(state,scope),row=candidateFrom(state,scope.characterId,id,tx);if(!row)throw socialError('PROACTIVE_NOT_FOUND','主动候选不存在');const result=fn(row,rows,state);saveCandidate(state,scope.characterId,id,row,tx);return result;});}
 const api={
  async setSettings(patch={}){if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.entries(patch).some(([key,value])=>!Object.hasOwn(DEFAULT_SOCIAL_SETTINGS,key)||typeof value!=='boolean'))throw socialError('SOCIAL_SETTINGS_INVALID','自动活动设置无效');return store.mutate(state=>{state.r95??={schemaVersion:1};state.r95.settings={...socialSettings(state),...patch};return copy(state.r95.settings);});},
  async offer({scope,kind='share',eventIds,sourceKey,expiresAt,nextConsiderAt,metadata={}}={}){
   assertSocialScope(store.state,scope);if(!supported.has(kind)||!Array.isArray(eventIds)||!eventIds.length||eventIds.length>100||eventIds.some(id=>typeof id!=='string')||typeof sourceKey!=='string'||!sourceKey||sourceKey.length>500)throw socialError('PROACTIVE_OFFER_INVALID','主动候选需要真实来源');
   if(metadata.generatedByProactive===true||metadata.generatedByDream===true)throw socialError('PROACTIVE_RECURSION','主动表达不能以自身输出递归激活');
   const evidence=await getEvidence({scope,eventIds});assertSocialScope(store.state,scope);if(!Array.isArray(evidence)||eventIds.some(id=>!evidence.some(row=>(row.eventId??row.id)===id)))throw socialError('PROACTIVE_EVIDENCE_INVALID','主动候选缺少可信实际经历');
   if(evidence.some(row=>['selftalk','self-talk','dream','proactive-expression'].includes(row.sourceKind)||row.generatedByProactive===true||row.generatedByDream===true))throw socialError('PROACTIVE_RECURSION','主动表达不能以自身输出递归激活');
   if(kind==='report'&&!evidence.some(row=>row.kind==='work-report'||row.sourceKind==='work-report'||row.type==='work-report'))throw socialError('PROACTIVE_EVIDENCE_INVALID','工作报告须有实际报告来源');
   for(const value of [expiresAt,nextConsiderAt])if(value!==undefined&&value!==null&&(!Number.isFinite(value)||value<now()))throw socialError('PROACTIVE_OFFER_INVALID','候选时间无效');
   return store.mutate((state,tx)=>{candidates(state,scope);const key=kind+'\0'+sourceKey,old=lifeRecord(store,state,scope.characterId,'life.proactive.sourceKeys',sourcePath,key,tx),existing=old&&candidateFrom(state,scope.characterId,old,tx);if(existing)return {duplicate:true,candidate:copy(existing)};
    const row={id:'proactive-'+randomUUID(),scope:copy(scope),kind,eventIds:[...new Set(eventIds)],sourceKey,status:'pending',createdAt:now(),nextConsiderAt:nextConsiderAt??now(),expiresAt:kind==='greeting'?(expiresAt??now()+86400000):null,metadata:copy(metadata),attempts:0};saveCandidate(state,scope.characterId,row.id,row,tx);saveLifeRecord(state,scope.characterId,'life.proactive.sourceKeys',sourcePath,key,row.id,tx);return {candidate:copy(row)};});
  },
  async tick({candidateId}={}){
   if(closed)return {skipped:'closing'};
   let selected;if(candidateId)selected=candidate(candidateId);else{const scope=getActiveContext();if(!scope)return {skipped:'no-active-context'};const life=assertSocialScope(store.state,scope),rows=(await candidateRows(scope.characterId,['pending','deferred','ready'])).filter(row=>row.nextConsiderAt<=now()).sort((a,b)=>a.createdAt-b.createdAt),plan=life.r95?.proactive?.plan;let blocked;
    // Keep candidates owned by their original scope, but do not let an old
    // conversation or a temporarily inadmissible kind block usable work.
    for(const row of rows){const check=admission(row),reason=!check.ok?check.reason:row.kind==='report'&&check.mode==='dream'?'report-awaiting-wake':null;if(!reason){selected={scope:row.scope,row};break;}blocked??=reason;if(reason==='expired')await update(row.id,value=>{value.status='expired';});}
    if(!selected&&plan?.status==='planned'&&plan.nextConsiderAt<=now()&&sameSocialScope(plan.scope,scope)){const check=admission({scope:plan.scope,kind:'greeting'});if(check.ok){const offered=await api.offer({scope:plan.scope,kind:'greeting',eventIds:plan.eventIds,sourceKey:'ai-plan:'+plan.id,nextConsiderAt:now(),metadata:{plannedFromCandidateId:plan.candidateId}});await store.mutate(state=>{const current=candidates(state,scope).plan;if(current?.id===plan.id)current.status='consumed';});selected={scope:offered.candidate.scope,row:offered.candidate};}else blocked??=check.reason;}
    if(!selected)return {skipped:blocked??'no-candidate',...(blocked==='report-awaiting-wake'?{retained:true}:{})};}
   const {row}=selected;if(running.has(row.scope.characterId))return running.get(row.scope.characterId);
   if(!['pending','deferred','ready'].includes(row.status))return {skipped:row.status};if(row.nextConsiderAt>now())return {skipped:'not-due'};
   const check=admission(row);if(!check.ok){if(check.reason==='expired')await update(row.id,value=>{value.status='expired';});return {skipped:check.reason};}
   if(row.kind==='report'&&check.mode==='dream')return {skipped:'report-awaiting-wake',retained:true};
   const controller=new AbortController();controllers.set(row.id,controller);
   const guard=()=>{if(controller.signal.aborted||controllers.get(row.id)!==controller)throw socialError('PROACTIVE_CANCELLED','主动表达已取消');};
   const beforeSubmit=({messageId}={})=>update(row.id,value=>{guard();if(value.status!=='presenting')throw socialError('PROACTIVE_STALE','主动候选已变化');const final=admission(value);if(!final.ok)throw socialError('PROACTIVE_CANCELLED','主动表达已取消：'+final.reason);if(value.outputMode!==final.mode)throw socialError('PROACTIVE_STALE','主动表达状态已变化');if(value.deliverySubmittedAt){if(value.deliveryMessageId!==messageId)throw socialError('PROACTIVE_STALE','主动提交编号已变化');return {duplicate:true};}value.deliverySubmittedAt=now();if(messageId)value.deliveryMessageId=messageId;return {submitted:true};});
   const job=(async()=>{try{let output=row.output,mode=row.outputMode;
    if(!output){await update(row.id,value=>{guard();if(!['pending','deferred'].includes(value.status))throw socialError('PROACTIVE_STALE','主动候选已变化');value.status='generating';value.attempts++;});
     try{if(typeof generate!=='function')throw socialError('PROACTIVE_MODEL_UNAVAILABLE','主动表达模型不可用');
      const result=await generate({kind:row.kind,mode:check.mode,scope:copy(row.scope),eventIds:copy(row.eventIds),availability:check.availability,unanswered:store.state.lives[row.scope.characterId].r95?.proactive?.unanswered??0,signal:controller.signal,candidateId:row.id});
      if(controller.signal.aborted)throw socialError('PROACTIVE_CANCELLED','主动表达已取消');
      if(result?.speak===false){if(result.nextConsiderAt!==undefined&&(!Number.isFinite(result.nextConsiderAt)||result.nextConsiderAt<now()+minimumRetryMs))throw socialError('PROACTIVE_SCHEDULE_INVALID','主动计划必须是有效未来时间');await update(row.id,value=>{guard();if(value.status!=='generating')throw socialError('PROACTIVE_STALE','主动候选已变化');value.status=result.nextConsiderAt?'deferred':'quiet';value.nextConsiderAt=result.nextConsiderAt??null;});return {silent:true};}
      if(typeof result?.text!=='string'||!result.text.trim()||result.text.length>200000||result.mode!==check.mode)throw socialError('PROACTIVE_OUTPUT_INVALID','主动台词或睡眠表达类型无效');output={text:result.text,sourceRefs:copy(row.eventIds),...(typeof result.motive==='string'?{motive:result.motive.slice(0,1000)}:{})};mode=check.mode;
      if(result.nextConsiderAt!==undefined&&(!Number.isFinite(result.nextConsiderAt)||result.nextConsiderAt<now()+minimumRetryMs))throw socialError('PROACTIVE_SCHEDULE_INVALID','主动计划必须是有效未来时间');
      await update(row.id,value=>{guard();if(value.status!=='generating')throw socialError('PROACTIVE_STALE','主动候选已变化');value.output=output;value.outputMode=mode;value.status='ready';value.nextPlanAt=result.nextConsiderAt??null;});
     }catch(error){await update(row.id,value=>{if(value.status!=='cancelled'){value.status='failed';value.error={code:error.code??'PROACTIVE_FAILED',message:String(error.message).slice(0,500),at:now()};}}).catch(()=>{});throw error;}
    }
    guard();const current=candidate(row.id).row,again=admission(current);if(!again.ok)return {skipped:again.reason,retained:true};
    // Work reports remain accurate reports, never fictional dream accomplishments.
    if(mode!==again.mode||current.kind==='report'&&again.mode==='dream'){await update(row.id,value=>{guard();if(value.status!=='ready')throw socialError('PROACTIVE_STALE','主动候选已变化');value.status='deferred';value.nextConsiderAt=now()+minimumRetryMs;delete value.output;delete value.outputMode;});return {skipped:'sleep-mode-changed',retained:true};}
    await update(row.id,value=>{guard();if(value.status!=='ready')throw socialError('PROACTIVE_STALE','主动候选已变化');value.status='presenting';value.deliveryStartedAt=now();});
    try{guard();await emit({candidateId:row.id,scope:copy(row.scope),mode,kind:row.kind,...copy(output)},{signal:controller.signal,beforeSubmit});return {delivered:true,candidateId:row.id};}catch(error){await update(row.id,value=>{if(value.status==='presented')return;if(!value.deliverySubmittedAt&&controller.signal.aborted){value.status='cancelled';return;}value.status=value.deliverySubmittedAt?'delivery-unknown':'failed';value.error={code:value.deliverySubmittedAt?'PROACTIVE_DELIVERY_UNKNOWN':error.code??'PROACTIVE_DELIVERY_FAILED',at:now(),message:String(error.message).slice(0,500)};}).catch(()=>{});throw error;}
   }finally{if(controllers.get(row.id)===controller)controllers.delete(row.id);}})();running.set(row.scope.characterId,job);try{return await job;}finally{running.delete(row.scope.characterId);}
  },
  async presented({candidateId,messageId}={}){if(typeof messageId!=='string'||!messageId)throw socialError('PROACTIVE_PRESENTATION_INVALID','呈现确认缺少真实消息');return update(candidateId,(row,rows)=>{if(row.status==='presented')return {duplicate:true};if(!['presenting','delivery-unknown'].includes(row.status)||row.deliveryMessageId&&row.deliveryMessageId!==messageId)throw socialError('PROACTIVE_PRESENTATION_INVALID','主动台词没有待确认的呈现');row.status='presented';row.messageId=messageId;row.presentedAt=now();rows.unanswered=(rows.unanswered??0)+1;
    if(row.kind!=='selftalk'&&row.kind!=='report'&&row.nextPlanAt>now())rows.plan={id:'plan-'+randomUUID(),candidateId:row.id,scope:copy(row.scope),eventIds:copy(row.eventIds),nextConsiderAt:row.nextPlanAt,status:'planned'};return {presented:true};});},
  async userReturned({scope}={}){
   const values=await candidateRows(scope.characterId,['pending','deferred','ready']);
   return store.mutate((state,tx)=>{const rows=candidates(state,scope);rows.unanswered=0;rows.lastUserReturnedAt=now();if(rows.plan)rows.plan.status='superseded-by-user-interaction';
    for(const candidate of values){
      const row=candidateFrom(state,scope.characterId,candidate.id,tx);
      if(row?.kind==='greeting'&&['pending','deferred','ready'].includes(row.status)){row.status='cancelled';row.cancelReason='user-returned';saveCandidate(state,scope.characterId,row.id,row,tx);}
    }
   });
  },
  async cancel({candidateId,reason='cancelled'}={}){controllers.get(candidateId)?.abort();return update(candidateId,row=>{if(row.status==='presented')return {cancelled:false,alreadyPresented:true};row.cancelReason=String(reason).slice(0,200);if(row.deliverySubmittedAt||row.status==='delivery-unknown'){row.cancelRequestedAt=now();return {cancelled:false,cancelRequested:true,awaitingReceipt:true};}row.status='cancelled';row.cancelledAt=now();return {cancelled:true};});},
  async retry({candidateId}={}){return update(candidateId,row=>{if(!['failed','interrupted'].includes(row.status))throw socialError('PROACTIVE_RETRY_INVALID','此候选不能直接重试；结果不明需先核对');row.status='pending';row.nextConsiderAt=now();delete row.error;return {retryable:true};});},
  async recover(){
   const candidates=await Promise.all(Object.keys(store.state.lives??{}).map(async char=>[char,await candidateRows(char,['generating','presenting'])]));
   return store.mutate((state,tx)=>{for(const [character,values] of candidates)for(const candidate of values){
    const row=candidateFrom(state,character,candidate.id,tx);
    if(row?.status==='generating')row.status='interrupted';else if(row?.status==='presenting')row.status='delivery-unknown';else continue;
    saveCandidate(state,character,row.id,row,tx);
   }});
  },
  pendingExternal:async character=>(await candidateRows(character,['pending','deferred','ready'])).filter(row=>!['app','app-private','app-group'].includes(row.scope.channel)),
  view({scope=getActiveContext()}={}){const life=assertSocialScope(store.state,scope);return {settings:socialSettings(store.state),availability:attentionAvailability(store.state,now()),candidates:copy((store.records?store.records.recent('life.proactive.candidates',scope.characterId,100).map(row=>row.value):Object.values(life.r95?.proactive?.candidates??{})).filter(row=>sameSocialScope(row.scope,scope))),running:running.has(scope.characterId)};},
  async close({timeoutMs=5000}={}){closed=true;for(const controller of controllers.values())controller.abort();let timer;try{return await Promise.race([Promise.allSettled([...running.values()]).then(()=>({settled:true})),new Promise(resolve=>{timer=setTimeout(()=>resolve({settled:false,pending:running.size}),timeoutMs);})]);}finally{clearTimeout(timer);}}
 };
 return api;
}
