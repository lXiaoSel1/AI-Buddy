import {fail,clone,canonical,cardLabel} from './rules/common.mjs';
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
export function actionPrompt({projection,character={},memories=[],strategyAssistance=false,correction=null}={}){
 if(!projection?.viewerId||projection.viewerId!==projection.actorId||!Array.isArray(projection.ownHand)||'allHands'in projection||'hands'in projection||'deck'in projection)throw fail('GAME_MODEL_PROJECTION_DENIED','A current private actor projection is required');
 rejectManagementData(projection);rejectManagementData(character);rejectManagementData(memories);
 const {legalActions,...view}=projection;
 // These objects are already actor-scoped by the host. Never pass a global checkpoint into this function.
 const system=['你正在作为当前角色参加正式积分牌局。性格影响策略，但最终每次行动都由你决定。','只返回一个JSON动作；不要输出思维过程、工具调用或工作命令。','不得推断自己看到了对手隐藏牌；只能使用提供的本人牌和公开事实。','可在同一个动作对象里附加 emotion（从 outputSchema 选）和 say（最多 40 字）。say 是全桌可见的角色台词，不想说就省略，不必每步都说。不要说自己或他人的底牌、具体点数、花色或内部牌号；可以说加油、惊叹或轻松接话。台词不是动作。','合法但策略较差的选择也会被执行。程序不会替你随机、机器人或强制超时代打。',`游戏规则版本：${projection.ruleVersion}。`,projection.type==='doudizhu'?'叫地主/抢地主/普通加倍/出牌均按合法动作。出牌可直接复制某个合法动作对象，或给出type=play、cards、pattern、bodyRanks。':'下注raiseTo为本街累计总额，只能使用当前真实桌上筹码。',strategyAssistance?'可先按角色性格在内部比较位置、公开行动、底池与实际筹码；仍由你选择最后动作，不假定任何隐藏信息。':'独立选择合法动作。',correction?'上次提案不合法，请根据同一牌局、同一绑定模型纠正；不需要改变角色或模型。':''].filter(Boolean).join('\n');
 const examples=projection.type==='texas'?{call:{type:'call'},check:{type:'check'},fold:{type:'fold'},raise:{type:'raise',raiseTo:legalActions?.find(a=>a.type==='raise')?.minRaiseTo??projection.blinds?.big??2},allIn:{type:'all-in'}}:{call:{type:'call-landlord'},decline:{type:'decline'},rob:{type:'rob'},double:{type:'double',factor:2},pass:{type:'pass'},play:{type:'play',cards:projection.ownHand.slice(0,1)}};
 const formatInstruction=projection.type==='texas'?'call/check/fold仅返回type；raise仅type和raiseTo；all-in优先只返回type。amount/minRaiseTo/maxRaiseTo仅是合法范围说明，不可复制到输出。':'每种叫抢/过牌仅返回type；double返回type与factor；play返回实际cards，可附pattern和bodyRanks。';
 return {system:system+'\n按cardEncoding与visibleCards理解牌面；cards输出保留原始整数ID。严格遵守outputSchema。'+formatInstruction+'示例只说明输出格式，say 与 emotion 是可选的附加字段，可选行为仍由当前legalActions决定。',messages:[{role:'user',content:JSON.stringify({character,knownMemories:memories,table:view,legalActions,...scopedCards(projection,{own:true}),outputSchema:actionOutputSchema(projection.type),outputExamples:examples,actionSchema:{allowedKeys:[...actionKeys,'say','emotion'],note:'Each action must match its exact outputSchema variant. Examples show format only; choose an action currently permitted by legalActions. amount/minRaiseTo/maxRaiseTo are explanations, never output fields; raiseTo is the final total on this street.'},correction:correction?{code:correction.code,message:correction.message,previousProposal:correction.previousProposal}:undefined})}],purpose:'card-game-action',tools:[],strategyAssistance};
}
export function publicChatPrompt({projection,character={},text,history=[]}={}){if(!projection||'ownHand'in projection||'allHands'in projection||'hands'in projection||'deck'in projection)throw fail('GAME_CHAT_PROJECTION_DENIED','Table chat accepts only a public projection');rejectManagementData(projection);rejectManagementData(character);if(typeof text!=='string'||!text.trim()||text.length>20000)throw fail('GAME_CHAT_INVALID','Chat text required');return {system:'你在公开牌桌聊天。只使用公开桌面与真实可知事实，不披露隐藏手牌或私有决策过程，不执行任何工作或开发工具。聊天不构成下注或出牌命令。按cardEncoding理解牌面，向用户谈牌时使用visibleCards中的牌名，不朗读内部整数ID。',messages:[{role:'user',content:JSON.stringify({character,publicTable:projection,...scopedCards(projection),history,text})}],purpose:'card-game-public-chat',tools:[]};}
export function reviewPrompt({replay,character={},question='请复盘这手牌'}={}){if(replay?.type!=='texas'||replay.phase!=='settled'||replay.settlement?.completed!==true||replay.knowledge!=='post-settlement-review'||!replay.allHands||'deck'in replay||'hands'in replay||'ownHand'in replay)throw fail('GAME_REPLAY_PROJECTION_DENIED','Finalized Texas replay required');rejectManagementData(replay);rejectManagementData(character);return {system:'你正在按需复盘已经最终结算的指定德州手牌，可以看全部底牌。这些是事后才获知的信息，不能倒写当时判断，不修改行动、资金或关系奖励，不读取另一手。按cardEncoding和visibleCards理解指定手牌，向用户使用牌名。只返回可向用户展示的分析，不输出私有思维过程。',messages:[{role:'user',content:JSON.stringify({character,hand:replay,...scopedCards(replay,{all:true}),question})}],purpose:'card-game-review',tools:[]};}
export function sameProposal(a,b){return canonical(a)===canonical(b);}
