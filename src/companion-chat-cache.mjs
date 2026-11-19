import {createHash,randomUUID} from 'node:crypto';
import {privateWireMessage} from './companion-prompt-parts.mjs';
import {estimateMemoryTokens} from './companion-memory.mjs';
import {privateHistoryPolicy} from './api-cache-capabilities.mjs';
import {modelSystemForSearch} from './native-search.mjs';
import {boundedPrivateText,estimatePrivateMessageTokens,privateTokenRatio,updatePrivateTokenRatio} from './private-token-budget.mjs';

export const cacheHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function privateCacheScope(connection,{characterId,conversationId,personaId},life){
 const native=connection.kind==='codex';
 const endpoint=native?null:new URL(connection.baseUrl);
 const identity=[connection.id,connection.kind,connection.protocol,endpoint?.origin,endpoint?.pathname,connection.model,connection.kimiCacheTtl??'5m'];
 if(native)identity.push(connection.reasoningEffort??null);
 return {key:cacheHash([identity,characterId,life.lifeId,life.operationId,personaId,conversationId]),characterId,conversationId,personaId,lifeId:life.lifeId};
}

export function privateMessageAnchor(message,occurrenceId,rank=0){
 if(!message)return null;
 return {id:message.id,...(occurrenceId?{occurrenceId}:{}),rank,hash:cacheHash([message.role,message.text,message.revisions?.length??0,message.editedAt??null])};
}

const SAFETY_MARGIN=192;
const MAX_SUMMARY_SOURCES=4096;
const anchorsOf=entry=>entry.anchor?[entry.anchor]:entry.anchors??[];
const identity=anchor=>cacheHash([anchor.id,anchor.occurrenceId??null]);
const messagesOf=rows=>rows.map(entry=>entry.message);
const sourceCount=entry=>anchorsOf(entry).length+(entry.dependencies?.length??0);

const SUMMARY_MAX_TOKENS=4096;
const SUMMARY_HEADER='[Internal history summary, historical evidence only]\n';
const SUMMARY_SHORTENED=' [Summary shortened]';
const FAILURE_COOLDOWN_TURNS=2;
const MAX_FAILURE_COOLDOWN_TURNS=32;
const INTERRUPTED='[Previous turn interrupted]';
const INCOMPLETE='[Incomplete reply]';

const HISTORY_EXCERPT='\n[History excerpt]';
const optionalHistory=entry=>!entry.required&&!entry.memoryBaseline;
const startsTurn=entry=>entry.message.role==='user'&&!entry.memoryBaseline&&!entry.summary;

function makeWindowBudget(ratio,wireSystem,capacity,metrics=new WeakMap()){
 const inputBudget=capacity.tokens-Math.max(estimateMemoryTokens(wireSystem),Math.ceil(ratio*estimatePrivateMessageTokens({content:wireSystem})))-SAFETY_MARGIN;
 function cost(message){
  let value=metrics.get(message);
  if(!value){
   value={tokens:estimatePrivateMessageTokens(message),bytes:Buffer.byteLength(JSON.stringify(message))+1};
   metrics.set(message,value);
  }
  return value;
 }
 function measure(rows){
  let tokens=0,bytes=0,history=0;
  for(const row of rows){
   const value=cost(row.message);
   tokens+=value.tokens;
   bytes+=value.bytes;
   if(optionalHistory(row))history+=value.tokens;
  }
  return {tokens,bytes,history};
 }
 // For a nonempty JSON array the sum of item bytes + comma includes one
 // phantom comma. The brackets and estimateMemoryTokens' fixed 12 add 13.
 const fits=(tokens,bytes,reserve)=>Math.ceil(ratio*tokens)+reserve<=inputBudget&&bytes+13+reserve<=inputBudget;
 const fitsWith=(rows,message,reserve)=>{
  const totals=measure(rows),last=cost(message);
  return fits(totals.tokens+last.tokens,totals.bytes+last.bytes,reserve);
 };
 return {cost,measure,fits,fitsWith,inputBudget,withSystem:system=>makeWindowBudget(ratio,system,capacity,metrics)};
}

