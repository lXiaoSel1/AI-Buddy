import {fail,clone,canonical,cardLabel} from './rules/common.mjs';
import {ddzRank} from './rules/doudizhu.mjs';
const actionKeys=new Set(['type','cards','pattern','bodyRanks','moveId','raiseTo','factor']);
export const ACTION_EMOTIONS=Object.freeze(['cheerful','shy','serious','confused','angry','frightened','exasperated','starry']);
const presentationProperties={say:{type:'string',maxLength:40},emotion:{enum:ACTION_EMOTIONS}};
const bareActions=new Set(['call-landlord','decline','rob','pass','fold','check','call']);
const safePositive=value=>Number.isSafeInteger(value)&&value>0;
const objectSchema=(type,properties={},required=[])=>({type:'object',properties:{type:{const:type},...properties,...presentationProperties},required:['type',...required],additionalProperties:false});
export function actionOutputSchema(type){return {oneOf:type==='doudizhu'?[
 ...['call-landlord','decline','rob','pass'].map(t=>objectSchema(t)),objectSchema('double',{factor:{enum:[1,2]}},['factor']),objectSchema('play',{cards:{type:'array',items:{type:'integer',minimum:0,maximum:53},minItems:1,uniqueItems:true},pattern:{type:'string'},bodyRanks:{type:'array',items:{type:'integer'}},moveId:{type:'string'}},['cards'])
 ]:[...['call','check','fold'].map(t=>objectSchema(t)),objectSchema('raise',{raiseTo:{type:'integer',minimum:1}},['raiseTo']),objectSchema('all-in',{raiseTo:{type:'integer',minimum:1}})]};}
