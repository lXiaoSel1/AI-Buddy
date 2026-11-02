import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createEconomyStore,MAX_REWARD_FACT_BATCH} from '../src/companion-economy-store.mjs';
import {createFeedingService} from '../src/companion-feeding.mjs';
// Independent frozen pre-fix implementation: per-fact results and persisted
// financial evidence must stay identical, not merely produce the same total.
import {createEconomyStore as createOriginal} from './fixtures/reward-pre-batch/companion-economy-store.mjs';

test('reward oracle is a self-contained exact frozen pre-batch implementation',()=>{
 const manifest=JSON.parse(readFileSync(new URL('./fixtures/reward-pre-batch/MANIFEST.json',import.meta.url),'utf8'));
 assert.equal(manifest.format,'ai-buddy-frozen-reward-oracle');assert.equal(manifest.files.length,3);
 assert.notStrictEqual(createOriginal,createEconomyStore);
 for(const row of manifest.files){assert.ok(['companion-economy-store.mjs','food-catalog.mjs','reward-facts.mjs'].includes(row.file));const bytes=readFileSync(new URL('./fixtures/reward-pre-batch/'+row.file,import.meta.url));assert.equal(bytes.length,row.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),row.sha256);}
 assert.equal(manifest.files.find(row=>row.file==='companion-economy-store.mjs').sha256,'fd64d073b3b171b827eacd5636c86ab16dd053dc7d272ed8425e196506a362fd');
});

const fixedNow=()=>Date.UTC(2026,9,26),trusted={trusted:true};
const scope={characterId:'deepseek',personaId:'default',lifeId:'life-a',operationId:'operation-a'};
const fact=(id,units,revision=1,extra={})=>({canonicalRequestId:id,totalTokens:units,revision,origin:'native-ledger',...extra});
const fallback=(id,count=1,revision=1)=>({canonicalRequestId:id,revision,basis:'cg-fallback',origin:'cg-completion',status:'ready',completedImageIds:Array.from({length:count},(_,i)=>'image-'+i)});
function fixture(t,create=createEconomyStore){
 const root=mkdtempSync(join(tmpdir(),'r95-reward-batch-'));let store=create(root,{now:fixedNow});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 return {root,get store(){return store;},reopen(){store.close();store=create(root,{now:fixedNow});return store;}};
}
function snapshot(path){const db=new DatabaseSync(path,{readOnly:true});try{return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,JSON.parse(JSON.stringify(db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()))]));}finally{db.close();}}
function schema(path){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all().map(r=>({...r}));}finally{db.close();}}
function reference(original,rows,options=trusted){return rows.map(row=>original.ingestUsageFact(row,options));}
function countTransactions(run){
 const original=DatabaseSync.prototype.exec,calls=[];
 DatabaseSync.prototype.exec=function(sql){if(/^(?:SAVEPOINT|RELEASE|ROLLBACK TO) economy_/.test(sql))calls.push(sql);return original.call(this,sql);};
 try{return {result:run(),calls};}finally{DatabaseSync.prototype.exec=original;}
}

test('reward batch preserves frozen per-fact results, complete ledgers, metadata and schema for mixed baselines/revisions',t=>{
 const {store}=fixture(t),old=fixture(t,createOriginal).store;
 const initialization=[fact('history',10000),fact('history',20000,2),fact('history-diagnostic',10000,1,{accounting:'child-detail'})];
 assert.deepEqual(store.initializeRewards({facts:initialization,cursor:'original-start'}),old.initializeRewards({facts:initialization,cursor:'original-start'}));
 const rows=[fact('history',25000,3),fact('new-import',100000,1,{baseline:true}),fact('new-import',110000,2),fact('new-live',9999),fact('rounding',1),fact('new-live',9999),fact('new-live',4000,0),fallback('cg:1',8),fact('cg:1',20000,2),fallback('cg:1',10,3),{canonicalRequestId:'official',revision:1,basis:'official-equivalent',origin:'verified-rule',units:3000,ruleRef:'rule-v1',ruleSha256:'a'.repeat(64)},fact('replay',50000,1,{replay:true}),fact('diagnostic',50000,1,{accounting:'child-detail'}),fact('missing',null),{canonicalRequestId:'unverified-equivalence',basis:'official-equivalent',units:100000}];
 const expected=reference(old,rows),actual=store.ingestUsageFacts(rows,trusted);
 assert.deepEqual(actual,expected);assert.deepEqual(snapshot(store.path),snapshot(old.path));assert.deepEqual(schema(store.path),schema(old.path));
 assert.notStrictEqual(actual[0].wallet,actual[1].wallet);actual[0].wallet.balance=999;
 assert.equal(actual[1].wallet.balance,expected[1].wallet.balance);assert.deepEqual(store.wallet(),old.wallet());
});

