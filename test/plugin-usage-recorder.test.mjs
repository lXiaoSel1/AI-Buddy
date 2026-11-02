import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createPluginUsageRecorder} from '../src/plugin-usage-recorder.mjs';
import {TokenMonitor} from '../src/token-monitor.mjs';
import {defaultTokenSources} from '../src/token-sources.mjs';
import {parseTokenRecord} from '../src/token-adapters.mjs';

// These are actual recorder/SQLite/monitor paths with controlled log fixtures.
// No engine, account, model inference, production data, or real UI is used.
const executionRoot=resolve(process.env.AI_BUDDY_PLUGIN_TEST_ROOT??resolve(import.meta.dirname,'../local/test-fixtures')),at='2026-10-24T12:00:00.000Z';
async function fixture(){const base=join(executionRoot,'test-data');await mkdir(base,{recursive:true});return await mkdtemp(join(base,'buddy-plugin-usage-'));}
const value=(nativeRequestId,extra={})=>({pluginId:'test.usage',sessionId:'host-session',nativeRequestId,engine:'test-engine',nativeSessionId:'native-session',usageMode:'request',origin:'managed-receipt',accounting:'independent',model:'test-model',provider:'test-provider',purpose:'work',timestamp:at,usage:{inputTokens:10,outputTokens:2,totalTokens:12},...extra});
const rows=async root=>(await readFile(join(root,'plugin-usage.jsonl'),'utf8')).trim().split('\n').map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);
async function monitor(t,root,extraRoots=[]){let current;const instance=new TokenMonitor({home:root,env:{},dataRoot:join(root,'monitor'),roots:[{provider:'companion',path:join(root,'plugin-usage.jsonl')},...extraRoots],onUpdate:v=>{current=v;}});await instance.prices.ready;assert.equal(instance.prices.state.autoUpdate,false);await instance.start();t.after(()=>instance.close());return {instance,get current(){return current;}};}

test('durable native receipt dedup survives restart, rejects changed evidence, and never repeats notification',async t=>{
 const root=await fixture(),seen=[];let r=createPluginUsageRecorder({dataRoot:root,onRecorded:v=>seen.push(v)});t.after(()=>r.close());
 const first=await r.record(value('one'));assert.equal(first.duplicate,false);assert.equal(first.idempotencyKey,'test.usage:host-session:one');
 assert.equal((await r.record(value('one'))).duplicate,true);await r.close();r=createPluginUsageRecorder({dataRoot:root,onRecorded:v=>seen.push(v)});
 assert.equal((await r.record(value('one',{sourceEvidenceId:'a-new-host-registration'}))).duplicate,true);assert.equal(seen.length,1);assert.equal((await rows(root)).length,1);
 await assert.rejects(r.record(value('one',{usage:{totalTokens:999}})),{code:'PLUGIN_USAGE_CONFLICT'});await assert.rejects(r.record(value('two',{idempotencyKey:'forged:key'})),{code:'PLUGIN_USAGE_IDENTITY_MISMATCH'});
 await r.record(value('one',{sessionId:'another-host-session',nativeSessionId:'another-native-session'}));assert.equal((await rows(root)).length,2);
 await r.close();await assert.rejects(r.record(value('after-close')),{code:'PLUGIN_USAGE_CLOSED'});
});

test('missing IDs, counters and explicit modes remain unknown with original evidence retained',async t=>{
 const root=await fixture(),r=createPluginUsageRecorder({dataRoot:root});t.after(()=>r.close());
 for(const [id,extra]of [['no-id',{nativeRequestId:null}],['no-mode',{usageMode:null}],['no-usage',{usage:null}],['no-native-session',{nativeSessionId:null}],['bad-count',{usage:{totalTokens:-10}}],['implicit-native',{engine:'codex',origin:'plugin-request'}],['partial-count',{usage:{inputTokens:5}}],['overflow',{usage:{inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:1}}]])assert.equal((await r.record(value(id,extra))).monitorDisposition,'unknown');
 const all=await rows(root);assert.equal(all[0].nativeRequestId,null);assert.equal(all[0].idempotencyKey,null);assert.equal(all[0].timestampBasis,'native-event');assert.ok(all.every(row=>row.accountedCounters===null&&row.billable===false));
 const m=await monitor(t,root);assert.equal(m.current.totals.companion.total,0);assert.equal(m.current.missingRequests,8);
});

