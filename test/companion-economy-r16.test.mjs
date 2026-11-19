import assert from 'node:assert/strict';
import {channel} from 'node:diagnostics_channel';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {setTimeout as wait} from 'node:timers/promises';
import {createCgRewardFacts} from '../src/cg-reward-facts.mjs';
import {createEconomyStore} from '../src/companion-economy-store.mjs';

const scope={characterId:'synthetic-character',personaId:'synthetic-persona',lifeId:'synthetic-life',operationId:'synthetic-op'};
const label='synthetic-reward-id';

test('economy and CG use nonblocking WAL commits and report measured operations without bindings',async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-r16-economy-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const actualPragmas=[],originalPrepare=DatabaseSync.prototype.prepare;
 let clock=0,simulateSlow=false;
 const commitChannel=channel('ai-buddy.companion.economy-sql'),commits=[],audit=[];
 const collect=event=>commits.push(event);
 commitChannel.subscribe(collect);
 DatabaseSync.prototype.prepare=function(sql,...args){
  const stmt=originalPrepare.call(this,sql,...args);
  if(/^SELECT value FROM meta WHERE key='?schemaVersion'?|^SELECT value FROM meta WHERE key=\?$/.test(sql)){
   actualPragmas.push(...[['synchronous','synchronous'],['busy_timeout','timeout'],['journal_mode','journal_mode']].map(([name,key])=>{
    const row=originalPrepare.call(this,'PRAGMA '+name).get();
    return [name,row[key]];
   }));
  }
  if(sql.startsWith('UPDATE hunger SET satiety')){
   const run=stmt.run.bind(stmt);
   stmt.run=(...values)=>{if(simulateSlow)clock+=16;return run(...values);};
  }
  return stmt;
 };
 let economy,cg;
 try{
  const options={audit:event=>audit.push(event),sqlClock:()=>clock};
  economy=createEconomyStore(root,options);
  cg=createCgRewardFacts({dataRoot:root,...options});
  economy.ensureScope(scope);
  simulateSlow=true;
  assert.equal(economy.settleHunger(scope,{elapsedMs:3600000}).satiety,92);
  simulateSlow=false;
  assert.equal(cg.registerJob({id:label,rewardScope:scope}).id,label);
  assert.equal((await cg.recordUsage({cgJobId:label,usageReceiptId:'synthetic-receipt',usage:{total_tokens:23},scope})).accepted,true);
  for(const [name,value] of actualPragmas){
   if(name==='synchronous'||name==='busy_timeout')assert.equal(value,name==='synchronous'?1:0,name);
   if(name==='journal_mode')assert.equal(value,'wal',name);
  }
  assert.ok(actualPragmas.length>=6,'inspect both production connections');
  assert.ok(commits.some(row=>row.type==='companion-economy-commit'&&row.database==='economy'&&row.operation==='settle-hunger'));
  assert.ok(commits.some(row=>row.type==='companion-economy-commit'&&row.database==='cg-reward-facts'&&row.operation==='record-usage'));
  for(const event of commits)assert.ok(event.endedAt>=event.startedAt&&event.elapsedMs>=0);
  assert.deepEqual(audit.map(({type,database,elapsedMs})=>({type,database,elapsedMs})),[
   {type:'companion-slow-query',database:'economy',elapsedMs:16},
   {type:'companion-slow-transaction',database:'economy',elapsedMs:16}
  ]);
  assert.ok(!JSON.stringify([...commits,...audit]).includes(label));
 }finally{
  DatabaseSync.prototype.prepare=originalPrepare;
  commitChannel.unsubscribe(collect);
  await cg?.close();
  await economy?.close();
 }
});


test('economy and CG keep more than 1000 live WAL pages off the main commit path and reopen intact',async t=>{
  const root=await mkdtemp(join(tmpdir(),'buddy-r17-economy-wal-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const slow=[],checkpoints=[],scheduled=new Set(),maintenanceReady=Promise.withResolvers();
  const options={walMaintenanceIntervalMs:20,audit:event=>{
    if(event.type.startsWith('companion-slow-'))slow.push(event);
    if(event.type!=='companion-economy-wal-checkpoint')return;
    checkpoints.push(event);
    if(event.reason==='scheduled'&&event.status==='checkpointed')scheduled.add(event.database);
    if(scheduled.size===2)maintenanceReady.resolve();
  }};
  let economy=createEconomyStore(root,options),cg=createCgRewardFacts({dataRoot:root,...options});
  try{
    slow.length=0;
    economy.ensureScope(scope);
    for(let i=0;i<1200;i++){
      economy.settleHunger(scope,{elapsedMs:1000});
      cg.registerJob({id:'wal-job-'+i,rewardScope:scope});
    }
    const before=[economy,cg].map(service=>{
      const observer=new DatabaseSync(service.path);
      try{return observer.prepare('PRAGMA wal_checkpoint(NOOP)').get();}
      finally{observer.close();}
    });
    for(const frames of before){
      assert.ok(frames.log>1000,JSON.stringify(before));
      assert.equal(frames.checkpointed,0,JSON.stringify(before));
    }
    // A separate quiet timing run checks storage latency without parallel test I/O.
    if(process.env.AI_BUDDY_R17_ECONOMY_TIMING==='1')assert.deepEqual(slow,[]);
    const cancelDeadline=new AbortController();
    try{
      await Promise.race([maintenanceReady.promise,wait(30_000,undefined,{signal:cancelDeadline.signal}).then(()=>{
        assert.fail('Both databases should report a scheduled checkpoint: '+JSON.stringify(checkpoints));
      })]);
    }finally{cancelDeadline.abort();}
    const periodic=checkpoints.filter(event=>event.reason==='scheduled');
    for(const result of periodic){
      assert.ok(result.checkpointed>1000,result.database);
      assert.equal(result.checkpointed,result.log,result.database);
    }
    const slowDuringBurst=slow.length;
    economy.settleHunger(scope,{elapsedMs:1000});
    cg.registerJob({id:'last-uncheckpointed',rewardScope:scope});
    const finalSatiety=economy.getHunger(scope,{create:false}).satiety;
    await Promise.all([economy.close(),cg.close()]);
    const shutdown=checkpoints.filter(event=>event.reason==='close');
    assert.equal(shutdown.length,2);
    for(const event of shutdown){
      assert.equal(event.status,'checkpointed',event.database);
      assert.ok(event.before.log>event.before.checkpointed,event.database+' still had live WAL frames after the main writer closed');
    }
    t.diagnostic(JSON.stringify({before,periodic,shutdown,slowDuringBurst,realTransactionsPerDatabase:1200}));
    economy=createEconomyStore(root);
    cg=createCgRewardFacts({dataRoot:root});
    assert.equal(economy.getHunger(scope,{create:false}).satiety,finalSatiety);
    assert.equal(cg.inspect('wal-job-1199').id,'wal-job-1199');
    assert.equal(cg.inspect('last-uncheckpointed').id,'last-uncheckpointed');
  }finally{
    await cg.close();
    await economy.close();
  }
});
