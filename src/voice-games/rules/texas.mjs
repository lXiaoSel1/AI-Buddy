import {fail,clone,validateDeck,validatePlayers,validateStateIdentity,integer,seatOf,assertTurn,nextIndex,sum,exactNumber} from './common.mjs';
export const TEXAS_RULE_VERSION='nlhe-points-dead-button-v1';
const rank=c=>Math.floor(c/4)+2,suit=c=>c%4;
function compare(a,b){for(let i=0;i<Math.max(a.length,b.length);i++){const d=(a[i]??0)-(b[i]??0);if(d)return Math.sign(d);}return 0;}
export function rankFive(cards){
 if(!Array.isArray(cards)||cards.length!==5||new Set(cards).size!==5||cards.some(c=>!Number.isInteger(c)||c<0||c>=52))throw fail('GAME_CARDS_INVALID','Five distinct standard cards required');
 const rs=cards.map(rank).sort((a,b)=>b-a),counts=new Map();for(const r of rs)counts.set(r,(counts.get(r)??0)+1);const groups=[...counts.entries()].sort((a,b)=>b[1]-a[1]||b[0]-a[0]),flush=cards.every(c=>suit(c)===suit(cards[0]));const unique=[...new Set(rs)],straight=unique.length===5&&(unique[0]-unique[4]===4?unique[0]:unique.join(',')==='14,5,4,3,2'?5:0);
 if(flush&&straight)return [8,straight];if(groups[0][1]===4)return [7,groups[0][0],groups[1][0]];if(groups[0][1]===3&&groups[1][1]===2)return [6,groups[0][0],groups[1][0]];if(flush)return [5,...rs];if(straight)return [4,straight];if(groups[0][1]===3)return [3,groups[0][0],...groups.slice(1).map(x=>x[0]).sort((a,b)=>b-a)];if(groups[0][1]===2&&groups[1][1]===2)return [2,...groups.slice(0,2).map(x=>x[0]).sort((a,b)=>b-a),groups[2][0]];if(groups[0][1]===2)return [1,groups[0][0],...groups.slice(1).map(x=>x[0]).sort((a,b)=>b-a)];return [0,...rs];
}
export function bestHand(cards){if(!Array.isArray(cards)||cards.length<5||cards.length>7||new Set(cards).size!==cards.length)throw fail('GAME_CARDS_INVALID','Five to seven distinct cards required');let best=null,bestCards=null;for(let a=0;a<cards.length-4;a++)for(let b=a+1;b<cards.length-3;b++)for(let c=b+1;c<cards.length-2;c++)for(let d=c+1;d<cards.length-1;d++)for(let e=d+1;e<cards.length;e++){const hand=[cards[a],cards[b],cards[c],cards[d],cards[e]],score=rankFive(hand);if(!best||compare(score,best)>0){best=score;bestCards=hand;}}return {score:best,cards:bestCards};}
export const compareHands=compare;
export function blindPlan(players,{button=0,previous=null}={}){
 const ids=players.map(p=>p.id);if(!previous){integer(button,'button');if(button>=ids.length)throw fail('GAME_SEAT_INVALID','Invalid button');return {buttonSeat:ids[button],buttonAnchor:ids[button],smallBlindSeat:ids[(button+(ids.length===2?0:1))%ids.length],smallBlindAnchor:ids[(button+(ids.length===2?0:1))%ids.length],bigBlindSeat:ids[(button+(ids.length===2?1:2))%ids.length],ring:[...ids]};}
 const oldRing=previous.ring??ids,ring=oldRing.filter((id,i)=>oldRing.indexOf(id)===i),newIds=ids.filter(id=>!ring.includes(id));let at=ring.indexOf(previous.bigBlindSeat);if(at<0)at=-1;let bb=null;for(let n=1;n<=ring.length;n++){const id=ring[(at+n+ring.length)%ring.length];if(ids.includes(id)&&id!==previous.bigBlindSeat){bb=id;break;}}
 if(!bb)bb=newIds[0]??ids.find(id=>id!==previous.bigBlindSeat)??ids[0];if(!ring.includes(bb))ring.push(bb);ring.splice(ring.indexOf(bb)+1,0,...newIds.filter(id=>id!==bb));
 if(ids.length===2){const sb=ids.find(id=>id!==bb);return {buttonSeat:sb,buttonAnchor:sb,smallBlindSeat:sb,smallBlindAnchor:sb,bigBlindSeat:bb,ring};}
 const sb=ids.includes(previous.bigBlindSeat)?previous.bigBlindSeat:null,sbAnchor=previous.bigBlindSeat,buttonAnchor=previous.smallBlindAnchor??previous.smallBlindSeat??previous.buttonAnchor;return {buttonSeat:ids.includes(buttonAnchor)?buttonAnchor:null,buttonAnchor,smallBlindSeat:sb,smallBlindAnchor:sbAnchor,bigBlindSeat:bb,ring};
}
function clockwise(s,afterId,predicate){const ring=s.blindPlan.ring,at=ring.indexOf(afterId);for(let n=1;n<=ring.length;n++){const id=ring[(at+n+ring.length)%ring.length],p=s.players.find(p=>p.id===id);if(p&&predicate(p))return p.id;}return null;}
function take(s){const card=s.deck[s.drawIndex++];if(card===undefined)throw fail('GAME_DECK_EXHAUSTED','Deck exhausted');return card;}
function post(s,id,amount){if(!id)return;const p=s.players.find(p=>p.id===id),paid=Math.min(amount,p.stack);p.stack-=paid;p.committed+=paid;p.streetCommitted+=paid;p.allIn=p.stack===0;s.history.push({type:'blind',actorId:id,amount:paid,nominal:amount});}
export function createTexas(spec){
 const players=validatePlayers(spec.players,2,10).map((p,i)=>{const stack=integer(spec.stacks?.[p.id]??p.stack??p.startingStack,'stack',1);return {...p,seat:i,stack,startingStack:stack,committed:0,streetCommitted:0,folded:false,allIn:false,left:false};});sum(players.map(p=>p.stack));
 const b=spec.blinds??[1,2],small=Array.isArray(b)?b[0]:b.small,big=Array.isArray(b)?b[1]:b.big;if(![[1,2],[2,5]].some(x=>x[0]===small&&x[1]===big))throw fail('GAME_BLINDS_INVALID','Only fixed 1/2 and 2/5 blinds are supported');
 const plan=blindPlan(players,{button:spec.button??0,previous:spec.previousBlindPlan??null}),ordered=plan.ring.filter(id=>players.some(p=>p.id===id));players.sort((a,b)=>ordered.indexOf(a.id)-ordered.indexOf(b.id));players.forEach((p,i)=>p.seat=i);
 const s={...validateStateIdentity(spec),type:'texas',ruleVersion:TEXAS_RULE_VERSION,players,deck:validateDeck(spec.deck,52),drawIndex:0,board:[],burn:[],hands:Object.fromEntries(players.map(p=>[p.id,[]])),blinds:{small,big},blindPlan:plan,phase:'preflop',currentBet:big,minRaise:big,actedAt:{},fullRaiseEpoch:0,history:[],returns:[],potClaims:[],settlement:null};
 let id=clockwise(s,plan.buttonAnchor,()=>true);for(let r=0;r<2;r++)for(let n=0;n<players.length;n++){s.hands[id].push(take(s));id=clockwise(s,id,()=>true);}
 post(s,plan.smallBlindSeat,small);post(s,plan.bigBlindSeat,big);s.actorId=clockwise(s,plan.bigBlindSeat,p=>!p.allIn);normalize(s,plan.bigBlindSeat);return s;
}
function canRaise(s,p){const old=Object.hasOwn(s.actedAt,p.id)?s.actedAt[p.id]:null;return !old||s.currentBet-old.to>=s.minRaise;}
export function texasLegalActions(s,actorId){if(s.paused||s.settlement||s.actorId!==actorId)return [];const p=s.players.find(p=>p.id===actorId);if(!p||p.folded||p.allIn)return [];const toCall=Math.max(0,s.currentBet-p.streetCommitted),actions=[{type:'fold'}];if(!toCall)actions.push({type:'check'});else actions.push({type:'call',amount:Math.min(toCall,p.stack),raiseTo:p.streetCommitted+Math.min(toCall,p.stack)});const max=p.streetCommitted+p.stack,others=s.players.some(x=>x.id!==p.id&&!x.folded&&!x.allIn),open=canRaise(s,p)&&others;if(open&&max>s.currentBet){const min=s.currentBet===0?s.blinds.big:s.currentBet+s.minRaise;if(max>=min)actions.push({type:'raise',minRaiseTo:min,maxRaiseTo:max});actions.push({type:'all-in',raiseTo:max});}else if(toCall&&max<=s.currentBet)actions.push({type:'all-in',raiseTo:max});return actions;}
function returnUncalled(s){const sorted=s.players.slice().sort((a,b)=>b.streetCommitted-a.streetCommitted),top=sorted[0];if(sorted.length<2||top.streetCommitted===sorted[1].streetCommitted)return;const amount=top.streetCommitted-sorted[1].streetCommitted;if(amount<=0)return;top.streetCommitted-=amount;top.committed-=amount;top.stack+=amount;top.allIn=top.stack===0;s.returns.push({actorId:top.id,amount,street:s.phase});s.history.push({type:'uncalled-return',actorId:top.id,amount});}
function nextStreet(s){s.burn.push(take(s));if(s.phase==='preflop'){s.board.push(take(s),take(s),take(s));s.phase='flop';}else if(s.phase==='flop'){s.board.push(take(s));s.phase='turn';}else if(s.phase==='turn'){s.board.push(take(s));s.phase='river';}else return false;for(const p of s.players)p.streetCommitted=0;s.currentBet=0;s.minRaise=s.blinds.big;s.actedAt={};s.fullRaiseEpoch=0;return true;}
function preserveUncontestedClaims(s,leaving){
 // An immediate out-of-turn exit must not discard a side pot that already has
 // only this contributor left. The claim is conditional: any subsequently
 // matching live player competes normally before this fallback is considered.
 const levels=[...new Set(s.players.map(p=>p.committed).filter(x=>x>0))].sort((a,b)=>a-b);let from=0;s.potClaims??=[];
 for(const to of levels){const contributors=s.players.filter(p=>p.committed>=to),eligible=contributors.filter(p=>!p.folded);if(contributors.length>1&&eligible.length===1&&eligible[0].id===leaving.id)s.potClaims.push({from,to,actorId:leaving.id,sequence:s.potClaims.length+1,reason:'uncontested-before-fold'});from=to;}
}
export function calculateTexasSettlement(s){
 const live=s.players.filter(p=>!p.folded);if(!live.length)throw fail('GAME_NO_ELIGIBLE_PLAYER','Cannot settle without an eligible player');const totalMax=Math.max(...s.players.map(p=>p.committed));const levels=[...new Set([...s.players.map(p=>p.committed),...(s.potClaims??[]).flatMap(p=>[p.from,p.to])].filter(x=>x>0&&x<=totalMax))].sort((a,b)=>a-b),awards=Object.fromEntries(s.players.map(p=>[p.id,0])),pots=[],refunds=[];let prior=0;
 const rankById=live.length>1?Object.fromEntries(live.map(p=>[p.id,bestHand([...s.hands[p.id],...s.board])])):{};
 for(const level of levels){const from=prior,contributors=s.players.filter(p=>p.committed>=level),amount=exactNumber(BigInt(level-prior)*BigInt(contributors.length));prior=level;if(contributors.length===1){awards[contributors[0].id]+=amount;refunds.push({actorId:contributors[0].id,amount});continue;}let eligible=contributors.filter(p=>!p.folded),fixedClaim=null;if(!eligible.length){fixedClaim=[...(s.potClaims??[])].reverse().find(c=>c.from<=from&&c.to>=level&&contributors.some(p=>p.id===c.actorId));if(!fixedClaim)throw fail('GAME_NO_ELIGIBLE_SIDEPOT','No eligible player or previously preserved claim for side pot');eligible=[contributors.find(p=>p.id===fixedClaim.actorId)];}let winners;if(eligible.length===1)winners=eligible;else{let best=null;for(const p of eligible)if(!best||compare(rankById[p.id].score,best)>0)best=rankById[p.id].score;winners=eligible.filter(p=>compare(rankById[p.id].score,best)===0);}
  const each=Math.floor(amount/winners.length);for(const p of winners)awards[p.id]+=each;let remainder=amount%winners.length;const ordered=[];let id=s.blindPlan.buttonAnchor;for(let n=0;n<s.players.length;n++){id=clockwise(s,id,()=>true);if(winners.some(p=>p.id===id))ordered.push(id);}for(let n=0;n<remainder;n++)awards[ordered[n]]++;pots.push({amount,contributorIds:contributors.map(p=>p.id),eligibleIds:eligible.map(p=>p.id),winnerIds:winners.map(p=>p.id),oddChipRecipients:ordered.slice(0,remainder),...fixedClaim?{preservedClaim:clone(fixedClaim)}:{}});
 }
 const endingStacks=Object.fromEntries(s.players.map(p=>[p.id,p.stack+awards[p.id]])),deltasByPlayer=Object.fromEntries(s.players.map(p=>[p.id,endingStacks[p.id]-p.startingStack]));if(Object.values(deltasByPlayer).reduce((a,b)=>a+BigInt(b),0n)!==0n||sum(Object.values(endingStacks))!==sum(s.players.map(p=>p.startingStack)))throw fail('GAME_CONSERVATION_FAILED','Settlement must conserve all points');return {completed:true,zeroSum:true,deltasByPlayer,endingStacks,awardsByPlayer:awards,winnerIds:[...new Set(pots.flatMap(p=>p.winnerIds))],pots,uncalledReturns:[...s.returns,...refunds],handRanks:rankById};
}
function settle(s){s.settlement=calculateTexasSettlement(s);s.phase='settled';s.actorId=null;}
function normalize(s,afterId){
 for(let safety=0;safety<6;safety++){
  const live=s.players.filter(p=>!p.folded);if(live.length===1){returnUncalled(s);settle(s);return;}
  const actionable=live.filter(p=>!p.allIn),highestActual=Math.max(...s.players.map(p=>p.streetCommitted)),needs=p=>!p.folded&&!p.allIn&&(!Object.hasOwn(s.actedAt,p.id)||p.streetCommitted<s.currentBet);
  const loneMatched=actionable.length===1&&actionable[0].streetCommitted>=highestActual;
  if(actionable.length===0||loneMatched||!actionable.some(needs)){
   returnUncalled(s);if(s.phase==='river'){settle(s);return;}nextStreet(s);afterId=s.blindPlan.buttonAnchor;continue;
  }
  s.actorId=clockwise(s,afterId,needs);if(!s.actorId)throw fail('GAME_ACTOR_MISSING','No legal actor can advance this street');return;
 }throw fail('GAME_NORMALIZE_FAILED','Street advancement exceeded its legal bound');
}
export function reduceTexas(state,action){
 const s=clone(state);if(s.settlement)throw fail('GAME_ALREADY_SETTLED','This hand has settled');if(s.paused)throw fail('GAME_PAUSED','The table is paused');const at=seatOf(s,action.actorId),p=s.players[at],oldActor=s.actorId;
 if(action.type==='leave'){
  if(p.left)return s;p.left=true;if(!p.allIn){preserveUncontestedClaims(s,p);p.folded=true;}s.history.push({actorId:p.id,type:'leave',allIn:p.allIn});const beforeCurrent=s.players[(seatOf(s,oldActor)-1+s.players.length)%s.players.length].id;normalize(s,p.id===oldActor?p.id:beforeCurrent);return s;
 }
 assertTurn(s,p.id);if(p.folded||p.allIn)throw fail('GAME_ACTOR_DENIED','This player has no pending action');
 const legal=texasLegalActions(s,p.id),kind=action.type==='bet'?'raise':action.type;let target=p.streetCommitted;
 if(kind==='fold'){preserveUncontestedClaims(s,p);p.folded=true;}
 else if(kind==='check'){if(!legal.some(x=>x.type==='check'))throw fail('GAME_CHECK_DENIED','A bet must be called or folded');}
 else if(kind==='call'){if(!legal.some(x=>x.type==='call'))throw fail('GAME_CALL_DENIED','No call is available');target=p.streetCommitted+Math.min(s.currentBet-p.streetCommitted,p.stack);}
 else if(kind==='raise'||kind==='all-in'){
  target=kind==='all-in'?p.streetCommitted+p.stack:integer(action.raiseTo,'raiseTo',1);const max=p.streetCommitted+p.stack;if(target>max||target<=p.streetCommitted)throw fail('GAME_OVERBET','Cannot wager beyond actual stack');
  if(target>s.currentBet){if(!canRaise(s,p)||!s.players.some(x=>x.id!==p.id&&!x.folded&&!x.allIn))throw fail('GAME_RAISE_CLOSED','Betting has not reopened for this player');const amount=target-s.currentBet,minimum=s.currentBet===0?s.blinds.big:s.minRaise;if(amount<minimum&&target!==max)throw fail('GAME_MIN_RAISE','A short raise is only legal when actually all-in');if(amount>=minimum){s.minRaise=amount;s.fullRaiseEpoch++;}s.currentBet=target;}
  else if(kind!=='all-in'||target!==max)throw fail('GAME_RAISE_INVALID','A raise must increase the current bet');
 }else throw fail('GAME_ACTION_INVALID','Unsupported action');
 const paid=target-p.streetCommitted;if(paid){p.stack-=paid;p.streetCommitted=target;p.committed+=paid;p.allIn=p.stack===0;}s.actedAt[p.id]={to:s.currentBet,fullRaiseEpoch:s.fullRaiseEpoch};s.history.push({actorId:p.id,type:kind,...paid?{amount:paid,raiseTo:target}:{},street:s.phase});normalize(s,p.id);return s;
}