function clipHistoryRow(row,tokens,bytes,budget,lookup,selected){
 const {role,content}=row.message;
 const cost=budget.cost(row.message);
 if(cost.tokens<=tokens&&cost.bytes<=bytes)return row;
 const original=row.anchor&&lookup(row.anchor.id,row.anchor.occurrenceId);
 if(!original&&row.dependencies?.length)return null;
 const raw=original?.text??content.map(part=>part.text).join('\n');
 const prefix=row.incomplete&&!row.anchor?INCOMPLETE+'\n':'';
 const suffix=HISTORY_EXCERPT+(row.interrupted?'\n'+INTERRUPTED:'');
 const base=budget.cost(privateWireMessage(role,prefix+suffix,selected));
 const text=boundedPrivateText(prefix&&raw.startsWith(prefix)?raw.slice(prefix.length):raw,tokens-base.tokens,bytes-base.bytes);
 if(!text)return null;
 // An excerpt cannot stand in for the original or for its memoryState blocks.
 const {memoryHashes,dependencies,...excerpt}=row;
 return {...excerpt,clipped:true,message:privateWireMessage(role,prefix+text+suffix,selected)};
}

function clipSummaryRow(row,tokens,bytes,budget,selected){
 const cost=budget.cost(row.message);
 if(cost.tokens<=tokens&&cost.bytes<=bytes)return row;
 const text=row.message.content.map(part=>part.text).join('\n');
 const body=text.startsWith(SUMMARY_HEADER)?text.slice(SUMMARY_HEADER.length):text;
 const marker=SUMMARY_SHORTENED;
 const base=budget.cost(privateWireMessage('user',SUMMARY_HEADER+marker,selected));
 if(tokens<base.tokens||bytes<base.bytes)return null;
 const excerpt=boundedPrivateText(body,tokens-base.tokens,bytes-base.bytes);
 const end=Math.max(...['.','!','?','。','！','？'].map(mark=>excerpt.lastIndexOf(mark)));
 return {...row,message:privateWireMessage('user',SUMMARY_HEADER+(end<0?excerpt:excerpt.slice(0,end+1)).trimEnd()+marker,selected)};
}

function clipHistoryTurn(rows,tokens,bytes,budget,lookup,selected){
 const excerpts=new Map(),latestReply=rows.findLast(row=>row.message.role==='assistant');
 const replyCost=latestReply?budget.cost(latestReply.message):{tokens:0,bytes:0};
 // Keep short rows at actual cost and pass unused room to the reply.
 let olderTokens=Math.max(tokens-replyCost.tokens,Math.min(tokens,32));
 let olderBytes=Math.max(bytes-replyCost.bytes,Math.min(bytes,128));
 for(const row of rows){
  if(row===latestReply)continue;
  const excerpt=clipHistoryRow(row,olderTokens,olderBytes,budget,lookup,selected);
  if(!excerpt)continue;
  excerpts.set(row,excerpt);
  const cost=budget.cost(excerpt.message);
  olderTokens-=cost.tokens;
  olderBytes-=cost.bytes;
  tokens-=cost.tokens;
  bytes-=cost.bytes;
 }
 if(latestReply){
  const excerpt=clipHistoryRow(latestReply,tokens,bytes,budget,lookup,selected);
  if(excerpt)excerpts.set(latestReply,excerpt);
 }
 return excerpts;
}

function tailBoundary(rows,tokenLimit,byteLimit,budget,excludeSummary=false){
 let tokens=0,bytes=0,split=rows.length;
 for(let index=rows.length-1;index>=0;index--){
  const entry=rows[index];
  if(optionalHistory(entry)&&!(excludeSummary&&entry.summary)){
   const value=budget.cost(entry.message);
   tokens+=value.tokens;
   bytes+=value.bytes;
  }
  if(tokens>tokenLimit||bytes>byteLimit)break;
  if(startsTurn(entry))split=index;
 }
 return split;
}

