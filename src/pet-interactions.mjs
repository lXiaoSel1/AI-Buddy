// DIP coordinates only. This controller owns placement during drag and flight;
// no video duration determines when a body reaches the floor.
export const PET_STRENGTHS=Object.freeze({gentle:.65,standard:1,strong:1.4,exaggerated:1.9});
const finitePoint=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y);
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
function collisionInsets(value,bounds){
  const result={left:0,top:0,right:0,bottom:0,...value};
  if(Object.keys(result).some(key=>!['left','top','right','bottom'].includes(key)||!Number.isFinite(result[key])||result[key]<0)||result.left+result.right>=bounds.width||result.top+result.bottom>=bounds.height)throw Error('Invalid fixed collision insets');
  return result;
}
export class PetActivityClock{
  constructor({now=()=>performance.now(),delayMs=300000,durations={},speed=1,requireReady=false}={}){
    this.requireReady=requireReady;this.animationEpoch=0;this.animationWaiting=false;this.now=now;this.delayMs=delayMs;this.durations={enter:4000,wake:4000,...durations};this.enabled=true;
    this.busy=new Set();this.lastActivity=now();this.awakeUntil=this.lastActivity+delayMs;this.phase='awake';this.since=this.lastActivity;this.wakeReason=null;
    this.speed=speed;this.animationAt=this.lastActivity;this.animationElapsed=0;
  }
  animationNow(now=this.now()){return this.animationWaiting?0:this.animationElapsed+Math.max(0,now-this.animationAt)*this.speed;}
  markReady(epoch){if(epoch!==this.animationEpoch||!this.animationWaiting)return false;this.animationWaiting=false;this.animationAt=this.now();this.animationElapsed=0;return true;}
  configure({enabled=this.enabled,durations=this.durations,speed=this.speed}={}){
    if(!Number.isFinite(speed)||speed<=0)throw Error('Invalid animation speed');
    const now=this.now();this.animationElapsed=this.animationNow(now);this.animationAt=now;this.speed=speed;
    this.enabled=!!enabled;this.durations={...this.durations,...durations};if(!this.enabled)this.wake('disabled');
  }
  setPhase(phase,now=this.now()){this.phase=phase;this.since=now;this.animationAt=now;this.animationElapsed=0;this.animationEpoch++;this.animationWaiting=this.requireReady&&['sleep-enter','waking'].includes(phase);}
  activity(reason='token'){this.lastActivity=this.now();this.wake(reason);}
  request(id,active){if(!id)return;if(active){this.busy.add(id);this.activity('request');}else if(this.busy.delete(id))this.activity('request-end');}
  observeExternal(snapshot){
    const value=Number(snapshot.workSinceStart)||0,epoch=snapshot.activityEpoch??'default';
    if(this.externalEpoch!==epoch||snapshot.indexing){this.externalEpoch=epoch;this.externalValue=value;this.externalReady=!snapshot.indexing;return false;}
    if(!this.externalReady){this.externalValue=value;this.externalReady=true;return false;}
    const added=value-(this.externalValue??value);this.externalValue=value;
    if(added>0){this.activity('token');return true;}return false;
  }
  wake(reason='touch'){
    if(reason==='feedback')this.awakeUntil=Math.max(this.awakeUntil,this.now()+this.delayMs);
    if(this.phase==='sleep-enter'||this.phase==='asleep'){this.setPhase('waking');this.wakeReason=reason;this.awakeUntil=this.now()+this.delayMs;return true;}
    return this.phase==='waking';
  }
  tick({defer=false,feedback=false}={}){
    const now=this.now();
    if(feedback)this.wake('feedback');
    if(this.phase==='waking'&&this.animationNow(now)>=this.durations.wake){this.setPhase('awake',now);this.awakeUntil=Math.max(this.awakeUntil,now+this.delayMs);}
    if(this.phase==='sleep-enter'&&this.animationNow(now)>=this.durations.enter)this.setPhase('asleep',now);
    if(this.phase==='awake'&&this.enabled&&!defer&&!feedback&&!this.busy.size&&now>=Math.max(this.lastActivity+this.delayMs,this.awakeUntil))this.setPhase('sleep-enter',now);
    return {phase:this.phase,animationEpoch:this.animationEpoch,animationWaiting:this.animationWaiting,elapsedMs:now-this.since,animationElapsedMs:this.animationNow(now),snapshotSpeed:this.speed,activeRequests:this.busy.size,lastActivity:this.lastActivity,awakeUntil:this.awakeUntil,wakeReason:this.wakeReason};
  }
  resume(){const now=this.now();this.lastActivity=now;this.awakeUntil=now+this.delayMs;this.setPhase('awake',now);}
  // "Let her nap" from the pet menu: only while she is awake and nothing is running.
  sleepNow(){if(this.phase!=='awake'||!this.enabled||this.busy.size)return false;this.setPhase('sleep-enter');return true;}
}

