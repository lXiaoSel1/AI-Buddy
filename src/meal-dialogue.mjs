import {FOODS} from './food-catalog.mjs';
import {t} from './i18n.mjs';
const foods=new Map(FOODS.map(f=>[f.id,f.name]));
export function mealDialogue(state,conversation,language='zh-CN'){
 if(!conversation)return [];
 const {id,characterId,personaId,lifeId}=conversation,life=state.lives?.[characterId],name=state.cards?.[characterId]?.name;
 if(!name||life?.id!==lifeId||!state.personas?.[personaId])return [];
 const rows=[];
 for(const event of Object.values(life.r95?.evidence??{})){
  const s=event.scope;
  if(event.sourceKind!=='meal'||event.actual!==true||!s||s.channel!=='app-private'||s.characterId!==characterId||s.personaId!==personaId||s.lifeId!==lifeId||s.operationId!==life.operationId||s.conversationId!==id)continue;
  let v;try{v=JSON.parse(event.text);}catch{continue;}
  if(v?.eventId!==event.eventId||!/^feeding:.+:experience$/.test(v.eventId)||v.kind!=='feeding'||v.status!=='completed'||!foods.has(v.foodId)||!Number.isFinite(v.occurredAt))continue;
  const text=t(v.automatic?'{name}自己吃了一份{food}。':'你喂给{name}一份{food}。',language).replace('{name}',()=>name).replace('{food}',()=>t(foods.get(v.foodId),language));
  rows.push({id:event.eventId,characterId,personaId,lifeId,conversationId:id,role:'narrator',who:'narrator',sourceKind:'meal',text,createdAt:v.occurredAt,status:'presented'});
 }
 return rows.sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
}
export function withMealDialogue(messages,meals){
 if(!meals.length)return messages;
 const ids=new Set(messages.map(m=>m.id));return [...messages,...meals.filter(m=>!ids.has(m.id))].sort((a,b)=>(a.createdAt??0)-(b.createdAt??0));
}
