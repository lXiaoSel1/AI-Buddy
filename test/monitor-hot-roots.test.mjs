import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalMonitor} from '../src/monitor.mjs';
import {TokenMonitor} from '../src/token-monitor.mjs';
test('managed roots update without replaying history, changing reward epoch or retaining removed watchers',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hot-roots-')),dataRoot=join(root,'data'),logs=join(root,'logs');await mkdir(logs);await mkdir(dataRoot);
 const line=(id,n)=>JSON.stringify({type:'session_meta',timestamp:'2026-10-30T10:00:00Z',payload:{id,cwd:root}})+'\n'+JSON.stringify({type:'event_msg',timestamp:'2026-10-30T10:01:00Z',payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,output_tokens:1}}}})+'\n';
 const a=join(logs,'a.jsonl'),b=join(logs,'b.jsonl');await writeFile(a,line('a',10));await writeFile(b,line('b',20));const sources=[{tool:'codex',path:a,enabled:true}],host={options:{dataRoot},sources:{list:()=>sources},repository:null,refreshIntervalMs:1000,errors:new Map(),emit(){}};
 t.after(async()=>{await host.legacy?.close();await rm(root,{recursive:true,force:true});});await TokenMonitor.prototype.restartLegacy.call(host);const original=host.legacy,ledger=original.ledger,epoch=original.startedAt,cursor=original.files.get(a);sources.push({tool:'codex',path:b,enabled:true});await TokenMonitor.prototype.restartLegacy.call(host);
 assert.equal(host.legacy,original);assert.equal(original.ledger,ledger);assert.equal(original.startedAt,epoch);assert.equal(original.files.get(a),cursor);assert.equal(original.snapshot().totals.codex.total,32);assert.equal(original.watchers.length,2);
 sources.shift();await TokenMonitor.prototype.restartLegacy.call(host);assert.equal(original.watchers.length,1);assert.equal(original.watches(a,'codex'),false);assert.equal(original.snapshot().totals.codex.total,32);assert.ok(original instanceof LocalMonitor);
});