test('parent total alone counts; child detail, native-log and core ModelRouter mirrors stay diagnostic',async t=>{
 const root=await fixture(),r=createPluginUsageRecorder({dataRoot:root});t.after(()=>r.close());
 await r.record(value('parent',{accounting:'parent-total',usage:{totalTokens:100}}));await r.record(value('child',{accounting:'child-detail',parentNativeRequestId:'parent',usage:{totalTokens:40}}));
 await r.record(value('native-mirror',{engine:'codex',origin:'native-log',usageMode:'cumulative',cumulative:{totalTokens:800}}));await r.record(value('router-mirror',{origin:'core-model-router',usage:{totalTokens:900}}));
 const all=await rows(root);assert.equal(all.length,4);assert.equal(all.filter(v=>v.monitorDisposition==='count').length,1);assert.equal(all[1].usage.totalTokens,40);assert.equal(all[2].cumulative.totalTokens,800);
 const m=await monitor(t,root);assert.equal(m.current.totals.companion.total,100);assert.equal(m.current.totals.companion.requests,1);assert.equal(m.current.missingRequests,0);
});

test('explicit native deltas stay request deltas and do not become invented cumulative counters',async t=>{
 const root=await fixture(),r=createPluginUsageRecorder({dataRoot:root});t.after(()=>r.close());
 await r.record(value('delta-1',{usageMode:'delta',usage:{totalTokens:120}}));await r.record(value('delta-2',{usageMode:'delta',usage:{totalTokens:70},timestamp:'2026-10-24T12:00:01Z'}));
 const all=await rows(root),s={tool:'companion',id:'fixture'};assert.ok(all.every(row=>row.cumulative===null));assert.ok(all.every((row,i)=>parseTokenRecord(s,row,{},'fixture.jsonl',i)[0].mode==='request'));
 const m=await monitor(t,root);assert.equal(m.current.totals.companion.total,190);assert.equal(m.current.totals.companion.requests,2);
 await m.instance.close();const reopened=await monitor(t,root);assert.equal(reopened.current.totals.companion.total,190);
});

test('only actual cumulative counters form a high-water series; missing or changed modes stay unknown',async t=>{
 const root=await fixture(),r=createPluginUsageRecorder({dataRoot:root});t.after(()=>r.close());
 await r.record(value('cum-1',{usageMode:'cumulative',usage:{totalTokens:120},cumulative:{totalTokens:120}}));await r.record(value('cum-2',{usageMode:'cumulative',usage:{totalTokens:70},cumulative:{totalTokens:190},timestamp:'2026-10-24T12:00:01Z'}));
 assert.equal((await r.record(value('cum-missing',{usageMode:'cumulative',usage:{totalTokens:50},timestamp:'2026-10-24T12:00:02Z'}))).monitorDisposition,'unknown');
 assert.equal((await r.record(value('mode-changed',{usageMode:'delta',usage:{totalTokens:50},timestamp:'2026-10-24T12:00:03Z'}))).monitorDisposition,'unknown');
 const all=await rows(root);assert.equal(all[1].usage.totalTokens,70);assert.equal(all[1].cumulative.totalTokens,190);assert.match(all[3].qualityReasons.join(','),/counter-mode-changed/);
 const m=await monitor(t,root);assert.equal(m.current.totals.companion.total,190);assert.equal(m.current.missingRequests,2);
});

