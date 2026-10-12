import test from 'node:test';
import assert from 'node:assert/strict';
import {UsageLedger,dayOf} from '../src/ledger.mjs';
const at='2026-10-07T16:00:00.000Z';
const meta=(id,parent)=>({type:'session_meta',timestamp:'2026-10-07T12:00:00.000Z',payload:{id,cwd:'E:\\work',source:parent?{subagent:{thread_spawn:{parent_thread_id:parent}}}:'cli'}});
const count=(input,output,time=at,cached=0)=>({type:'event_msg',timestamp:time,payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,output_tokens:output,cached_input_tokens:cached,reasoning_output_tokens:output/2},last_token_usage:{input_tokens:input,output_tokens:output}}}});
test('Codex cumulative snapshots count deltas, caching and reasoning stay subsets',()=>{
 const l=new UsageLedger();l.ingestCodex(meta('one'),'one');l.ingestCodex(count(100,20,at,80),'one');l.ingestCodex(count(100,20,at,80),'one');l.ingestCodex(count(250,50,'2026-10-07T16:01:00Z',200),'one');
 const s=l.snapshot();assert.equal(s.totals.codex.total,300);assert.equal(s.totals.codex.cacheRead,200);assert.equal(s.totals.codex.reasoning,25);
 const restored=new UsageLedger(l.serialize());restored.ingestCodex(count(250,50,'2026-10-07T16:01:00Z',200),'one');assert.equal(restored.snapshot().totals.codex.total,300);
});
test('Copied Codex history and parent/subagent sums count API use once',()=>{
 const l=new UsageLedger();l.ingestCodex(meta('parent'),'parent');l.ingestCodex(count(100,10),'parent');
 l.ingestCodex({...meta('fork'),timestamp:'2026-10-07T17:00:00Z'},'fork');l.ingestCodex(count(100,10),'fork');
 l.ingestCodex(meta('child','parent'),'child');l.ingestCodex(count(30,5,'2026-10-07T16:02:00Z'),'child');
 assert.equal(l.snapshot().totals.codex.total,145);assert.equal(l.snapshot().sessions.find(s=>s.id==='child').subagent,true);
});
test('Claude streaming blocks, nested iterations, copied history and cache fields',()=>{
 const l=new UsageLedger();const record={type:'assistant',timestamp:at,sessionId:'c',cwd:'E:\\work',message:{id:'msg-real',model:'claude-opus',stop_reason:'tool_use',usage:{input_tokens:2,output_tokens:10,cache_read_input_tokens:100,cache_creation_input_tokens:20,cache_creation:{ephemeral_1h_input_tokens:20},iterations:[{input_tokens:2,output_tokens:10,cache_read_input_tokens:100,cache_creation_input_tokens:20}]}}};
 l.ingestClaude(record,'c');l.ingestClaude(record,'c');l.ingestClaude({...record,message:{...record.message,usage:{...record.message.usage,output_tokens:30}}},'c');
 l.ingestClaude({...record,sessionId:'copied'},'copied');assert.equal(l.snapshot().totals.claude.total,152);
 l.ingestClaude({...record,sessionId:'c',isSidechain:true,message:{...record.message,id:'msg-child'}},'agent-x','E:\\projects\\c\\subagents\\agent-x.jsonl');
 assert.equal(l.snapshot().sessions.find(s=>s.id==='agent-x').subagent,true);assert.equal(l.snapshot().totals.claude.total,284);
});
test('Long quiet turns become unknown, never completed; explicit terminal wins',()=>{
 const l=new UsageLedger();l.ingestCodex(meta('one'),'one');l.ingestCodex({type:'event_msg',timestamp:at,payload:{type:'task_started',turn_id:'t'}},'one');
 assert.equal(l.snapshot(Date.parse(at)+180000).sessions[0].displayStatus,'unknown');assert.equal(l.snapshot().sessions[0].status,'running');
 l.ingestCodex({type:'event_msg',timestamp:'2026-10-07T16:04:00Z',payload:{type:'task_complete',turn_id:'t'}},'one');assert.equal(l.snapshot().sessions[0].status,'completed');
});
test('New York midnight and independent provider totals',()=>{
 assert.equal(dayOf('2026-10-08T03:59:59Z'),'2026-10-07');assert.equal(dayOf('2026-10-08T04:00:00Z'),'2026-10-08');
 const l=new UsageLedger();l.ingestCodex(meta('one'),'one');l.ingestCodex(count(100,10,'2026-10-08T03:59:59Z'),'one');l.ingestCodex(count(150,20,'2026-10-08T04:00:00Z'),'one');
 assert.equal(l.snapshot().daily.find(d=>d.date==='2026-10-07').codex.total,110);assert.equal(l.snapshot().daily.find(d=>d.date==='2026-10-08').codex.total,60);
});
test('Legacy paginated child keeps its own identity and excludes inherited parent seed',()=>{
 const l=new UsageLedger();l.ingestCodex(meta('parent'),'parent');l.ingestCodex(count(1000,100),'parent');
 l.ingestCodex({type:'session_meta',ordinal:0,timestamp:at,payload:{id:'child',session_id:'parent',parent_thread_id:'parent',thread_source:'subagent',subagent_history_start_ordinal:10,cwd:'E:\\work'}},'child');
 assert.equal(l.ingestCodex({...meta('parent'),ordinal:1},'child'),'child');
 l.ingestCodex({...count(1000,100),ordinal:2},'child');l.ingestCodex({...count(40,5,'2026-10-07T16:00:01Z'),ordinal:11},'child');
 const snapshot=l.snapshot();assert.equal(snapshot.totals.codex.total,1145);assert.equal(snapshot.sessions.find(s=>s.id==='child').usage.total,45);assert.equal(snapshot.sessions.find(s=>s.id==='child').subagent,true);
});

