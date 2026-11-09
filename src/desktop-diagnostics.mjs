import {monitorEventLoopDelay,performance} from 'node:perf_hooks';

let sample=null;
const rounded=value=>Number.isFinite(value)?Math.round(value*100)/100:null;
export function measureDesktopDiagnostic(name,run){
  if(!sample)return run();
  const current=sample,at=performance.now();
  try{return run();}finally{
    const ms=performance.now()-at,row=current.timings[name]??={count:0,totalMs:0,maxMs:0};
    row.count++;row.totalMs+=ms;row.maxMs=Math.max(row.maxMs,ms);
  }
}

const phases=new Set(['idle','message','history','drag','profile']);
export function startDesktopSample(phase,{timeoutMs=30_000}={}){
  if(!phases.has(phase)||sample)throw Error('Invalid desktop sample phase');
  const delay=monitorEventLoopDelay({resolution:10}),cpu=process.cpuUsage(),elu=performance.eventLoopUtilization();
  const current={phase,at:performance.now(),delay,cpu,elu,timings:{}};
  sample=current;delay.enable();
  const timeout=setTimeout(()=>{if(sample===current)stopDesktopSample();},Math.min(Math.max(Number(timeoutMs)||30_000,1_000),90_000));timeout.unref?.();current.timeout=timeout;
}
export function stopDesktopSample(){
  if(!sample)return null;
  const {phase,at,delay,cpu,elu,timings,timeout}=sample;sample=null;clearTimeout(timeout);delay.disable();
  const durationMs=rounded(performance.now()-at),usage=process.cpuUsage(cpu);
  return {phase,durationMs,cpuMs:rounded((usage.user+usage.system)/1000),rss:process.memoryUsage().rss,
    eventLoop:{p95Ms:rounded(delay.percentile(95)/1e6),p99Ms:rounded(delay.percentile(99)/1e6),maxMs:rounded(delay.max/1e6),utilization:rounded(performance.eventLoopUtilization(elu).utilization)},
    timings:Object.fromEntries(Object.entries(timings).map(([name,row])=>[name,{count:row.count,totalMs:rounded(row.totalMs),maxMs:rounded(row.maxMs)}]))};
}
