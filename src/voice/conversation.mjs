const terminal = new Set(['audioCompleted','explicitlySkipped','interrupted','failed']);
const statuses = new Set(['textDisplayed','audioStarted',...terminal]);
const scopeFields = ['characterId','lifeId','operationId','personaId','conversationId','channel'];

export function sameVoiceScope(a,b) {
  return !!a && !!b && scopeFields.every(key=>a[key]===b[key]);
}

export function createVoiceConversation({voice,current,valid,persist,beginPresentation,completePresentation,now,audit}) {
  const turns = new Map();
  function report(error) {audit({type:'voice-presentation-error',message:String(error?.message??error).slice(0,400)});}
  function invoke(fn) { try { return Promise.resolve(fn()); } catch (error) {return Promise.reject(error);} }
  function update(turn) {
    if (!turn.finished || [...turn.segments.values()].some(segment=>!segment.terminal)) return false;
    if(!turns.delete(turn.scope.requestId))return false;
    completePresentation(turn.scope,turn.closed);
    return true;
  }
  function records(turn) {
    return turn ? [...turn.segments.values()].flatMap(segment=>segment.receipts) : [];
  }
  async function begin(scope, target) {
    if (!voice || !valid(scope) || !sameVoiceScope(target,current())) return null;
    let lease;
    try {lease=await voice.admit(scope);} catch (error) {report(error);return null;}
    if (!lease || lease.epoch==null || lease.voiceProfileVersion==null) return null;
    if (!valid(scope) || !sameVoiceScope(target,current())) {
      void invoke(()=>voice.finish({requestId:scope.requestId,failed:true})).catch(report);
      return null;
    }
    const turn={scope:Object.freeze({...scope,epoch:lease.epoch,voiceProfileVersion:lease.voiceProfileVersion}),target,segments:new Map(),offset:0,finished:false,closed:false};
    turns.set(scope.requestId,turn);
    return turn;
  }
  function record(segment,status,playedMs) {
    const receipt={segmentId:segment.envelope.segmentId,index:segment.envelope.index,status,at:now(),textRange:segment.textRange};
    if (Number.isFinite(playedMs) && playedMs>=0) receipt.playedMs=Math.round(playedMs);
    segment.receipts.push(receipt);
    if (terminal.has(status)) segment.terminal=true;
    return receipt;
  }
  function finish(turn,failed=false,unadmitted=null) {
    if (!turn) {
      if(failed&&unadmitted)void invoke(()=>voice.finish({...unadmitted,failed:true})).catch(report);
      return;
    }
    if (turn.closed || turn.finished && !failed) return;
    turn.finished=true;
    turn.closed=failed;
    if (failed) {
      for (const segment of turn.segments.values()) {
        if (segment.terminal) continue;
        const receipt=record(segment,'interrupted');
        void invoke(()=>persist(turn.scope,receipt)).catch(report);
      }
    }
    update(turn);
    void invoke(()=>voice.finish({requestId:turn.scope.requestId,failed})).catch(error=>{
      report(error);
      if (!failed) finish(turn,true);
    });
  }
  function emit(turn,segment) {
    if (!turn || turn.finished || !turns.has(turn.scope.requestId)) return;
    if (!valid(turn.scope) || !sameVoiceScope(turn.target,current())) {finish(turn,true);return;}
    const index=turn.segments.size;
    const envelope=Object.freeze({...turn.scope,index,segmentId:turn.scope.requestId+':voice:'+index});
    const textRange={start:turn.offset,end:turn.offset+segment.text.length};
    turn.offset=textRange.end;
    turn.segments.set(envelope.segmentId,{envelope,textRange,receipts:[],terminal:false});
    if(index===0)beginPresentation(turn.scope);
    return invoke(()=>voice.segment({envelope,...segment})).then(value=>{
      if (value===false) finish(turn,true);
      return value;
    },error=>{report(error);finish(turn,true);});
  }
  async function receipt({envelope,status,playedMs}={}) {
    const turn=turns.get(envelope?.requestId);
    const segment=turn?.segments.get(envelope?.segmentId);
    if (!segment || !valid(turn.scope) || !sameVoiceScope(turn.target,current()) || !statuses.has(status) ||
      !Object.keys(segment.envelope).every(key=>segment.envelope[key]===envelope[key])) return {accepted:false,ready:false};
    if (segment.terminal || segment.receipts.some(row=>row.status===status)) return {accepted:false,ready:false,requestId:turn.scope.requestId};
    const receipt=record(segment,status,playedMs);
    if(status==='failed'||status==='interrupted')turn.closed=true;
    let accepted=true;
    try{await persist(turn.scope,receipt);}catch(error){report(error);accepted=false;}
    const ready=update(turn);
    return {accepted,ready,requestId:turn.scope.requestId};
  }
  return {begin,emit,finish,receipt,records,blocked:id=>turns.has(id),
    presenting:target=>[...turns.values()].some(turn=>turn.segments.size>0&&sameVoiceScope(target,turn.target)),
    cancel(predicate) {for (const turn of turns.values()) if (predicate(turn.scope,turn.target)) finish(turn,true);}};
}