test('Regressed Codex snapshots do not bill the entire accumulator again; evidenced restarts count new work',()=>{
 const l=new UsageLedger();l.ingestCodex(meta('one'),'one');
 const sample=(input,output,lastInput,lastOutput,minute)=>({type:'event_msg',timestamp:`2026-10-07T16:${String(minute).padStart(2,'0')}:00Z`,payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,output_tokens:output},last_token_usage:{input_tokens:lastInput,output_tokens:lastOutput}}}});
 l.ingestCodex(sample(1000,100,100,10,0),'one');l.ingestCodex(sample(990,101,100,10,1),'one');l.ingestCodex(sample(1100,120,110,19,2),'one');
 assert.equal(l.snapshot().totals.codex.total,1220);assert.equal(l.snapshot().sessions[0].counterRegressions,1);
 l.ingestCodex(sample(50,5,50,5,3),'one');l.ingestCodex(sample(80,8,30,3,4),'one');
 assert.equal(l.snapshot().totals.codex.total,1308);assert.equal(l.snapshot().sessions[0].counterRestarts,1);
 assert.equal(new UsageLedger(l.serialize()).snapshot().totals.codex.total,1308);
});

test('Explicit error, permission and stop records control state; missing evidence stays unknown',()=>{
 const l=new UsageLedger();l.ingestCodex(meta('c'),'c');assert.equal(l.snapshot().sessions[0].displayStatus,'unknown');
 l.ingestCodex({type:'event_msg',timestamp:at,payload:{type:'approval_requested'}},'c');assert.equal(l.snapshot().sessions[0].status,'waiting');
 l.ingestCodex({type:'event_msg',timestamp:'2026-10-07T16:01:00Z',payload:{type:'error'}},'c');assert.equal(l.snapshot().sessions[0].status,'failed');
 l.ingestClaude({type:'assistant',sessionId:'a',timestamp:at,isApiErrorMessage:true,message:{id:'failure',model:'claude-opus',usage:{input_tokens:0,output_tokens:0}}},'a');assert.equal(l.snapshot().sessions.find(s=>s.id==='a').status,'failed');
 l.ingestClaude({type:'system',sessionId:'a',timestamp:'2026-10-07T16:01:00Z',subtype:'permission_request'},'a');assert.equal(l.snapshot().sessions.find(s=>s.id==='a').status,'waiting');
 l.ingestClaude({type:'assistant',sessionId:'a',timestamp:'2026-10-07T16:02:00Z',message:{stop_reason:'end_turn'}},'a');assert.equal(l.snapshot().sessions.find(s=>s.id==='a').status,'completed');
});