function boundedHistory(rows,{target,limit,ratio,budget,reserve,buildCurrent,lookup,selected,capacityError}){
 let mandatory=rows.filter(row=>!optionalHistory(row));
 let current=buildCurrent(mandatory);
 const summaryRows=rows.filter(row=>row.summary);
 const summaryMarker={message:privateWireMessage('user',SUMMARY_HEADER+SUMMARY_SHORTENED,selected)};
 const fitsMinimum=()=>budget.fitsWith([...mandatory,...summaryRows.map(()=>summaryMarker)],current.message,reserve);
 if(!fitsMinimum()){
  // The current message rebuilds authoritative memoryState when needed.
  mandatory=mandatory.filter(row=>row.required);
  current=buildCurrent(mandatory);
  if(!fitsMinimum())throw capacityError();
 }
 const required=budget.measure(mandatory),last=budget.cost(current.message);
 const tokenRoom=Math.min(Math.floor(limit/ratio),Math.floor((budget.inputBudget-reserve)/ratio)-required.tokens-last.tokens);
 const byteRoom=budget.inputBudget-reserve-13-required.bytes-last.bytes;
 const keep=new Set(mandatory),summaries=new Map();
 let remainingTokens=tokenRoom,remainingBytes=byteRoom;
 for(const row of rows){
  if(!row.summary||keep.has(row))continue;
  const summary=clipSummaryRow(row,Math.min(remainingTokens,Math.floor(target/ratio)),remainingBytes,budget,selected);
  if(!summary)throw capacityError();
  summaries.set(row,summary);
  const cost=budget.cost(summary.message);
  remainingTokens-=cost.tokens;
  remainingBytes-=cost.bytes;
 }
 const filter=(split,excerpts=new Map())=>rows.flatMap((row,index)=>{
  const pinned=keep.has(row)?row:summaries.get(row)??excerpts.get(row);
  return pinned?[pinned]:index>=split&&optionalHistory(row)&&!row.summary?[row]:[];
 });
 const latest=Math.max(0,rows.findLastIndex(startsTurn));
 const newest=rows.slice(latest).filter(row=>optionalHistory(row)&&!row.summary);
 const latestCost=budget.measure(newest);
 const tailTarget=Math.max(latestCost.history,Math.floor(target/ratio)-(tokenRoom-remainingTokens));
 const retainedByteTarget=Math.min(remainingBytes,Math.max(latestCost.bytes,Math.floor(remainingBytes/2)));
 const split=tailBoundary(rows,Math.min(tailTarget,remainingTokens),retainedByteTarget,budget,true);
 const complete=latestCost.history<=remainingTokens&&latestCost.bytes<=remainingBytes;
 const rebuilt=complete?filter(Math.min(split,latest)):
  filter(rows.length,clipHistoryTurn(newest,Math.max(0,remainingTokens),Math.max(0,remainingBytes),budget,lookup,selected));
 const rebuiltCurrent=buildCurrent(rebuilt);
 if(budget.fitsWith(rebuilt,rebuiltCurrent.message,reserve))return {rows:rebuilt,current:rebuiltCurrent};

 // buildCurrent can recall material previously present in an optional row.
 const pinned=filter(rows.length),pinnedCurrent=buildCurrent(pinned);
 if(budget.fitsWith(pinned,pinnedCurrent.message,reserve))return {rows:pinned,current:pinnedCurrent};
 throw capacityError();
}

function summaryInstruction(selection,summaryMaxChars,selected){
 return privateWireMessage('user',
  'Summarize the dialogue in '+selection+' as historical evidence. '+
  'If those messages contain a history summary, update the previous history summary with the selected dialogue and preserve its relevant facts. '+
  'Exclude all memoryState blocks, recalled material, runtime context, and setup. Preserve chronology, speaker boundaries, explicit corrections and do-not-mention agreements. '+
  'Do not add facts from later messages or invent events. Return plain text, at most '+summaryMaxChars+' characters.',selected);
}

