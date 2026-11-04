import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,existsSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {FOODS,foodById} from './food-catalog.mjs';
import {normalizeRewardFact,rewardDelta} from './reward-facts.mjs';
import {createGameEconomy,GAME_ECONOMY_SCHEMA,GAME_ECONOMY_WRITER} from './voice-games/game-economy.mjs';

const clone=v=>structuredClone(v),json=v=>JSON.stringify(v),parse=v=>v==null?null:JSON.parse(v);
const fail=(message,code)=>Object.assign(Error(message),{code});
const hash=v=>createHash('sha256').update(json(v)).digest('hex');
const id=(value,label='事件编号')=>{if(typeof value!=='string'||!value||value.length>512)throw fail(label+'无效','ECONOMY_INVALID_ID');return value;};
export function feedingScope(value){
 if(!value||typeof value!=='object')throw fail('投喂角色上下文无效','FEEDING_SCOPE_REQUIRED');
 return Object.fromEntries(['characterId','personaId','lifeId','operationId'].map(key=>[key,id(value[key],key)]));
}
export const MAX_REWARD_FACT_BATCH=1000;
const hungerKey=scope=>scope.characterId+'\0'+scope.lifeId;
const defaults=()=>({autoEat:false,autoBuyRice:false,allowedFoods:[],dailyAutoPurchaseLimit:'unlimited'});
export function validateFeedingSettings(patch,previous=defaults()){
 if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error('进食设置无效');const next={...previous};
 for(const [key,value]of Object.entries(patch)){
  if(key==='autoEat'||key==='autoBuyRice'){if(typeof value!=='boolean')throw Error('进食开关无效');next[key]=value;}
  else if(key==='allowedFoods'){if(!Array.isArray(value)||value.length>FOODS.length||value.some(v=>typeof v!=='string'))throw Error('自动食用清单无效');for(const v of value)foodById(v);next[key]=[...new Set(value)];}
  else if(key==='dailyAutoPurchaseLimit'){if(value!=='unlimited'&&(!Number.isSafeInteger(value)||value<0))throw Error('自动采购上限无效');next[key]=value;}
  else throw Error('未知进食设置：'+key);
 }
 return next;
}
function localDay(at){const d=new Date(at);if(!Number.isFinite(d.getTime()))throw Error('采购日期无效');return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');}
function economyCompatibility(db){
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
 if(!tables.length)return;
 if(!tables.some(row=>row.name==='meta'))throw fail('不支持的投喂资料版本','ECONOMY_SCHEMA_UNSUPPORTED');
 const schema=db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get(),writer=db.prepare("SELECT value FROM meta WHERE key='minimumWriter'").get();
 if(schema&&![1,GAME_ECONOMY_SCHEMA].includes(parse(schema.value)))throw fail('不支持的投喂资料版本','ECONOMY_SCHEMA_UNSUPPORTED');
 if(writer&&!['r95-economy-v1',GAME_ECONOMY_WRITER].includes(parse(writer.value)))throw fail('投喂资料需要其他 minimum writer 版本','ECONOMY_WRITER_UNSUPPORTED');
}

export function createEconomyStore(dataRoot,{now=Date.now}={}){
 if(!isAbsolute(dataRoot??''))throw Error('经济资料目录须为绝对路径');
 const directory=join(dataRoot,'companion-economy-v1'),path=join(directory,'economy.sqlite');
 // Inspect unknown stores read-only, before PRAGMA journal_mode or any schema
 // creation can change their header. Never stamp a future writer back to ours.
 if(existsSync(path)){const reader=new DatabaseSync(path,{readOnly:true});try{economyCompatibility(reader);}finally{reader.close();}}
 mkdirSync(directory,{recursive:true});const db=new DatabaseSync(path);try{economyCompatibility(db);}catch(error){db.close();throw error;}
 db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
 const meta=(key,value)=>{if(value!==undefined){db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,json(value));return value;}return parse(db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value);};
 const schema=meta('schemaVersion');if(schema!==null&&![1,GAME_ECONOMY_SCHEMA].includes(schema)){db.close();throw fail('不支持的投喂资料版本','ECONOMY_SCHEMA_UNSUPPORTED');}
 db.exec(`CREATE TABLE IF NOT EXISTS wallet(id INTEGER PRIMARY KEY CHECK(id=1),balance INTEGER NOT NULL CHECK(balance>=0),remainder INTEGER NOT NULL CHECK(remainder>=0 AND remainder<10000),debt_units INTEGER NOT NULL CHECK(debt_units>=0));
  INSERT OR IGNORE INTO wallet VALUES(1,0,0,0);
  CREATE TABLE IF NOT EXISTS inventory(food_id TEXT PRIMARY KEY,quantity INTEGER NOT NULL CHECK(quantity>=0));
  CREATE TABLE IF NOT EXISTS reward_facts(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,basis TEXT NOT NULL,units INTEGER NOT NULL,baseline_units INTEGER NOT NULL,credited_units INTEGER NOT NULL,fingerprint TEXT NOT NULL,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,at REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS ledger(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,value TEXT NOT NULL,at REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS hunger(id TEXT PRIMARY KEY,character_id TEXT NOT NULL,life_id TEXT NOT NULL,operation_id TEXT NOT NULL,satiety REAL NOT NULL CHECK(satiety>=0 AND satiety<=100),updated_at REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS purchases(id TEXT PRIMARY KEY,food_id TEXT NOT NULL,packages INTEGER NOT NULL,cost INTEGER NOT NULL,automatic INTEGER NOT NULL,day TEXT NOT NULL,value TEXT NOT NULL,at REAL NOT NULL);
  CREATE INDEX IF NOT EXISTS purchases_day ON purchases(day,automatic);
  CREATE TABLE IF NOT EXISTS meals(id TEXT PRIMARY KEY,character_id TEXT NOT NULL,life_id TEXT NOT NULL,operation_id TEXT NOT NULL,affection_state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at REAL,value TEXT NOT NULL,at REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS auto_sessions(id TEXT PRIMARY KEY,character_id TEXT NOT NULL,life_id TEXT NOT NULL,operation_id TEXT NOT NULL,state TEXT NOT NULL,value TEXT NOT NULL,at REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS life_evidence(projection_key TEXT NOT NULL,event_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(projection_key,event_id));
  CREATE TABLE IF NOT EXISTS life_transactions(id TEXT PRIMARY KEY,character_id TEXT NOT NULL,state TEXT NOT NULL,fingerprint TEXT NOT NULL,value TEXT NOT NULL,at REAL NOT NULL);`);
 if(meta('settings')===null)meta('settings',defaults());
 let closed=false,serial=0,ledgerCount=null;
 const assertOpen=()=>{if(closed)throw fail('投喂服务已经关闭','ECONOMY_CLOSED');};
 function transaction(fn){assertOpen();if(fn?.constructor?.name==='AsyncFunction')throw fail('经济事务不能等待异步调用','ECONOMY_ASYNC_TRANSACTION');const save='economy_'+(++serial),priorCount=ledgerCount;db.exec('SAVEPOINT '+save);try{const result=fn();if(result?.then)throw fail('经济事务不能等待异步调用','ECONOMY_ASYNC_TRANSACTION');db.exec('RELEASE '+save);return result;}catch(error){try{db.exec('ROLLBACK TO '+save+'; RELEASE '+save);}finally{ledgerCount=priorCount;}throw error;}}
 const walletRead=db.prepare('SELECT balance,remainder,debt_units AS debtUnits FROM wallet WHERE id=1'),walletWrite=db.prepare('UPDATE wallet SET balance=?,remainder=?,debt_units=? WHERE id=1'),ledgerWrite=db.prepare('INSERT INTO ledger(event_key,kind,value,at) VALUES(?,?,?,?)');
 const ledgerCountRead=db.prepare('SELECT COUNT(*) AS total FROM ledger'),dataVersionRead=db.prepare('PRAGMA data_version');
 // Same-connection inserts increment the count; legacy/external writers invalidate it.
 function ledgerTotal(){assertOpen();const version=dataVersionRead.get().data_version;if(!ledgerCount||ledgerCount.version!==version)ledgerCount={version,total:ledgerCountRead.get().total};return ledgerCount.total;}
 const wallet=()=>({...walletRead.get()});
 const setWallet=value=>walletWrite.run(value.balance,value.remainder,value.debtUnits);
 function protectedRewardDelta(value,delta){const held=games?.held('user')??0;if(value.balance<held)throw fail('积分本金背书不足','GAME_RESERVATION_UNFUNDED');const next=rewardDelta({...value,balance:value.balance-held},delta);return {...next,balance:next.balance+held};}
 function recoverGameDebt(){const value=wallet(),held=games.held('user'),freeUnits=(value.balance-held)*10000+value.remainder,paid=Math.min(value.debtUnits,freeUnits);if(paid>0){const free=freeUnits-paid;setWallet({balance:held+Math.floor(free/10000),remainder:free%10000,debtUnits:value.debtUnits-paid});ledger('game-debt-recovery:'+serial+':'+now(),'reward-debt-recovery',{paidUnits:paid});}}
 const games=transaction(()=>{const extension=createGameEconomy({db,transaction,wallet,setWallet,ledger,now,recoverDebt:recoverGameDebt});meta('schemaVersion',GAME_ECONOMY_SCHEMA);meta('minimumWriter',GAME_ECONOMY_WRITER);return extension;});
 function ledger(eventKey,kind,value,at=now(),walletValue=wallet()){ledgerWrite.run(eventKey,kind,json({...value,wallet:walletValue}),at);if(ledgerCount)ledgerCount={...ledgerCount,total:ledgerCount.total+1};}
 function priorCommand(requestId,kind,body){const fingerprint=hash(body),row=db.prepare('SELECT * FROM commands WHERE id=?').get(id(requestId));if(!row)return {fingerprint};if(row.kind!==kind||row.fingerprint!==fingerprint)throw fail('事件编号被不同操作重复使用','ECONOMY_COMMAND_CONFLICT');return {fingerprint,result:{...parse(row.result),duplicate:true}};}
 const saveCommand=(requestId,kind,fingerprint,result)=>db.prepare('INSERT INTO commands VALUES(?,?,?,?,?)').run(requestId,kind,fingerprint,json(result),now());
 function settings(patch){assertOpen();if(patch===undefined)return clone(meta('settings'));return transaction(()=>meta('settings',validateFeedingSettings(patch,meta('settings'))));}
 function assertNoLifeTransaction(characterId){if(db.prepare("SELECT id FROM life_transactions WHERE character_id=? AND state IN ('prepared','applied') LIMIT 1").get(characterId))throw fail('该角色人生事务尚未完成','FEEDING_LIFE_TRANSACTION_PENDING');}
 function getHunger(scope,{create=true}={}){
  scope=feedingScope(scope);let row=db.prepare('SELECT * FROM hunger WHERE id=?').get(hungerKey(scope));
  if(!row&&create){db.prepare('INSERT INTO hunger VALUES(?,?,?,?,?,?)').run(hungerKey(scope),scope.characterId,scope.lifeId,scope.operationId,100,now());row=db.prepare('SELECT * FROM hunger WHERE id=?').get(hungerKey(scope));}
  return row?{scope:{...scope,operationId:row.operation_id},satiety:row.satiety,updatedAt:row.updated_at}:null;
 }
 function ensureScope(value){const scope=feedingScope(value);assertNoLifeTransaction(scope.characterId);return transaction(()=>{const state=getHunger(scope);if(state.scope.operationId!==scope.operationId)db.prepare('UPDATE hunger SET operation_id=?,updated_at=? WHERE id=?').run(scope.operationId,now(),hungerKey(scope));return getHunger(scope);});}
 function settleHunger(scope,{elapsedMs,sleeping=false}={}){
  if(!Number.isFinite(elapsedMs)||elapsedMs<0)throw Error('饥饿运行时间无效');scope=feedingScope(scope);assertNoLifeTransaction(scope.characterId);
  return transaction(()=>{const state=getHunger(scope);if(state.scope.operationId!==scope.operationId)throw fail('饥饿状态属于旧人生代次','FEEDING_STALE_SCOPE');const satiety=Math.max(0,state.satiety-elapsedMs/3600000*(sleeping?2:8));db.prepare('UPDATE hunger SET satiety=?,updated_at=? WHERE id=?').run(satiety,now(),hungerKey(scope));return getHunger(scope);});
 }
 // Statements and wallet state are reused inside one bounded transaction, not
 // cached across commits. A SQL failure anywhere rolls back every row and ledger.
 const rewardRead=db.prepare('SELECT * FROM reward_facts WHERE id=?'),rewardWrite=db.prepare('INSERT INTO reward_facts VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,basis=excluded.basis,units=excluded.units,baseline_units=excluded.baseline_units,credited_units=excluded.credited_units,fingerprint=excluded.fingerprint,value=excluded.value');
 const rewardPriority={actual:3,'official-equivalent':2,'cg-fallback':1};
 const rewardContext=()=>({initializing:meta('rewardsInitialized')!==true,wallet:wallet()});
 function applyRewardFact(fact,context){
  if(!fact.accepted)return fact;
  const old=rewardRead.get(fact.id);
  if(old){
   if(rewardPriority[fact.basis]<rewardPriority[old.basis]||fact.revision<old.revision)return {accepted:true,duplicate:true,ignoredRevision:true,wallet:{...context.wallet}};
   if(fact.revision===old.revision&&fact.fingerprint===old.fingerprint)return {accepted:true,duplicate:true,wallet:{...context.wallet}};
   if(fact.revision===old.revision&&rewardPriority[fact.basis]<=rewardPriority[old.basis])throw fail('同一用量版本存在冲突','REWARD_FACT_CONFLICT');
  }
  const initializing=context.initializing,isBaseline=initializing||!old&&fact.baseline,baselineUnits=initializing?fact.units:old?.baseline_units??(isBaseline?fact.units:0),creditedUnits=initializing?0:Math.max(0,fact.units-baselineUnits),delta=creditedUnits-(old?.credited_units??0);
  if(delta){context.wallet=protectedRewardDelta(context.wallet,delta);setWallet(context.wallet);}
  rewardWrite.run(fact.id,Math.max(fact.revision,old?.revision??0),fact.basis,fact.units,baselineUnits,creditedUnits,fact.fingerprint,json(fact));
  ledger('reward:'+fact.id+':'+fact.revision+':'+fact.fingerprint,'reward-revision',{requestId:fact.id,basis:fact.basis,deltaUnits:delta,units:fact.units,baselineUnits,creditedUnits},now(),context.wallet);
  return {accepted:true,duplicate:false,baseline:isBaseline,deltaUnits:delta,wallet:{...context.wallet}};
 }
 function ingestUsageFacts(rawFacts,options={}){
  const length=Array.isArray(rawFacts)?rawFacts.length:-1;
  if(!Number.isSafeInteger(length)||length<0||length>MAX_REWARD_FACT_BATCH)throw fail('用量事实批量须为最多 '+MAX_REWARD_FACT_BATCH+' 项的数组','REWARD_BATCH_INVALID');
  if(!length)return [];
  // Take a bounded, dense snapshot before validation: sparse holes are invalid
  // facts, not implicitly skipped rows, and custom iterators cannot grow a batch.
  const input=Array.from({length},(_,index)=>rawFacts[index]);
  const facts=input.map(raw=>normalizeRewardFact(raw,options));
  if(!facts.some(fact=>fact.accepted))return facts;
  return transaction(()=>{const context=rewardContext();return facts.map(fact=>applyRewardFact(fact,context));});
 }
 function ingestUsageFact(raw,options={}){return ingestUsageFacts([raw],options)[0];}
 function initializeRewards({facts=[],cursor=null}={}){return transaction(()=>{if(meta('rewardsInitialized')===true)return {initialized:true,duplicate:true,cursor:meta('rewardStartCursor')};const context=rewardContext();for(const raw of facts)applyRewardFact(normalizeRewardFact(raw,{trusted:true,baseline:true}),context);meta('rewardStartCursor',cursor);meta('rewardsInitialized',true);return {initialized:true,duplicate:false,cursor};});}

 function purchase({foodId,packages=1,requestId,automatic=false,scope}){
  const food=foodById(foodId);if(!Number.isSafeInteger(packages)||packages<1||packages>1000)throw Error('购买包数无效');if(automatic&&packages!==1)throw Error('自动采购每次只能买一碗米饭');scope=feedingScope(scope);assertNoLifeTransaction(scope.characterId);
  return transaction(()=>{
   const prior=priorCommand(requestId,'purchase',{foodId,packages,automatic,scope});if(prior.result)return prior.result;
   const prefs=settings(),cost=food.price*packages,day=localDay(now());
   if(automatic){if(!prefs.autoEat||!prefs.autoBuyRice||foodId!=='rice'||!prefs.allowedFoods.includes('rice'))throw fail('未获得自动购买及食用米饭的双重授权','AUTO_PURCHASE_NOT_ALLOWED');const spent=db.prepare('SELECT COALESCE(SUM(cost),0) AS total FROM purchases WHERE day=? AND automatic=1').get(day).total;if(prefs.dailyAutoPurchaseLimit!=='unlimited'&&spent+cost>prefs.dailyAutoPurchaseLimit)throw fail('已达到每日自动采购上限','AUTO_PURCHASE_DAILY_LIMIT');}
   const balance=wallet();if(balance.balance-games.held('user')<cost)throw fail('积分不足，饥饿状态保留','INSUFFICIENT_POINTS');
   const quantity=db.prepare('SELECT quantity FROM inventory WHERE food_id=?').get(foodId)?.quantity??0;if(!Number.isSafeInteger(quantity+food.portions*packages))throw Error('库存超出安全范围');
   setWallet({...balance,balance:balance.balance-cost});db.prepare('INSERT INTO inventory VALUES(?,?) ON CONFLICT(food_id) DO UPDATE SET quantity=excluded.quantity').run(foodId,quantity+food.portions*packages);
   const value={id:requestId,foodId,packages,portions:food.portions*packages,cost,automatic,day,scope,at:now()};db.prepare('INSERT INTO purchases VALUES(?,?,?,?,?,?,?,?)').run(requestId,foodId,packages,cost,Number(automatic),day,json(value),value.at);ledger('purchase:'+requestId,'purchase',value);const result={...value,wallet:wallet()};saveCommand(requestId,'purchase',prior.fingerprint,result);return result;
  });
 }
 function consume({scope,foodId,requestId,automatic=false,sessionId=null,conversationId=null}){
  scope=feedingScope(scope);const food=foodById(foodId);assertNoLifeTransaction(scope.characterId);
  return transaction(()=>{
   const prior=priorCommand(requestId,'consume',{scope,foodId,automatic,sessionId});if(prior.result)return prior.result;
   const state=getHunger(scope);if(state.scope.operationId!==scope.operationId)throw fail('进食属于旧人生','FEEDING_STALE_SCOPE');
   if(state.satiety>=100){const result={consumed:false,reason:'already-full',satiety:100};saveCommand(requestId,'consume',prior.fingerprint,result);return result;}
   const prefs=settings();if(automatic&&(!prefs.autoEat||!prefs.allowedFoods.includes(foodId)))throw fail('自动进食授权已撤销','AUTO_FOOD_NOT_ALLOWED');
   const stock=db.prepare('SELECT quantity FROM inventory WHERE food_id=?').get(foodId)?.quantity??0;if(stock<1)throw fail('该食品没有库存','FOOD_OUT_OF_STOCK');
   const satiety=Math.min(100,state.satiety+food.restore);db.prepare('UPDATE inventory SET quantity=quantity-1 WHERE food_id=?').run(foodId);db.prepare('UPDATE hunger SET satiety=?,updated_at=? WHERE id=?').run(satiety,now(),hungerKey(scope));
   const meal={id:requestId,scope,foodId,automatic,sessionId,conversationId,before:state.satiety,after:satiety,restored:satiety-state.satiety,overflow:food.restore-(satiety-state.satiety),at:now(),affectionState:'pending',attempts:0,retryAt:null,attentionDone:automatic,experienceDone:false};
   db.prepare('INSERT INTO meals(id,character_id,life_id,operation_id,affection_state,attempts,retry_at,value,at) VALUES(?,?,?,?,?,?,?,?,?)').run(meal.id,scope.characterId,scope.lifeId,scope.operationId,'pending',0,null,json(meal),meal.at);ledger('meal:'+requestId,'meal',meal);
   const result={consumed:true,newlyConsumed:true,meal,satiety};saveCommand(requestId,'consume',prior.fingerprint,{...result,newlyConsumed:false});return result;
  });
 }
 function purchaseAndConsumeRice({scope,requestId,sessionId=null,conversationId=null}){
  scope=feedingScope(scope);return transaction(()=>{
   const prior=priorCommand(requestId,'consume',{scope,foodId:'rice',automatic:true,sessionId});if(prior.result)return prior.result;
   const state=getHunger(scope);if(state.scope.operationId!==scope.operationId)throw fail('进食属于旧人生','FEEDING_STALE_SCOPE');
   if(state.satiety<100&&(db.prepare('SELECT quantity FROM inventory WHERE food_id=?').get('rice')?.quantity??0)<1)purchase({foodId:'rice',packages:1,requestId:requestId+':purchase',automatic:true,scope});
   return consume({scope,foodId:'rice',requestId,automatic:true,sessionId,conversationId});
  });
 }
 const getMeal=mealId=>parse(db.prepare('SELECT value FROM meals WHERE id=?').get(id(mealId))?.value);
 function updateMeal(mealId,update){return transaction(()=>{const meal=getMeal(mealId);if(!meal)throw Error('进食事件不存在');const next={...meal,...clone(update)};db.prepare('UPDATE meals SET affection_state=?,attempts=?,retry_at=?,value=? WHERE id=?').run(next.affectionState,next.attempts,next.retryAt??null,json(next),mealId);return next;});}
 function autoSession(scope){const row=db.prepare("SELECT value FROM auto_sessions WHERE character_id=? AND life_id=? AND operation_id=? AND state IN ('active','blocked') ORDER BY at DESC LIMIT 1").get(scope.characterId,scope.lifeId,scope.operationId);return parse(row?.value);}
 function saveAuto(value){db.prepare('INSERT INTO auto_sessions VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,value=excluded.value').run(value.id,value.scope.characterId,value.scope.lifeId,value.scope.operationId,value.state,json(value),value.at);return clone(value);}
 const projectionKey=scope=>hungerKey(scope)+'\0'+scope.operationId;
 function snapshot(scope){
  scope=feedingScope(scope);const state=getHunger(scope);if(state.scope.operationId!==scope.operationId)throw fail('人生饱腹快照代次不匹配','FEEDING_STALE_SCOPE');
  const evidence=new Map(db.prepare('SELECT event_id,value FROM life_evidence WHERE projection_key=?').all(projectionKey(scope)).map(row=>[row.event_id,parse(row.value)]));
  for(const row of db.prepare('SELECT id,value FROM meals WHERE character_id=? AND life_id=? AND operation_id=? ORDER BY at,rowid').all(scope.characterId,scope.lifeId,scope.operationId)){if(evidence.has(row.id)&&json(evidence.get(row.id))!==row.value)throw Error('进食经历编号冲突');evidence.set(row.id,parse(row.value));}
  return {format:'ai-buddy-feeding-state',version:1,scope,satiety:state.satiety,gameBalance:games.snapshotBalance(scope),frozenAt:now(),mealEvidence:[...evidence.values()]};
 }
 function prepareLife({transactionId,scope,target}){
  id(transactionId);scope=feedingScope(scope);const targetScope=feedingScope(target?.scope);if(scope.characterId!==targetScope.characterId||!Number.isFinite(target.satiety)||target.satiety<0||target.satiety>100)throw Error('人生进食投影无效');
  return transaction(()=>{
   const fingerprint=hash({scope,target}),old=db.prepare('SELECT * FROM life_transactions WHERE id=?').get(transactionId);if(old){if(old.fingerprint!==fingerprint)throw fail('人生经济事务编号冲突','ECONOMY_LIFE_CONFLICT');return parse(old.value);}
   assertNoLifeTransaction(scope.characterId);games.assertLifeClear(scope.characterId);const before=getHunger(scope);if(before.scope.operationId!==scope.operationId)throw fail('人生经济事务属于旧代次','FEEDING_STALE_SCOPE');
   const mealEvidence=target.mealEvidence??[];if(!Array.isArray(mealEvidence)||new Set(mealEvidence.map(e=>e?.id)).size!==mealEvidence.length)throw Error('人生进食经历无效');
   for(const event of mealEvidence){id(event?.id,'进食经历');const eventScope=feedingScope(event.scope);if(eventScope.characterId!==targetScope.characterId||eventScope.lifeId!==targetScope.lifeId)throw Error('人生进食经历归属无效');foodById(event.foodId);if(!Number.isFinite(event.before)||!Number.isFinite(event.after)||event.before<0||event.before>100||event.after<0||event.after>100||typeof event.automatic!=='boolean')throw Error('人生进食经历内容无效');}
   const targetBefore=db.prepare('SELECT * FROM hunger WHERE id=?').get(hungerKey(targetScope))??null,targetEvidenceBefore=db.prepare('SELECT event_id,value FROM life_evidence WHERE projection_key=?').all(projectionKey(targetScope)),value={id:transactionId,scope,target:{scope:targetScope,satiety:target.satiety,gameBalance:target.gameBalance??0,mealEvidence:clone(mealEvidence)},before:clone(before),targetBefore,targetGameBalanceBefore:games.snapshotBalance(targetScope),targetEvidenceBefore,state:'prepared',at:now()};db.prepare('INSERT INTO life_transactions VALUES(?,?,?,?,?,?)').run(transactionId,scope.characterId,'prepared',fingerprint,json(value),value.at);return clone(value);
  });
 }
 function applyLife({transactionId}){return transaction(()=>{const row=db.prepare('SELECT value FROM life_transactions WHERE id=?').get(id(transactionId));if(!row)throw Error('人生经济事务不存在');const value=parse(row.value);if(value.state==='finalized'||value.state==='applied')return value;if(value.state!=='prepared')throw Error('人生经济事务不能应用');const {scope,satiety}=value.target;games.restoreAccount({commandId:'life-game-apply:'+transactionId,player:scope,balance:value.target.gameBalance??0});db.prepare('INSERT INTO hunger VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET operation_id=excluded.operation_id,satiety=excluded.satiety,updated_at=excluded.updated_at').run(hungerKey(scope),scope.characterId,scope.lifeId,scope.operationId,satiety,now());db.prepare('DELETE FROM life_evidence WHERE projection_key=?').run(projectionKey(scope));for(const event of value.target.mealEvidence??[])db.prepare('INSERT INTO life_evidence VALUES(?,?,?)').run(projectionKey(scope),event.id,json(event));value.state='applied';db.prepare('UPDATE life_transactions SET state=?,value=? WHERE id=?').run(value.state,json(value),transactionId);return value;});}
 function finalizeLife({transactionId}){return transaction(()=>{const row=db.prepare('SELECT value FROM life_transactions WHERE id=?').get(id(transactionId));if(!row)throw Error('人生经济事务不存在');const value=parse(row.value);if(value.state==='finalized')return value;if(value.state!=='applied')throw Error('人生经济投影尚未应用');value.state='finalized';db.prepare('UPDATE life_transactions SET state=?,value=? WHERE id=?').run(value.state,json(value),transactionId);return value;});}
 function recoverLife({transactionId,decision}){
  if(decision==='commit'){applyLife({transactionId});return finalizeLife({transactionId});}
  if(decision!=='rollback')throw Error('须由人生协调器明确决定提交或回退');
  return transaction(()=>{const row=db.prepare('SELECT value FROM life_transactions WHERE id=?').get(id(transactionId));if(!row)throw Error('人生经济事务不存在');const value=parse(row.value);if(value.state==='rolled-back')return value;if(value.state==='finalized')throw Error('已提交人生经济事务不能回滚');
   if(value.state==='applied'){games.restoreAccount({commandId:'life-game-rollback:'+transactionId,player:value.target.scope,balance:value.targetGameBalanceBefore??0});const before=value.targetBefore;if(before)db.prepare('INSERT OR REPLACE INTO hunger VALUES(?,?,?,?,?,?)').run(before.id,before.character_id,before.life_id,before.operation_id,before.satiety,before.updated_at);else db.prepare('DELETE FROM hunger WHERE id=? AND operation_id=?').run(hungerKey(value.target.scope),value.target.scope.operationId);db.prepare('DELETE FROM life_evidence WHERE projection_key=?').run(projectionKey(value.target.scope));for(const row of value.targetEvidenceBefore??[])db.prepare('INSERT INTO life_evidence VALUES(?,?,?)').run(projectionKey(value.target.scope),row.event_id,row.value);}
   value.state='rolled-back';db.prepare('UPDATE life_transactions SET state=?,value=? WHERE id=?').run(value.state,json(value),transactionId);return value;});
 }
 function pendingMeals(scope,{at=now(),limit=1}={}){scope=feedingScope(scope);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('重试批量无效');return db.prepare("SELECT value FROM meals WHERE character_id=? AND life_id=? AND operation_id=? AND json_extract(value,'$.scope.personaId')=? AND affection_state='pending' AND attempts>0 AND attempts<3 AND retry_at<=? ORDER BY at,rowid LIMIT ?").all(scope.characterId,scope.lifeId,scope.operationId,scope.personaId,at,limit).map(row=>parse(row.value));}
 function ledgerPage({page=1,pageSize=100}={}){if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>200)throw Error('积分流水分页无效');return {page,pageSize,total:ledgerTotal(),rows:db.prepare('SELECT kind,value,at FROM ledger ORDER BY seq DESC LIMIT ? OFFSET ?').all(pageSize,(page-1)*pageSize).map(row=>({...parse(row.value),kind:row.kind,at:row.at}))};}
 function view(scope=null){assertOpen();const latest=table=>db.prepare('SELECT value FROM '+table+' ORDER BY at DESC,rowid DESC LIMIT 100').all().map(r=>parse(r.value));return {schemaVersion:GAME_ECONOMY_SCHEMA,wallet:{...wallet(),held:games.held('user'),available:wallet().balance-games.held('user')},rewardsInitialized:meta('rewardsInitialized')===true,rewardStartCursor:meta('rewardStartCursor'),settings:settings(),inventory:Object.fromEntries(db.prepare('SELECT food_id,quantity FROM inventory').all().map(r=>[r.food_id,r.quantity])),hunger:scope?getHunger(scope,{create:false}):null,meals:latest('meals'),purchases:latest('purchases'),ledger:db.prepare('SELECT kind,value,at FROM ledger ORDER BY seq DESC LIMIT 100').all().map(r=>({...parse(r.value),kind:r.kind,at:r.at})),rewardFacts:db.prepare('SELECT value FROM reward_facts ORDER BY rowid DESC LIMIT 100').all().map(r=>parse(r.value)),pendingLifeTransactions:db.prepare("SELECT value FROM life_transactions WHERE state IN ('prepared','applied') ORDER BY at").all().map(r=>parse(r.value)),autoSession:scope?autoSession(scope):null};}
 return {path,view,settings,wallet,games,ensureScope,getHunger,settleHunger,ingestUsageFact,ingestUsageFacts,initializeRewards,purchase,consume,purchaseAndConsumeRice,getMeal,updateMeal,pendingMeals,ledgerPage,autoSession,saveAuto,snapshot,prepareLife,applyLife,finalizeLife,recoverLife,close(){if(closed)return;closed=true;db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();}};
}
