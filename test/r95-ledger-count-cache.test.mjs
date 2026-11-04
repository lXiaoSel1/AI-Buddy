import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createEconomyStore} from '../src/companion-economy-store.mjs';
import {createFeedingService} from '../src/companion-feeding.mjs';
import {createEconomyStore as createOld} from './fixtures/reward-pre-batch/companion-economy-store.mjs';

const scope={characterId:'deepseek',personaId:'default',lifeId:'life-a',operationId:'operation-a'},trusted={trusted:true};
const fact=(id,units=10000,revision=1)=>({canonicalRequestId:id,totalTokens:units,revision,origin:'native-ledger'});
function fixture(t,create=createEconomyStore){
 const root=mkdtempSync(join(tmpdir(),'ledger-cache-')),stores=[],open=(create=createEconomyStore)=>{const s=create(root);stores.push(s);return s;};
 t.after(()=>{for(const s of stores)s.close();rmSync(root,{recursive:true,force:true});});return {root,open,store:open(create)};
}
function scans(t){
 const prepare=DatabaseSync.prototype.prepare;let calls=0;
 DatabaseSync.prototype.prepare=function(sql){const stmt=prepare.call(this,sql);if(!/COUNT\(\*\) AS total FROM ledger/i.test(sql))return stmt;return new Proxy(stmt,{get(target,key){if(key==='get')return (...args)=>{calls++;return target.get(...args);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});};
 t.after(()=>{DatabaseSync.prototype.prepare=prepare;});return ()=>calls;
}
function external(store,fn){const db=new DatabaseSync(store.path);try{return fn(db);}finally{db.close();}}
const actual=store=>external(store,db=>db.prepare('SELECT count(seq) n FROM ledger').get().n);

test('idle feeding ticks scan the entire ledger only once despite hunger writes',async t=>{
 const count=scans(t),f=fixture(t);let time=0;const service=createFeedingService({store:f.store,monotonicNow:()=>time});t.after(()=>service.close());
 service.activeScope(scope);for(let i=0;i<50;i++){time+=1000;await service.tick();assert.equal(service.view().ledgerTotal,0);}
 assert.equal(count(),1);
});

test('successful reward revisions, purchases and meals update totals without rescans; retries do not increment',t=>{
 const count=scans(t),{store:s}=fixture(t);s.initializeRewards();s.ensureScope(scope);assert.equal(s.ledgerPage().total,0);
 s.ingestUsageFact(fact('earn',100000),trusted);assert.equal(s.ledgerPage().total,1);
 s.ingestUsageFact(fact('earn',120000,2),trusted);s.ingestUsageFact(fact('earn',120000,2),trusted);assert.equal(s.ledgerPage().total,2);
 const buy={foodId:'rice',requestId:'buy',scope};s.purchase(buy);s.purchase(buy);assert.equal(s.ledgerPage().total,3);
 s.settleHunger(scope,{elapsedMs:3600000});const meal={foodId:'rice',requestId:'meal',scope};s.consume(meal);s.consume(meal);
 assert.equal(s.ledgerPage().total,4);assert.equal(actual(s),4);assert.equal(count(),1);
});

test('late batch failure restores cached total as well as all financial rows',t=>{
 const count=scans(t),{store:s}=fixture(t);s.initializeRewards();s.ingestUsageFact(fact('exists'),trusted);assert.equal(s.ledgerPage().total,1);const before=s.wallet();
 assert.throws(()=>s.ingestUsageFacts([fact('prefix'),fact('exists',20000)],trusted),{code:'REWARD_FACT_CONFLICT'});
 assert.equal(s.ledgerPage().total,1);assert.equal(actual(s),1);assert.deepEqual(s.wallet(),before);
 s.ingestUsageFact(fact('prefix'),trusted);assert.equal(s.ledgerPage().total,2);assert.equal(count(),1);
});

test('outer failure undoes the count from a released nested purchase',t=>{
 const count=scans(t),{store:s}=fixture(t);s.initializeRewards();s.ensureScope(scope);s.ingestUsageFact(fact('earn',100000),trusted);s.settings({autoEat:true,autoBuyRice:true,allowedFoods:['rice']});s.settleHunger(scope,{elapsedMs:3600000});
 external(s,db=>db.exec("CREATE TRIGGER reject_meal BEFORE INSERT ON commands WHEN NEW.id='nested' BEGIN SELECT RAISE(ABORT,'injected meal failure'); END"));
 assert.equal(s.ledgerPage().total,1);const balance=s.wallet();
 assert.throws(()=>s.purchaseAndConsumeRice({scope,requestId:'nested'}),/injected meal failure/);
 assert.equal(s.ledgerPage().total,1);assert.equal(actual(s),1);assert.deepEqual(s.wallet(),balance);assert.equal(count(),1);
 external(s,db=>db.exec('DROP TRIGGER reject_meal'));s.purchaseAndConsumeRice({scope,requestId:'nested'});assert.equal(s.ledgerPage().total,3);assert.equal(actual(s),3);
});

test('external commits and deleted sequence gaps refresh exact totals, uncommitted rows do not',t=>{
 const count=scans(t),{store:s}=fixture(t);s.initializeRewards();s.ingestUsageFacts([fact('one'),fact('two'),fact('three')],trusted);assert.equal(s.ledgerPage().total,3);
 external(s,db=>{db.exec('BEGIN IMMEDIATE; DELETE FROM ledger WHERE seq=2');assert.equal(s.ledgerPage().total,3);db.exec('ROLLBACK');});
 assert.equal(s.ledgerPage().total,3);assert.equal(count(),1);
 external(s,db=>db.exec('DELETE FROM ledger WHERE seq=2'));assert.equal(s.ledgerPage().total,2);assert.equal(count(),2);
 s.ingestUsageFact(fact('four'),trusted);assert.equal(s.ledgerPage().total,3);assert.equal(actual(s),3);assert.equal(count(),2);
});

test('external insert followed by own insert before a view does not hide the external commit',t=>{
 const count=scans(t),f=fixture(t),s=f.store;s.initializeRewards();assert.equal(s.ledgerPage().total,0);const secondWriter=f.open();
 secondWriter.ingestUsageFact(fact('external'),trusted);s.ingestUsageFact(fact('new'),trusted);
 assert.equal(s.ledgerPage().total,2);assert.equal(actual(s),2);for(let i=0;i<10;i++)assert.equal(s.ledgerPage().total,2);assert.equal(count(),2);
});

test('migrate legacy rewards, refuse a stale writer and reopen with exact totals and idempotency',t=>{
 const f=fixture(t,createOld),old=f.store;old.initializeRewards();old.ingestUsageFact(fact('first',25000),trusted);assert.equal(old.ledgerPage().total,1);old.close();
 const current=f.open();assert.equal(current.ledgerPage().total,1);current.ingestUsageFact(fact('second',15000),trusted);
 const schema=external(current,db=>db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all());current.close();
 const bytes=readFileSync(current.path);
 assert.throws(()=>f.open(createOld),{code:'ECONOMY_SCHEMA_UNSUPPORTED'});assert.deepEqual(readFileSync(current.path),bytes);
 const next=f.open();assert.equal(next.ledgerPage().total,2);assert.equal(next.wallet().balance,4);next.ingestUsageFact(fact('second',15000),trusted);assert.equal(next.ledgerPage().total,2);
 assert.deepEqual(external(next,db=>db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()),schema);
});