function summarySourceSelection(indices){
 if(indices.every((index,offset)=>index===offset+1))return 'the first '+indices.length+' messages above';
 const ranges=[];
 for(const index of indices){
  const tail=ranges.at(-1);
  if(tail&&tail[1]+1===index)tail[1]=index;
  else ranges.push([index,index]);
 }
 return 'messages '+ranges.map(([first,last])=>first===last?first:first+'–'+last).join(', ')+' above (counting from 1)';
}

function anthropicSourceSelection(rows,indices){
 const selected=new Set(indices),groups=[];
 let role;
 for(const [index,row] of rows.entries()){
  if(row.message.role!==role){role=row.message.role;groups.push([]);}
  groups.at(-1).push(selected.has(index+1));
 }
 const whole=[],partial=[];
 for(const [index,blocks] of groups.entries()){
  const covered=blocks.flatMap((include,ordinal)=>include?[ordinal+1]:[]);
  if(covered.length===blocks.length&&index<groups.length-1)whole.push(index+1);
  else if(covered.length)partial.push('turn '+(index+1)+' text blocks '+covered.join(', '));
 }
 const ranges=whole.length?[summarySourceSelection(whole).replaceAll('messages','turns')]:[];
 return [...ranges,...partial].join('; ')+' (counting merged dialogue turns and text blocks from 1, combining adjacent messages with the same role and excluding the system and this instruction)';
}

function previousChatPrefix(confirmed,parent,lookup){
 const reply=confirmed.at(-1),user=confirmed.at(-2);
 if(reply?.message.role!=='assistant'||!reply.anchor||reply.incomplete||user?.message.role!=='user'||!user.anchor||user.interrupted)return null;
 if(cacheHash(reply.anchor)!==cacheHash(parent))return null;
 const originalUser=lookup(user.anchor.id,user.anchor.occurrenceId);
 const originalReply=lookup(reply.anchor.id,reply.anchor.occurrenceId);
 if(!originalUser?.requestId||originalUser.requestId!==originalReply?.requestId||originalUser.status!=='sent')return null;
 return confirmed.slice(0,-1);
}

function summaryRequest(prefix,older,{budget,triggerTokens,ratio,summaryMaxChars,selected,historyProtocol}){
 const instructionFor=(rows,indices=rows.map((_,index)=>index+1))=>{
  const selection=historyProtocol==='anthropic'?anthropicSourceSelection(rows,indices):summarySourceSelection(indices);
  return summaryInstruction(selection,summaryMaxChars,selected);
 };
 if(prefix){
  // The last row was the current user message in the previous request.
  const full=budget.measure(prefix.slice(0,-1));
  if(Math.ceil(ratio*full.history)>triggerTokens)return null;
  const olderByMessage=new Map(older.map(row=>[row.message,row]));
  const sourceRows=[],indices=[];
  for(const [index,row] of prefix.entries()){
   if(!optionalHistory(row)||!olderByMessage.has(row.message))continue;
   sourceRows.push(olderByMessage.get(row.message));
   indices.push(index+1);
  }
  if(!sourceRows.some(row=>!row.summary)||older.some(row=>row.summary&&!sourceRows.includes(row)))return null;
  const instruction=instructionFor(prefix,indices);
  if(budget.fitsWith(prefix,instruction,SUMMARY_MAX_TOKENS))return {sourceRows,requestRows:prefix,instruction};
  return null;
 }

 // A legacy seed is not a previously sent request. Bound its source rows.
 const previousSummary=older.find(row=>row.summary);
 const previousCost=previousSummary?budget.cost(previousSummary.message):{tokens:0,bytes:0};
 const instructionCost=budget.cost(instructionFor(older));
 const tokenRoom=Math.min(Math.floor(triggerTokens/ratio),Math.floor((budget.inputBudget-SUMMARY_MAX_TOKENS)/ratio)-instructionCost.tokens)-previousCost.tokens;
 const byteRoom=budget.inputBudget-SUMMARY_MAX_TOKENS-13-instructionCost.bytes-previousCost.bytes;
 const dialogue=older.filter(row=>!row.summary);
 const split=tailBoundary(dialogue,tokenRoom,byteRoom,budget);
 const sourceRows=[...(previousSummary?[previousSummary]:[]),...dialogue.slice(split)];
 if(sourceRows.length<=Number(!!previousSummary))return null;
 const instruction=instructionFor(sourceRows);
 if(budget.fitsWith(sourceRows,instruction,SUMMARY_MAX_TOKENS))return {sourceRows,requestRows:sourceRows,instruction};
 return null;
}

