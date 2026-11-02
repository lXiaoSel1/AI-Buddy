import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {UsageRewardOutbox} from '../src/usage-reward-outbox.mjs';

function fixture(t){
 const sqlite=new DatabaseSync(':memory:'),meta=new Map(),trace=[];
 t.after(()=>sqlite.close());
 const db={exec(sql){trace.push(sql);return sqlite.exec(sql);},prepare(sql){return sqlite.prepare(sql);}};
 const outbox=new UsageRewardOutbox({db,meta(key,value){if(arguments.length===2)meta.set(key,value);return meta.get(key);}},{now:()=>1000});
 for(let n=0;n<4;n++)outbox.observe({tool:'codex',sessionId:'session',requestId:'request-'+n,timestamp:new Date(2000).toISOString(),usage:{total:100+n}},{live:true});
 trace.length=0;return {sqlite,outbox,trace,ids:outbox.pending().map(row=>row.seq),requests:()=>sqlite.prepare('SELECT * FROM reward_requests ORDER BY id').all()};
}
test('second delete abort rolls back the whole ACK batch and permits an exact retry',t=>{
 const f=fixture(t),before=f.outbox.pending(),facts=f.requests();
 f.sqlite.exec("CREATE TEMP TRIGGER ack_fault BEFORE DELETE ON reward_outbox WHEN OLD.seq="+f.ids[1]+" BEGIN SELECT RAISE(ABORT,'injected second delete');END;");
 assert.throws(()=>f.outbox.ack(f.ids),/injected second delete/);assert.deepEqual(f.outbox.pending(),before,'first delete must not escape the failed transaction');assert.deepEqual(f.requests(),facts,'ACK never changes canonical reward facts');
 f.sqlite.exec('DROP TRIGGER ack_fault');f.outbox.ack(f.ids);assert.deepEqual(f.outbox.pending(),[]);assert.deepEqual(f.requests(),facts);
});
test('one successful batch uses one outer atomic SQL boundary',t=>{
 const f=fixture(t);f.outbox.ack(f.ids);assert.equal(f.trace.length,2,'one begin/savepoint and one commit/release for the whole batch');assert.match(f.trace[0],/^(?:SAVEPOINT|BEGIN)\b/i);assert.match(f.trace[1],/^(?:RELEASE|COMMIT)\b/i);assert.equal(f.outbox.pending().length,0);
});
test('empty ACK is a no-op with no SQLite transaction',t=>{const f=fixture(t),before=f.outbox.pending();assert.equal(f.outbox.ack([]),undefined);assert.deepEqual(f.outbox.pending(),before);assert.deepEqual(f.trace,[]);});
test('duplicates, already ACKed and unknown sequences remain idempotent',t=>{
 const f=fixture(t),facts=f.requests(),input=[f.ids[0],f.ids[0],999999],copy=[...input];assert.equal(f.outbox.ack(input),undefined);assert.deepEqual(input,copy);assert.deepEqual(f.outbox.pending().map(row=>row.seq),f.ids.slice(1));f.outbox.ack(input);assert.deepEqual(f.outbox.pending().map(row=>row.seq),f.ids.slice(1));assert.deepEqual(f.requests(),facts);
});
test('every invalid sequence is rejected before any deletion',t=>{
 const f=fixture(t),before=f.outbox.pending();
 for(const invalid of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'1',1n,null,undefined]){assert.throws(()=>f.outbox.ack([f.ids[0],invalid]),/Invalid reward outbox ACK/);assert.deepEqual(f.outbox.pending(),before);}
 for(const invalid of [null,undefined,{},'1',new Set(f.ids),new Uint32Array(f.ids)]){assert.throws(()=>f.outbox.ack(invalid),/Invalid reward outbox ACK/);assert.deepEqual(f.outbox.pending(),before);}
 assert.deepEqual(f.trace,[],'invalid requests must never enter a transaction');
});
test('sparse arrays are invalid before a valid prefix can be deleted',t=>{const f=fixture(t),before=f.outbox.pending(),sparse=[f.ids[0]];sparse.length=3;assert.throws(()=>f.outbox.ack(sparse),/Invalid reward outbox ACK/);assert.deepEqual(f.outbox.pending(),before);assert.deepEqual(f.trace,[]);});
test('nested ACK does not commit its caller transaction',t=>{const f=fixture(t),before=f.outbox.pending();f.sqlite.exec('BEGIN');f.outbox.ack([f.ids[0],f.ids[1]]);assert.deepEqual(f.outbox.pending().map(row=>row.seq),f.ids.slice(2));f.sqlite.exec('ROLLBACK');assert.deepEqual(f.outbox.pending(),before);});
test('failed ACK inside an outer transaction preserves unrelated caller changes',t=>{
 const f=fixture(t),before=f.outbox.pending();f.sqlite.exec('CREATE TABLE caller_state(value TEXT)');f.sqlite.exec('BEGIN');f.sqlite.exec("INSERT INTO caller_state VALUES('retained')");f.sqlite.exec("CREATE TEMP TRIGGER ack_outer_fault BEFORE DELETE ON reward_outbox WHEN OLD.seq="+f.ids[1]+" BEGIN SELECT RAISE(ABORT,'nested ACK fault');END;");assert.throws(()=>f.outbox.ack(f.ids),/nested ACK fault/);assert.deepEqual(f.outbox.pending(),before);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM caller_state').get().n,1);f.sqlite.exec('COMMIT');assert.equal(f.sqlite.prepare('SELECT value FROM caller_state').get().value,'retained');
});
