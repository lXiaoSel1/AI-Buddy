import {channel} from 'node:diagnostics_channel';

const commits=channel('ai-buddy.companion.economy-sql');
const slowMs=15;
export const economyWriterPragmas='PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=0; PRAGMA wal_autocheckpoint=0;';

// Used only by the dedicated economy writer. Its synchronous checkpoints and
// SQLite transactions share one thread and can never overlap. CG retains its
// separate checkpoint worker because its writer lives on a different thread.
export function createInlineEconomyWalMaintenance(db,{audit,walMaintenanceIntervalMs=30_000}){
 let timer,closed=false;
 const report=(reason,value)=>{
  try{audit?.({type:'companion-economy-wal-checkpoint',database:'economy',reason,...value});}catch{}
 };
 function checkpoint(reason){
  try{
   const before=db.prepare('PRAGMA wal_checkpoint(NOOP)').get();
   const startedAt=Date.now(),started=performance.now();
   const result=db.prepare(reason==='close'?'PRAGMA wal_checkpoint(TRUNCATE)':'PRAGMA wal_checkpoint(PASSIVE)').get();
   const status=result.busy||result.checkpointed<result.log?'busy':'checkpointed';
   report(reason,{...result,before,status,startedAt,endedAt:Date.now(),elapsedMs:performance.now()-started});
   return status;
  }catch(error){
   report(reason,{status:'failed',code:error.code});
   if(reason==='close')throw error;
   return 'failed';
  }
 }
 function recordWrite(){
  if(closed||timer)return;
  timer=setTimeout(()=>{
   timer=null;
   if(checkpoint('scheduled')!=='checkpointed')recordWrite();
  },walMaintenanceIntervalMs);
  timer.unref();
 }
 return {recordWrite,close(closeDb){
  if(closed)return;
  closed=true;
  clearTimeout(timer);
  try{checkpoint('close');}finally{closeDb();}
 }};
}

export function monitorEconomySql(db,database,{audit,sqlClock=()=>performance.now(),onCommit,beforeRun}){
  let operation='database',depth=0;
  const slow=(type,fields,start,startedAt)=>{
    const elapsedMs=sqlClock()-start;
    if(elapsedMs>slowMs)try{audit?.({type,database,operation,...fields,startedAt,endedAt:Date.now(),elapsedMs});}catch{}
  };
  function statement(statement,execute){
    const start=sqlClock(),startedAt=Date.now();
    try{return execute();}
    finally{slow('companion-slow-query',{statement},start,startedAt);}
  }
  function transaction(name,execute){
    const start=sqlClock(),startedAt=Date.now(),previous=operation;
    operation=name;depth++;
    try{return execute();}
    finally{
      try{slow('companion-slow-transaction',{},start,startedAt);}
      finally{depth--;operation=previous;}
    }
  }
  function commit(sql){
    if(depth!==1)return connection.exec(sql);
    const observed=commits.hasSubscribers;
    const start=observed?sqlClock():0,startedAt=observed?Date.now():0;
    const result=connection.exec(sql);
    if(observed)commits.publish({type:'companion-economy-commit',database,operation,startedAt,endedAt:Date.now(),elapsedMs:sqlClock()-start});
    onCommit?.();
    return result;
  }
  const connection={
    exec:sql=>statement(sql.split(' ',1)[0].toLowerCase(),()=>db.exec(sql)),
    prepare(sql){
      const command=sql.split(' ',1)[0].toLowerCase();
      const prepared=statement('prepare.'+command,()=>db.prepare(sql));
      return Object.fromEntries(['all','get','run'].map(method=>[
        method,(...args)=>{
          if(method==='run')beforeRun?.();
          return statement(command+'.'+method,()=>prepared[method](...args));
        }
      ]));
    },
    close:()=>db.close()
  };
  return {connection,transaction,commit};
}
