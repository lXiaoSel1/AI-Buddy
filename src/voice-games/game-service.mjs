import {createHash,randomUUID} from 'node:crypto';
import {actionPrompt,parseActionResponse,publicChatPrompt,reviewPrompt} from './prompts.mjs';
import {createGameModelBindings} from './model-bindings.mjs';
import {settledHands,settledShowdown} from './game-presentation.mjs';
import {committedCardSpeechFacts,committedTableChatFact} from '../voice/card-speech-facts.mjs';
import {CARD_SPEECH_DISPLAY_WAIT_MS} from '../voice/card-speech.mjs';
import {voiceSpeechText} from '../voice/speech-text.mjs';
const copy=v=>structuredClone(v),digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=(code,message=code)=>Object.assign(Error(message),{code});
const allowedActionKeys=new Set(['type','cards','raiseTo','factor','pattern','bodyRanks','moveId']);
const modelCancelled=()=>fail('GAME_MODEL_CANCELLED');
const moveMethod='games.table.action',leaveMethod='games.table.leave';
/** This service is composed by Core, never created by a page or a tool-enabled agent. */
export function createCardGameService({getGame,getProvider,now=Date.now,onCommittedSpeech=null,onSpeechPresentation=null,onSpeechError=()=>{}}){
 let economy,models,rules,ruleHash,closed=false,closing=false,closePromise;
 const running=new Map(),auxiliary=new Map(),faults=new Map();
 const speechScopes=new Map(),speechKey=(tableId,handId)=>JSON.stringify([tableId,handId]);
 const tableIdentities=new Map();
 function announce(facts){
  if(typeof onCommittedSpeech!=='function')return;
  for(const fact of facts.filter(Boolean)){
   let row;
   if(fact.eventId&&fact.scope&&(['allin','trips','triple'].includes(fact.kind)||voiceSpeechText(fact.text??''))){
    const key=speechKey(fact.scope.tableId,fact.scope.handId);
    let rows=speechScopes.get(key);if(!rows){rows=new Map();speechScopes.set(key,rows);if(speechScopes.size>128)speechScopes.delete(speechScopes.keys().next().value);}
    if(rows.has(fact.eventId))continue;
    // Register before yielding: view/chat responses cannot escape through the
    // asynchronous host admission window with uncorrelated visible text.
    row={eventId:fact.eventId,deadlineAt:now()+CARD_SPEECH_DISPLAY_WAIT_MS,admission:'pending'};rows.set(fact.eventId,row);
    while(rows.size>256)rows.delete(rows.keys().next().value);
   }
   const request=row?{...fact,deadlineAt:row.deadlineAt}:fact;
   void Promise.resolve().then(()=>onCommittedSpeech(request)).then(result=>{if(row)row.admission=result?.accepted===true||result?.duplicate===true?'accepted':'fallback';}).catch(error=>{if(row)row.admission='fallback';try{onSpeechError(error);}catch{}});
  }
 }
 async function speechPresentation(t){
  if(typeof onSpeechPresentation!=='function')return null;
  const rows=speechScopes.get(speechKey(t.id,t.state.handId)),records=rows?[...rows.values()]:[];
  let remote;try{remote=await onSpeechPresentation({tableId:t.id,handId:t.state.handId,eventIds:records.map(row=>row.eventId)});}catch{remote={available:false};}
  const current=new Map((remote?.records??[]).map(row=>[row.eventId,row]));
  return {version:1,tableId:t.id,handId:t.state.handId,records:records.map(row=>{
   if(!row.state||row.state==='waiting'){
    const observed=current.get(row.eventId)?.state;
    row.state=observed==='display'?'display':observed==='fallback'||row.admission==='fallback'||remote?.available===false||now()>=row.deadlineAt?'fallback':'waiting';
   }
   return {eventId:row.eventId,state:row.state,deadlineAt:row.deadlineAt};
  })};
 }
 function ready(){if(closed||closing)throw fail('GAME_SERVICE_CLOSED');const live=getGame()?.gameEconomy;if(!live)throw fail('GAME_ECONOMY_UNAVAILABLE');if(!rules)throw fail('GAME_RULES_UNAVAILABLE');if(economy!==live){tableIdentities.clear();economy=live;economy.registerRules({...rules,versions:rules.RULE_MANIFEST,deck:type=>rules.STANDARD_DECK[type],sourceHash:ruleHash});economy.recover();models=createGameModelBindings({economy,getProvider,getContext:scope=>getGame().gameContext(scope),now});}return economy;}
 function persona(){return getGame().context().personaId;}
 function authorizedTable(t){if(t.players.find(p=>p.kind==='user')?.personaId!==persona())throw fail('GAME_PERSONA_DENIED');for(const p of t.players.filter(p=>p.kind!=='user')){const current=getGame().pluginScope(p.characterId,p.personaId);for(const k of ['lifeId','operationId'])if(current[k]!==p[k])throw fail('GAME_LIFE_CHANGED');}return t;}
 function table(id){
  const t=authorizedTable(ready().table(id));
  // Cache only identities and the hand. Chat/cards are never retained here.
  tableIdentities.set(t.id,{id:t.id,type:t.type,version:t.version,status:t.status,state:{handId:t.state.handId},players:t.players.map(player=>Object.fromEntries(['id','kind','characterId','personaId','lifeId','operationId'].filter(key=>Object.hasOwn(player,key)).map(key=>[key,player[key]])))});
  if(tableIdentities.size>128)tableIdentities.delete(tableIdentities.keys().next().value);
  return t;
 }
 function tableIdentity(id){
  const live=ready();if(typeof live.tableMetadata!=='function')return table(id);
  // Every poll re-reads persisted columns. A mutation/recovery refreshes the
  // bounded snapshot once; chat-only writes leave its identity/hand unchanged.
  const metadata=live.tableMetadata(id),snapshot=tableIdentities.get(id);
  if(!snapshot||['type','version','status'].some(key=>snapshot[key]!==metadata[key]))return table(id);
  return authorizedTable(snapshot);
 }
 function voiceScopeValid(scope){
  try{
   if(scope?.channel!=='card-table')return false;
   const current=table(scope.tableId);
   if(!['active','completed'].includes(current.status)||current.state.handId!==scope.handId)return false;
   return current.players.some(player=>player.kind==='ai'&&['characterId','personaId','lifeId','operationId'].every(key=>player[key]===scope[key]));
  }catch{return false;}
 }
 function characters({includeEntry=false}={}){
  const pid=includeEntry?persona():null;
  return getGame().viewState().characters.filter(p=>!p.draft).map(p=>({id:p.id,label:p.name,...includeEntry&&{entry:economy.entryEligibility(getGame().pluginScope(p.id,pid))}}));
 }
 function lobby(){
  const game=getGame(),{characterId=null,personaId}=game.context();
  const scope=characterId&&game.hasCharacter(characterId)?game.pluginScope(characterId,personaId):null;
  const progress=type=>{const {completed,remainder,next}=economy.relationshipProgress(type,scope);return {completed,remainder,next};};
  return {tables:economy.list().filter(t=>t.players.find(p=>p.kind==='user')?.personaId===personaId).map(t=>({tableId:t.id,type:t.type,status:t.status,version:t.version,hand:t.hand,characterIds:t.players.flatMap(p=>p.characterId?[p.characterId]:[])})),
   charactersAvailable:characters({includeEntry:true}),currentCharacterId:characterId,
   currentCharacterProgress:scope?{doudizhu:progress('doudizhu'),texas:progress('texas')}:null,wallet:economy.account('user')};
 }
 function pendingTurn(t){
  const row=running.get(t.id);
  return t.status==='active'&&row?.expectedVersion===t.version?row:null;
 }
 const bindingIdFor=(t,p,handId=t.state.handId)=>t.bindings?.[handId+':'+p.id]??handId+':'+p.id;
 function bindingRevoked(t){if(t.status!=='paused')return false;for(const p of t.players.filter(row=>row.kind!=='user'))try{models.assert(bindingIdFor(t,p));}catch(error){if(['GAME_BINDING_REVOKED','GAME_BINDING_MISSING'].includes(error.code))return true;throw error;}return false;}
 function view(t){
  const user=t.players.find(p=>p.kind==='user'),turn=pendingTurn(t)?.turn,fault=faults.get(t.id);
  const topups={},remainingHands=settledHands(t.state);
  if(t.type==='texas'&&t.status==='completed')for(const p of t.players){
   const stack=t.state.settlement?.endingStacks?.[p.id];
   const amount=Number.isSafeInteger(stack)?economy.tableHold(t.id,p)-stack:0;
   if(amount>0)topups[p.id]=amount;
  }
  return {tableId:t.id,version:t.version,status:t.status,type:t.type,hand:t.hand,userSeatId:user.id,leaveAfter:t.leaveAfter===true,currentCharacterId:getGame().context().characterId??null,pendingSeats:t.pendingSeats?.map(({id,kind,characterId})=>({id,kind,characterId}))??null,topups,
   modelTurn:turn?copy(turn):null,bindingRecovery:bindingRevoked(t),
   modelStatus:t.status==='paused'&&fault?.version===t.version?copy(fault.status):null,
   presentation:{...copy(t.presentation??{emotions:{},lastSpeech:null,events:[]}),showdown:settledShowdown(t.state),...remainingHands&&{remainingHands}},relationshipProgress:Object.fromEntries(t.players.filter(p=>p.kind==='ai'&&economy.relationshipProgress).map(p=>[p.id,economy.relationshipProgress(t.type,p,t.state.handId)])),actorKind:t.players.find(p=>p.id===t.state.actorId)?.kind??null,projection:ready().project(t,{actorId:user.id,channel:'user'}),accounts:t.players.map(p=>({playerId:p.id,...economy.account(p)})),history:copy(t.history),charactersAvailable:characters(),pendingAiAiFacts:economy.pendingRelationshipFacts().filter(f=>f.tableId===t.id).length,outboxPending:economy.outbox().filter(o=>t.history.includes(o.handId)).length};
 }
 function resolvePlayers(selected){if(!Array.isArray(selected)||selected.filter(p=>p.kind==='user').length!==1||new Set(selected.filter(p=>p.kind!=='user').map(p=>p.characterId)).size!==selected.filter(p=>p.kind!=='user').length)throw fail('GAME_PLAYERS_INVALID');const pid=persona();return selected.map(p=>{if(p.kind==='user')return {id:'user',kind:'user',personaId:pid};if(!p.characterId||!getGame().hasCharacter(p.characterId))throw fail('GAME_CHARACTER_MISSING');const scope=getGame().pluginScope(p.characterId,pid);return {id:'ai-'+p.characterId,kind:'ai',...Object.fromEntries(['characterId','personaId','lifeId','operationId'].map(k=>[k,scope[k]]))};});}
 async function prepareBindings(players,handId){const values=[];for(const p of players.filter(p=>p.kind!=='user')){const context=await getGame().gameContext(p);values.push(models.prepare({id:handId+':'+p.id,scope:p,modelBinding:context.modelBinding}));}return values;}
 async function flushOutbox(){ready();for(const fact of economy.outbox()){try{const ack=await getGame().recordGameFact(fact);economy.acknowledge(fact.id,ack);}catch(error){if(['GAME_LIFE_CHANGED','COMPANION_STALE_LIFE'].includes(error.code))continue;/* Retain pending facts, never fabricate delivery. */}}}
 function checkVersion(t,v){if(t.version!==v)throw fail('GAME_STALE_VERSION');}
 function mutationIntent(t,method,payload){
  const {tableId,expectedVersion,commandId}=payload??{};
  if(tableId!==t.id||!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw fail('GAME_COMMAND_RECEIPT_INVALID');
  if(method===moveMethod){
   const proposed=payload.action;
   if(!proposed||typeof proposed!=='object'||Array.isArray(proposed)||proposed.type==='leave'||
    proposed.actorId&&proposed.actorId!=='user'||Object.keys(proposed).some(k=>k!=='actorId'&&!allowedActionKeys.has(k)))throw fail('GAME_USER_ACTION_DENIED');
   const action={...proposed,actorId:'user'},canonical=Object.fromEntries(Object.keys(action).sort().map(k=>[k,action[k]]));
   return {action,body:{op:moveMethod,tableId,expectedVersion,action:canonical},legacy:[{op:'action',tableId,expectedVersion,action}]};
  }
  if(method!==leaveMethod)throw fail('GAME_COMMAND_RECEIPT_INVALID');
  const {afterHand=false,immediate=false,voidHand=false,confirmed=false}=payload;
  if(typeof afterHand!=='boolean'||typeof immediate!=='boolean'||typeof voidHand!=='boolean'||typeof confirmed!=='boolean'||afterHand&&immediate)throw fail('GAME_COMMAND_RECEIPT_INVALID');
  if(voidHand)return {body:{op:leaveMethod,tableId,expectedVersion,voidHand,confirmed},legacy:[]};
  const legacy=afterHand?[{op:'leave-after',tableId,expectedVersion}]:[
   {op:'close',tableId,expectedVersion},
   t.type==='doudizhu'?{op:'leave-after',tableId,expectedVersion}:{op:'action',tableId,expectedVersion,action:{type:'leave',actorId:'user'}},
  ];
  return {body:{op:leaveMethod,tableId,expectedVersion,afterHand,immediate},legacy};
 }
 function receiptFor(t,method,payload,intent=mutationIntent(t,method,payload)){
  const {commandId}=payload,value=economy.commandReceipt(commandId,intent.body,...intent.legacy);
  if(!value)return {commandId,status:'not-found'};
  if(value.id!==t.id||!Number.isSafeInteger(value.version))throw fail('GAME_COMMAND_CONFLICT');
  return {commandId,status:'applied',appliedVersion:value.version};
 }
 function cancel(t,requestId){
  const turn=pendingTurn(t),other=auxiliary.get(requestId);
  const row=turn?.turn.requestId===requestId&&turn?turn:other?.tableId===t.id?other:null;
  if(!row||row.committing||row.controller.signal.aborted)return {cancelRequested:false};
  row.controller.abort(modelCancelled());
  return {cancelRequested:true};
 }
 async function runAuxiliary(t,requestId,signal,work,receiptKey){
  if(typeof requestId!=='string'||!requestId||requestId.length>300)throw fail('GAME_INVALID_ID');
  if(auxiliary.has(requestId)||running.get(t.id)?.turn.requestId===requestId)throw fail('GAME_REQUEST_CONFLICT');
  const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const row={tableId:t.id,controller,receiptKey,committing:false,task:Promise.resolve().then(()=>work(combined,()=>{row.committing=true;}))};
  auxiliary.set(requestId,row);
  try{return await row.task;}finally{if(auxiliary.get(requestId)===row)auxiliary.delete(requestId);}
 }
 async function chatSend(t,payload,options){
  const priorMessage=t.chat.find(m=>m.id===payload.submissionId),selectedId=payload.characterId??priorMessage?.scope?.replyCharacterId??t.players.find(p=>p.id===t.state.actorId&&p.kind!=='user')?.characterId??t.players.find(p=>p.kind!=='user')?.characterId,p=t.players.find(p=>p.characterId===selectedId);if(!p)throw fail('GAME_CHAT_PARTICIPANT_REQUIRED');
  const receipt=economy.chat({...payload,scope:{personaId:persona(),replyCharacterId:selectedId}}),baseId=payload.submissionId+':reply',receiptKey=digest([t.id,payload.submissionId,p.id]);let requestId=baseId;
  const chatStatus=id=>{
   const value=models.status(id);
   if(!value)return null;
   if(value.purpose==='card-game-public-chat'&&value.receiptKey===receiptKey)return value;
   const publicMessage=t.chat.find(m=>m.id===id&&m.role==='assistant'&&m.source!=='game-action'&&m.characterId===p.characterId);
   if(!value.purpose&&value.state==='completed'&&publicMessage)return {state:'completed',result:{text:publicMessage.text}};
   throw fail('GAME_CHAT_REPLY_SCOPE_DENIED');
  };
  if(payload.retryAssistant){const old=chatStatus(baseId);if(old&&!['failed','cancelled','interrupted'].includes(old.state))return {...receipt,messages:copy(economy.table(t.id).chat),assistant:{status:old.state==='completed'?'completed':'waiting',requestId:baseId,retryAllowed:false}};if(typeof payload.replyRequestId!=='string'||!payload.replyRequestId||payload.replyRequestId===baseId)throw fail('GAME_CHAT_RETRY_ID_REQUIRED');requestId=payload.replyRequestId;}
  const known=chatStatus(requestId);if(known?.state==='completed'){options.checkSync?.();table(t.id);economy.appendChat({tableId:t.id,id:requestId,characterId:p.characterId,text:known.result.text});announce([committedTableChatFact(t,p,{id:requestId,text:known.result.text})]);return {...receipt,messages:copy(economy.table(t.id).chat),assistant:{status:'completed',text:known.result.text,characterId:p.characterId,requestId,retryAllowed:false}};}if(known&&['queued','submitted'].includes(known.state))return {...receipt,messages:copy(economy.table(t.id).chat),assistant:{status:'waiting',characterId:p.characterId,requestId,retryAllowed:false}};
  const active=auxiliary.get(requestId);
  if(active){
   if(active.tableId!==t.id||active.receiptKey!==receiptKey)throw fail('GAME_CHAT_REPLY_SCOPE_DENIED');
   return {...receipt,messages:copy(economy.table(t.id).chat),assistant:{status:'waiting',characterId:p.characterId,requestId,retryAllowed:false}};
  }
  return runAuxiliary(t,requestId,options.signal,async signal=>{
   const checkHand=()=>{options.checkSync?.();signal.throwIfAborted();if(table(t.id).state.handId!==t.state.handId)throw fail('GAME_CHAT_HAND_CHANGED');};
   try{
    const context=await getGame().gameContext(p);
    checkHand();
    const prompt=publicChatPrompt({projection:economy.project(t,{channel:'public'}),character:context.character,text:payload.text,history:t.chat.filter(m=>m.source!=='game-action').slice(-20)}),bindingId=bindingIdFor(t,p);
    const result=await models.request({bindingId,requestId,receiptKey,...prompt,scope:p,guard:async()=>{await options.check?.();checkHand();},signal});
    checkHand();models.assert(bindingId);
    if(!result.text||result.text.length>200000)throw fail('GAME_CHAT_REPLY_INVALID');
    economy.appendChat({tableId:t.id,id:requestId,characterId:p.characterId,text:result.text});
    announce([committedTableChatFact(t,p,{id:requestId,text:result.text})]);
    return {...receipt,messages:copy(economy.table(t.id).chat),assistant:{status:'completed',text:result.text,characterId:p.characterId,requestId,retryAllowed:false}};
   }catch(error){
    options.checkSync?.();table(t.id);
    const state=models.status(requestId)?.state,code=typeof error?.code==='string'?error.code:'GAME_CHAT_FAILED';
    const status=signal.reason?.code==='GAME_MODEL_CANCELLED'?'cancelled':['queued','submitted'].includes(state)?'waiting':code.includes('OFFLINE')||code.includes('UNAVAILABLE')||code==='GAME_BINDING_REVOKED'?'unavailable':'failed';
    return {...receipt,messages:copy(economy.table(t.id).chat),assistant:{status,code,characterId:p.characterId,requestId,retryAllowed:!state||['failed','cancelled','interrupted'].includes(state)}};
   }
  },receiptKey);
 }
 function modelFault(t,turn,code,commandId){
  const paused=economy.control({tableId:t.id,commandId,expectedVersion:t.version,op:'pause'});
  const status={status:'needs-retry',code,actorId:turn.actorId,requestId:turn.requestId};
  if(faults.size>=128&&!faults.has(t.id))faults.delete(faults.keys().next().value);
  faults.set(t.id,{version:paused.version,status});
  return paused;
 }
 async function modelAction(payload,{signal,check=async()=>{},checkSync}){
  const t=table(payload.tableId);checkVersion(t,payload.expectedVersion);
  if(t.status!=='active')throw fail('GAME_PAUSED_OR_COMPLETED');
  const p=t.players.find(p=>p.id===t.state.actorId);
  if(!p||p.kind==='user')throw fail('GAME_AI_TURN_REQUIRED');
  if(running.has(t.id))throw fail('GAME_MODEL_BUSY');
  const requestId=payload.requestId??randomUUID();
  if(typeof requestId!=='string'||!requestId||requestId.length>280)throw fail('GAME_INVALID_ID');
  if(auxiliary.has(requestId))throw fail('GAME_REQUEST_CONFLICT');
  if(models.status(requestId+':0'))throw fail('GAME_REQUEST_ALREADY_SUBMITTED');
  const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal,started=performance.now();
  const turn={requestId,actorId:p.id,stage:'queued',attempt:1,startedAt:now()};
  const bindingId=bindingIdFor(t,p);
  const guardSync=()=>{
   checkSync?.();combined.throwIfAborted();
   const current=table(t.id);
   if(current.version!==t.version||current.status!=='active'||current.state.actorId!==p.id)throw fail('GAME_STALE_MODEL_RESULT');
  };
  const guard=async()=>{await check();guardSync();};
  const task=Promise.resolve().then(async()=>{
   await guard();
   const context=await getGame().gameContext(p);
   if(!economy.binding(bindingId))throw fail('GAME_BINDING_MISSING');
   let correction=null;
   for(let attempt=0;attempt<=2;attempt++){
    await guard();
    if(attempt)Object.assign(turn,{stage:'correcting',attempt:attempt+1});
    const prompt=actionPrompt({projection:economy.project(t,{actorId:p.id,channel:'action'}),character:context.character,memories:context.knownMemories??[],strategyAssistance:payload.strategyAssistance===true,correction});
    const result=await models.request({bindingId,requestId:requestId+':'+attempt,...prompt,scope:p,guard,signal:combined,maxTokens:8192,onSubmitted:()=>{if(!attempt)turn.stage='generating';}});
    await guard();
    let action,decoration;
    try{({action,...decoration}=parseActionResponse(result.text));if(!rules.legalActions(t.state,p.id).some(legal=>legal.type===action.type))throw fail('GAME_MODEL_ACTION_TYPE_DENIED');if(action.type==='all-in'&&action.raiseTo!==undefined&&action.raiseTo!==rules.legalActions(t.state,p.id).find(a=>a.type==='all-in')?.raiseTo)throw fail('GAME_ALLIN_AMOUNT_INVALID');rules.reduceGame(copy(t.state),{...action,actorId:p.id});}
    catch(error){
     correction={code:error.code??'GAME_MODEL_FORMAT',message:String(error.message).slice(0,1000),previousProposal:action??null};
     if(attempt<2)continue;
     guardSync();
     const paused=modelFault(t,turn,correction.code,requestId+':pause');
     return {...view(paused),model:{...faults.get(t.id).status,corrections:attempt,latencyMs:performance.now()-started}};
    }
    guardSync();models.assert(bindingId);
    const next=economy.action({tableId:t.id,expectedVersion:t.version,commandId:requestId+':commit',action:{...action,actorId:p.id}},decoration);
    announce(committedCardSpeechFacts(next,{...action,actorId:p.id}));
    await flushOutbox();await check();
    return {...view(table(next.id)),model:{requestId,corrections:attempt,latencyMs:performance.now()-started,status:'completed'}};
   }
  });
  running.set(t.id,{turn,controller,task,expectedVersion:t.version});faults.delete(t.id);
  try{return await task;}
  catch(error){
   if(combined.reason?.code==='GAME_MODEL_CANCELLED')throw combined.reason;
   let current;
   if(!closing)try{current=table(t.id);}catch{}
   if(current?.status==='active'&&current.version===t.version)modelFault(t,turn,typeof error?.code==='string'?error.code:'GAME_MODEL_FAILED',requestId+':fault-pause');
   throw error;
  }finally{if(running.get(t.id)?.task===task)running.delete(t.id);}
 }
 async function invokeCore(method,payload={},options={}){
  ready();await options.check?.();options.checkSync?.();
  if(method==='games.model.cancel')return cancel(table(payload.tableId),payload.requestId);
  if(method==='games.model.request')return modelAction(payload,options);
  if(method==='games.table.read'&&(payload.tableId||payload.command!==undefined)){
   const t=table(payload.tableId);
   if(payload.command===undefined)return view(t);
   const {method:original,payload:input}=payload.command??{};
   return {...view(t),commandReceipt:receiptFor(t,original,input)};
  }
  if(!['games.chat.send','games.replay.review'].includes(method))await flushOutbox();
  options.checkSync?.();if(method==='games.table.read')return lobby();
  options.checkSync?.();if(method==='games.table.create'){const players=resolvePlayers(payload.players),tableId='table-'+digest([persona(),payload.commandId]).slice(0,24),bindings=await prepareBindings(players,tableId+':1');options.checkSync?.();ready();const current=resolvePlayers(payload.players);if(digest(current)!==digest(players))throw fail('GAME_LIFE_CHANGED');for(const value of bindings)models.assertPrepared(value);const created=economy.create({...payload,tableId,players,bindings});return view(table(created.id));}
  const t=table(payload.tableId);
  if(method===moveMethod||method===leaveMethod){
   const intent=mutationIntent(t,method,payload);
   if(receiptFor(t,method,payload,intent).status==='applied')return view(t);
   if(method===leaveMethod&&pendingTurn(t))throw fail('GAME_MODEL_BUSY');
   checkVersion(t,payload.expectedVersion);
   if(method===moveMethod){
    const {action}=intent,legal=rules.legalActions(t.state,'user').find(a=>a.type===action.type);
    if(!legal)throw fail('GAME_USER_ACTION_DENIED');
    if(action.type==='all-in'&&action.raiseTo!==undefined&&action.raiseTo!==legal.raiseTo)throw fail('GAME_ALLIN_AMOUNT_INVALID');
    const next=economy.action({...payload,action},undefined,intent.body);announce(committedCardSpeechFacts(next,action));
   }else if(payload.voidHand){
    if(payload.confirmed!==true)throw fail('GAME_RECOVERY_CONFIRMATION_REQUIRED');if(!bindingRevoked(t))throw fail('GAME_BINDING_RECOVERY_DENIED');
    if([...auxiliary.values()].some(row=>row.tableId===t.id))throw fail('GAME_MODEL_BUSY');
    economy.control({...payload,op:'void-hand'},intent.body);
   }else if(t.status==='closed'){
    throw fail('GAME_PAUSED_OR_COMPLETED');
   }else if(t.status==='completed'||t.type==='doudizhu'||payload.afterHand){
    const op=t.status==='completed'?'close':'leave-after';
    economy.control({...payload,op},intent.body);
   }else{
    economy.action({...payload,action:{type:'leave',actorId:'user'}},undefined,intent.body);
   }
   await flushOutbox();options.checkSync?.();const current=table(t.id);if(method===leaveMethod)announce(committedCardSpeechFacts(current,null));return view(current);
  }
  if(method==='games.table.next'){const bindings=t.state.phase==='redeal-required'?[]:await prepareBindings(t.pendingSeats??t.players,t.id+':'+(t.hand+1));options.checkSync?.();table(t.id);for(const value of bindings)models.assertPrepared(value);const next=economy.next({...payload,bindings});announce(committedCardSpeechFacts(next,null));return view(next);}
  if(['games.table.pause','games.table.resume','games.table.seats','games.table.topup'].includes(method)){
   let recoveryBindings=[];
   if(method==='games.table.resume'){
    const body={op:'resume',tableId:t.id,expectedVersion:payload.expectedVersion,amount:payload.amount,players:payload.players,...payload.rebindCurrent&&{rebindCurrent:payload.rebindCurrent,confirmed:payload.confirmed}};
    if(economy.commandReceipt(payload.commandId,body))return view(t);
    if(payload.rebindCurrent){if(payload.confirmed!==true)throw fail('GAME_RECOVERY_CONFIRMATION_REQUIRED');if(!bindingRevoked(t))throw fail('GAME_BINDING_RECOVERY_DENIED');checkVersion(t,payload.expectedVersion);if(running.has(t.id)||[...auxiliary.values()].some(row=>row.tableId===t.id))throw fail('GAME_MODEL_BUSY');recoveryBindings=await prepareBindings(t.players,t.state.handId+':rebind:'+digest(payload.commandId).slice(0,16));options.checkSync?.();checkVersion(table(t.id),t.version);for(const value of recoveryBindings)models.assertPrepared(value);}
    else for(const p of t.players.filter(row=>row.kind!=='user'))models.assert(bindingIdFor(t,p));
   }
   if(method==='games.table.topup'){
    const {commandId,expectedVersion,amount,players}=payload;
    const prior=economy.commandReceipt(commandId,{op:'topup',tableId:t.id,expectedVersion,amount,players});
    if(prior)return view(t);
    if(pendingTurn(t))throw fail('GAME_MODEL_BUSY');
   }
   const result=economy.control({...payload,op:method.split('.').at(-1),bindings:recoveryBindings,...(method.endsWith('.seats')?{players:resolvePlayers(payload.players)}:{})});
   if(method==='games.table.pause'&&!result.duplicate&&result.status==='paused')running.get(t.id)?.controller.abort(modelCancelled());
   announce(committedCardSpeechFacts(table(result.id),null));
   return view(table(result.id));
  }
  if(method==='games.chat.read'){if(payload.handId&&!t.history.includes(payload.handId)&&payload.handId!==t.state.handId)throw fail('GAME_REPLAY_NOT_SETTLED');return economy.chatPage(t.id,{before:payload.before??null,limit:payload.limit??200,handId:payload.handId??null});}
  if(method==='games.chat.send')return chatSend(t,payload,options);
  if(method==='games.replay.read'||method==='games.replay.review'){
   if(!t.history.includes(payload.handId))throw fail('GAME_REPLAY_NOT_SETTLED');
   const state=economy.replay(payload.handId),replay=rules.replayGame(state,{handId:payload.handId});
   if(method.endsWith('.read'))return {replay};
   const p=state.players.find(p=>p.characterId===payload.characterId);
   if(!p)throw fail('GAME_REVIEW_PARTICIPANT_REQUIRED');
   return runAuxiliary(t,payload.requestId,options.signal,async(signal,beginCommit)=>{
    const checkReview=()=>{
     options.checkSync?.();signal.throwIfAborted();
     if(!table(t.id).history.includes(payload.handId))throw fail('GAME_REPLAY_NOT_SETTLED');
     const scope=getGame().pluginScope(p.characterId,p.personaId);
     if(scope.lifeId!==p.lifeId||scope.operationId!==p.operationId)throw fail('GAME_LIFE_CHANGED');
    };
    const context=await getGame().gameContext(p);checkReview();
    const prompt=reviewPrompt({replay,character:context.character,question:payload.question}),bindingId=bindingIdFor(t,p,payload.handId);
    const result=await models.request({bindingId,requestId:payload.requestId,...prompt,scope:p,guard:async()=>{await options.check?.();checkReview();},signal});
    checkReview();models.assert(bindingId);beginCommit();
    await getGame().recordGameFact({id:payload.requestId+':review',kind:'review',scope:p,handId:payload.handId,text:result.text,knowledge:'post-settlement-review'});
    return {review:{text:result.text,knowledge:'post-settlement-review',requestId:result.requestId}};
   });
  }
  throw fail('GAME_METHOD_UNAVAILABLE');
 }
 async function invoke(method,payload={},options={}){
  if(method==='games.table.read'&&payload.voiceOnly===true){
   ready();await options.check?.();options.checkSync?.();
   const t=tableIdentity(payload.tableId);
   if(typeof payload.handId!=='string'||payload.handId!==t.state.handId)throw fail('GAME_CHAT_HAND_CHANGED');
   // Same authorization and live table/life checks, without a game projection,
   // chat copy, outbox flush, or scan of other tables on the 50 ms wait path.
   const voice=await speechPresentation(t);options.checkSync?.();
   if(tableIdentity(t.id).state.handId!==payload.handId)throw fail('GAME_CHAT_HAND_CHANGED');
   return {tableId:t.id,handId:t.state.handId,presentation:{...voice&&{voice}}};
  }
  const value=await invokeCore(method,payload,options);
  const tableId=value?.tableId??(['games.chat.read','games.chat.send'].includes(method)?payload.tableId:null);
  if(!tableId||typeof onSpeechPresentation!=='function')return value;
  const t=table(tableId),voice=await speechPresentation(t);options.checkSync?.();
  if(table(tableId).state.handId!==t.state.handId)throw fail('GAME_CHAT_HAND_CHANGED');
  return {...value,...(!value.tableId?{tableId,handId:t.state.handId}:{}),presentation:{...value.presentation,voice}};
 }
  return {invoke,flushOutbox,voiceScopeValid,principalScope:()=>({personaId:persona()}),registerRuleArtifact(value){if(!value?.module||!/^[a-f0-9]{64}$/.test(value.sha256??''))throw fail('GAME_RULE_MODULE_INVALID');if(economy)economy.registerRules({...value.module,versions:value.module.RULE_MANIFEST,deck:type=>value.module.STANDARD_DECK[type],sourceHash:value.sha256});rules=value.module;ruleHash=value.sha256;return {registered:true,ruleModuleSha256:ruleHash};},describe(){let gamesReady=false;try{ready();gamesReady=true;}catch{}return {gamesReady,voiceReady:false,aiAiRelationshipReady:false,ruleModuleSha256:ruleHash??null};},async pauseAll(){const tasks=[...running.values(),...auxiliary.values()];for(const row of tasks)row.controller.abort(modelCancelled());await Promise.allSettled(tasks.map(row=>row.task));if(economy){economy.recover();for(const current of economy.list())announce(committedCardSpeechFacts(current,null));}},close(){if(closePromise)return closePromise;closing=true;closePromise=Promise.resolve().then(async()=>{await this.pauseAll();await models?.close();closed=true;});return closePromise;}};
}
