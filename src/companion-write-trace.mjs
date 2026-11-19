import {channel} from 'node:diagnostics_channel';

// Diagnostic subscribers must contain their own errors. diagnostics_channel
// reports subscriber exceptions asynchronously to the process.
const events=channel('ai-buddy.companion.write-latency');
const epochMs=Date.now(),epochNs=process.hrtime.bigint();
const elapsed=(start,end)=>Number(end-start)/1e6;
const wall=ns=>epochMs+elapsed(epochNs,ns);
const operations=new Set([
 'conversation-import','memory.sync','memory.tick','memory.consolidate','memory.prepared-record',
 'life-restore-prepare','life-restore-stage','life-restore-staged','life-restore-publish',
 'life-restore-clear','life-restore-rolled-back','life-restore-abandoned'
]);

export function startCompanionWriteTrace(operation){
 if(!events.hasSubscribers)return null;
 const accepted=process.hrtime.bigint(),marks=new BigInt64Array(new SharedArrayBuffer(24));
 let entered=accepted;
 return {
  marks,
  enter(){entered=process.hrtime.bigint();},
  finish(failed,rows,workerWaitMs){
   const finished=process.hrtime.bigint(),workerStart=Atomics.load(marks,0);
   const commitStart=Atomics.load(marks,1),committed=Atomics.load(marks,2);
   events.publish({
    operation:operations.has(operation)?operation:'mutate',status:committed?'committed':failed?'failed':'no-op',rows,
    acceptedAt:wall(accepted),committedAt:committed?wall(committed):null,
    queueMs:elapsed(accepted,entered),workerWaitMs,workerMs:workerStart&&committed?elapsed(workerStart,committed):null,
    commitMs:committed?elapsed(commitStart,committed):null,
    acceptedToCommitMs:committed?elapsed(accepted,committed):null,acceptedToOutcomeMs:elapsed(accepted,finished)
   });
  }
 };
}