function readableSummary(raw,{summaryMaxChars,summaryMaxBytes}){
 const clean=raw.replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,'').replace(/<\/?(?:think|thinking|reasoning)\b[^>]*>/gi,'').trim();
 if(!clean)return '';
 const chars=Array.from(clean);
 if(chars.length<=summaryMaxChars&&Buffer.byteLength(clean)<=summaryMaxBytes)return clean;
 const marker=SUMMARY_SHORTENED;
 let clipped='',lastSentence='',bytes=Buffer.byteLength(marker);
 for(const char of chars.slice(0,summaryMaxChars-marker.length)){
  bytes+=Buffer.byteLength(char);
  if(bytes>summaryMaxBytes)break;
  clipped+=char;
  if(/[.!?。！？]/u.test(char))lastSentence=clipped;
 }
 return (lastSentence||clipped).trimEnd()+marker;
}

function insertInLocalOrder(rows,additions,anchor,localOrder){
 const position=localOrder?.(anchor);
 const after=position===undefined?-1:rows.findIndex(row=>!row.summary&&!row.memoryBaseline&&
  anchorsOf(row).some(source=>(localOrder(source)??-1)>position));
 rows.splice(after<0?rows.length:after,0,...additions);
}

function recoveredEntries(base,pending,lookup,selected){
 const user=lookup(pending.requestId+':user',pending.userOccurrenceId);
 if(!user||user.requestId!==pending.requestId)return base;
 const anchor=privateMessageAnchor(user,pending.userOccurrenceId);
 const rows=[...base,{interrupted:true,anchor,message:privateWireMessage('user',user.text+'\n'+INTERRUPTED,selected)}];
 const reply=lookup(pending.requestId+':reply',pending.replyOccurrenceId);
 if(reply?.requestId===pending.requestId){
  rows.push({incomplete:true,anchor:privateMessageAnchor(reply,pending.replyOccurrenceId),message:privateWireMessage('assistant',reply.text,selected)});
 }else if(pending.visibleText){
  rows.push({incomplete:true,anchors:[anchor],message:privateWireMessage('assistant',INCOMPLETE+'\n'+pending.visibleText,selected)});
 }
 return rows;
}

