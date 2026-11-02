import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {UsageLedger} from '../src/ledger.mjs';
import {UsageRepository} from '../src/usage-repository.mjs';
import {GenericTokenLedger} from '../src/token-monitor.mjs';

function fixture(t){const root=mkdtempSync(join(tmpdir(),'snap-inc-')),repo=new UsageRepository(join(root,'usage.sqlite'));t.after(()=>{repo.close();rmSync(root,{recursive:true,force:true});});const reads=[],entries=repo.entries.bind(repo);repo.entries=function*(kind,options){for(const row of entries(kind,options)){reads.push([kind,row[1].session??row[1].sessionId]);yield row;}};return {repo,reads};}
const time='2026-10-30T10:00:00Z',now=Date.parse('2026-10-30T11:00:00Z');
function ingest(ledger,id,input=10,at=time,extra={}){ledger.ingestCodex({type:'session_meta',timestamp:time,payload:{id,cwd:'/project'}},id);ledger.ingestCodex({type:'event_msg',timestamp:at,payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,output_tokens:2},...extra}}},id);}
function normalized(value){return JSON.parse(JSON.stringify(value,(key,v)=>Array.isArray(v)&&!['active'].includes(key)?v.slice().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):v));}
test('persistent legacy snapshots touch only changed sessions and match original aggregation',t=>{
 const {repo,reads}=fixture(t),disk=new UsageLedger({},repo),oracle=new UsageLedger();disk.workStartedAt=oracle.workStartedAt=Date.parse(time);
 for(let i=0;i<12;i++){ingest(disk,'s'+i);ingest(oracle,'s'+i);}assert.deepEqual(normalized(disk.snapshot(now)),normalized(oracle.snapshot(now)));reads.length=0;
 disk.snapshot(now+1);assert.equal(reads.length,0);ingest(disk,'s4',20,'2026-10-30T10:01:00Z');ingest(oracle,'s4',20,'2026-10-30T10:01:00Z');
 assert.deepEqual(normalized(disk.snapshot(now)),normalized(oracle.snapshot(now)));assert.deepEqual([...new Set(reads.map(r=>r[1]))],['codex:s4']);
 reads.length=0;const view={key:'new-attribution',projectSession:s=>({...s,workspace:s.id==='s4'?'/common':s.workspace})};assert.deepEqual(normalized(disk.snapshot(now,view)),normalized(oracle.snapshot(now,view)));assert.equal(reads.length,0);
});
test('counter restarts, out of order deltas, timezone, start boundary and Claude reassignment invalidate the right folds',t=>{
 const {repo}=fixture(t),disk=new UsageLedger({},repo),oracle=new UsageLedger();
 for(const ledger of [disk,oracle]){ledger.workStartedAt=Date.parse('2026-10-30T10:00:30Z');ingest(ledger,'a',10);ingest(ledger,'a',30,'2026-10-30T10:01:00Z');ledger.snapshot(now);ingest(ledger,'a',20,'2026-10-30T10:00:40Z');ingest(ledger,'a',2,'2026-10-30T10:02:00Z',{last_token_usage:{input_tokens:2,output_tokens:2}});ledger.ingestClaude({type:'assistant',sessionId:'later',timestamp:time,message:{id:'shared',usage:{input_tokens:7,output_tokens:3}}},'later');ledger.snapshot(now);ledger.ingestClaude({type:'user',sessionId:'earlier',timestamp:'2026-10-29T10:00:00Z'},'earlier');ledger.ingestClaude({type:'assistant',sessionId:'earlier',timestamp:time,message:{id:'shared',usage:{input_tokens:8,output_tokens:3}}},'earlier');}
 assert.deepEqual(normalized(disk.snapshot(now)),normalized(oracle.snapshot(now)));disk.timeZone=oracle.timeZone='Asia/Shanghai';assert.deepEqual(normalized(disk.snapshot(now)),normalized(oracle.snapshot(now)));disk.workStartedAt=oracle.workStartedAt=now-1000;disk.cached=oracle.cached=null;assert.deepEqual(normalized(disk.snapshot(now)),normalized(oracle.snapshot(now)));
});
const event=(sessionId,n=10)=>({tool:'dsh',sessionId,requestId:'request',sourceId:'dsh',timestamp:time,model:'model',workspace:'/project',purpose:'work',status:'completed',usage:{input:n,output:2,total:n+2,requests:1},workEligible:true});
test('persistent generic snapshots retain corrections, overlap and missing fields with bounded reads',t=>{
 const {repo,reads}=fixture(t),disk=new GenericTokenLedger(repo),oracle=new GenericTokenLedger();disk.startedAt=oracle.startedAt=now-3600001;const sources=[{id:'dsh',tool:'dsh'}];
 for(let i=0;i<12;i++){disk.ingest(event('s'+i));oracle.ingest(event('s'+i));}assert.deepEqual(normalized(disk.snapshot(sources,now)),normalized(oracle.snapshot(sources,now)));reads.length=0;
 disk.ingest(event('s3',25));oracle.ingest(event('s3',25));assert.deepEqual(normalized(disk.snapshot(sources,now)),normalized(oracle.snapshot(sources,now)));assert.deepEqual([...new Set(reads.map(r=>r[1]))],['s3']);
 for(const ledger of [disk,oracle]){ledger.ingest({...event('s3',30),requestId:'c1',mode:'cumulative'});ledger.ingest({...event('s3',45),requestId:'c2',mode:'cumulative',timestamp:'2026-10-30T10:01:00Z'});ledger.ingest({...event('missing'),usage:{input:null,output:null,total:null,requests:1}});}
 assert.deepEqual(normalized(disk.snapshot(sources,now)),normalized(oracle.snapshot(sources,now)));sources[0].overlapGroup='same';sources[0].primary=false;assert.deepEqual(normalized(disk.snapshot(sources,now)),normalized(oracle.snapshot(sources,now)));
});
