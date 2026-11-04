import {ACTION_EMOTIONS} from './prompts.mjs';

const texasRanks=['highcard','pair','twopair','trips','straight','flush','fullhouse','quads','straightflush'];
const suits=['spade','heart','diamond','club'];
const directCardReference=/[\p{N}♠♤♥♡♦♢♣♧]|\b(?:ace|king|queen|jack|joker|spades?|hearts?|diamonds?|clubs?|[akqjt])\b|黑桃|红桃|红心|方块|梅花|小王|大王|手牌|底牌|口袋对|手里有|手上有/iu;

function tableSpeech(value){
 if(typeof value!=='string')return null;
 const text=value.trim();
 return text&&[...text].length<=40&&!/[\p{Cc}\p{Cf}]/u.test(text)&&!directCardReference.test(text.normalize('NFKC'))?text:null;
}

function actionEvents(previous,next,action){
 const events=[];
 if(next.type==='doudizhu'){
  if(next.landlordId&&next.phase==='doubling'&&previous.phase!=='doubling')events.push({kind:'landlord',actorId:next.landlordId});
  const played=next.history.at(-1);
  if(action.type==='play'&&played?.actorId===action.actorId&&played.type==='play'){
   const pattern=played.pattern;
   const kind=pattern.startsWith('airplane')?'plane':({bomb:'bomb',rocket:'rocket',straight:'ddzstraight','pair-straight':'chainpair'})[pattern];
   if(kind)events.push({kind,actorId:action.actorId,cards:played.cards});
  }
  const spring=next.settlement?.spring;
  if(spring==='spring'||spring==='counter-spring')events.push({kind:spring==='spring'?'spring':'antispring',actorId:action.actorId});
  return events;
 }
 const wasAllIn=previous.players.find(p=>p.id===action.actorId)?.allIn;
 const nowAllIn=next.players.find(p=>p.id===action.actorId)?.allIn;
 if(!wasAllIn&&nowAllIn&&['raise','call','all-in'].includes(action.type))events.push({kind:'allin',actorId:action.actorId});
 if(previous.settlement||next.phase!=='settled'||next.settlement?.completed!==true)return events;
 for(const actorId of next.settlement.winnerIds){
  // The approved reducer computes handRanks only on a contested, completed showdown.
  const rank=Object.hasOwn(next.settlement.handRanks??{},actorId)?next.settlement.handRanks[actorId]:null;
  const cards=rank?.cards;
  if(!Array.isArray(cards)||cards.length!==5||new Set(cards).size!==5||cards.some(c=>!Number.isInteger(c)||c<0||c>51))continue;
  const kind=rank.score?.[0]===8&&rank.score[1]===14?'royal':texasRanks[rank.score?.[0]];
  if(kind&&kind!=='highcard')events.push({kind,actorId,cards:[...cards],...(kind==='flush'?{suit:suits[cards[0]%4]}:{})});
 }
 return events;
}

export function settledShowdown(state){
 if(state.type!=='texas'||state.phase!=='settled'||state.settlement?.completed!==true||!state.settlement.handRanks)return null;
 const pairs=state.players.flatMap(p=>{
  if(p.folded||!Object.hasOwn(state.settlement.handRanks,p.id))return [];
  const cards=state.hands[p.id];
  return Array.isArray(cards)&&cards.length===2&&cards[0]!==cards[1]&&cards.every(c=>Number.isInteger(c)&&c>=0&&c<=51)?[[p.id,[...cards]]]:[];
 });
 return pairs.length>1?Object.fromEntries(pairs):null;
}

export function recordActionPresentation(table,previous,action,decoration,at){
 const next=table.state;
 const id=table.id+':presentation:'+table.version;
 const events=actionEvents(previous,next,action).map((event,i)=>({id:id+':'+i,...event}));
 const actor=table.players.find(p=>p.id===action.actorId&&p.kind==='ai');
 const completed=next.settlement?.completed===true;
 const bomb=events.some(e=>e.kind==='bomb'||e.kind==='rocket');
 const pressure=!bomb&&(action.type==='rob'||next.type==='doudizhu'&&action.type==='play'&&previous.lastPlay||events.some(e=>e.kind==='allin')||action.type==='raise');
 const emotions=Object.fromEntries(table.players.filter(p=>p.kind==='ai').map(p=>{
  const requested=p.id===actor?.id&&decoration?.emotion;
  const fallback=completed?(next.settlement.winnerIds.includes(p.id)?'starry':'exasperated'):p.id!==action.actorId?(bomb?'frightened':pressure?'angry':'cheerful'):action.type==='fold'?'exasperated':'cheerful';
  return [p.id,ACTION_EMOTIONS.includes(requested)?requested:fallback];
 }));
 const speech=actor?tableSpeech(decoration?.say):null;
 const lastSpeech=speech?{id:id+':say',role:'assistant',source:'game-action',actorId:actor.id,characterId:actor.characterId,handId:next.handId,text:speech,emotion:emotions[actor.id],at}:null;
 if(lastSpeech)table.chat.push(lastSpeech);
 table.presentation={emotions,lastSpeech,events};
}