export async function preparePrivateWindow({store,scope,previous,requestId,wireSystem,entries,buildCurrent,buildBaseline,capacity,historyPolicy=privateHistoryPolicy(),historyProtocol,connectionKey,calibration,validEntry,lookup,selected,parent,recovery,localOrder,compact,assertScope,verifyEntries,audit,skipCompaction=false}){
 const instructionsHash=cacheHash(wireSystem);
 const compatible=previous?.instructionsHash===instructionsHash;
 const sessionUuid=compatible?previous.sessionUuid:randomUUID();
 const confirmed=compatible?previous.entries:[];
 const pending=(compatible?previous.pending:null)??recovery;
 const mandatory=new Map(entries.filter(entry=>entry.required).map(entry=>[identity(entry.anchor),entry]));
 const oldWithCurrentRequirements=confirmed.map(entry=>{
  const original=entry.anchor&&mandatory.get(identity(entry.anchor));
  return entry.clipped&&original?original:{...entry,required:!!original};
 });
 const invalid=oldWithCurrentRequirements.findIndex(entry=>!validEntry(entry));
 let retained=invalid<0?oldWithCurrentRequirements:oldWithCurrentRequirements.slice(0,invalid);
 if(!compatible||!confirmed.length||invalid>=0||pending||cacheHash(previous.parent)!==cacheHash(parent)||mandatory.size){
  const seedIndices=new Map(entries.map((entry,index)=>[identity(entry.anchor),index]));
  const lastSeedAnchor=retained.flatMap(anchorsOf).findLast(anchor=>seedIndices.has(identity(anchor)));
  const anchorIndex=lastSeedAnchor?seedIndices.get(identity(lastSeedAnchor)):-1;
  const retainedIds=new Set(retained.flatMap(anchorsOf).map(identity));
  const retainedOriginals=new Set(retained.flatMap(entry=>entry.anchor?[identity(entry.anchor)]:[]));
  for(const [index,entry] of entries.entries()){
   const key=identity(entry.anchor);
   if(entry.required){
    if(!retainedOriginals.has(key))insertInLocalOrder(retained,[entry],entry.anchor,localOrder);
   }else if(index>anchorIndex&&!retainedIds.has(key))retained.push(entry);
  }
 }
 if(pending){
  const recovered=recoveredEntries([],pending,lookup,selected);
  if(recovered.length&&recovered.every(validEntry)){
   const recoveredId=identity(recovered[0].anchor);
   if(!retained.some(entry=>anchorsOf(entry).some(anchor=>identity(anchor)===recoveredId))){
    insertInLocalOrder(retained,recovered,recovered[0].anchor,localOrder);
   }
  }
 }
 const cacheContext={version:1,kind:'private',sessionUuid,scopeKey:scope.key};
 let revision=previous?.revision;
 const ratio=await privateTokenRatio(calibration,connectionKey);
 let compactionAttempt=compatible&&invalid<0?previous.compactionAttempt:undefined;
 let {cooldown=0,failures=0}=previous?.compactionState??{};
 if(!failures)cooldown=0;
 const {triggerTokens,targetTokens,summaryMaxChars}=historyPolicy;
 const reserve=capacity.reserveTokens;
 const budget=makeWindowBudget(ratio,wireSystem,capacity);
 const capacityError=()=>Object.assign(Error('当前必需输入及来源说明超过所选模型上下文容量；原文保留'),{code:'MEMORY_CONTEXT_CAPACITY',capacity});
 const historyTokens=rows=>Math.ceil(ratio*budget.measure(rows).history);

 const parentMatches=compatible&&cacheHash(previous.parent)===cacheHash(parent);
 const stalePrefix=compatible&&(pending||invalid>=0||!parentMatches);
 let current=buildCurrent(retained);
 const latest=retained.findLastIndex(startsTurn);
 const latestRows=retained.slice(Math.max(0,latest)).filter(row=>!row.summary);
 const latestTokens=historyTokens(latestRows);
 const oversizedTurn=latestTokens>triggerTokens;
 const before=historyTokens(retained);
 const hard=!budget.fitsWith(retained,current.message,reserve);
 let reduced=false,failed=false;
 if(!oversizedTurn&&!skipCompaction&&!cooldown&&!stalePrefix&&before>=triggerTokens){
  const baseline=buildBaseline();
  // The declared output limit bounds both worst-case Unicode token weight
  // and JSON escaping (one ASCII control can use six encoded bytes).
  const ceiling={message:privateWireMessage('user',SUMMARY_HEADER+'\u0000'.repeat(summaryMaxChars),selected)};
  const allowance=Math.floor(targetTokens/ratio)-(estimatePrivateMessageTokens({content:SUMMARY_HEADER})+summaryMaxChars);
  let tail,candidate,summaryLimit=targetTokens,skipped='NO_FEASIBLE_SUMMARY';
  if(!store.isDurable())skipped='CACHE_NOT_DURABLE';
  else if(retained.reduce((total,entry)=>total+sourceCount(entry),0)>MAX_SUMMARY_SOURCES)skipped='TOO_MANY_SOURCES';
  else{
   summaryLimit=Math.min(triggerTokens,Math.max(targetTokens,latestTokens+Math.ceil(ratio*(estimatePrivateMessageTokens({content:SUMMARY_HEADER})+summaryMaxChars))));
   let split=tailBoundary(retained,allowance,Infinity,budget);
   if(latest>=0)split=Math.min(latest,split);
   const keepTail=()=>retained.filter((row,index)=>row.required||index>=split&&optionalHistory(row));
   const fitsTail=()=>{
    const expected=[ceiling,baseline,...tail];
    return historyTokens(expected)<=summaryLimit&&budget.fitsWith(expected,buildCurrent(expected).message,reserve);
   };
   tail=keepTail();
   let feasible=fitsTail();
   if(!feasible&&latest>=0&&split<latest){
    split=latest;
    tail=keepTail();
    feasible=fitsTail();
   }
   const older=retained.slice(0,split).filter(optionalHistory);
   if(feasible&&older.length){
    const priorPrefix=parentMatches?previousChatPrefix(confirmed,parent,lookup):null;
    const replayWireSystemMode=priorPrefix?previous.wireSystemMode:undefined;
    const summaryBudget=replayWireSystemMode?budget.withSystem(modelSystemForSearch(wireSystem,replayWireSystemMode)):budget;
    if(!priorPrefix||previous.replayWirePrefix===true&&replayWireSystemMode)
     candidate=summaryRequest(priorPrefix,older,{budget:summaryBudget,triggerTokens,ratio,summaryMaxChars,selected,historyProtocol});
    if(candidate){
     candidate.replayWireSystemMode=replayWireSystemMode;
     candidate.fingerprint=cacheHash([instructionsHash,candidate.sourceRows.map(entry=>[entry.message,anchorsOf(entry),entry.dependencies])]);
     if(candidate.fingerprint===compactionAttempt){
      candidate=undefined;
      skipped='SUMMARY_ALREADY_ATTEMPTED';
     }
    }
   }
  }
  if(candidate){
   const {sourceRows,requestRows,instruction,fingerprint,replayWireSystemMode}=candidate;
   compactionAttempt=fingerprint;
   try{
    const raw=await compact({messages:[...messagesOf(requestRows),instruction],cacheContext,maxTokens:SUMMARY_MAX_TOKENS,replayWireSystemMode,
     checkModelSubmit:()=>verifyEntries(requestRows)});
    const summary=readableSummary(raw,historyPolicy);
    if(!summary)throw Object.assign(Error('Summary is empty'),{code:'EMPTY_SUMMARY'});
    const summaryEntry={
     summary:true,
     message:privateWireMessage('user',SUMMARY_HEADER+summary,selected),
     anchors:[...new Map(sourceRows.flatMap(anchorsOf).map(anchor=>[identity(anchor),anchor])).values()],
     dependencies:[...new Map(sourceRows.flatMap(entry=>entry.dependencies??[]).map(source=>[source.hash,source])).values()],
    };
    const compacted=[summaryEntry,baseline,...tail];
    const nextCurrent=buildCurrent(compacted);
    if(!budget.fitsWith(compacted,nextCurrent.message,reserve)||historyTokens(compacted)>summaryLimit)
     throw Object.assign(Error('Insufficient summary gain'),{code:'INSUFFICIENT_GAIN'});
    retained=compacted;
    current=nextCurrent;
    failures=0;
    cooldown=0;
    reduced=true;
   }catch(error){
    assertScope({allowAborted:true});
    if(error.code==='MEMORY_SOURCE_CHANGED')throw error;
    failures++;
    cooldown=Math.min(MAX_FAILURE_COOLDOWN_TURNS,FAILURE_COOLDOWN_TURNS*2**(failures-1))+1;
    failed=true;
    // Remember a failed charge even if the chat is cancelled or goes
    // stale before it gets a window to commit. Do not save unverified rows.
    const previousBase=previous??{sessionUuid,instructionsHash,entries:[],parent:null};
    const saved=store.write(scope,revision,{...previousBase,compactionAttempt,compactionState:{cooldown,failures}});
    if(saved!=null)revision=saved;
    audit({type:'companion-cache-compaction-failed',code:error.code??'SUMMARY_REQUEST_FAILED',hard});
   }
  }else audit({type:'companion-cache-compaction-skipped',code:skipped,hard});
 }
 if(!reduced&&(failed||before>triggerTokens||hard)){
  if(hard)audit({type:'companion-cache-capacity-reset'});
  const bounded=boundedHistory(retained,{target:targetTokens,limit:triggerTokens,ratio,budget,reserve,buildCurrent,lookup,selected,capacityError});
  const originals=new Set(retained);
  const dropped=retained.length-bounded.rows.length;
  const clipped=bounded.rows.filter(row=>!originals.has(row)).length;
  if(dropped||clipped)audit({type:'companion-cache-history-trimmed',
   reason:failed?'summary-failed':oversizedTurn?'oversized-turn':hard?'capacity':'history-limit',dropped,clipped});
  retained=bounded.rows;
  current=bounded.current;
 }
 if(historyTokens(retained)>triggerTokens||!budget.fitsWith(retained,current.message,reserve))throw capacityError();
 assertScope();
 const wireRows=[...retained,current];
 const messages=messagesOf(wireRows);
 const base={sessionUuid,instructionsHash,entries:retained,parent,compactionAttempt};
 let assistantWire,wireSystemMode,replayWirePrefix,submitted=false,stale=false,usageObserved=false;
 if(!historyProtocol){wireSystemMode='plain';replayWirePrefix=true;}
 return {
  cacheContext,
  messages,
  inputVersions:retained.filter(entry=>entry.anchor).map(entry=>({id:entry.anchor.id,revision:entry.version??0,...(entry.messageOccurrence?{messageOccurrence:entry.messageOccurrence}:{})})),
  async checkModelSubmit(){
   try{await verifyEntries(wireRows);}
   catch(error){stale=error.code==='MEMORY_SOURCE_CHANGED';throw error;}
  },
  get staleBeforeSubmit(){return stale;},
  markSubmitted(){submitted=true;},
  observeWireSystemMode(mode,reusable){
   wireSystemMode=mode;
   replayWirePrefix=replayWirePrefix!==false&&reusable===true;
  },
  observeAssistant(raw){submitted=true;assistantWire=privateWireMessage('assistant',raw,selected);},
  async observeUsage(actualPromptTokens){
   if(usageObserved||!Number.isFinite(actualPromptTokens)||actualPromptTokens<=0||!calibration||!connectionKey)return;
   usageObserved=true;
   const uncalibratedPrompt=messages.reduce((total,message)=>total+estimatePrivateMessageTokens(message),
    wireSystem?estimatePrivateMessageTokens({content:modelSystemForSearch(wireSystem,wireSystemMode)}):0);
   await updatePrivateTokenRatio(calibration,connectionKey,actualPromptTokens/uncalibratedPrompt);
  },
  async commit(userOccurrenceId,replyOccurrenceId){
   const user=lookup(requestId+':user',userOccurrenceId),reply=lookup(requestId+':reply',replyOccurrenceId);
   if(!assistantWire||!user||!reply||user.status!=='sent'||user.requestId!==requestId||reply.requestId!==requestId)return false;
   await verifyEntries(wireRows);
   const userAnchor=privateMessageAnchor(user,userOccurrenceId),replyAnchor=privateMessageAnchor(reply,replyOccurrenceId);
   const compactionState={cooldown:Math.max(0,cooldown-1),failures};
   if(store.write(scope,revision,{...base,parent:replyAnchor,compactionState,wireSystemMode,replayWirePrefix,entries:[...retained,{...current,anchor:userAnchor},{message:assistantWire,anchor:replyAnchor}]})!=null)
    return true;
   audit({type:'companion-cache-commit-error',code:'COMPANION_CACHE_CONFLICT'});
   return false;
  },
  async interrupt(userOccurrenceId,visibleText){
   if(stale||!submitted)return;
   await verifyEntries(retained,{allowAborted:true});
   const recovered=recoveredEntries(retained,{requestId,userOccurrenceId,visibleText},lookup,selected);
   const interruptedParent=recovered.at(-1)?.anchor??recovered.at(-1)?.anchors?.at(-1)??previous?.parent??parent;
   const compactionState={cooldown,failures};
   if(store.write(scope,revision,{...base,parent:interruptedParent,compactionState,entries:recovered})==null)
    audit({type:'companion-cache-commit-error',code:'COMPANION_CACHE_CONFLICT'});
  },
 };
}