test('Affection uses new work since startup and excludes companion requests',()=>{
 const l=new UsageLedger();l.workStartedAt=Date.parse('2026-10-07T16:01:00Z');
 l.ingestCodex(meta('work'),'work');l.ingestCodex(count(100,10,at),'work');l.ingestCodex(count(150,20,'2026-10-07T16:01:01Z'),'work');
 l.ingestCodex({...meta('chat'),payload:{...meta('chat').payload,originator:'whale_companion'}},'chat');l.ingestCodex(count(30,5,'2026-10-07T16:02:00Z'),'chat');
 assert.equal(l.snapshot().totals.codex.total,205);assert.equal(l.snapshot().workSinceStart,60);
 const restored=new UsageLedger(l.serialize());restored.workStartedAt=Date.parse('2026-10-07T16:03:00Z');assert.equal(restored.snapshot().workSinceStart,0);
});

test('Companion origin survives legacy metadata whose ID differs from the log filename',()=>{
 const l=new UsageLedger();l.workStartedAt=Date.parse(at)-1000;
 l.ingestCodex({...meta('own-companion'),payload:{...meta('own-companion').payload,originator:'whale_companion'}},'companion','companion.jsonl');
 l.ingestCodex(count(30,5),'companion','companion.jsonl');
 const snapshot=l.snapshot();assert.equal(snapshot.sessions[0].companion,true);assert.equal(snapshot.sessions[0].origin,'whale_companion');assert.equal(snapshot.workSinceStart,0);
});

test('Legacy paginated user continuations share the family counter, while embedded child history stays isolated',()=>{
 const l=new UsageLedger();l.ingestCodex(meta('family'),'family');l.ingestCodex(count(1000,100),'family');
 const pageMeta={type:'session_meta',ordinal:400,timestamp:'2026-10-07T17:00:00Z',payload:{id:'family',session_id:'family',thread_source:'user',history_mode:'paginated',history_base:{thread_id:'family',end_ordinal_exclusive:400},cwd:'E:\\work'}};
 const page=l.ingestCodex(pageMeta,'new-page');assert.equal(page,'family');l.ingestCodex(count(1100,120,'2026-10-07T17:00:01Z'),page);assert.equal(l.snapshot().totals.codex.total,1220);
 l.ingestCodex({type:'session_meta',ordinal:0,timestamp:at,payload:{id:'child',session_id:'family',parent_thread_id:'family',thread_source:'subagent',history_mode:'paginated',subagent_history_start_ordinal:10}},'child');
 assert.equal(l.ingestCodex({...pageMeta,ordinal:1},'child'),'child');l.ingestCodex({...count(1100,120),ordinal:2},'child');l.ingestCodex({...count(40,5,'2026-10-07T17:00:02Z'),ordinal:11},'child');
 assert.equal(l.snapshot().totals.codex.total,1265);assert.equal(l.snapshot().sessions.find(s=>s.id==='child').usage.total,45);
});

test('A new recorded turn context supersedes a previous completion without inferring completion from silence',()=>{
 const l=new UsageLedger();l.ingestCodex(meta('one'),'one');l.ingestCodex({type:'event_msg',timestamp:at,payload:{type:'task_complete'}},'one');
 l.ingestCodex({type:'turn_context',timestamp:'2026-10-07T16:01:00Z',payload:{model:'gpt-6.1-sol',cwd:'E:\\work'}},'one');assert.equal(l.snapshot(Date.parse('2026-10-07T16:01:20Z')).sessions[0].displayStatus,'running');
 assert.equal(l.snapshot(Date.parse('2026-10-07T16:04:00Z')).sessions[0].displayStatus,'unknown');
 l.ingestCodex({type:'event_msg',timestamp:'2026-10-07T16:02:00Z',payload:{type:'task_complete'}},'one');assert.equal(l.snapshot().sessions[0].status,'completed');
});
