const rank=value=>['failed','chat-error'].includes(value.source)?4:value.source==='completed'?3:value.source==='dialog'?2:1;
export class PetFeedbackQueue{
  constructor({now=()=>Date.now(),cycle=id=>1000,ready=()=>true}={}){this.now=now;this.cycle=cycle;this.ready=ready;this.queue=[];this.active=null;this.seen=new Set();this.serial=0;this.lastAt=now();this.lastChatSequence=0;}
  enqueue(value){
    const item={...value,eventId:value.eventId??'pet-feedback-'+(++this.serial),count:value.count??1,createdAt:this.now()};
    if(this.seen.has(item.eventId))return false;
    this.seen.add(item.eventId);if(this.seen.size>2000)this.seen.delete(this.seen.values().next().value);
    if(item.source==='dialog'){
      if(Number.isFinite(item.sequence)&&item.sequence<this.lastChatSequence)return false;
      this.lastChatSequence=Math.max(this.lastChatSequence,item.sequence??0);
      this.queue=this.queue.filter(x=>x.source!=='dialog');
      if(this.active?.source==='dialog')this.active=null;
    }
    if(rank(item)===1&&(this.active&&rank(this.active)>1||this.queue.some(x=>rank(x)>1)))return false;
    if(this.active&&rank(item)>rank(this.active)){
      if(rank(this.active)>=3)this.queue.push(this.active);
      this.active=null;
    }
    const existing=this.queue.find(x=>item.provider&&x.source===item.source&&x.provider===item.provider&&['completed','failed'].includes(item.source)&&item.createdAt-x.createdAt<=1000);
    if(existing){existing.count+=item.count;existing.eventIds??=[existing.eventId];existing.eventIds.push(item.eventId);return true;}
    this.queue.push(item);this.queue.sort((a,b)=>rank(b)-rank(a)||a.createdAt-b.createdAt);
    if(this.queue.length>10){for(const source of ['completed','failed'])for(const provider of new Set(this.queue.map(x=>x.provider).filter(Boolean))){const items=this.queue.filter(x=>x.source===source&&x.provider===provider);if(items.length>1){items[0].count=items.reduce((n,x)=>n+x.count,0);this.queue=this.queue.filter(x=>!items.includes(x)||x===items[0]);}}}
    return true;
  }
  tick({paused=false,speed=1,resumedAt=null}={}){
    const now=this.now(),dt=Math.max(0,now-Math.max(this.lastAt,resumedAt??this.lastAt));this.lastAt=now;
    if(this.active&&!paused){const candidate=this.active.elapsed+dt*speed;if(!this.active.id||this.ready(this.active.id,candidate))this.active.elapsed=candidate;if(this.active.elapsed>=this.active.duration)this.active=null;}
    if(!this.active&&!paused&&this.queue.length){const next=this.queue[0];if(!next.id||this.ready(next.id,next.elapsed??0)){
      this.queue.shift();const cycles=next.cycles??(next.id==='jump'?2:1);
      this.active={...next,elapsed:next.elapsed??0,duration:next.duration??(next.durationMs!==undefined?next.durationMs*speed:next.id?this.cycle(next.id)*cycles:6500*speed),startedAt:next.startedAt??now};
      if(this.active.count>1){const name=this.active.provider==='claude'?'Claude':TOOL_NAMES[this.active.provider]||this.active.provider||'AI';this.active.text=this.active.source==='completed'?`${name}有${this.active.count}个任务完成啦，辛苦了～`:`${name}日志记录了${this.active.count}条错误，点我查看。`;}
    }}
    return this.active?{...this.active,paused,expiresAt:paused?null:now+Math.max(0,this.active.duration-this.active.elapsed)/speed}:null;
  }
  clear(){this.queue=[];this.active=null;this.lastAt=this.now();}
}
import {TOOL_NAMES} from './token-types.mjs';
