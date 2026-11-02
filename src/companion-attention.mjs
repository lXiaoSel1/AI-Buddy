import {assertSocialScope,r95LifeState,socialError} from './companion-presentation-state.mjs';

const copy=value=>structuredClone(value),validId=value=>typeof value==='string'&&value.length>0&&value.length<=300;
export function attentionAvailability(state,now=Date.now()){
 const value=state.r95?.availability??{};
 return {busy:Number.isFinite(value.busyUntil)&&value.busyUntil>now,busyUntil:value.busyUntil??null,doNotDisturb:value.doNotDisturb===true&&(!value.doNotDisturbUntil||value.doNotDisturbUntil>now),doNotDisturbUntil:value.doNotDisturbUntil??null,revision:value.revision??0};
}
export function createAttentionService({store,now=()=>Date.now(),getActiveContext=()=>null}={}){
 if(!store?.mutate)throw Error('Attention service requires a serialized store');
 return {
  async record({scope,eventId,kind='interaction',source='user',userInteraction=true,participantScopes}={}){
   if(!validId(eventId)||!validId(kind))throw socialError('ATTENTION_EVENT_INVALID','关注事件无效');
   if(source!=='user'||userInteraction!==true)return {recorded:false,reason:'not-user-attention'};
   const scopes=participantScopes??[scope];if(!Array.isArray(scopes)||!scopes.length||scopes.length>100)throw socialError('ATTENTION_SCOPE_INVALID','关注对象无效');
   const seen=new Set();return store.mutate(state=>{const results=[];
    for(const current of scopes){assertSocialScope(state,current);if(seen.has(current.characterId))continue;seen.add(current.characterId);const r95=r95LifeState(state,current),attention=r95.attention??={events:{},lastAt:null};
     const previous=attention.events[eventId];if(previous){if(previous.personaId!==(current.personaId??null)||previous.channel!==(current.channel??'app')||previous.conversationId!==(current.conversationId??null))throw socialError('ATTENTION_EVENT_CONFLICT','关注事件ID已绑定其他会话');results.push({characterId:current.characterId,duplicate:true,event:copy(previous)});continue;}
     const event={eventId,kind,source:'user',at:now(),characterId:current.characterId,lifeId:current.lifeId,operationId:current.operationId,personaId:current.personaId??null,channel:current.channel??'app',conversationId:current.conversationId??null};
     attention.events[eventId]=event;attention.lastAt=event.at;attention.lastEventId=eventId;results.push({characterId:current.characterId,duplicate:false,event:copy(event)});
    }return {recorded:true,results};
   });
  },
  async setAvailability({busyUntil,busyForMs,clearBusy=false,doNotDisturb,doNotDisturbUntil}={}){
   const at=now();if(busyForMs!==undefined&&(!Number.isFinite(busyForMs)||busyForMs<0||busyForMs>31536000000))throw socialError('AVAILABILITY_INVALID','忙碌时长无效');
   for(const value of [busyUntil,doNotDisturbUntil])if(value!==undefined&&value!==null&&(!Number.isFinite(value)||value<at))throw socialError('AVAILABILITY_INVALID','截止时间无效');
   if(doNotDisturb!==undefined&&typeof doNotDisturb!=='boolean')throw socialError('AVAILABILITY_INVALID','免打扰开关无效');
   return store.mutate(state=>{state.r95??={schemaVersion:1};const value=state.r95.availability??={};if(clearBusy)value.busyUntil=null;else if(busyForMs!==undefined)value.busyUntil=at+busyForMs;else if(busyUntil!==undefined)value.busyUntil=busyUntil;
    if(doNotDisturb!==undefined)value.doNotDisturb=doNotDisturb;if(doNotDisturbUntil!==undefined)value.doNotDisturbUntil=doNotDisturbUntil;value.revision=(value.revision??0)+1;return attentionAvailability(state,at);});
  },
  async noteBusyQuestion({scope,eventId,text}={}){if(!validId(eventId)||typeof text!=='string'||!text.trim())throw socialError('AVAILABILITY_INVALID','忙碌询问无效');return store.mutate(state=>{const attention=r95LifeState(state,scope).attention??={events:{},lastAt:null};if(attention.busyQuestion?.status==='awaiting-answer')return {duplicate:true,question:copy(attention.busyQuestion)};if(!attentionAvailability(state,now()).busy)return {skipped:true};attention.busyQuestion={eventId,text:text.trim(),personaId:scope.personaId??null,channel:scope.channel??'app-private',conversationId:scope.conversationId??null,status:'awaiting-answer',at:now()};return {question:copy(attention.busyQuestion)};});},
  async resolveBusy({scope,eventId,answer,extendMs}={}){if(!['finished','still-busy','unknown'].includes(answer))throw socialError('AVAILABILITY_INVALID','忙碌答复无效');return store.mutate(state=>{const attention=r95LifeState(state,scope).attention??={events:{},lastAt:null},question=attention.busyQuestion;if(question&&(question.personaId!==(scope.personaId??null)||question.channel&&question.channel!==(scope.channel??'app-private')||question.conversationId&&question.conversationId!==scope.conversationId))throw socialError('ATTENTION_SCOPE_INVALID','忙碌答复身份不匹配');if(question&&eventId&&question.eventId!==eventId)throw socialError('AVAILABILITY_INVALID','忙碌询问已变化');state.r95??={schemaVersion:1};state.r95.availability??={};if(answer==='finished')state.r95.availability.busyUntil=null;if(answer==='still-busy'&&extendMs!==undefined){if(!Number.isFinite(extendMs)||extendMs<0||extendMs>31536000000)throw socialError('AVAILABILITY_INVALID','忙碌时长无效');state.r95.availability.busyUntil=now()+extendMs;}if(question&&answer!=='unknown')Object.assign(question,{status:'answered',answer,answeredAt:now()});return attentionAvailability(state,now());});},
  view({scope=getActiveContext()}={}){const life=assertSocialScope(store.state,scope),attention=life.r95?.attention??{},question=attention.busyQuestion?.personaId===(scope.personaId??null)&&(!attention.busyQuestion.channel||attention.busyQuestion.channel===(scope.channel??'app-private'))&&(!attention.busyQuestion.conversationId||attention.busyQuestion.conversationId===scope.conversationId)?copy(attention.busyQuestion):null;return {...attentionAvailability(store.state,now()),lastAttentionAt:attention.lastAt??null,busyQuestion:question};}
 };
}