test('reward batch without initialization preserves original all-baseline semantics and later cursor initialization',t=>{
 const store=fixture(t).store,old=fixture(t,createOriginal).store,rows=[fact('h',9999),fact('h',20000,2),fact('second',70000)];
 assert.deepEqual(store.ingestUsageFacts(rows,trusted),reference(old,rows));assert.deepEqual(store.wallet(),{balance:0,remainder:0,debtUnits:0});
 store.initializeRewards({cursor:'baseline-done'});old.initializeRewards({cursor:'baseline-done'});
 assert.deepEqual(store.ingestUsageFacts([fact('h',25000,3)],trusted),reference(old,[fact('h',25000,3)]));assert.deepEqual(snapshot(store.path),snapshot(old.path));
});

test('reward batch preserves downward correction debt and progressive repayments after actual purchases',t=>{
 const store=fixture(t).store,old=fixture(t,createOriginal).store;
 for(const s of [store,old]){s.initializeRewards({cursor:'empty'});s.ensureScope(scope);s.ingestUsageFact(fact('spendable',20000),trusted);s.purchase({foodId:'rice',requestId:'rice',scope});}
 const rows=[fact('spendable',5000,2),fact('fresh-a',9999),fact('fresh-b',5001),fact('fresh-c',15000),fact('fresh-c',0,2),fact('fresh-d',20000)];
 const actual=store.ingestUsageFacts(rows,trusted),expected=reference(old,rows);
 assert.deepEqual(actual,expected);assert.deepEqual(actual.map(r=>r.wallet.debtUnits),[15000,5001,0,0,0,0]);
 assert.deepEqual(snapshot(store.path),snapshot(old.path));
});

test('second-row injected SQL abort rolls back wallet, facts, ledger and sequence for the whole batch',t=>{
 const {store}=fixture(t);store.initializeRewards({cursor:'ready'});
 const db=new DatabaseSync(store.path);try{db.exec("CREATE TRIGGER injected_second BEFORE INSERT ON reward_facts WHEN NEW.id='sql-fail' BEGIN SELECT RAISE(ABORT,'injected second row'); END;");}finally{db.close();}
 const before=snapshot(store.path),observed=countTransactions(()=>assert.throws(()=>store.ingestUsageFacts([fact('first',20000),fact('sql-fail',30000),fact('never',10000)],trusted),/injected second row/));
 assert.equal(observed.calls.filter(x=>x.startsWith('SAVEPOINT ')).length,1);assert.equal(observed.calls.filter(x=>x.startsWith('ROLLBACK TO ')).length,1);
 assert.deepEqual(snapshot(store.path),before);
 const remove=new DatabaseSync(store.path);try{remove.exec('DROP TRIGGER injected_second');}finally{remove.close();}
 const result=store.ingestUsageFacts([fact('first',20000),fact('sql-fail',30000)],trusted);assert.equal(result[1].wallet.balance,5);
});

test('late conflicting revision rolls back accepted prefix and retry/restart remain idempotent',t=>{
 const f=fixture(t);f.store.initializeRewards({cursor:'ready'});f.store.ingestUsageFact(fact('existing',10000),trusted);const before=snapshot(f.store.path);
 assert.throws(()=>f.store.ingestUsageFacts([fact('new-prefix',20000),fact('existing',11000)],trusted),{code:'REWARD_FACT_CONFLICT'});assert.deepEqual(snapshot(f.store.path),before);
 const rows=[fact('new-prefix',20000),fact('existing',11000,2)],expected=f.store.ingestUsageFacts(rows,trusted);assert.equal(expected[1].wallet.balance,3);
 const committed=snapshot(f.store.path);f.reopen();const repeated=f.store.ingestUsageFacts(rows,trusted);assert.ok(repeated.every(r=>r.duplicate));assert.deepEqual(snapshot(f.store.path),committed);
});