export class PetMotion{
  constructor({now=()=>performance.now(),bounds,displays=()=>[],onState=()=>{},onPosition=()=>{},collisionInsets:insets={},requireReady=false}={}){
    this.requireReady=requireReady;this.animationEpoch=0;this.animationWaiting=false;this.now=now;this.bounds={...bounds};this.displays=displays;this.onState=onState;this.onPosition=onPosition;
    this.collisionInsets=collisionInsets(insets,this.bounds);
    this.mode='rest';this.enabled=true;this.strength='standard';this.samples=[];this.velocity={x:0,y:0};this.lastTick=now();this.serial=0;this.speed=1;this.animationAt=this.lastTick;this.animationElapsed=0;
  }
  animationNow(now=this.now()){return this.animationWaiting?0:this.animationElapsed+Math.max(0,now-this.animationAt)*this.speed;}
  markReady(epoch){if(epoch!==this.animationEpoch||!this.animationWaiting)return false;this.animationWaiting=false;this.animationAt=this.now();this.animationElapsed=0;return true;}
  configure({enabled=this.enabled,strength=this.strength,landDurationMs=this.landDurationMs??4000,speed=this.speed,collisionInsets:insets=this.collisionInsets}={}){
    if(!Number.isFinite(speed)||speed<=0)throw Error('Invalid animation speed');
    const nextInsets=collisionInsets(insets,this.bounds);
    const now=this.now();this.animationElapsed=this.animationNow(now);this.animationAt=now;this.speed=speed;
    this.enabled=!!enabled;this.landDurationMs=landDurationMs;this.collisionInsets=nextInsets;if(Object.hasOwn(PET_STRENGTHS,strength))this.strength=strength;if(!this.enabled&&this.mode==='flying')this.stop();else if(!this.enabled&&['landing','charging'].includes(this.mode))this.cancel();else this.contain();
  }
  setMode(mode){if(mode===this.mode)return;this.mode=mode;this.since=this.now();this.animationAt=this.since;this.animationElapsed=0;this.animationEpoch++;this.animationWaiting=this.requireReady&&['flying','landing'].includes(mode);this.onState(this.state());}
  state(){return {mode:this.mode,button:this.button,releaseButton:this.releaseButton,walkDirection:this.walkDirection??1,animationEpoch:this.animationEpoch,animationWaiting:this.animationWaiting,bounds:{...this.bounds},collisionInsets:{...this.collisionInsets},collisionBounds:this.collisionRect(),velocity:{...this.velocity},since:this.since??this.now(),animationElapsedMs:this.animationNow(),snapshotSpeed:this.speed,anchor:this.anchor?{...this.anchor}:null,pull:this.pull?{...this.pull}:null};}
  collisionRect(x=this.bounds.x,y=this.bounds.y){const inset=this.collisionInsets;return {x:x+inset.left,y:y+inset.top,width:this.bounds.width-inset.left-inset.right,height:this.bounds.height-inset.top-inset.bottom};}
  areas(){const areas=this.displays().map(d=>d.workArea??d).filter(a=>Number.isFinite(a.x)&&Number.isFinite(a.y)&&a.width>0&&a.height>0);return areas.length?areas:[{x:0,y:0,width:1920,height:1080}];}
  area(){
    const areas=this.areas();
    const body=this.collisionRect(),cx=body.x+body.width/2,cy=body.y+body.height/2;
    return areas.reduce((best,a)=>{const distance=Math.hypot(cx-clamp(cx,a.x,a.x+a.width),cy-clamp(cy,a.y,a.y+a.height));return !best||distance<best.distance?{...a,distance}:best;},null);
  }
  contains(area,x,y){const body=this.collisionRect(x,y);return body.x>=area.x-1e-7&&body.y>=area.y-1e-7&&body.x+body.width<=area.x+area.width+1e-7&&body.y+body.height<=area.y+area.height+1e-7;}
  allowed(x,y){
    const areas=this.areas(),body=this.collisionRect(x,y),width=body.width,height=body.height;
    if(areas.some(area=>this.contains(area,x,y)))return true;
    // Cover the complete body rectangle with the union of display work areas.
    // A shared seam may split its coverage; an uncovered hole must not pass.
    const left=body.x,top=body.y,right=left+width,bottom=top+height,clipped=areas.filter(a=>a.x<right&&a.x+a.width>left&&a.y<bottom&&a.y+a.height>top);
    const edges=[...new Set([left,right,...clipped.flatMap(a=>[Math.max(left,a.x),Math.min(right,a.x+a.width)])])].sort((a,b)=>a-b);
    for(let i=1;i<edges.length;i++){
      if(edges[i]-edges[i-1]<=1e-7)continue;
      const middle=(edges[i]+edges[i-1])/2,rows=clipped.filter(a=>middle>=a.x&&middle<=a.x+a.width).map(a=>[Math.max(top,a.y),Math.min(bottom,a.y+a.height)]).sort((a,b)=>a[0]-b[0]);
      let covered=top;for(const [start,end]of rows){if(start>covered+1e-7)return false;covered=Math.max(covered,end);if(covered>=bottom-1e-7)break;}
      if(covered<bottom-1e-7)return false;
    }
    return edges.length>1;
  }
  sweep(axis,target){
    const start=this.bounds[axis],other=axis==='x'?'y':'x',delta=target-start;
    if(!delta)return {value:start,blocked:false};
    const x=axis==='x'?target:this.bounds.x,y=axis==='y'?target:this.bounds.y,areas=this.areas();
    if(areas.some(area=>this.contains(area,this.bounds.x,this.bounds.y)&&this.contains(area,x,y)))return {value:target,blocked:false};
    const size=this.bounds[axis==='x'?'width':'height'],leading=this.collisionInsets[axis==='x'?'left':'top'],trailing=this.collisionInsets[axis==='x'?'right':'bottom'],fixed=this.bounds[other],points=[0,1];
    for(const area of areas)for(const edge of [area[axis],area[axis]+area[axis==='x'?'width':'height']])for(const offset of [leading,size-trailing]){const t=(edge-offset-start)/delta;if(t>0&&t<1)points.push(t);}
    const boundaries=[...new Set(points)].sort((a,b)=>a-b);
    for(let i=1;i<boundaries.length;i++){
      const middle=start+delta*(boundaries[i]+boundaries[i-1])/2;
      if(!this.allowed(axis==='x'?middle:fixed,axis==='y'?middle:fixed))return {value:start+delta*boundaries[i-1],blocked:true};
    }
    return {value:target,blocked:false};
  }
  limits(){
    const areas=this.areas(),inset=this.collisionInsets;
    // Each limit is reachable along its axis; corners across a union hole are
    // still checked by sweep(), rather than treating this as one large screen.
    const minX=Math.min(...areas.map(a=>a.x))-inset.left,maxX=Math.max(...areas.map(a=>a.x+a.width))-(this.bounds.width-inset.right);
    const minY=Math.min(...areas.map(a=>a.y))-inset.top,maxY=Math.max(...areas.map(a=>a.y+a.height))-(this.bounds.height-inset.bottom);
    return {minX:this.sweep('x',minX).value,maxX:this.sweep('x',maxX).value,minY:this.sweep('y',minY).value,maxY:this.sweep('y',maxY).value};
  }
  commit(x,y){this.bounds={...this.bounds,x,y};const fixed={...this.bounds,x:Math.round(x),y:Math.round(y)};if(!this.lastPosition||Object.keys(fixed).some(k=>fixed[k]!==this.lastPosition[k])){this.lastPosition=fixed;this.onPosition({...fixed});}}
  contain(){
    if(this.allowed(this.bounds.x,this.bounds.y)){this.commit(this.bounds.x,this.bounds.y);return;}
    const {x,y,width,height}=this.bounds,inset=this.collisionInsets,areas=this.areas(),xs=[x,...areas.flatMap(a=>[a.x-inset.left,a.x-(width-inset.right),a.x+a.width-inset.left,a.x+a.width-(width-inset.right)])],ys=[y,...areas.flatMap(a=>[a.y-inset.top,a.y-(height-inset.bottom),a.y+a.height-inset.top,a.y+a.height-(height-inset.bottom)])];
    let best=null;
    for(const px of new Set(xs))for(const py of new Set(ys)){const distance=Math.hypot(px-x,py-y);if((!best||distance<best.distance)&&this.allowed(px,py))best={x:px,y:py,distance};}
    if(best)this.commit(best.x,best.y);
    else{const area=this.area();this.commit(clamp(x,area.x-inset.left,Math.max(area.x-inset.left,area.x+area.width-(width-inset.right))),clamp(y,area.y-inset.top,Math.max(area.y-inset.top,area.y+area.height-(height-inset.bottom))));}
  }
  sample(p){const t=this.now();this.samples=this.samples.filter(s=>t-s.t<=150);const last=this.samples.at(-1);if(last&&t-last.t<8){last.x=p.x;last.y=p.y;}else this.samples.push({...p,t});}
  begin(p,{button=2}={}){
    if(!finitePoint(p))throw Error('Invalid pointer coordinates');
    if(button!==0&&button!==2)throw Error('Invalid gesture button');
    this.button=button;this.releaseButton=button;this.chordUsed=false;this.walkDirection=1;this.directionPoint={...p};
    // Electron returns integer native bounds. At fractional DPI the rounded
    // floor position can lie a fraction outside the DIP collision area, which
    // otherwise blocks every sweep (including dragging away from the floor).
    this.contain();
    const caught=this.mode==='flying'||this.mode==='landing';this.serial++;this.velocity={x:0,y:0};this.origin={...p};this.offset={x:p.x-this.bounds.x,y:p.y-this.bounds.y};this.moved=false;this.caught=caught;this.samples=[];this.sample(p);this.pull=null;this.anchor=null;this.setMode('pressed');return {caught,serial:this.serial};
  }
  move(p,{sample=true}={}){
    if(!finitePoint(p)||!['pressed','dragging','charging'].includes(this.mode))return;
    if(this.mode==='charging'){this.pull={x:p.x-this.chargePoint.x,y:p.y-this.chargePoint.y};this.onState(this.state());return;}
    if(Math.abs(p.x-this.directionPoint.x)>=2){this.walkDirection=Math.sign(p.x-this.directionPoint.x);this.directionPoint={...p};}
    // A stopped cursor must not become a fresh velocity sample at release.
    const last=this.samples.at(-1);if(sample&&(!last||p.x!==last.x||p.y!==last.y))this.sample(p);
    if(Math.hypot(p.x-this.origin.x,p.y-this.origin.y)>5)this.moved=true;
    if(!this.moved)return;
    this.setMode('dragging');const x=this.sweep('x',p.x-this.offset.x);this.bounds.x=x.value;const y=this.sweep('y',p.y-this.offset.y);this.bounds.y=y.value;this.commit(this.bounds.x,this.bounds.y);
  }
  estimate(){
    const now=this.now(),last=this.samples.at(-1);if(!last||now-last.t>=150)return {x:0,y:0};
    const rows=this.samples.filter(s=>last.t-s.t<=120),first=rows[0];if(!first||last.t-first.t<8)return {x:0,y:0};
    return this.limit({x:(last.x-first.x)/(last.t-first.t)*1000,y:(last.y-first.y)/(last.t-first.t)*1000},3600*PET_STRENGTHS[this.strength]);
  }
  limit(v,cap){const length=Math.hypot(v.x,v.y);if(!length)return {x:0,y:0};const speed=cap*Math.tanh(length/cap);return {x:v.x/length*speed,y:v.y/length*speed};}
  right(p){
    // Legacy method name retained; called by the secondary LEFT press of a
    // RIGHT-owned gesture. Left-owned walking cannot arm a slingshot.
    if(this.button!==2||!finitePoint(p))return false;
    this.chordUsed=true;
    if(this.mode==='charging')return false;
    if(this.mode!=='dragging'||!this.enabled)return false;
    this.anchor={x:this.bounds.x,y:this.bounds.y};this.chargePoint={...p};this.pull={x:0,y:0};this.releaseButton=0;this.setMode('charging');return true;
  }
  // Cancelling a gesture never freezes a throw that is already in the air (B8).
  cancel(){if(this.mode==='flying')return {moved:false,cancelled:false,flying:true};if(this.anchor)this.commit(this.anchor.x,this.anchor.y);this.velocity={x:0,y:0};this.pull=null;this.anchor=null;this.samples=[];this.setMode('rest');this.contain();return {moved:true,cancelled:true};}
  release(p,{cancelled=false,button=this.releaseButton??this.button}={}){
    if(cancelled)return this.cancel();
    if(!['pressed','dragging','charging'].includes(this.mode))return {moved:true,ignored:true};
    if(button!==(this.releaseButton??this.button))return {ignored:true};
    // Only previously sampled movement determines release. A late renderer or
    // button-up coordinate must never add velocity or relocate the pet.
    const charging=this.mode==='charging';let velocity=charging?this.limit({x:-this.pull.x*8*PET_STRENGTHS[this.strength],y:-this.pull.y*8*PET_STRENGTHS[this.strength]},4800*PET_STRENGTHS[this.strength]):this.estimate();
    const tap=!this.moved&&!this.caught&&!this.chordUsed;
    const result={moved:this.moved,caught:this.caught,touch:tap&&this.button===0,context:tap&&this.button===2,button:this.button,releasedButton:button,slingshot:charging,serial:this.serial};
    if(this.button===2&&this.enabled&&this.moved&&Math.hypot(velocity.x,velocity.y)>=300){this.velocity=velocity;this.flightAt=this.now();this.lastTick=this.now();this.pull=null;this.anchor=null;this.setMode('flying');result.flying=true;}
    else{this.velocity={x:0,y:0};this.pull=null;this.anchor=null;this.setMode('rest');this.contain();}
    return result;
  }
  preview(){
    if(this.mode!=='charging')return [];
    const v=this.limit({x:-this.pull.x*8*PET_STRENGTHS[this.strength],y:-this.pull.y*8*PET_STRENGTHS[this.strength]},4800*PET_STRENGTHS[this.strength]);
    if(Math.hypot(v.x,v.y)<300)return [];
    let time=0;const probe=new PetMotion({now:()=>time,bounds:this.bounds,collisionInsets:this.collisionInsets,displays:()=>this.areas()});
    probe.velocity=v;probe.setMode('flying');
    return Array.from({length:13},(_,i)=>{time=i*25;probe.tick();return {x:probe.bounds.x-this.bounds.x-this.pull.x,y:probe.bounds.y-this.bounds.y-this.pull.y};});
  }
  // Where the throw with the current pull settles (design 5.4 landing ring): the same flight as preview(), run until it lands.
  landing(){
    if(this.mode!=='charging')return null;
    const v=this.limit({x:-this.pull.x*8*PET_STRENGTHS[this.strength],y:-this.pull.y*8*PET_STRENGTHS[this.strength]},4800*PET_STRENGTHS[this.strength]);
    if(Math.hypot(v.x,v.y)<300)return null;
    let time=0;const probe=new PetMotion({now:()=>time,bounds:this.bounds,collisionInsets:this.collisionInsets,displays:()=>this.areas()});
    probe.velocity=v;probe.setMode('flying');
    for(let i=1;i<=320&&probe.mode==='flying';i++){time=i*25;probe.tick();}
    return probe.mode==='flying'?null:{x:probe.bounds.x-this.bounds.x-this.pull.x,y:probe.bounds.y-this.bounds.y-this.pull.y};
  }
  tick(){
    const now=this.now(),elapsed=now-this.lastTick;this.lastTick=now;
    if(this.mode==='landing'){if(this.animationNow(now)>=(this.landDurationMs??4000))this.setMode('rest');return this.state();}
    if(this.mode!=='flying')return this.state();
    // After a stall longer than 500 ms (busy main thread, hidden window) the throw
    // advances 50 ms and carries on; it never stops in mid-air (B8).
    let remaining=(elapsed>500?50:Math.max(0,elapsed))/1000;
    while(remaining>0&&this.mode==='flying'){
      const dt=Math.min(remaining,1/120);remaining-=dt;
      this.velocity.y+=1400*dt;this.velocity.x*=Math.exp(-.35*dt);
      const horizontal=this.sweep('x',this.bounds.x+this.velocity.x*dt);this.bounds.x=horizontal.value;
      if(horizontal.blocked)this.velocity.x=-this.velocity.x*.65;
      const vertical=this.sweep('y',this.bounds.y+this.velocity.y*dt);this.bounds.y=vertical.value;
      if(vertical.blocked&&this.velocity.y<0)this.velocity.y=Math.abs(this.velocity.y)*.5;
      else if(vertical.blocked){if(Math.abs(this.velocity.y)<125){this.velocity.y=0;this.velocity.x*=Math.exp(-5*dt);if(Math.abs(this.velocity.x)<18){this.velocity={x:0,y:0};this.setMode('landing');}}else{this.velocity.y=-Math.abs(this.velocity.y)*.62;this.velocity.x*=.78;}}
    }
    this.commit(this.bounds.x,this.bounds.y);
    return this.state();
  }
  // A throw that has to stop (physics turned off, flight animation failed) lands
  // straight below instead of resting in mid-air (B8).
  stop(){if(this.mode==='flying'){const floor=this.sweep('y',this.bounds.y+100000);this.bounds.y=floor.value;}this.velocity={x:0,y:0};this.pull=null;this.anchor=null;this.samples=[];this.setMode('rest');this.contain();}
  // Drop straight down from the current position. The new animation epoch makes
  // media messages for the interrupted flight stale.
  fall(){this.velocity={x:0,y:0};this.pull=null;this.anchor=null;this.samples=[];this.contain();this.mode='rest';this.setMode('flying');this.flightAt=this.now();this.lastTick=this.now();}
  recover(bounds){
    if(bounds)this.bounds={...bounds};
    // The OS may have moved the native window independently (DPI, display or
    // resume). Reapply the recovered position even when it equals our cache.
    this.lastPosition=null;
    if(this.mode==='flying'&&this.enabled){this.fall();return;}
    this.stop();this.lastTick=this.now();
  }
}