const managementKeys=new Set(['accounts','wallet','welfare','welfareClaims','remainingClaims','debtUnits','holds','bindings','outbox','potClaims','drawIndex','burn','seed','randomSeed','actionIds']);
function rejectManagementData(value){if(!value||typeof value!=='object')return;for(const key of Object.keys(value)){if(managementKeys.has(key))throw fail('GAME_MODEL_MANAGEMENT_DATA_DENIED','Management-only information cannot enter game model requests');rejectManagementData(value[key]);}}
function scopedCards(view,{own=false,all=false}={}){
 const type=view.type;if(!['doudizhu','texas'].includes(type))throw fail('GAME_MODEL_CARD_ENCODING','A known card encoding is required');
 // Only these already-projected fields may contribute labels. Never inspect a global checkpoint.
 const lists=[view.board,view.bottom,view.lastPlay?.cards,...(view.history??[]).map(e=>e.cards)];if(own)lists.push(view.ownHand);if(all)lists.push(...Object.values(view.allHands));
 const ids=[...new Set(lists.filter(Array.isArray).flat())].sort((a,b)=>a-b),maximum=type==='doudizhu'?53:51;
 if(ids.some(id=>!Number.isInteger(id)||id<0||id>maximum))throw fail('GAME_MODEL_CARD_ENCODING','Projected cards contain an invalid ID');
 return {cardEncoding:{game:type,idRange:[0,maximum],suitsByIdModulo4:['♠','♥','♦','♣'],rankFormula:type==='doudizhu'?'IDs 0..51: floor(id/4)+3; ranks 11=J,12=Q,13=K,14=A,15=2. IDs52=小王,53=大王.':'floor(id/4)+2; ranks 11=J,12=Q,13=K,14=A.',instruction:'visibleCards maps only currently permitted card IDs to human-readable labels. Use labels when speaking; action.cards must retain the original integer IDs.'},visibleCards:Object.fromEntries(ids.map(id=>[id,cardLabel(id,type)]))};
}
export function parseActionResponse(text){
 if(typeof text!=='string'||text.length>100000)throw fail('GAME_MODEL_FORMAT','Model action must be bounded text');let value;try{value=JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g,''));}catch{throw fail('GAME_MODEL_FORMAT','Return one JSON action object');}
 if(value?.action&&typeof value.action==='object'&&Object.keys(value).length===1)value=value.action;
 if(!value||typeof value!=='object'||Array.isArray(value))throw fail('GAME_MODEL_FORMAT','Action contains unsupported fields');
 const {say,emotion,...action}=value;
 if(typeof action.type!=='string'||Object.keys(action).some(k=>!actionKeys.has(k)))throw fail('GAME_MODEL_FORMAT','Action contains unsupported fields');
 value=action;
 const keys=Object.keys(value);let valid=false;if(bareActions.has(value.type))valid=keys.length===1;
 else if(value.type==='raise')valid=keys.length===2&&safePositive(value.raiseTo);
 else if(value.type==='all-in')valid=keys.every(k=>['type','raiseTo'].includes(k))&&(value.raiseTo===undefined||safePositive(value.raiseTo));
 else if(value.type==='double')valid=keys.length===2&&[1,2].includes(value.factor);
 else if(value.type==='play')valid=keys.every(k=>['type','cards','pattern','bodyRanks','moveId'].includes(k))&&Array.isArray(value.cards)&&value.cards.length>0&&new Set(value.cards).size===value.cards.length&&value.cards.every(c=>Number.isInteger(c)&&c>=0&&c<54)&&(value.pattern===undefined||typeof value.pattern==='string')&&(value.moveId===undefined||typeof value.moveId==='string')&&(value.bodyRanks===undefined||Array.isArray(value.bodyRanks)&&value.bodyRanks.every(Number.isSafeInteger));
 if(!valid)throw fail('GAME_MODEL_FORMAT','Return exactly the action fields required by the output schema; amount/minRaiseTo/maxRaiseTo describe legal ranges only');const speech=typeof say==='string'?say.trim():'';
 return {action:clone(value),...(speech&&[...speech].length<=40&&!/[\p{Cc}\p{Cf}]/u.test(speech)?{say:speech}:{}),...(ACTION_EMOTIONS.includes(emotion)?{emotion}:{})};
}
export function parseActionProposal(text){return parseActionResponse(text).action;}
const playCommand=({cards,pattern,bodyRanks,moveId})=>({type:'play',cards,...pattern!==undefined&&{pattern},...bodyRanks!==undefined&&{bodyRanks},...moveId!==undefined&&{moveId}});
function decisionFacts({type,phase,players=[],actorId,landlordId,history=[],lastPlay,currentBet,blindPlan,ownHand,legalActions=[]}){
 const actor=players.find(p=>p.id===actorId);
 const others=players.filter(p=>p.id!==actorId);
 if(type==='doudizhu'){
  const side=id=>!landlordId||!['doubling','playing','settled'].includes(phase)?'undecided':id===landlordId?'landlord':'farmer';
  const role=side(actorId),lastActor=lastPlay?history.findLast(event=>Array.isArray(event.cards))?.actorId:null;
  return {role,winningGoal:'地主先出完即地主获胜；任一农民先出完即全体农民获胜。',
   teammates:others.filter(p=>role==='farmer'&&side(p.id)==='farmer').map(p=>p.id),
   opponents:others.filter(p=>role!=='undecided'&&side(p.id)!==role).map(p=>p.id),
   remainingCards:Object.fromEntries(players.map(p=>[p.id,p.handCount])),
   lastPlay:lastActor?{actorId:lastActor,side:lastActor===actorId?'self':side(lastActor)===role?'teammate':'opponent'}:null,
   immediateWins:legalActions.filter(a=>a.type==='play'&&a.cards.length===ownHand.length).map(playCommand)};
 }
 const pot=players.reduce((sum,p)=>sum+(p.committed??0),0),toCall=Math.max(0,(currentBet??0)-(actor?.streetCommitted??0));
 const callAmount=legalActions.find(a=>a.type==='call')?.amount??0;
 return {pot,toCall,callAmount,potOdds:callAmount?callAmount/(pot+callAmount):null,
  position:{actorSeat:actor?.seat??players.findIndex(p=>p.id===actorId),...blindPlan},
  effectiveStacks:Object.fromEntries(others.filter(p=>!p.folded&&!p.left).map(p=>[p.id,Math.min(actor?.stack??0,p.stack??0)]))};
}
function legalExamples(actions){
 const examples={},playRank=a=>Math.max(...a.cards.map(ddzRank));
 for(const action of actions){
  const {type}=action,key=type==='all-in'?'allIn':type;
  if(type==='play'){
   const prior=examples.play;
   if(!prior||action.cards.length<prior.cards.length||action.cards.length===prior.cards.length&&playRank(action)<playRank(prior))examples.play=playCommand(action);
  }else if(!Object.hasOwn(examples,key))examples[key]=type==='raise'?{type,raiseTo:action.minRaiseTo}:type==='double'?{type,factor:action.factor}:{type};
 }
 return examples;
}
export function actionPrompt({projection,character={},memories=[],strategyAssistance=false,correction=null}={}){
 if(!projection?.viewerId||projection.viewerId!==projection.actorId||!Array.isArray(projection.ownHand)||'allHands'in projection||'hands'in projection||'deck'in projection)throw fail('GAME_MODEL_PROJECTION_DENIED','A current private actor projection is required');
 rejectManagementData(projection);rejectManagementData(character);rejectManagementData(memories);
 const {legalActions,...view}=projection;
 // These objects are already actor-scoped by the host. Never pass a global checkpoint into this function.
 const ddz=projection.type==='doudizhu';
 const system=['在合法动作中以赢牌为首要目标。性格影响打法和台词，最终每次行动由你决定。','只返回一个JSON动作；不要输出思维过程、工具调用或工作命令。','只能使用提供的本人牌和公开事实，不能假定看到了对手隐藏牌。','可在同一个动作对象里附加 emotion（从 outputSchema 选）和 say（最多 40 字）。say 是全桌可见的角色台词，不想说就省略，不必每步都说。不要说自己或他人的底牌、具体点数、花色或内部牌号；可以说加油、惊叹或轻松接话。台词不是动作。',`游戏规则版本：${projection.ruleVersion}。`,ddz?'按本方的胜利条件决策。队友领先时，过牌可以保留队友的牌权；对手余牌少时，评估能否拦截。考虑一手走完的合法动作，以及拆牌或用大牌对后续的影响。':'以赢手和长期筹码收益作决策。合理弃牌也是策略，无需为表现积极而跟注。potOdds 以公开总底池估算，存在边池时须考虑可争夺的部分。raiseTo 是本街累计总额。',strategyAssistance?(ddz?'先按阵营和公开余牌数判断紧迫性，再比较保留牌型、让队友领出和争夺牌权的利弊。':'先看位置、公开下注和有效筹码，再用待跟金额与底池赔率比较弃牌、跟注和加注。'):'',correction?'上次提案不合法，请根据同一牌局、同一绑定模型纠正。':''].filter(Boolean).join('\n');
 const examples=legalExamples(legalActions??[]);
 const formatInstruction=projection.type==='texas'?'call/check/fold仅返回type；raise仅type和raiseTo；all-in优先只返回type。amount/minRaiseTo/maxRaiseTo仅是合法范围说明，不可复制到输出。':'每种叫抢/过牌仅返回type；double返回type与factor；play返回实际cards，可附pattern和bodyRanks。';
 return {system:system+'\n按cardEncoding与visibleCards理解牌面；cards输出保留原始整数ID。严格遵守outputSchema。'+formatInstruction+'示例只说明输出格式，say 与 emotion 是可选的附加字段，可选行为仍由当前legalActions决定。',messages:[{role:'user',content:JSON.stringify({character,knownMemories:memories,table:view,legalActions,decisionContext:decisionFacts(projection),...scopedCards(projection,{own:true}),outputSchema:actionOutputSchema(projection.type),outputExamples:examples,actionSchema:{allowedKeys:[...actionKeys,'say','emotion'],note:'Each action must match its exact outputSchema variant. Examples show format only; choose an action currently permitted by legalActions. amount/minRaiseTo/maxRaiseTo are explanations, never output fields; raiseTo is the final total on this street.'},correction:correction?{code:correction.code,message:correction.message,previousProposal:correction.previousProposal}:undefined})}],purpose:'card-game-action',tools:[],strategyAssistance};
}
export function publicChatPrompt({projection,character={},text,history=[]}={}){if(!projection||'ownHand'in projection||'allHands'in projection||'hands'in projection||'deck'in projection)throw fail('GAME_CHAT_PROJECTION_DENIED','Table chat accepts only a public projection');rejectManagementData(projection);rejectManagementData(character);if(typeof text!=='string'||!text.trim()||text.length>20000)throw fail('GAME_CHAT_INVALID','Chat text required');return {system:'你在公开牌桌聊天。只使用公开桌面与真实可知事实，不披露隐藏手牌或私有决策过程，不执行任何工作或开发工具。聊天不构成下注或出牌命令。按cardEncoding理解牌面，向用户谈牌时使用visibleCards中的牌名，不朗读内部整数ID。',messages:[{role:'user',content:JSON.stringify({character,publicTable:projection,...scopedCards(projection),history,text})}],purpose:'card-game-public-chat',tools:[]};}
export function reviewPrompt({replay,character={},question='请复盘这手牌'}={}){if(replay?.type!=='texas'||replay.phase!=='settled'||replay.settlement?.completed!==true||replay.knowledge!=='post-settlement-review'||!replay.allHands||'deck'in replay||'hands'in replay||'ownHand'in replay)throw fail('GAME_REPLAY_PROJECTION_DENIED','Finalized Texas replay required');rejectManagementData(replay);rejectManagementData(character);return {system:'你正在按需复盘已经最终结算的指定德州手牌，可以看全部底牌。这些是事后才获知的信息，不能倒写当时判断，不修改行动、资金或关系奖励，不读取另一手。按cardEncoding和visibleCards理解指定手牌，向用户使用牌名。只返回可向用户展示的分析，不输出私有思维过程。',messages:[{role:'user',content:JSON.stringify({character,hand:replay,...scopedCards(replay,{all:true}),question})}],purpose:'card-game-review',tools:[]};}
export function sameProposal(a,b){return canonical(a)===canonical(b);}