test('bounded batch validates all input before mutation and uses exactly one transaction',t=>{
 const {store}=fixture(t);store.initializeRewards({cursor:'ready'});const before=snapshot(store.path);
 assert.throws(()=>store.ingestUsageFacts({length:1},trusted),{code:'REWARD_BATCH_INVALID'});assert.throws(()=>store.ingestUsageFacts(Array(MAX_REWARD_FACT_BATCH+1),trusted),{code:'REWARD_BATCH_INVALID'});
 assert.throws(()=>store.ingestUsageFacts([fact('valid-prefix',10000),fact('invalid',-1)],trusted),/非负安全整数/);assert.deepEqual(snapshot(store.path),before);
 const sparse=[fact('sparse-prefix',10000),,fact('sparse-end',10000)];assert.throws(()=>store.ingestUsageFacts(sparse,trusted),/用量事实无效/);assert.deepEqual(snapshot(store.path),before);
 assert.throws(()=>store.ingestUsageFacts([fact('not-trusted',10000)]),{code:'REWARD_TRUST_REQUIRED'});
 assert.deepEqual(countTransactions(()=>store.ingestUsageFacts([],trusted)),{result:[],calls:[]});
 const ignored=countTransactions(()=>store.ingestUsageFacts([fact('r',10000,1,{replay:true})],trusted));assert.equal(ignored.result[0].accepted,false);assert.deepEqual(ignored.calls,[]);
 const rows=Array.from({length:MAX_REWARD_FACT_BATCH},(_,i)=>fact('bounded-'+i,10000));
 rows[Symbol.iterator]=function*(){throw Error('custom batch iterator must not run');};
 const observed=countTransactions(()=>store.ingestUsageFacts(rows,trusted));assert.equal(observed.result.length,MAX_REWARD_FACT_BATCH);assert.equal(observed.calls.length,2);assert.ok(observed.calls[0].startsWith('SAVEPOINT '));assert.ok(observed.calls[1].startsWith('RELEASE '));assert.equal(store.wallet().balance,MAX_REWARD_FACT_BATCH);
});

test('batch-local wallet cache is refreshed for later purchases and independent committed writers',t=>{
 const {store,root}=fixture(t);store.initializeRewards({cursor:'ready'});store.ensureScope(scope);store.ingestUsageFacts([fact('a',20000),fact('b',10000)],trusted);store.purchase({scope,foodId:'rice',requestId:'spend'});
 const other=createEconomyStore(root,{now:fixedNow});try{other.ingestUsageFact(fact('external',10000),trusted);}finally{other.close();}
 const result=store.ingestUsageFacts([fact('c',9999),fact('d',1)],trusted);assert.deepEqual(result.map(x=>x.wallet),[{balance:2,remainder:9999,debtUnits:0},{balance:3,remainder:0,debtUnits:0}]);
});

function measuredService(t,{subscribe=false}={}){
 const f=fixture(t),calls={view:0,ledger:0,notify:0},proxy=new Proxy(f.store,{get(target,key){if(key==='view')return (...args)=>{calls.view++;return target.view(...args);};if(key==='ledgerPage')return (...args)=>{calls.ledger++;return target.ledgerPage(...args);};return Reflect.get(target,key);}});
 const service=createFeedingService({store:proxy,now:fixedNow,...subscribe?{onState:()=>calls.notify++}:{}});t.after(()=>service.close());service.initializeRewards({cursor:'ready'});Object.assign(calls,{view:0,ledger:0,notify:0});return {service,calls,store:f.store};
}
test('no default subscriber means neither single nor batch ingestion computes a full view or ledger count',t=>{
 const {service,calls}=measuredService(t);service.ingestUsageFacts([fact('a',10000),fact('b',10000)],trusted);service.ingestUsageFact(fact('c',10000),trusted);
 assert.deepEqual(calls,{view:0,ledger:0,notify:0});assert.equal(service.view().wallet.balance,3);
});
test('one subscriber notification per committed nonempty batch, none for empty or aborted batch',t=>{
 const {service,calls,store}=measuredService(t,{subscribe:true});service.ingestUsageFacts([fact('a',10000),fact('b',10000)],trusted);assert.deepEqual(calls,{view:1,ledger:1,notify:1});
 service.ingestUsageFacts([],trusted);assert.throws(()=>service.ingestUsageFacts([fact('prefix',10000),fact('a',11000)],trusted),{code:'REWARD_FACT_CONFLICT'});assert.deepEqual(calls,{view:1,ledger:1,notify:1});assert.equal(store.wallet().balance,2);
});
test('SQL failure cannot notify a subscriber or leave accepted-prefix reward evidence',t=>{
 const {service,calls,store}=measuredService(t,{subscribe:true});const db=new DatabaseSync(store.path);try{db.exec("CREATE TRIGGER injected_notify BEFORE INSERT ON reward_facts WHEN NEW.id='stop' BEGIN SELECT RAISE(ABORT,'notification batch abort'); END;");}finally{db.close();}
 const before=snapshot(store.path);assert.throws(()=>service.ingestUsageFacts([fact('prefix',10000),fact('stop',20000)],trusted),/notification batch abort/);assert.deepEqual(calls,{view:0,ledger:0,notify:0});assert.deepEqual(snapshot(store.path),before);
});
