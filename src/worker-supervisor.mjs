// Restart a worker that exits unexpectedly, backing off 2 s, 4 s, ... up to
// 60 s. A worker that ran for a minute counts as healthy and resets the delay.
export function superviseWorker(create,{shouldRestart=()=>true,onExit=()=>{},now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,minDelay=2000,maxDelay=60000,healthyMs=60000}={}){
 let failures=0,timer=null,current=null;
 function start(){
  timer=null;const startedAt=now(),worker=create();current=worker;
  worker.on('exit',code=>{
   onExit(code);
   if(worker!==current||!shouldRestart())return;
   if(now()-startedAt>=healthyMs)failures=0;
   timer=setTimer(start,Math.min(maxDelay,minDelay*2**failures++));timer?.unref?.();
  });
  return worker;
 }
 start();
 return {get worker(){return current;},stop(){if(timer)clearTimer(timer);timer=null;}};
}

// Keep only the newest `limit` entries of an append-only diagnostic list.
export function pushBounded(list,value,limit=200){list.push(value);if(list.length>limit)list.splice(0,list.length-limit);return list;}
