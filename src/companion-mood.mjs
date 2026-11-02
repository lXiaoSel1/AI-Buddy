import {assertSocialScope,r95LifeState,socialError} from './companion-presentation-state.mjs';

const copy=value=>structuredClone(value),MAX_RECOVERY=315360000000;
export function projectedMood(value,at=Date.now()){
 if(!value)return null;const result=copy(value),elapsed=Math.max(0,at-(Number.isFinite(value.anchorAt)?value.anchorAt:at));
 const project=feeling=>({...feeling,intensity:Math.max(0,Math.min(1,feeling.anchorIntensity*Math.pow(.5,elapsed/feeling.recoveryHalfLifeMs)))});
 result.overall=project(result.overall);result.feelings=(result.feelings??[]).map(project);result.projectedAt=at;return result;
}
function normalizedFeeling(raw,eventIds,scope,at){
 if(!raw||typeof raw.label!=='string'||!raw.label.trim()||raw.label.length>100||typeof raw.summary!=='string'||raw.summary.length>2000||!Number.isFinite(raw.intensity)||raw.intensity<0||raw.intensity>1||!Number.isFinite(raw.recoveryHalfLifeMs)||raw.recoveryHalfLifeMs<1000||raw.recoveryHalfLifeMs>MAX_RECOVERY)throw socialError('MOOD_OUTPUT_INVALID','心情判断格式或数值无效');
 const refs=raw.eventIds??eventIds;if(!Array.isArray(refs)||!refs.length||refs.some(id=>!eventIds.includes(id)))throw socialError('MOOD_EVIDENCE_INVALID','心情引用不属于当前真实事件');
 return {label:raw.label.trim(),summary:raw.summary,anchorIntensity:raw.intensity,intensity:raw.intensity,recoveryHalfLifeMs:raw.recoveryHalfLifeMs,eventIds:[...new Set(refs)],visibility:{personaId:scope.personaId??null,channel:scope.channel??'app',conversationId:scope.conversationId??null},updatedAt:at,...(typeof raw.target==='string'?{target:raw.target.slice(0,200)}:{})};
}
export function rebaseMoodSnapshot(life,at=Date.now(),snapshotAt){
 const mood=life?.r95?.mood;if(!mood)return;const projected=projectedMood(mood,Number.isFinite(snapshotAt)?snapshotAt:mood.anchorAt);
 projected.overall.anchorIntensity=projected.overall.intensity;for(const row of projected.feelings)row.anchorIntensity=row.intensity;
 // A saved life does not spend its remaining review delay while archived.
 // Keep the old receipt as evidence and alias a completed review to the new
 // clock key, rather than executing an already committed logical review twice.
 if(Number.isFinite(mood.nextReviewAt)){
  const frozenAt=Number.isFinite(snapshotAt)?snapshotAt:Number.isFinite(mood.anchorAt)?mood.anchorAt:at;
  projected.nextReviewAt=at+Math.max(0,mood.nextReviewAt-frozenAt);
  const oldKey=String(mood.version)+':'+String(mood.nextReviewAt),newKey=String(mood.version)+':'+String(projected.nextReviewAt),receipt=life.r95.moodReviewEvaluations?.[oldKey];
  if(receipt?.status==='committed'&&newKey!==oldKey)life.r95.moodReviewEvaluations[newKey]={...copy(receipt),rebasedFrom:oldKey};
 }
 projected.anchorAt=at;projected.rebasedAt=at;life.r95.mood=projected;
}
export function createMoodService({store,now=()=>Date.now(),generate,getEvidence=async()=>[],getActiveContext=()=>null}={}){
 const running=new Map(),tails=new Map(),controllers=new Set();let closing=false;
 function visible(feeling,scope){
  const visibility=feeling.visibility;if(!visibility?.personaId||visibility.personaId!==scope.personaId)return false;
  const channel=value=>value==='app'||value==null?'app-private':value;
  // Legacy APP-only reasons have no channel. Only their exact, nonempty APP
  // conversation can read them; missing identity never makes a reason public.
  if(visibility.channel==null)return channel(scope.channel)==='app-private'&&!!visibility.conversationId&&visibility.conversationId===scope.conversationId;
  return channel(visibility.channel)===channel(scope.channel)&&(!visibility.conversationId||visibility.conversationId===scope.conversationId);
 }
 const api={
  async evaluate({scope=getActiveContext(),eventIds,context={},reason='event'}={}){
   if(closing)return {deferred:true,reason:'closing'};
   assertSocialScope(store.state,scope);if(!Array.isArray(eventIds)||!eventIds.length||eventIds.length>100||eventIds.some(id=>typeof id!=='string'))throw socialError('MOOD_EVIDENCE_INVALID','心情评估需要实际事件');
   if(!['event','scheduled-review'].includes(reason))throw socialError('MOOD_REASON_INVALID','心情复评原因无效');
   const ids=[...new Set(eventIds)],key=JSON.stringify([scope.characterId,scope.lifeId,scope.operationId,ids,reason]);if(running.has(key))return running.get(key);
   const job=(tails.get(scope.characterId)??Promise.resolve()).catch(()=>{}).then(async()=>{if(closing)return {deferred:true,reason:'closing'};assertSocialScope(store.state,scope);const r95=store.state.lives[scope.characterId].r95??{},known=r95.moodEvaluations??{},reviewKey=reason==='scheduled-review'?String(r95.mood?.version)+':'+String(r95.mood?.nextReviewAt):null;
    if(reason==='scheduled-review'&&(!r95.mood?.nextReviewAt||r95.mood.nextReviewAt>now()))return {deferred:true,reason:'review-not-due'};
    if(reason==='scheduled-review'?r95.moodReviewEvaluations?.[reviewKey]?.status==='committed':ids.every(id=>known[id]?.status==='committed'))return {duplicate:true,mood:api.view({scope})};
    const events=await getEvidence({scope,eventIds:ids});assertSocialScope(store.state,scope);if(!Array.isArray(events)||ids.some(id=>!events.some(event=>(event.eventId??event.id)===id)))throw socialError('MOOD_EVIDENCE_INVALID','缺少当前范围的真实事件证据');
    if(typeof generate!=='function')return {deferred:true,reason:'model-unavailable'};
    const controller=new AbortController();controllers.add(controller);
    try{const current=api.view({scope}),raw=await generate({kind:'mood',reason,scope:copy(scope),events:copy(events),currentMood:current,context:copy(context),signal:controller.signal}),at=now();if(closing||controller.signal.aborted)throw socialError('MOOD_CANCELLED','心情评估已取消');assertSocialScope(store.state,scope);
     if(raw?.changed===false)return store.mutate(state=>{const life=r95LifeState(state,scope);life.moodEvaluations??={};life.moodReviewEvaluations??={};if(reason==='scheduled-review')life.moodReviewEvaluations[reviewKey]={status:'committed',unchanged:true,at};else for(const id of ids)life.moodEvaluations[id]={status:'committed',unchanged:true,at};delete life.moodFailure;return {unchanged:true};});
     const overall=normalizedFeeling(raw?.overall,ids,scope,at),feelings=(raw.feelings??[]);if(!Array.isArray(feelings)||feelings.length>50)throw socialError('MOOD_OUTPUT_INVALID','感受列表无效');
     const next={schemaVersion:1,anchorAt:at,lastEvaluatedAt:at,overall,feelings:feelings.map(row=>normalizedFeeling(row,ids,scope,at)),eventIds:ids,reviewCondition:typeof raw.reviewCondition==='string'?raw.reviewCondition.slice(0,1000):null};
     if(raw.nextReviewAt!==undefined&&raw.nextReviewAt!==null){if(!Number.isFinite(raw.nextReviewAt)||raw.nextReviewAt<=at||raw.nextReviewAt>at+MAX_RECOVERY)throw socialError('MOOD_OUTPUT_INVALID','下次心情复评时间无效');next.nextReviewAt=raw.nextReviewAt;}
     return store.mutate(state=>{const life=r95LifeState(state,scope);life.moodEvaluations??={};life.moodReviewEvaluations??={};if(reason==='scheduled-review'?life.moodReviewEvaluations[reviewKey]?.status==='committed':ids.every(id=>life.moodEvaluations[id]?.status==='committed'))return {duplicate:true};next.version=(life.mood?.version??0)+1;
      const feelingKey=row=>JSON.stringify([row.target??'',row.visibility?.personaId,row.visibility?.channel,row.visibility?.conversationId]),updated=new Set(next.feelings.map(feelingKey)),previous=projectedMood(life.mood,at);next.feelings=[...(previous?.feelings??[]).filter(row=>!updated.has(feelingKey(row))).map(row=>({...row,anchorIntensity:row.intensity})),...next.feelings];life.mood=next;
      if(reason==='scheduled-review')life.moodReviewEvaluations[reviewKey]={status:'committed',at,version:next.version};else for(const id of ids)life.moodEvaluations[id]={status:'committed',at,version:next.version};delete life.moodFailure;return {mood:copy(next)};});
    }catch(error){if(!closing)await store.mutate(state=>{const r95=r95LifeState(state,scope);r95.moodFailure={at:now(),code:error.code??'MOOD_MODEL_FAILED',message:String(error.message).slice(0,500)};}).catch(()=>{});throw error;}finally{controllers.delete(controller);}
   });running.set(key,job);tails.set(scope.characterId,job);try{return await job;}finally{running.delete(key);if(tails.get(scope.characterId)===job)tails.delete(scope.characterId);}
  },
  view({scope=getActiveContext()}={}){const life=assertSocialScope(store.state,scope),mood=projectedMood(life.r95?.mood,now());if(!mood)return {available:false,label:'平静',readOnly:true};const canSee=visible(mood.overall,scope);return {available:true,readOnly:true,version:mood.version,anchorAt:mood.anchorAt,lastEvaluatedAt:mood.lastEvaluatedAt,nextReviewAt:mood.nextReviewAt??null,overall:{...mood.overall,summary:canSee?mood.overall.summary:'',eventIds:canSee?mood.overall.eventIds:[]},feelings:mood.feelings.filter(row=>visible(row,scope)),failure:copy(life.r95?.moodFailure??null)};},
  snapshot({scope=getActiveContext()}={}){const life=assertSocialScope(store.state,scope);return projectedMood(life.r95?.mood,now());},
  rebase:rebaseMoodSnapshot,
  async close({timeoutMs=5000}={}){closing=true;for(const controller of controllers)controller.abort();let timer;try{return await Promise.race([Promise.allSettled([...running.values()]).then(()=>({settled:true})),new Promise(resolve=>{timer=setTimeout(()=>resolve({settled:false,pending:running.size}),timeoutMs);})]);}finally{clearTimeout(timer);}}
 };return api;
}
