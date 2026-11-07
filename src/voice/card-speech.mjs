import {voiceSpeechText,voiceSpeechChunks} from './speech-text.mjs';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const fixedWords={allin:'All in!',trips:'三条',triple:'三条'};
const terminal=new Set(['audioCompleted','explicitlySkipped','interrupted','failed']);
const fault=(code,message=code)=>Object.assign(Error(message),{code});

/** Trusted host input only. This bridge shares the host runtime and never creates a model or engine. */
export function createCardSpeech({dataRoot,resolveVoice,isScopeValid,emit=()=>{},now=Date.now}){
  const queue=[],seen=new Map();let active,closed=false,epoch=0,stopping=null,stopFailure;
  const directory=dataRoot?join(dataRoot,'voice'):null,file=directory?join(directory,'card-speech.json'):null;
  let writes=Promise.resolve();
  const send=value=>{try{emit(value);}catch{}};
  function save(){
    while(seen.size>2048){const removable=[...seen.values()].find(row=>terminal.has(row.status));if(!removable)break;seen.delete(removable.eventId);}
    if(!file)return Promise.resolve();
    const value=JSON.stringify({schemaVersion:1,events:[...seen.values()].map(row=>({eventId:row.eventId,kind:row.kind,scope:row.scope,status:row.status,reason:row.reason,acceptedAt:row.acceptedAt,updatedAt:row.updatedAt,
      textHash:row.textHash,envelope:row.envelope,receipts:row.receiptEvidence??[]}))});
    const operation=writes.then(async()=>{const temporary=file+'.'+randomUUID()+'.tmp';await mkdir(directory,{recursive:true});await writeFile(temporary,value,{flag:'wx'});await rename(temporary,file);});
    writes=operation.catch(()=>{});return operation;
  }
  const ready=(async()=>{
    if(!file)return;
    let stored;try{stored=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return;throw fault('VOICE_CARD_RECEIPTS_INVALID');}
    if(stored?.schemaVersion!==1||!Array.isArray(stored.events)||stored.events.length>2052)throw fault('VOICE_CARD_RECEIPTS_INVALID');
    for(const entry of stored.events){
      if(!entry||typeof entry.eventId!=='string'||!entry.scope||typeof entry.status!=='string'||!Array.isArray(entry.receipts))throw fault('VOICE_CARD_RECEIPTS_INVALID');
      const row={...entry,receipts:new Set(entry.receipts.map(receipt=>receipt.status)),receiptEvidence:entry.receipts.slice(-6)};
      if(!terminal.has(row.status)){row.status='interrupted';row.reason='restart-unfinished';row.updatedAt=now();row.receiptEvidence.push({status:'interrupted',reason:row.reason,at:now()});}
      seen.set(row.eventId,row);
    }
    await save();
  })();void ready.catch(()=>{});
  async function guard(row){
    row.abort.signal.throwIfAborted();
    if(closed||active!==row||row.epoch!==epoch||!await isScopeValid(row.scope))throw fault('VOICE_CARD_SCOPE_CHANGED');
    if(typeof row.voice?.assertCurrent==='function')await row.voice.assertCurrent();
    row.abort.signal.throwIfAborted();
    if(active!==row||row.epoch!==epoch)throw fault('VOICE_CARD_SCOPE_CHANGED');
  }
  function pump(){
    if(active||closed||stopping||stopFailure||!queue.length)return;
    const row=active=queue.shift();row.epoch=epoch;row.task=run(row);
  }
  async function run(row){
    try{
      await guard(row);
      const resolved=row.speech?await resolveVoice(row.scope):null;
      const voice=row.voice=resolved?Object.freeze({...resolved}):null;
      await guard(row);
      if(voice&&(!voice.runtime||typeof voice.runtime.speak!=='function'||typeof voice.runtime.stopEngine!=='function'||!['breeze','gpt'].includes(voice.engine)||!['local','minimax'].includes(voice.speechProvider)||
        typeof voice.packageId!=='string'||!voice.packageId||typeof voice.profileId!=='string'||!voice.profileId||voice.profileVersion==null))throw fault('VOICE_CARD_VOICE_INVALID');
      const requestId='card:'+row.eventId;
      const envelope=row.envelope=Object.freeze({...row.scope,requestId,messageId:row.eventId,epoch,voiceProfileVersion:voice?.profileVersion??0,index:0,segmentId:requestId+':voice:0'});
      row.status='synthesizing';row.updatedAt=now();await save();
      await guard(row);
      let sampleRate=voice?.speechProvider==='minimax'?32000:voice?.engine==='gpt'?48000:24000,pcmRate;
      send({type:'segment',state:'queued',envelope,text:row.text,speech_text:row.speech});
      send({type:'audio',phase:'start',envelope,text:row.text,speech_text:row.speech,sampleRate});
      if(row.speech){
        const {runtime,assertCurrent,...request}=voice;
        for(const text of voiceSpeechChunks(row.speech)){
          await guard(row);
          let received=false;
          for await(const value of runtime.speak({...request,characterId:row.scope.characterId,text,signal:row.abort.signal})){
            await guard(row);
            if(value.type==='pcm'){
              if(!(value.pcm instanceof Uint8Array)||!value.pcm.byteLength||value.pcm.byteLength%2||!Number.isInteger(value.sampleRate)||value.sampleRate<8000||value.sampleRate>192000)throw fault('VOICE_CARD_AUDIO_INVALID');
              if(pcmRate!==undefined&&pcmRate!==value.sampleRate)throw fault('VOICE_CARD_AUDIO_RATE_CHANGED');
              received=true;sampleRate=pcmRate=value.sampleRate;send({type:'audio',phase:'pcm',envelope,pcm:value.pcm,sampleRate});
            }
          }
          if(!received)throw fault('VOICE_CARD_AUDIO_EMPTY');
        }
      }
      await guard(row);
      row.generated=true;
      row.status='awaiting-playback';row.updatedAt=now();await save();
      await guard(row);
      send({type:'audio',phase:'end',envelope,sampleRate,skipped:!row.speech});
      send({type:'turn',state:'generated',requestId});
    }catch(error){
      if(row.abort.signal.aborted||active!==row)return;
      row.status='failed';row.reason=error.code??'VOICE_CARD_FAILED';row.receiptEvidence.push({status:'failed',reason:row.reason,at:now()});
      try{await save();}catch{}
      send({type:'segment',state:'failed',envelope:row.envelope,code:row.reason});
      send({type:'turn',state:'generated',requestId:'card:'+row.eventId,failed:true});
      void invalidate(row.reason).catch(()=>{});
    }
  }
  async function accept({eventId,kind,text,scope}={}){
    await ready;
    if(closed)return {accepted:false,reason:'closed'};
    if(stopFailure)return {accepted:false,reason:'stop-failed'};
    if(stopping)return {accepted:false,reason:'stopping'};
    if(seen.has(eventId)){const prior=seen.get(eventId);return {accepted:false,duplicate:true,eventId,status:prior.status,...prior.reason?{reason:prior.reason}:{}};}
    if(queue.length>=(active?3:4))return {accepted:false,duplicate:false,eventId,reason:'queue-full'};
    const words=fixedWords[kind]??text;
    if(typeof eventId!=='string'||!eventId||eventId.length>500||!['allin','trips','triple','table-chat','lastSpeech'].includes(kind)||typeof words!=='string'||!words.trim()||words.length>200000||!scope||scope.channel!=='card-table'||
      !['tableId','handId','characterId','personaId','lifeId','operationId'].every(key=>typeof scope[key]==='string'&&scope[key]&&scope[key].length<=500))throw fault('VOICE_CARD_EVENT_INVALID');
    const captured=Object.freeze({...structuredClone(scope),conversationId:scope.conversationId??scope.tableId});
    const row={eventId,kind,scope:captured,text:words,speech:voiceSpeechText(words),textHash:createHash('sha256').update(words).digest('hex'),abort:new AbortController(),acceptedAt:now(),status:'queued',receipts:new Set(),receiptEvidence:[]};
    seen.set(eventId,row);queue.push(row);await save();void pump();
    return {accepted:true,duplicate:false,eventId};
  }
  async function receipt({envelope,status,playedMs}={}){
    await ready;
    const row=active;
    if(!row?.envelope||!envelope||!Object.keys(row.envelope).every(key=>row.envelope[key]===envelope[key])||
      !['textDisplayed','audioStarted',...terminal].includes(status)||row.receipts.has(status)||['audioCompleted','explicitlySkipped'].includes(status)&&!row.generated)return {accepted:false};
    try{await guard(row);}catch{await invalidate('scope-changed');return {accepted:false};}
    if(active!==row||row.receipts.has(status)||terminal.has(row.status))return {accepted:false};
    row.receipts.add(status);
    row.receiptEvidence.push({status,at:now(),...Number.isFinite(playedMs)&&playedMs>=0?{playedMs:Math.round(playedMs)}:{}});
    if(terminal.has(status)){row.status=status;row.updatedAt=now();}
    await save();
    if(status==='failed'||status==='interrupted'){await invalidate('playback-'+status);return {accepted:true};}
    if(terminal.has(status)&&active===row){active=null;void pump();}
    return {accepted:true,...Number.isFinite(playedMs)&&playedMs>=0?{playedMs:Math.round(playedMs)}:{}};
  }
  async function invalidate(reason='cancelled'){
    await ready;if(stopping)return stopping;if(stopFailure)throw stopFailure;
    epoch++;const rows=[...queue,...active?[active]:[]];queue.length=0;const row=active;active=null;row?.abort.abort();
    for(const item of rows){if(terminal.has(item.status))continue;item.status='interrupted';item.reason=reason;item.updatedAt=now();item.receiptEvidence.push({status:'interrupted',reason,at:now()});}
    send({type:'invalidate',channel:'card-table',reason});
    stopping=(async()=>{
      const results=await Promise.allSettled([save(),Promise.resolve().then(()=>row?.voice?.runtime.stopEngine?.()),row?.task]);
      const failure=results.find(result=>result.status==='rejected');
      if(failure){stopFailure=fault('VOICE_CARD_STOP_FAILED',String(failure.reason?.message??failure.reason));if(row){row.reason='stop-failed';row.receiptEvidence.push({status:'interrupted',reason:'stop-failed',at:now()});}await save();throw stopFailure;}
      await save();await writes;
    })();
    try{return await stopping;}finally{stopping=null;}
  }
  async function reconcile(){
    await ready;
    for(const row of [...active?[active]:[],...queue])if(!await isScopeValid(row.scope)){await invalidate('scope-changed');return {invalidated:true};}
    return {invalidated:false};
  }
  return {accept,receipt,invalidate,reconcile,busy:()=>!!active||queue.length>0||!!stopping||!!stopFailure,async close(){closed=true;await invalidate('closed');}};
}
