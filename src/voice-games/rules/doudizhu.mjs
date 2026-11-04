import {fail,clone,validateDeck,validatePlayers,validateStateIdentity,integer,seatOf,assertTurn,nextIndex,canonical} from './common.mjs';
export const DOUDIZHU_RULE_VERSION='ddz-r87-classic-v1';
export const ddzRank=card=>card>=52?card-36:Math.floor(card/4)+3;
const sequence=(ranks,min)=>ranks.length>=min&&ranks.at(-1)<=14&&ranks.every((r,i)=>!i||r===ranks[i-1]+1);
function counts(cards){const map=new Map();for(const c of cards){const r=ddzRank(c);if(!map.has(r))map.set(r,[]);map.get(r).push(c);}for(const v of map.values())v.sort((a,b)=>a-b);return map;}
function chooseGroups(entries,needed,start=0,picked=[],out=[]){if(!needed){out.push([...picked]);return out;}for(let i=start;i<entries.length;i++)chooseGroups(entries,needed-1,i+1,[...picked,entries[i]],out);return out;}
function singleAttachments(entries,needed,at=0,picked=[],out=[]){if(!needed){out.push([...picked]);return out;}if(at>=entries.length)return out;const cards=entries[at][1];for(let n=0;n<=Math.min(cards.length,needed);n++)singleAttachments(entries,needed-n,at+1,[...picked,...cards.slice(0,n)],out);return out;}
function make(type,body,cards){const ranks=body.slice().sort((a,b)=>a-b);return {type:'play',pattern:type,bodyRanks:ranks,cards:cards.slice().sort((a,b)=>a-b),moveId:type+':'+ranks.join('.')+':'+cards.slice().sort((a,b)=>a-b).join('.')};}
export function ddzPatterns(cards){
 if(!Array.isArray(cards)||!cards.length||new Set(cards).size!==cards.length||cards.some(c=>!Number.isInteger(c)||c<0||c>53))return [];
 const cs=counts(cards),ranks=[...cs.keys()].sort((a,b)=>a-b),out=[],size=cards.length,add=(type,body)=>out.push(make(type,body,cards));
 if(size===1)add('single',ranks);if(size===2&&ranks.length===1)add('pair',ranks);if(size===2&&cs.has(16)&&cs.has(17))add('rocket',[17]);
 if(size===3&&ranks.length===1)add('triple',ranks);if(size===4&&ranks.length===1)add('bomb',ranks);
 for(const [r,v]of cs)if(v.length===3){if(size===4&&ranks.length===2)add('triple-single',[r]);if(size===5&&ranks.length===2&&[...cs.values()].some(x=>x.length===2))add('triple-pair',[r]);}
 if(sequence(ranks,5)&&ranks.every(r=>cs.get(r).length===1))add('straight',ranks);
 if(sequence(ranks,3)&&ranks.every(r=>cs.get(r).length===2))add('pair-straight',ranks);
 if(sequence(ranks,2)&&ranks.every(r=>cs.get(r).length===3))add('airplane',ranks);
 const triples=ranks.filter(r=>cs.get(r).length===3&&r<=14);
 for(let start=0;start<triples.length;start++)for(let n=2;n<=triples.length-start;n++){
  const body=triples.slice(start,start+n);if(!sequence(body,2))continue;const attachments=ranks.filter(r=>!body.includes(r));
  if(size===4*n&&attachments.reduce((a,r)=>a+cs.get(r).length,0)===n)add('airplane-single',body);
  if(size===5*n&&attachments.length===n&&attachments.every(r=>cs.get(r).length===2))add('airplane-pair',body);
 }
 for(const r of ranks)if(cs.get(r).length===4){const rest=ranks.filter(x=>x!==r);if(size===6&&rest.reduce((a,x)=>a+cs.get(x).length,0)===2)add('four-single',[r]);if(size===8&&rest.length===2&&rest.every(x=>cs.get(x).length===2))add('four-pair',[r]);}
 return out;
}
export function ddzCanBeat(play,prior){if(!prior)return true;if(prior.pattern==='rocket')return false;if(play.pattern==='rocket')return true;if(play.pattern==='bomb')return prior.pattern!=='bomb'||play.bodyRanks[0]>prior.bodyRanks[0];if(prior.pattern==='bomb')return false;return play.pattern===prior.pattern&&play.cards.length===prior.cards.length&&play.bodyRanks.length===prior.bodyRanks.length&&play.bodyRanks.at(-1)>prior.bodyRanks.at(-1);}
export function ddzAllPlays(hand,prior=null){
 const cs=counts(hand),entries=[...cs.entries()].sort((a,b)=>a[0]-b[0]),out=new Map(),emit=(type,body,cards)=>{const move=make(type,body,cards);if(ddzCanBeat(move,prior))out.set(move.moveId,move);};
 for(const [r,cards]of entries){emit('single',[r],cards.slice(0,1));if(cards.length>=2)emit('pair',[r],cards.slice(0,2));if(cards.length>=3){emit('triple',[r],cards.slice(0,3));for(const [wing,c]of entries)if(wing!==r){emit('triple-single',[r],[...cards.slice(0,3),c[0]]);if(c.length>=2)emit('triple-pair',[r],[...cards.slice(0,3),...c.slice(0,2)]);}}if(cards.length===4){emit('bomb',[r],cards);for(const wing of singleAttachments(entries.filter(([x])=>x!==r),2))emit('four-single',[r],[...cards,...wing]);for(const wing of chooseGroups(entries.filter(([x,c])=>x!==r&&c.length>=2),2))emit('four-pair',[r],[...cards,...wing.flatMap(([,c])=>c.slice(0,2))]);}}
 if(cs.has(16)&&cs.has(17))emit('rocket',[17],[cs.get(16)[0],cs.get(17)[0]]);
 for(const [repeat,min,type]of [[1,5,'straight'],[2,3,'pair-straight'],[3,2,'airplane']])for(let first=3;first<=14;first++)for(let n=min;n<=15-first;n++){
  const body=Array.from({length:n},(_,i)=>first+i);if(!body.every(r=>(cs.get(r)?.length??0)>=repeat))continue;const base=body.flatMap(r=>cs.get(r).slice(0,repeat));emit(type,body,base);
  if(repeat===3){const others=entries.filter(([r])=>!body.includes(r));for(const wing of singleAttachments(others,n))emit('airplane-single',body,[...base,...wing]);for(const wing of chooseGroups(others.filter(([,c])=>c.length>=2),n))emit('airplane-pair',body,[...base,...wing.flatMap(([,c])=>c.slice(0,2))]);}
 }
 return [...out.values()];
}
function deal(state,deck){state.deck=validateDeck(deck,54);state.hands=Object.fromEntries(state.players.map(p=>[p.id,[]]));for(let i=0;i<51;i++)state.hands[state.players[i%3].id].push(state.deck[i]);state.bottom=state.deck.slice(51);state.phase='calling';state.actorId=state.players[state.startCaller].id;state.callOrder=Array.from({length:3},(_,i)=>state.players[(state.startCaller+i)%3].id);state.declined=[];state.callerId=null;state.landlordId=null;state.publicMultiplier=1;state.doubles={};state.lastPlay=null;state.lastPlayActor=null;state.passCount=0;state.playCounts=Object.fromEntries(state.players.map(p=>[p.id,0]));return state;}
export function createDoudizhu(spec){const players=validatePlayers(spec.players,3,3),startCaller=integer(spec.startCaller??0,'start caller');if(startCaller>2)throw fail('GAME_SEAT_INVALID','Invalid first caller');return deal({...validateStateIdentity(spec),type:'doudizhu',ruleVersion:DOUDIZHU_RULE_VERSION,players,startCaller,dealAttempt:1,history:[],settlement:null},spec.deck);}
function landlordReady(s){s.hands[s.landlordId].push(...s.bottom);s.phase='doubling';s.actorId=s.players[s.startCaller].id;}
function finish(s,winnerId){const landlordWin=winnerId===s.landlordId,farmers=s.players.filter(p=>p.id!==s.landlordId);const spring=landlordWin?farmers.every(p=>s.playCounts[p.id]===0):s.playCounts[s.landlordId]===1;if(spring)s.publicMultiplier*=2;const deltas=Object.fromEntries(s.players.map(p=>[p.id,0])),pairStakes={};for(const f of farmers){const stake=Math.min(16,s.publicMultiplier*(s.doubles[s.landlordId]??1)*(s.doubles[f.id]??1));pairStakes[f.id]=stake;deltas[f.id]=landlordWin?-stake:stake;deltas[s.landlordId]-=deltas[f.id];}s.phase='settled';s.actorId=null;s.settlement={completed:true,zeroSum:true,deltasByPlayer:deltas,winnerIds:landlordWin?[s.landlordId]:farmers.map(p=>p.id),pairStakes,spring:spring?(landlordWin?'spring':'counter-spring'):null,publicMultiplier:s.publicMultiplier};}
export function doudizhuLegalActions(s,actorId){if(s.paused||s.settlement||s.actorId!==actorId)return [];if(s.phase==='calling')return [{type:'call-landlord'},{type:'decline'}];if(s.phase==='robbing')return [{type:'rob'},{type:'decline'}];if(s.phase==='doubling')return [{type:'double',factor:1},{type:'double',factor:2}];if(s.phase==='playing')return [...ddzAllPlays(s.hands[actorId],s.lastPlay),...(s.lastPlay?[{type:'pass'}]:[])];return [];}
export function reduceDoudizhu(state,action){
 const s=clone(state);if(s.settlement)throw fail('GAME_ALREADY_SETTLED','This game has settled');if(s.paused)throw fail('GAME_PAUSED','The game is paused');
 if(s.phase==='redeal-required'){if(action.type!=='deal'||!action.hostAuthorized)throw fail('GAME_REDEAL_REQUIRED','Fresh host deck is required');s.dealAttempt++;s.startCaller=(s.startCaller+1)%3;deal(s,action.deck);return s;}
 const actor=action.actorId;seatOf(s,actor);assertTurn(s,actor);
 if(s.phase==='calling'){
  if(action.type==='decline'){s.declined.push(actor);const i=s.callOrder.indexOf(actor)+1;if(i===3){s.phase='redeal-required';s.actorId=null;}else s.actorId=s.callOrder[i];}
  else if(action.type==='call-landlord'){s.callerId=actor;s.landlordId=actor;const at=seatOf(s,actor);s.robQueue=Array.from({length:2},(_,i)=>s.players[(at+i+1)%3].id).filter(id=>!s.declined.includes(id));s.phase='robbing';if(!s.robQueue.length)landlordReady(s);else s.actorId=s.robQueue[0];}else throw fail('GAME_ACTION_INVALID','Choose call or decline');
 }else if(s.phase==='robbing'){
  if(!['rob','decline'].includes(action.type))throw fail('GAME_ACTION_INVALID','Choose rob or decline');if(action.type==='rob'){s.landlordId=actor;s.publicMultiplier*=2;}s.robQueue.shift();
  if(!s.robQueue.length&&actor!==s.callerId&&s.landlordId!==s.callerId)s.robQueue.push(s.callerId);
  if(s.robQueue.length)s.actorId=s.robQueue[0];else landlordReady(s);
 }else if(s.phase==='doubling'){
  if(action.type!=='double'||![1,2].includes(action.factor)||Object.hasOwn(s.doubles,actor))throw fail('GAME_ACTION_INVALID','Choose one ordinary double or no double');s.doubles[actor]=action.factor;
  if(Object.keys(s.doubles).length===3){s.phase='playing';s.actorId=s.landlordId;}else s.actorId=s.players[nextIndex(s.players,seatOf(s,actor),p=>!Object.hasOwn(s.doubles,p.id))].id;
 }else if(s.phase==='playing'){
  if(action.type==='pass'){if(!s.lastPlay)throw fail('GAME_PASS_DENIED','Leading player must play');s.passCount++;if(s.passCount===2){s.actorId=s.lastPlayActor;s.lastPlay=null;s.passCount=0;}else s.actorId=s.players[(seatOf(s,actor)+1)%3].id;}
  else if(action.type==='play'){
   const hand=s.hands[actor];if(!Array.isArray(action.cards)||action.cards.some(c=>!hand.includes(c))||new Set(action.cards).size!==action.cards.length)throw fail('GAME_CARDS_DENIED','Play only your actual cards');
   const patterns=ddzPatterns(action.cards),selected=patterns.find(p=>(!action.pattern||p.pattern===action.pattern)&&(!action.bodyRanks||canonical(p.bodyRanks)===canonical([...action.bodyRanks].sort((a,b)=>a-b)))&&(!action.moveId||p.moveId===action.moveId)&&ddzCanBeat(p,s.lastPlay));if(!selected)throw fail('GAME_ILLEGAL_PLAY','Cards do not form a legal beating pattern');
   s.hands[actor]=hand.filter(c=>!action.cards.includes(c));s.playCounts[actor]++;s.lastPlay=selected;s.lastPlayActor=actor;s.passCount=0;if(['bomb','rocket'].includes(selected.pattern))s.publicMultiplier*=2;s.history.push({actorId:actor,...selected});if(!s.hands[actor].length)finish(s,actor);else s.actorId=s.players[(seatOf(s,actor)+1)%3].id;
  }else throw fail('GAME_ACTION_INVALID','Play or pass is required');
 }else throw fail('GAME_PHASE_INVALID','Unsupported phase');
 if(action.type!=='play')s.history.push({actorId:actor,type:action.type,...action.factor?{factor:action.factor}:{}});return s;
}