test('actual native Codex, Claude and core API fixture logs plus managed mirrors count each authority once',async t=>{
 const root=await fixture(),codex=join(root,'native-codex'),claude=join(root,'native-claude'),workspace=join(root,'project');await mkdir(codex);await mkdir(claude);await mkdir(workspace);
 const nativeSession='11111111-2222-3333-4444-555555555555';
 await writeFile(join(codex,'rollout-2026-10-24T12-00-00-'+nativeSession+'.jsonl'),[
 {type:'session_meta',timestamp:at,payload:{id:nativeSession,cwd:workspace,originator:'ai_buddy_work',model_provider:'openai'}},
 {type:'event_msg',timestamp:at,payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,output_tokens:20,total_tokens:120}}}}
 ].map(v=>JSON.stringify(v)).join('\n')+'\n');
 await writeFile(join(claude,'claude-real-session.jsonl'),JSON.stringify({type:'assistant',timestamp:at,sessionId:'claude-real-session',cwd:workspace,message:{id:'msg-native',model:'claude-opus',stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:2}}})+'\n');
 const r=createPluginUsageRecorder({dataRoot:root});t.after(()=>r.close());
 await r.record(value('codex-native',{engine:'codex',nativeSessionId:nativeSession,origin:'native-log',usageMode:'cumulative',cumulative:{totalTokens:120}}));await r.record(value('msg-native',{engine:'claude',nativeSessionId:'claude-real-session',origin:'native-log',usage:{totalTokens:12}}));
 const coreApiLog=join(root,'api-usage.jsonl');await writeFile(coreApiLog,JSON.stringify({timestamp:at,sessionId:'core-chat',requestId:'core-api',provider:'anthropic',model:'claude-opus',purpose:'galgame',usage:{total_tokens:4}})+'\n');await r.record(value('core-api',{origin:'core-model-router',usage:{totalTokens:4},purpose:'galgame'}));
 // When no readable native source is registered, a fully attested managed receipt
 // is an independent authority. This is explicit, never a mirror fallback guess.
 await r.record(value('managed-only',{engine:'dsh',nativeSessionId:'no-native-log',origin:'managed-receipt',usageMode:'delta',usage:{totalTokens:7}}));
 const nativeRoots=[{provider:'codex',path:codex},{provider:'claude',path:claude},{provider:'companion',path:coreApiLog}],m=await monitor(t,root,nativeRoots);assert.equal(m.current.totals.codex.total,120);assert.equal(m.current.totals.claude.total,12);assert.equal(m.current.totals.companion.total,11);assert.equal(m.current.workTotal,139);
 const before=await readFile(join(root,'plugin-usage.jsonl'));await m.instance.close();const again=await monitor(t,root,nativeRoots);assert.equal(again.current.workTotal,139);assert.deepEqual(await readFile(join(root,'plugin-usage.jsonl')),before);
});

test('durable outbox detects a completed append after interrupted export without appending again',async t=>{
 const root=await fixture();let r=createPluginUsageRecorder({dataRoot:root});await r.record(value('one'));await r.close();const before=await readFile(join(root,'plugin-usage.jsonl')),db=new DatabaseSync(join(root,'plugin-usage-index-v1','receipts.sqlite'));db.exec('UPDATE receipts SET exported=0');db.close();
 r=createPluginUsageRecorder({dataRoot:root});t.after(()=>r.close());assert.equal((await r.record(value('one'))).duplicate,true);assert.deepEqual(await readFile(join(root,'plugin-usage.jsonl')),before);
});

test('partial JSONL tails are retained as evidence and do not prevent later durable records',async t=>{
 const root=await fixture(),partial='{"interrupted_receipt":';await writeFile(join(root,'plugin-usage.jsonl'),partial);const r=createPluginUsageRecorder({dataRoot:root});t.after(()=>r.close());await r.record(value('after-partial'));
 assert.ok((await readFile(join(root,'plugin-usage.jsonl'),'utf8')).startsWith(partial+'\n'));assert.equal((await rows(root)).length,1);const m=await monitor(t,root);assert.equal(m.current.totals.companion.total,12);
});

test('plugin log is a default readable source; diagnostics cannot be counted by the generic adapter',async()=>{
 const root=await fixture(),sources=defaultTokenSources({home:root,env:{},dataRoot:root});assert.equal(sources.filter(v=>v.path===join(root,'plugin-usage.jsonl')&&v.tool==='companion').length,1);
 const source={id:'test',tool:'companion'};assert.deepEqual(parseTokenRecord(source,{type:'plugin-usage',schemaVersion:1,monitorDisposition:'diagnostic',billable:true,usage:{totalTokens:999}}, {},'fixture.jsonl',0),[]);assert.deepEqual(parseTokenRecord(source,{type:'plugin-usage',usage:{totalTokens:999}}, {},'fixture.jsonl',0),[]);
});
