import {randomUUID} from 'node:crypto';
import {FOODS,foodById} from './food-catalog.mjs';
import {createEconomyStore,feedingScope} from './companion-economy-store.mjs';

const copy=value=>structuredClone(value);
const fail=(message,code)=>Object.assign(Error(message),{code});
const same=(a,b)=>!!a&&!!b&&['characterId','personaId','lifeId','operationId'].every(k=>a[k]===b[k]);
// Engineering validation, not a product-defined fixed reward per portion.
export const MAX_MEAL_AFFECTION=5;

export function createFeedingService({dataRoot,now=Date.now,monotonicNow=()=>performance.now(),assertScope=()=>{},evaluateMeal=null,settleAffection=null,chooseFood=null,canEatFood=()=>true,mealConversation=()=>null,onAttention=null,onExperience=null,onState=null,onSleepIntent=async()=>{},requestTimeoutMs=60000,store=createEconomyStore(dataRoot,{now})}={}){
 if(!Number.isFinite(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>600000)throw Error('进食请求超时设置无效');
 let current=null,anchor=null,sleeping=false,paused=true,closed=false,epoch=0,autoPromise=null;
 const controllers=new Set(),mealPromises=new Map(),diagnostics=[];
 const report=error=>{diagnostics.push({at:now(),message:String(error?.message??error).slice(0,1000)});if(diagnostics.length>10)diagnostics.shift();};
 function checkScope(scope){feedingScope(scope);const result=assertScope(copy(scope));if(result&&typeof result.then==='function')throw Error('assertScope 必须同步核验人生令牌');if(result===false)throw fail('角色人生上下文已经失效','FEEDING_STALE_SCOPE');}
 function checkActive(scope,generation=epoch){if(closed||paused||generation!==epoch||!same(current,scope))throw fail('当前角色或进食活动已经变化','FEEDING_NOT_CURRENT');checkScope(scope);}
 function view(){const value=store.view(current);return {...value,meals:value.meals.filter(meal=>same(meal.scope,current)),catalog:FOODS.map(copy),activeScope:current?copy(current):null,paused,sleeping,diagnostics:copy(diagnostics),ledgerTotal:store.ledgerPage({pageSize:1}).total};}
 function changed(){if(typeof onState!=='function')return;try{onState(view());}catch(error){report(error);}}
 function settle(){
  const time=monotonicNow();if(!Number.isFinite(time))throw Error('饥饿计时器无效');
  if(current&&!paused&&anchor!==null){const elapsed=Math.max(0,time-anchor);if(elapsed)store.settleHunger(current,{elapsedMs:elapsed,sleeping});}
  anchor=paused?null:time;
 }
 function invalidate(){epoch++;for(const controller of controllers)controller.abort();}
 function boundedCall(fn,value,controller){
  return new Promise((resolve,reject)=>{
   let done=false;const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);controller.signal.removeEventListener('abort',abort);error?reject(error):resolve(result);},abort=()=>finish(fail('进食评估已经取消','FEEDING_EVALUATION_CANCELLED'));
   const timer=setTimeout(()=>{finish(fail('进食评估超时，可稍后补结算','FEEDING_EVALUATION_TIMEOUT'));controller.abort();},requestTimeoutMs);
   controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted){abort();return;}
   Promise.resolve().then(()=>fn(value)).then(result=>finish(null,result),error=>finish(error));
  });
 }
 function activeScope(scope,options={}){
  settle();invalidate();
  if(scope===null){current=null;paused=true;anchor=null;changed();return view();}
  const next=feedingScope(scope);checkScope(next);store.ensureScope(next);current=next;sleeping=options.sleeping===true;paused=false;anchor=monotonicNow();changed();return view();
 }
 function pause(reason='paused'){if(closed)return;settle();paused=true;anchor=null;invalidate();changed();return {paused:true,reason};}
 function resume(options={}){if(closed)throw Error('投喂服务已经关闭');if(current){checkScope(current);store.ensureScope(current);}paused=false;anchor=monotonicNow();if(typeof options.sleeping==='boolean')sleeping=options.sleeping;changed();return view();}
 async function allowed(scope,food){const value=await canEatFood({scope:copy(scope),food:copy(food)});return value===true;}
 async function processMeal(mealId,{force=false}={}){
  if(mealPromises.has(mealId))return mealPromises.get(mealId);
  const run=(async()=>{
   let meal=store.getMeal(mealId);if(!meal)throw Error('进食事件不存在');
   if(meal.affectionState==='cancelled')return meal;
   const controller=new AbortController();controllers.add(controller);
   try{
    checkScope(meal.scope);
    const hasWork=!meal.attentionDone&&onAttention||!meal.experienceDone&&onExperience||meal.affectionState!=='settled'&&evaluateMeal&&settleAffection;
    if(!hasWork||!force&&(meal.attempts>=3||meal.retryAt!=null&&meal.retryAt>now()))return meal;
    meal=store.updateMeal(meal.id,{attempts:meal.attempts+1,retryAt:null});
    if(!meal.attentionDone&&onAttention){await boundedCall(onAttention,{eventId:'feeding:'+meal.id+':attention',scope:copy(meal.scope),kind:'manual-feeding',occurredAt:meal.at,signal:controller.signal},controller);meal=store.updateMeal(meal.id,{attentionDone:true});}
    if(!meal.experienceDone&&onExperience){await boundedCall(onExperience,{eventId:'feeding:'+meal.id+':experience',scope:copy(meal.scope),kind:'feeding',status:'completed',conversationId:meal.conversationId,occurredAt:meal.at,foodId:meal.foodId,automatic:meal.automatic,before:meal.before,after:meal.after,signal:controller.signal},controller);meal=store.updateMeal(meal.id,{experienceDone:true});}
    if(meal.affectionState==='settled'||!evaluateMeal||!settleAffection)return meal;
    if(!meal.assessment){
     const result=await boundedCall(evaluateMeal,{scope:copy(meal.scope),meal:copy(meal),food:copy(foodById(meal.foodId)),signal:controller.signal,automatic:meal.automatic},controller);
     if(controller.signal.aborted)throw fail('进食情感评估已中断','FEEDING_EVALUATION_CANCELLED');checkScope(meal.scope);
     const manualEquivalentAffection=result?.manualEquivalentAffection;
     if(!Number.isFinite(manualEquivalentAffection)||manualEquivalentAffection<0||manualEquivalentAffection>MAX_MEAL_AFFECTION)throw fail('投喂好感评估不在有效范围','FEEDING_INVALID_AFFECTION');
     const assessment={manualEquivalentAffection,amount:manualEquivalentAffection*(meal.automatic?.5:1),reason:typeof result.reason==='string'?result.reason.slice(0,2000):''};meal=store.updateMeal(meal.id,{assessment});
    }
    if(controller.signal.aborted)throw fail('进食情感结算已中断','FEEDING_EVALUATION_CANCELLED');checkScope(meal.scope);
    const receipt=await boundedCall(settleAffection,{scope:copy(meal.scope),eventId:'feeding:'+meal.id+':relationship',mealId:meal.id,amount:meal.assessment.amount,manualEquivalentAffection:meal.assessment.manualEquivalentAffection,automatic:meal.automatic,signal:controller.signal},controller);
    checkScope(meal.scope);meal=store.updateMeal(meal.id,{affectionState:'settled',settledAt:now(),retryAt:null,error:null,...receipt?.eventId?{relationshipEventId:receipt.eventId}:{}});
   }catch(error){
    let stale=false;try{checkScope(meal.scope);}catch{stale=true;}
    const retryAt=now()+[1000,10000,60000][Math.min(2,Math.max(0,meal.attempts-1))];meal=store.updateMeal(meal.id,{affectionState:stale?'cancelled':'pending',error:String(error?.message??error).slice(0,1000),retryAt:stale?null:retryAt});report(error);
   }finally{controllers.delete(controller);changed();}
   return meal;
  })();mealPromises.set(mealId,run);try{return await run;}finally{mealPromises.delete(mealId);}
 }
 async function feed(foodId,requestId,{automatic=false,sessionId=null,generation=epoch,scope=current,purchaseRice=false}={}){
  checkActive(scope,generation);const food=foodById(foodId);if(!await allowed(scope,food))throw fail('角色的饮食限制不允许该食物','FOOD_DIETARY_RESTRICTION');checkActive(scope,generation);settle();
  const conversationId=mealConversation(scope);const result=purchaseRice?store.purchaseAndConsumeRice({scope:copy(scope),requestId,sessionId,conversationId}):store.consume({scope:copy(scope),foodId,requestId,automatic,sessionId,conversationId});changed();
  if(result.newlyConsumed)await processMeal(result.meal.id);
  return {...result,...result.meal?{meal:store.getMeal(result.meal.id)}:{}};
 }
 function retryFingerprint(state){const d=new Date(now());return JSON.stringify({scope:current,settings:state.settings,inventory:state.inventory,balance:state.wallet.balance,day:[d.getFullYear(),d.getMonth(),d.getDate()]});}
 async function auto({force=false}={}){
  if(autoPromise)return autoPromise;
  const run=(async()=>{
   if(!current||paused||closed)return {state:'blocked',reason:'no-active-character'};
   settle();const scope=copy(current),generation=epoch,prefs=store.settings();if(!prefs.autoEat)return {state:'blocked',reason:'auto-disabled'};
   let session=store.autoSession(scope),satiety=store.getHunger(scope).satiety;
   if(!session&&satiety>20)return {state:'idle',reason:'not-hungry'};
   if(session?.state==='blocked'&&!force&&session.blockFingerprint===retryFingerprint(store.view(scope)))return session;
   session??={id:'auto-meal-'+randomUUID(),scope,state:'active',step:0,at:now(),goal:70};store.saveAuto(session);
   let temporarySleep=false;
   try{
    for(let safety=0;safety<16;safety++){
     checkActive(scope,generation);const state=store.view(scope),currentPrefs=state.settings;satiety=state.hunger.satiety;
     if(satiety>=session.goal){session={...session,state:'completed',reason:null};store.saveAuto(session);return session;}
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
     const mealId=session.id+':'+session.step+':eat';await feed(foodId,mealId,{automatic:true,sessionId:session.id,generation,scope,purchaseRice});session={...session,step:session.step+1,state:'active',reason:null};store.saveAuto(session);
    }
    throw fail('本餐已暂停，等待核对进度','AUTO_MEAL_SAFETY_PAUSE');
   }catch(error){session={...session,state:'blocked',reason:error.code??'AUTO_MEAL_FAILED',error:String(error.message).slice(0,1000),blockFingerprint:retryFingerprint(store.view(scope))};store.saveAuto(session);return session;}
   finally{if(temporarySleep)try{await onSleepIntent({kind:'temporary-feeding-end',scope:copy(scope),sessionId:session.id,generation,resumeOriginalSleep:same(current,scope)&&generation===epoch,state:session.state});}catch(error){report(error);}changed();}
  })();autoPromise=run;try{return await run;}finally{autoPromise=null;}
 }
 async function tick(options={}){
  if(closed)return;settle();if(typeof options.sleeping==='boolean')sleeping=options.sleeping;
  // No model polling: retry only an actual, due, unfinished meal of this scope.
  if(current&&!paused){const pending=store.pendingMeals(current)[0];if(pending)await processMeal(pending.id);if(store.settings().autoEat&&options.auto!==false)await auto();}
  changed();return view();
 }
 async function action(name,args={}){
  if(closed)throw Error('投喂服务已经关闭');
  if(name==='view')return view();
  if(name==='settings'){const result=store.settings(args.patch??args);if(!result.autoEat)invalidate();changed();return view();}
  if(name==='buy'){const scope=copy(current);checkActive(scope);const result=store.purchase({...args,packages:args.packages??args.quantity??1,scope,automatic:false});changed();return result;}
  if(name==='feed')return feed(args.foodId,args.requestId);
  if(name==='auto')return auto({force:true});
  if(name==='ledger')return store.ledgerPage(args);
  if(name==='retry-meal'){const meal=store.getMeal(args.mealId);if(!meal)throw Error('进食事件不存在');if(!same(current,meal.scope))throw fail('请切换到进食时的角色、身份和人生后重试','FEEDING_MEAL_SCOPE_MISMATCH');checkScope(meal.scope);return processMeal(meal.id,{force:true});}
  throw fail('未知投喂操作','FEEDING_ACTION_UNKNOWN');
 }
 const lifeBridge={
  async quiesce(scope){const wasCurrent=current?.characterId===scope?.characterId;if(wasCurrent)pause('life-quiesce');const pending=[...mealPromises.entries()].filter(([mealId])=>store.getMeal(mealId)?.scope.characterId===scope?.characterId).map(([,promise])=>promise);await Promise.allSettled([...pending,...(wasCurrent&&autoPromise?[autoPromise]:[])]);return {quiesced:true,pending:store.view().meals.filter(meal=>meal.scope.characterId===scope?.characterId&&meal.affectionState==='pending').map(meal=>meal.id)};},
  snapshot(scope){if(current&&['characterId','lifeId','operationId'].every(key=>current[key]===scope?.[key]))settle();checkScope(scope);return store.snapshot(scope);},
  prepare(value){if(current?.characterId===value.scope?.characterId){settle();pause('life-transaction');}return store.prepareLife(value);},
  apply:value=>store.applyLife(value),finalize:value=>store.finalizeLife(value),recover:value=>store.recoverLife(value),
  pending:()=>store.view().pendingLifeTransactions,
 };
 // Life projection leaves runtime paused until the coordinator rebinds the
 // committed scope. No prepared cross-store transaction permits feeding.
 return {view,action,activeScope,pause,resume,tick,lifeBridge,gameEconomy:store.games,ingestUsageFact(raw,options){const result=store.ingestUsageFact(raw,options);changed();return result;},ingestUsageFacts(facts,options){const results=store.ingestUsageFacts(facts,options);if(results.length)changed();return results;},initializeRewards(value){const result=store.initializeRewards(value);changed();return result;},async close(){if(closed)return;pause('close');closed=true;invalidate();await Promise.allSettled([...mealPromises.values(),...(autoPromise?[autoPromise]:[])]);store.close();}};
}
