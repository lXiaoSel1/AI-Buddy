import {blindPlan} from './rules/texas.mjs';

// Only the next hand is adapted; admitted rules and saved hands stay unchanged.
export function nextBlindInput(previousState,players){
 const previous=previousState.blindPlan;
 if(previousState.type!=='texas'||previousState.players.length!==2||players.length<=2)return previous;
 const plan=blindPlan(players,{previous});
 const anchor=plan.smallBlindSeat??plan.smallBlindAnchor;
 const ids=new Set(players.map(player=>player.id)),ring=plan.ring.filter(id=>ids.has(id)||id===anchor),at=ring.indexOf(anchor);
 if(at<0)return previous;
 return {...structuredClone(previous),smallBlindAnchor:ring[(at+ring.length-1)%ring.length]};
}
