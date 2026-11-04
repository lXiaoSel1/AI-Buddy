import {fail,clone,integer,requireId,canonical,publicPlayer} from './common.mjs';
import {createDoudizhu,reduceDoudizhu,doudizhuLegalActions,DOUDIZHU_RULE_VERSION} from './doudizhu.mjs';
import {createTexas,reduceTexas,texasLegalActions,TEXAS_RULE_VERSION} from './texas.mjs';
export * from './common.mjs';
export * from './doudizhu.mjs';
export * from './texas.mjs';
export const RULE_MANIFEST=Object.freeze({contract:'voice-games-v1',doudizhu:DOUDIZHU_RULE_VERSION,texas:TEXAS_RULE_VERSION,productionRandom:'host-crypto-fisher-yates-required',settlement:'host-economy-only',privateCheckpoint:true});
export const STANDARD_DECK=Object.freeze({doudizhu:Object.freeze(Array.from({length:54},(_,i)=>i)),texas:Object.freeze(Array.from({length:52},(_,i)=>i))});
export function createGame(spec){const type=spec.type??spec.game;return type==='doudizhu'?createDoudizhu(spec):type==='texas'?createTexas(spec):(()=>{throw fail('GAME_TYPE_INVALID','Unknown game type');})();}
export function reduceGame(state,action){
 if(!action||typeof action!=='object'||Array.isArray(action))throw fail('GAME_ACTION_INVALID','Action must be an object');const id=action.commandId??action.actionId,fingerprint=canonical(Object.fromEntries(Object.entries(action).filter(([k])=>!['expectedVersion','commandId','actionId'].includes(k))));
 if(id!==undefined){requireId(id,'command');const old=Object.hasOwn(state.actionIds??{},id)?state.actionIds[id]:undefined;if(old){if(old!==fingerprint)throw fail('GAME_COMMAND_CONFLICT','Command id reused with different content');return clone(state);}}
 if(action.expectedVersion!==undefined&&action.expectedVersion!==state.version)throw fail('GAME_VERSION_STALE','Action belongs to an old game version');
 let result;if(action.type==='pause'||action.type==='resume'){if(state.settlement)throw fail('GAME_ALREADY_SETTLED','This hand has settled');result=clone(state);result.paused=action.type==='pause';}
 else result=state.type==='doudizhu'?reduceDoudizhu(state,action):state.type==='texas'?reduceTexas(state,action):(()=>{throw fail('GAME_TYPE_INVALID','Unknown game type');})();
 result.version=integer(state.version,'version')+1;if(id)result.actionIds[id]=fingerprint;return result;
}
export function legalActions(state,actorId){return state.type==='doudizhu'?doudizhuLegalActions(state,actorId):texasLegalActions(state,actorId);}
export function projectGame(state,{actorId,channel='public'}={}){
 const own=state.players.find(p=>p.id===actorId);if(channel!=='public'&&!own)throw fail('GAME_PROJECTION_DENIED','Only a seated actor can read a private projection');
 const settlement=state.settlement?clone(state.settlement):null;if(settlement)delete settlement.handRanks;
 const value={id:state.id,handId:state.handId,type:state.type,ruleVersion:state.ruleVersion,version:state.version,phase:state.phase,paused:state.paused,actorId:state.actorId,players:state.players.map(p=>({...publicPlayer(p),handCount:state.hands[p.id].length})),history:clone(state.history),settlement};
 if(state.type==='doudizhu'){Object.assign(value,{landlordId:state.landlordId,callerId:state.callerId,publicMultiplier:state.publicMultiplier,doubles:clone(state.doubles),bottom:['doubling','playing','settled'].includes(state.phase)?[...state.bottom]:[],lastPlay:clone(state.lastPlay),dealAttempt:state.dealAttempt});}
 else Object.assign(value,{board:[...state.board],blinds:clone(state.blinds),blindPlan:{buttonSeat:state.blindPlan.buttonSeat,smallBlindSeat:state.blindPlan.smallBlindSeat,bigBlindSeat:state.blindPlan.bigBlindSeat},currentBet:state.currentBet,minRaise:state.minRaise});
 // Even after settlement normal projections remain scoped. Full cards are available only through the explicit Texas replay gate.
 if(channel!=='public'){value.ownHand=[...state.hands[actorId]];value.legalActions=legalActions(state,actorId);value.viewerId=actorId;}return value;
}
export function replayGame(state,{handId}={}){if(state.type!=='texas')throw fail('GAME_REPLAY_UNAVAILABLE','Independent Dou Dizhu replay is not in this release');if(handId!==state.handId||state.phase!=='settled'||state.settlement?.completed!==true)throw fail('GAME_REPLAY_NOT_SETTLED','Only this specific finally settled Texas hand can be reviewed');return {...projectGame(state,{channel:'public'}),allHands:clone(state.hands),knowledge:'post-settlement-review',settlement:clone(state.settlement)};}
