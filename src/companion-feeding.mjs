import {randomUUID} from 'node:crypto';
import {FOODS,foodById} from './food-catalog.mjs';
import {feedingScope} from './companion-economy-store.mjs';
import {createEconomyStore} from './companion-economy-worker-client.mjs';

const copy=value=>structuredClone(value);
const fail=(message,code)=>Object.assign(Error(message),{code});
const modelDisabled=()=>fail('联网聊天关闭','R95_MODEL_DISABLED');
const same=(a,b)=>!!a&&!!b&&['characterId','personaId','lifeId','operationId'].every(k=>a[k]===b[k]);
// Engineering validation, not a product-defined fixed reward per portion.
export const MAX_MEAL_AFFECTION=5;
const HUNGER_SAVE_INTERVAL=5*60*1000;

export function createFeedingService({dataRoot,now=Date.now,monotonicNow=()=>performance.now(),assertScope=()=>{},rollbackPending=()=>false,evaluateMeal=null,canEvaluateMeal=()=>true,settleAffection=null,chooseFood=null,canEatFood=()=>true,mealConversation=()=>null,onAttention=null,onExperience=null,onState=null,onSleepIntent=async()=>{},requestTimeoutMs=60000,audit,store}={}){
 if(!Number.isFinite(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>600000)throw Error('进食请求超时设置无效');
 const ready=store?Promise.resolve():createEconomyStore(dataRoot,{now,audit}).then(opened=>{store=opened;});
 let current=null,clock=null,flushTimer,sleeping=false,paused=true,closed=false,epoch=0,lifecycleVersion=0,autoPromise=null,closePromise;
 let hungerTail=ready;
 let mealTail=Promise.resolve();
 const controllers=new Set(),mealPromises=new Map(),frozenClocks=new Set(),diagnostics=[];
 const modelAvailable=()=>canEvaluateMeal()!==false;
 const offlineWork={attention:!!onAttention,experience:!!onExperience,settlement:!!(evaluateMeal&&settleAffection)};
 const report=error=>{diagnostics.push({at:now(),message:String(error?.message??error).slice(0,1000)});if(diagnostics.length>10)diagnostics.shift();};
 function checkScope(scope){feedingScope(scope);const result=assertScope(copy(scope));if(result&&typeof result.then==='function')throw fail('assertScope 必须同步核验人生令牌','FEEDING_SCOPE_GUARD_ASYNC');if(result===false)throw fail('角色人生上下文已经失效','FEEDING_STALE_SCOPE');}
 const checkRollback=scope=>{if(scope&&rollbackPending(scope))throw fail('人生经济回退待恢复，投喂暂缓','FEEDING_ROLLBACK_PENDING');};
 function checkActive(scope,generation=epoch){checkRollback(scope);if(closed||paused||generation!==epoch||!same(current,scope))throw fail('当前角色或进食活动已经变化','FEEDING_NOT_CURRENT');checkScope(scope);}
 function projectedHunger(hunger,elapsed=clock){
  if(!elapsed||!hunger)return hunger;
  // A read connection can see a commit before its ACK arrives. Keep the
  // pre-write value through that interval so the fragment is subtracted once.
  const base=elapsed.inFlight?.base??hunger;
  return {...base,satiety:Math.max(0,base.satiety-elapsed.pendingDecay),updatedAt:elapsed.updatedAt??base.updatedAt};
 }
 function view(){const value=store.view(current);return {...value,hunger:projectedHunger(value.hunger),meals:value.meals.filter(meal=>same(meal.scope,current)),catalog:FOODS.map(copy),activeScope:current?copy(current):null,paused,sleeping,modelAvailable:modelAvailable(),diagnostics:copy(diagnostics),ledgerTotal:store.ledgerPage({pageSize:1}).total};}
 function changed(){if(typeof onState!=='function')return;try{onState(view());}catch(error){report(error);}}
 function clockTime(){const time=monotonicNow();if(!Number.isFinite(time))throw Error('饥饿计时器无效');return time;}
 function settle(){
  if(!clock||clock.anchor===null)return;
  const time=clockTime(),elapsed=time-clock.anchor;
  if(elapsed<=0)return;
  clock.pendingDecay+=elapsed/3600000*(sleeping?2:8);
  clock.anchor=time;clock.through=time;clock.updatedAt=now();
 }
 function queueHunger(work){
  const task=hungerTail.then(async()=>{await ready;return work();});
  hungerTail=task.catch(()=>{});
  return task;
 }
 function fragmentFor(elapsed){
  if(!elapsed?.pendingDecay)return null;
  return {hunger:{requestId:'hunger-'+randomUUID(),decay:elapsed.pendingDecay},at:elapsed.updatedAt,through:elapsed.through};
 }
 async function writeFragment(elapsed,fragment,write,wasApplied){
  if(!fragment)return write();
  elapsed.inFlight={base:store.getHunger(elapsed.scope,{create:false})};
  try{
   const result=await write(fragment);
   if(wasApplied(result)){
    elapsed.pendingDecay-=fragment.hunger.decay;
    elapsed.lastFlush=fragment.through;
    if(!elapsed.pendingDecay)elapsed.updatedAt=null;
   }
   return result;
  }finally{elapsed.inFlight=null;}
 }
 async function merge(elapsed,fragment){
  if(!fragment)return;
  elapsed.retry=fragment;
  await writeFragment(elapsed,fragment,({hunger,at})=>store.mergeHunger(elapsed.scope,{...hunger,at}),()=>true);
  elapsed.retry=null;
 }
 async function flush(elapsed){
  if(!elapsed)return;
  if(elapsed.retry)await merge(elapsed,elapsed.retry);
  await merge(elapsed,fragmentFor(elapsed));
 }
 async function flushFrozen(){
  for(const elapsed of frozenClocks){
   try{await flush(elapsed);}
   catch(error){
    if(error?.code!=='FEEDING_STALE_SCOPE')throw error;
    elapsed.pendingDecay=0;elapsed.retry=null;elapsed.updatedAt=null;
    try{audit?.({type:'feeding-hunger-discarded',scope:copy(elapsed.scope),code:error.code});}catch{}
   }
   frozenClocks.delete(elapsed);
  }
 }
 function flushIfDue(elapsed){
  if(!elapsed||elapsed.anchor===null||elapsed.through-elapsed.lastFlush<HUNGER_SAVE_INTERVAL)return;
  return queueHunger(async()=>{if(elapsed.through-elapsed.lastFlush>=HUNGER_SAVE_INTERVAL)await flush(elapsed);});
 }
 function scheduleFlush(elapsed,retryDelay=0){
  const delay=Math.max(1,retryDelay,HUNGER_SAVE_INTERVAL-(clockTime()-elapsed.lastFlush));
  flushTimer=setTimeout(async()=>{
   let failed=false;
   try{settle();await flushIfDue(elapsed);}
   catch(error){report(error);if(error?.code==='ECONOMY_WORKER_REOPEN')return;failed=true;}
   if(clock===elapsed&&elapsed.anchor!==null)scheduleFlush(elapsed,failed?1000:0);
  },delay);
  flushTimer.unref();
 }
 function invalidate(){epoch++;for(const controller of controllers)controller.abort();}
 function boundedCall(fn,value,controller){
  return new Promise((resolve,reject)=>{
   let done=false;const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);controller.signal.removeEventListener('abort',abort);error?reject(error):resolve(result);},abort=()=>finish(fail('进食评估已经取消','FEEDING_EVALUATION_CANCELLED'));
   const timer=setTimeout(()=>{finish(fail('进食评估超时，可稍后补结算','FEEDING_EVALUATION_TIMEOUT'));controller.abort();},requestTimeoutMs);
   controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted){abort();return;}
   Promise.resolve().then(()=>{controller.signal.throwIfAborted();return fn(value);}).then(result=>finish(null,result),error=>finish(error));
  });
 }
 function activeScope(scope,options={}){
  if(closed)throw Error('投喂服务已经关闭');
  const next=scope===null?null:feedingScope(scope);
  if(!options.allowPending)checkRollback(next);
  if(next)checkScope(next);
  freeze();const version=lifecycleVersion;
  current=next;clock=null;
  return queueHunger(async()=>{
   await flushFrozen();
   if(version!==lifecycleVersion)return view();
   if(!options.allowPending)checkRollback(next);
   if(next)await activate(next,version,options.sleeping===true);
   changed();return view();
  });
 }
 function freeze(){
  settle();paused=true;
  if(clock){clock.anchor=null;frozenClocks.add(clock);}
  clearTimeout(flushTimer);
  lifecycleVersion++;invalidate();
  return clock;
 }
 async function activate(scope,version,nextSleeping){
  const guard=()=>{if(version!==lifecycleVersion)throw fail('当前角色或进食活动已经变化','FEEDING_NOT_CURRENT');checkScope(scope);};
  try{guard();await store.ensureScope(scope,{guard});}catch(error){if(version!==lifecycleVersion)return;throw error;}
  if(version!==lifecycleVersion)return;
  const time=clockTime();
  clock={scope,anchor:time,through:time,lastFlush:time,pendingDecay:0,updatedAt:null,inFlight:null,retry:null};
  sleeping=nextSleeping;paused=false;
  scheduleFlush(clock);
 }
 function pause(reason='paused'){
  if(closed)return Promise.resolve();
  freeze();
  return queueHunger(async()=>{await flushFrozen();changed();return {paused:true,reason};});
 }
 function resume(options={}){
  if(closed)throw Error('投喂服务已经关闭');
  freeze();const scope=current,version=lifecycleVersion,nextSleeping=options.sleeping??sleeping;
  return queueHunger(async()=>{await flushFrozen();if(version===lifecycleVersion&&scope)await activate(scope,version,nextSleeping);changed();return view();});
 }
 async function allowed(scope,food){const value=await canEatFood({scope:copy(scope),food:copy(food)});return value===true;}
 async function processMeal(mealId,{force=false,generation=epoch}={}){
  if(mealPromises.has(mealId))return mealPromises.get(mealId);
  const run=mealTail.then(async()=>{
   let meal=store.getMeal(mealId);if(!meal)throw fail('进食事件不存在','FEEDING_MEAL_NOT_FOUND');
   if(meal.affectionState==='cancelled')return meal;
   if(generation!==epoch&&!force)return meal;
   checkActive(meal.scope,generation);
   const available=modelAvailable();
   if(force&&!available)throw modelDisabled();
   const needsAttention=!meal.attentionDone&&onAttention,needsExperience=!meal.experienceDone&&onExperience;
   const needsSettlement=meal.affectionState!=='settled'&&offlineWork.settlement,needsModel=needsSettlement&&!meal.assessment;
   if(!(needsAttention||needsExperience||needsSettlement&&(!needsModel||available))||!force&&(meal.attempts>=3||meal.retryAt!=null&&meal.retryAt>now()))return meal;
   const controller=new AbortController();controllers.add(controller);
   const guard=()=>{controller.signal.throwIfAborted();checkActive(meal.scope,generation);};
   const update=patch=>{guard();return store.updateMeal(meal.id,patch,{guard});};
   const originalAttempts=meal.attempts,originalRetryAt=meal.retryAt??null;
   let counted=false,localAttempted=false,evaluating=false;
   const countAttempt=async()=>{meal=await update({attempts:originalAttempts+1,retryAt:null});counted=true;};
   try{
    if(available||!needsModel)await countAttempt();
    if(needsAttention){guard();localAttempted=true;await boundedCall(onAttention,{eventId:'feeding:'+meal.id+':attention',scope:copy(meal.scope),kind:'manual-feeding',occurredAt:meal.at,signal:controller.signal},controller);meal=await update({attentionDone:true});}
    if(needsExperience){guard();localAttempted=true;await boundedCall(onExperience,{eventId:'feeding:'+meal.id+':experience',scope:copy(meal.scope),kind:'feeding',status:'completed',conversationId:meal.conversationId,occurredAt:meal.at,foodId:meal.foodId,automatic:meal.automatic,before:meal.before,after:meal.after,signal:controller.signal},controller);meal=await update({experienceDone:true});}
    if(!needsSettlement)return meal;
    if(needsModel){
     evaluating=true;
     if(!modelAvailable())throw modelDisabled();
     if(!counted)await countAttempt();
     const result=await boundedCall(value=>{if(!modelAvailable())throw modelDisabled();return evaluateMeal(value);},{scope:copy(meal.scope),meal:copy(meal),food:copy(foodById(meal.foodId)),signal:controller.signal,automatic:meal.automatic},controller);
     evaluating=false;
     if(controller.signal.aborted)throw fail('进食情感评估已中断','FEEDING_EVALUATION_CANCELLED');checkScope(meal.scope);
     const manualEquivalentAffection=result?.manualEquivalentAffection;
     if(!Number.isFinite(manualEquivalentAffection)||manualEquivalentAffection<0||manualEquivalentAffection>MAX_MEAL_AFFECTION)throw fail('投喂好感评估不在有效范围','FEEDING_INVALID_AFFECTION');
     const assessment={manualEquivalentAffection,amount:manualEquivalentAffection*(meal.automatic?.5:1),reason:typeof result.reason==='string'?result.reason.slice(0,2000):''};meal=await update({assessment});
    }
    if(controller.signal.aborted)throw fail('进食情感结算已中断','FEEDING_EVALUATION_CANCELLED');checkScope(meal.scope);
    const receipt=await boundedCall(settleAffection,{scope:copy(meal.scope),eventId:'feeding:'+meal.id+':relationship',mealId:meal.id,amount:meal.assessment.amount,manualEquivalentAffection:meal.assessment.manualEquivalentAffection,automatic:meal.automatic,signal:controller.signal},controller);
    meal=await update({affectionState:'settled',settledAt:now(),retryAt:null,error:null,...receipt?.eventId?{relationshipEventId:receipt.eventId}:{}});
   }catch(error){
    let stale=false;try{checkScope(meal.scope);}catch{stale=true;}
    const guard=()=>{if(!same(store.getMeal(meal.id)?.scope,meal.scope))throw fail('角色人生上下文已经失效','FEEDING_STALE_SCOPE');};
    const disabled=evaluating&&error?.code==='R95_MODEL_DISABLED';
    if(disabled&&!stale){
     // Preserve a genuine earlier failure and its cooldown if the user forced a retry.
     if(counted)meal=await store.updateMeal(meal.id,{attempts:originalAttempts,retryAt:originalRetryAt},{guard});
     if(force)throw error;
     return meal;
    }
    const attempts=originalAttempts+Number(!disabled&&(counted||localAttempted));
    const retryAt=now()+[1000,10000,60000][Math.min(2,Math.max(0,attempts-1))];
    meal=await store.updateMeal(meal.id,{affectionState:stale?'cancelled':'pending',attempts,error:String(error?.message??error).slice(0,1000),retryAt:stale?null:retryAt},{guard});
    report(error);
   }finally{controllers.delete(controller);changed();}
   return meal;
  });mealTail=run.catch(()=>{});mealPromises.set(mealId,run);try{return await run;}finally{mealPromises.delete(mealId);}
 }
 async function feed(foodId,requestId,{automatic=false,sessionId=null,generation=epoch,scope=current,purchaseRice=false}={}){
  const guard=()=>checkActive(scope,generation);
  guard();const food=foodById(foodId);if(!await allowed(scope,food))throw fail('角色的饮食限制不允许该食物','FOOD_DIETARY_RESTRICTION');guard();
  const result=await queueHunger(async()=>{
   guard();const elapsed=clock;
   if(elapsed.retry)await merge(elapsed,elapsed.retry);
   guard();settle();
   const fragment=fragmentFor(elapsed),conversationId=mealConversation(scope);
   const write=part=>{
    const request={scope:copy(scope),requestId,sessionId,conversationId,...part&&{hunger:part.hunger,at:now()}};
    return purchaseRice?store.purchaseAndConsumeRice(request,{guard}):store.consume({...request,foodId,automatic},{guard});
   };
   return writeFragment(elapsed,fragment,write,value=>value.hungerRequestId===fragment.hunger.requestId);
  });
  changed();
  if(result.consumed&&!closed&&!paused&&generation===epoch&&same(current,scope)&&(result.newlyConsumed||store.getMeal(result.meal.id)?.attempts===0))await processMeal(result.meal.id);
  return {...result,...result.meal?{meal:store.getMeal(result.meal.id)}:{}};
 }
 function retryFingerprint(state){const d=new Date(now());return JSON.stringify({scope:current,settings:state.settings,inventory:state.inventory,balance:state.wallet.balance,day:[d.getFullYear(),d.getMonth(),d.getDate()]});}
 async function auto({force=false}={}){
  if(autoPromise)return autoPromise;
  const run=(async()=>{
   if(!current||paused||closed)return {state:'blocked',reason:'no-active-character'};
   settle();const scope=copy(current),generation=epoch,prefs=store.settings();if(!prefs.autoEat)return {state:'blocked',reason:'auto-disabled'};
   const guard=()=>checkActive(scope,generation);
   let session=store.autoSession(scope),satiety=projectedHunger(store.getHunger(scope,{create:false})).satiety;
   if(!session&&satiety>20)return {state:'idle',reason:'not-hungry'};
   if(session?.state==='blocked'&&!force&&session.blockFingerprint===retryFingerprint(store.view(scope)))return session;
   session??={id:'auto-meal-'+randomUUID(),scope,state:'active',step:0,at:now(),goal:70};await store.saveAuto(session,{guard});
   let temporarySleep=false;
   try{
    for(let safety=0;safety<16;safety++){
     guard();settle();const state=store.view(scope),currentPrefs=state.settings;satiety=projectedHunger(state.hunger).satiety;
     if(satiety>=session.goal){session={...session,state:'completed',reason:null};await store.saveAuto(session,{guard});return session;}
     if(!currentPrefs.autoEat)throw fail('自动进食授权已撤销','AUTO_FOOD_NOT_ALLOWED');
     const candidates=[];for(const foodId of currentPrefs.allowedFoods){const food=foodById(foodId);if((state.inventory[foodId]??0)>0&&await allowed(scope,food))candidates.push(foodId);}
     checkActive(scope,generation);let foodId,purchaseRice=false;
     if(candidates.includes('rice'))foodId='rice';
     else if(candidates.length){
      if(!chooseFood)throw fail('等待当前角色选择允许库存中的食物','AUTO_FOOD_CHOICE_UNAVAILABLE');
      const controller=new AbortController();controllers.add(controller);let choice;try{choice=await boundedCall(chooseFood,{scope:copy(scope),foodIds:[...candidates],foods:candidates.map(foodById).map(copy),signal:controller.signal},controller);}finally{controllers.delete(controller);}checkActive(scope,generation);
      foodId=typeof choice==='string'?choice:choice?.foodId;if(!candidates.includes(foodId))throw fail('角色未选择有效的允许食物','AUTO_FOOD_CHOICE_INVALID');
     }else{
      if(!currentPrefs.autoBuyRice||!currentPrefs.allowedFoods.includes('rice')||!await allowed(scope,foodById('rice')))throw fail('没有可吃库存或补买米饭授权','AUTO_NO_FOOD');
      checkActive(scope,generation);foodId='rice';purchaseRice=true;
     }
     checkActive(scope,generation);
     if(!temporarySleep&&sleeping){await onSleepIntent({kind:'temporary-feeding-start',scope:copy(scope),sessionId:session.id,generation});temporarySleep=true;checkActive(scope,generation);}
     const mealId=session.id+':'+session.step+':eat';await feed(foodId,mealId,{automatic:true,sessionId:session.id,generation,scope,purchaseRice});session={...session,step:session.step+1,state:'active',reason:null};await store.saveAuto(session,{guard});
    }
    throw fail('本餐已暂停，等待核对进度','AUTO_MEAL_SAFETY_PAUSE');
   }catch(error){
    session={...session,state:'blocked',reason:error.code??'AUTO_MEAL_FAILED',error:String(error.message).slice(0,1000),blockFingerprint:retryFingerprint(store.view(scope))};
    const guard=()=>checkScope(scope);
    guard();await store.saveAuto(session,{guard});
    return session;
   }
   finally{if(temporarySleep)try{await onSleepIntent({kind:'temporary-feeding-end',scope:copy(scope),sessionId:session.id,generation,resumeOriginalSleep:same(current,scope)&&generation===epoch,state:session.state});}catch(error){report(error);}changed();}
  })();autoPromise=run;try{return await run;}finally{autoPromise=null;}
 }
 async function tick(options={}){
  if(closed)return;settle();if(typeof options.sleeping==='boolean')sleeping=options.sleeping;
  await ready;
  if(current&&rollbackPending(current))return view();
  await flushIfDue(clock);
  // No model polling: retry only an actual, due, unfinished meal of this scope.
  if(current&&!paused){
   if(!mealPromises.size){
    const pending=store.pendingMeals(current,modelAvailable()?undefined:{offlineWork})[0];
    if(pending)await processMeal(pending.id);
   }
   if(store.settings().autoEat&&options.auto!==false)await auto();
  }
  changed();return view();
 }
 async function action(name,args={}){
  if(closed)throw Error('投喂服务已经关闭');
  await ready;
  if(name==='view')return view();
  if(['buy','feed','auto','retry-meal'].includes(name))checkRollback(current??args?.scope);
  if(name==='settings'){const result=await store.settings(args.patch??args);if(!result.autoEat)invalidate();changed();return view();}
  if(name==='buy'){const scope=copy(current),generation=epoch,guard=()=>checkActive(scope,generation);guard();const result=await store.purchase({...args,packages:args.packages??args.quantity??1,scope,automatic:false},{guard});changed();return result;}
  if(name==='feed')return feed(args.foodId,args.requestId);
  if(name==='auto')return auto({force:true});
  if(name==='ledger')return store.ledgerPage(args);
  if(name==='retry-meal'){const meal=store.getMeal(args.mealId);if(!meal)throw fail('进食事件不存在','FEEDING_MEAL_NOT_FOUND');if(!same(current,meal.scope))throw fail('请切换到进食时的角色、身份和人生后重试','FEEDING_MEAL_SCOPE_MISMATCH');if(!modelAvailable())throw modelDisabled();return processMeal(meal.id,{force:true});}
  throw fail('未知投喂操作','FEEDING_ACTION_UNKNOWN');
 }
 const lifeBridge={
  async quiesce(scope){
   const wasCurrent=current?.characterId===scope?.characterId,pausedWrite=wasCurrent?pause('life-quiesce'):null;
   const pending=[...mealPromises.entries()].filter(([mealId])=>store.getMeal(mealId)?.scope.characterId===scope?.characterId).map(([,promise])=>promise);
   await Promise.allSettled([pausedWrite,...pending,...(wasCurrent&&autoPromise?[autoPromise]:[])]);
   await pausedWrite;
   return {quiesced:true,pending:store.view().meals.filter(meal=>meal.scope.characterId===scope?.characterId&&meal.affectionState==='pending').map(meal=>meal.id)};
  },
  snapshot(scope){
   checkRollback(scope);
   const elapsed=current&&['characterId','lifeId','operationId'].every(key=>current[key]===scope?.[key])?clock:null;
   if(elapsed)settle();
   return queueHunger(async()=>{checkScope(scope);await flushFrozen();await flush(elapsed);checkScope(scope);return store.snapshot(scope);});
  },
  prepare(value){
   const elapsed=current?.characterId===value.scope?.characterId?freeze():null;
   return queueHunger(async()=>{await flushFrozen();const result=await store.prepareLife(value);if(elapsed)changed();return result;});
  },
  apply:value=>queueHunger(()=>store.applyLife(value)),finalize:value=>queueHunger(()=>store.finalizeLife(value)),recover:value=>queueHunger(()=>store.recoverLife(value)),
  rebindRollback:value=>queueHunger(()=>store.rebindPendingMeals(value)),
  pending:()=>store.view().pendingLifeTransactions,
 };
 // Life projection leaves runtime paused until the coordinator rebinds the
 // committed scope. No prepared cross-store transaction permits feeding.
 return {ready,view,action,activeScope,pause,resume,tick,lifeBridge,get gameEconomy(){return store?.games;},isRewardFactRecorded:fact=>store.isRewardFactRecorded(fact),
  async ingestUsageFact(raw,options,admission){await ready;const result=await store.ingestUsageFact(raw,options,admission);changed();return result;},
  async ingestUsageFacts(facts,options,admission){await ready;const results=await store.ingestUsageFacts(facts,options,admission);if(results.length)changed();return results;},
  async initializeRewards(value){await ready;const result=await store.initializeRewards(value);changed();return result;},
  close(){
   if(closePromise)return closePromise;
   let pausedWrite;
   try{pausedWrite=pause('close');}catch(error){pausedWrite=Promise.reject(error);clearTimeout(flushTimer);paused=true;invalidate();}
   closed=true;
   closePromise=(async()=>{
    const [pauseResult]=await Promise.allSettled([pausedWrite,...mealPromises.values(),...(autoPromise?[autoPromise]:[])]);
    const [closeResult]=await Promise.allSettled([Promise.resolve().then(()=>store?.close())]);
    const errors=[pauseResult,closeResult].filter(result=>result.status==='rejected').map(result=>result.reason);
    if(errors.length===1)throw errors[0];
    if(errors.length)throw new AggregateError(errors,'投喂服务关闭失败');
   })();
   return closePromise;
  }};
}
