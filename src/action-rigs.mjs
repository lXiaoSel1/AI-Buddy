import {smooth,TAU} from './working-rig.mjs';
export const RIG_SIZE={width:384,height:416,step:16};
const front={headPivot:[192,247],headBand:[238,310],floor:395,headDegrees:3.5,breath:1.7};
const arm=(pivot,end,radius=18)=>({pivot,end,radius});
export const ACTION_RIGS={
 idle:{...front,mother:0,headPivot:[192,296],headBand:[286,327],floor:395,headDegrees:3,breath:1,textLock:150,eyes:[[177,260,16,15],[214,260,16,15]]},
 'move-left':{...front,mother:0,headPivot:[145,235],headBand:[221,286],floor:365,headDegrees:2,breath:0,eyes:[[122,179,14,18]],run:-1,arms:[arm([147,236],[96,238],20),arm([202,253],[231,258],20)],legs:[arm([152,313],[100,348],32),arm([211,312],[239,337],29)]},
 'move-right':{...front,mother:0,headPivot:[225,229],headBand:[214,275],floor:372,headDegrees:2,breath:0,eyes:[[254,171,16,18]],run:1,arms:[arm([249,233],[298,228],20),arm([193,249],[152,246],20)],legs:[arm([240,310],[274,344],32),arm([193,307],[141,329],29)]},
 wave:{...front,mother:0,eyes:[[167,194,24,22],[230,194,24,22]],arms:[arm([154,258],[127,225],20)],waving:true},
 jump:{...front,mother:0,eyes:[[167,197,24,22],[227,197,24,22]],jump:true,arms:[arm([153,257],[141,295],20),arm([234,257],[246,294],20)],armKeys:[{at:0,frame:0,ends:[[141,295],[246,294]]},{at:.18,frame:0,ends:[[139,288],[247,287]]},{at:.31,frame:6,ends:[[119,194],[273,196]]},{at:.65,frame:6,ends:[[119,194],[273,196]]},{at:.83,frame:0,ends:[[141,295],[246,294]]},{at:1,frame:0,ends:[[141,295],[246,294]]}]},
 fail:{...front,mother:8,eyes:[[162,198,24,22],[226,198,24,22]],fail:true,arms:[arm([154,267],[161,242],19),arm([230,267],[225,243],19)],armKeys:[{at:0,frame:0,ends:[[163,300],[224,300]]},{at:.18,frame:0,ends:[[163,300],[224,300]]},{at:.31,frame:8,ends:[[161,242],[225,243]]},{at:.66,frame:8,ends:[[161,242],[225,243]]},{at:.82,frame:23,ends:[[164,302],[220,301]]},{at:1,frame:0,ends:[[163,300],[224,300]]}]},
 waiting:{...front,mother:0,eyes:[[164,193,24,22],[225,193,24,22]],arms:[arm([155,258],[185,250],18),arm([232,258],[204,250],18)],armKeys:[{at:0,frame:0,ends:[[185,250],[204,250]]},{at:.18,frame:0,ends:[[185,250],[204,250]]},{at:.38,frame:12,ends:[[121,247],[274,243]]},{at:.67,frame:12,ends:[[121,247],[274,243]]},{at:.87,frame:0,ends:[[185,250],[204,250]]},{at:1,frame:0,ends:[[185,250],[204,250]]}]},
 reviewing:{...front,mother:0,headBand:[254,307],headDegrees:5.5,eyes:[[164,194,24,22],[219,194,24,22]],chin:true},
 look:{...front,mother:0,headPivot:[192,239],headBand:[228,299],headDegrees:0,eyes:[],look:true},
};
for(const id of ['move-left','move-right','wave'])ACTION_RIGS[id].meshLimbs=true;
export const RIG_DESCRIPTIONS={idle:'文字和牌面固定 · 轻呼吸、摇头、眨眼','move-left':'向左跑 · 手脚交替、落脚回弹、发梢延迟','move-right':'向右跑 · 手脚交替、落脚回弹、发梢延迟',wave:'弧线挥手 · 摇头、眨眼、发梢轻摆',jump:'下蹲、起跳、腾空、落地 · 抬手、收手、闭眼笑',fail:'受惊、哭泣、沮丧 · 抬手、肩部细颤',waiting:'合手、摊手 · 摇头、眨眼、轻呼吸',working:'沿用已确认小样 · 摇头、眨眼、双手交替',reviewing:'托腮思考 · 头部倾摆、眨眼、手随头动',look:'24个方向姿态配准 · 保留16方向按钮和鼠标跟随'};
export const phaseOf=sample=>((sample.frame+(sample.mix??0))/24)%1;
export function blinkState(t){return t>=.60&&t<.67?2:t>=.55&&t<.72?1:0;}
const radians=degrees=>degrees*Math.PI/180;
export function jumpState(t){
 if(t<.18){const s=smooth(0,.18,t);return {lift:0,squash:.075*s,stage:'anticipation'};}
 if(t<.68){const u=(t-.18)/.50;return {lift:-57*4*u*(1-u),squash:.075*(1-smooth(.18,.24,t)),stage:u<.5?'launch':'descent'};}
 if(t<.82){const u=(t-.68)/.14;return {lift:0,squash:.10*Math.sin(Math.PI*u),stage:'contact'};}
 return {lift:0,squash:0,stage:'recovery'};
}
export function expressionState(id,t){if(id==='fail')return t<.24||t>=.97?'fear':t<.75?'cry':'sad';if(id==='jump'&&t>.27&&t<.62)return 'joy';return ['open','half','closed'][blinkState(t)];}
function arc(a,b){return ((b-a+Math.PI*3)%(TAU))-Math.PI;}
export function jointPose(cfg,t,index){const base=cfg.arms[index];let angle=0,scale=1,sourceFrame=cfg.mother,sourceEnd=base.end;
 if(cfg.armKeys){const keys=cfg.armKeys,j=Math.min(keys.length-2,Math.max(0,keys.findLastIndex(k=>k.at<=t))),a=keys[j],b=keys[j+1],u=smooth(a.at,b.at,t);sourceFrame=u<.5?a.frame:b.frame;sourceEnd=(u<.5?a:b).ends[index];const vector=end=>[end[0]-base.pivot[0],end[1]-base.pivot[1]],v=vector(a.ends[index]),w=vector(b.ends[index]),s=vector(sourceEnd);const desired=Math.atan2(v[1],v[0])+arc(Math.atan2(v[1],v[0]),Math.atan2(w[1],w[0]))*u;angle=desired-Math.atan2(s[1],s[0]);scale=(Math.hypot(...v)*(1-u)+Math.hypot(...w)*u)/Math.hypot(...s);
 }else if(cfg.run){angle=radians((index?1:-1)*23*Math.sin(TAU*t));}
 else if(cfg.waving){angle=radians(17*Math.sin(TAU*t));}
 else if(cfg.chin){angle=radians(cfg.headDegrees*Math.sin(TAU*t));}
 return {angle,scale,sourceFrame,sourceEnd};}
export function actionPose(cfg,t){const p=TAU*t,jump=cfg.jump?jumpState(t):null,sin=Math.sin(p),head=radians(cfg.headDegrees*sin),tail=radians(1.6*Math.sin(p-1)),arm=(cfg.waving?.27:.18)*sin,leg=.23*sin;return {t,head,headCos:Math.cos(head)-1,headSin:Math.sin(head),tail,tailCos:Math.cos(tail)-1,tailSin:Math.sin(tail),armCos:Math.cos(arm)-1,armSin:Math.sin(arm),legCos:Math.cos(leg)-1,legSin:Math.sin(leg),lift:cfg.run?-2.1*(1-Math.cos(2*p)):-(cfg.breath??1.7)*sin,jumpLift:jump?.lift??0,squash:jump?.squash??0,stage:jump?.stage??null,hair:2*Math.sin(p-.65),quiver:cfg.fail&&t>.24&&t<.75?Math.sin(p*8)*.75:0};}
function boneDistance(x,y,bone){const dx=bone.end[0]-bone.pivot[0],dy=bone.end[1]-bone.pivot[1],t=Math.max(0,Math.min(1,((x-bone.pivot[0])*dx+(y-bone.pivot[1])*dy)/(dx*dx+dy*dy)));return Math.hypot(x-bone.pivot[0]-dx*t,y-bone.pivot[1]-dy*t);}
// Write into the persistent GPU buffer. No per-vertex arrays or closures during
// playback, and one set of trigonometric controls per action per refresh.
export function actionPointInto(cfg,pose,x,y,out,offset=0){
 if(cfg.textLock&&y<cfg.textLock){out[offset]=x;out[offset+1]=y;return;}
 const h=(cfg.textLock?smooth(150,176,y):1)*(1-smooth(cfg.headBand[0],cfg.headBand[1],y)),body=(cfg.textLock?smooth(150,176,y):1)*(1-smooth(cfg.floor-55,cfg.floor,y)),dx=x-cfg.headPivot[0],dy=y-cfg.headPivot[1];
 const hair=(1-smooth(135,164,x)+smooth(255,291,x))*smooth(236,270,y)*(1-smooth(324,354,y)),tail=smooth(258,286,x)*smooth(299-.32*(x-260),321-.32*(x-260),y)*(1-smooth(370,391,y));
 let qx=x+h*(dx*pose.headCos-dy*pose.headSin)+hair*pose.hair+tail*((x-253)*pose.tailCos-(y-326)*pose.tailSin)+body*pose.quiver,qy=y+h*(dx*pose.headSin+dy*pose.headCos)+body*pose.lift+tail*((x-253)*pose.tailSin+(y-326)*pose.tailCos);
 if(cfg.meshLimbs){for(let n=0;n<cfg.arms.length;n++){const bone=cfg.arms[n],bx=x-bone.pivot[0],by=y-bone.pivot[1],w=1-smooth(12,43,boneDistance(x,y,bone));qx+=w*(bx*pose.armCos-by*pose.armSin);qy+=w*(bx*pose.armSin+by*pose.armCos);}for(let n=0;n<(cfg.legs?.length??0);n++){const bone=cfg.legs[n],bx=x-bone.pivot[0],by=y-bone.pivot[1],w=(1-smooth(24,65,boneDistance(x,y,bone)))*smooth(bone.pivot[1]+2,bone.pivot[1]+25,y);qx+=w*(bx*pose.legCos-by*pose.legSin);qy+=w*(bx*pose.legSin+by*pose.legCos);}}
 if(cfg.jump){qy=cfg.floor+(qy-cfg.floor)*(1-pose.squash)+pose.jumpLift;qx=192+(qx-192)*(1+pose.squash*.25);}out[offset]=qx;out[offset+1]=qy;
}
export function actionPoint(cfg,pose,x,y){const out=[0,0];actionPointInto(cfg,pose,x,y,out);return out;}
export const cols=24,rows=26;
const node=(x,y)=>[x*16,y*16];
export function meshNodes(){return Array.from({length:(cols+1)*(rows+1)},(_,i)=>node(i%(cols+1),Math.floor(i/(cols+1))));}
export function meshIndices(){const out=[];for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){const a=y*(cols+1)+x,b=a+1,c=a+cols+1,d=c+1;out.push(a,b,c,b,d,c);}return new Uint16Array(out);}
export function invertMesh(x,y,points){const min=(v,max)=>Math.max(0,Math.min(max,v));const ix=min(Math.floor(x/16),23),iy=min(Math.floor(y/16),25);
 for(let cy=min(iy-5,25);cy<=min(iy+5,25);cy++)for(let cx=min(ix-3,23);cx<=min(ix+3,23);cx++){const a=cy*25+cx,b=a+1,c=a+25,d=c+1;for(const ids of [[a,b,c],[b,d,c]]){const [p,q,r]=ids.map(i=>points[i]);const det=(q[1]-r[1])*(p[0]-r[0])+(r[0]-q[0])*(p[1]-r[1]);const u=((q[1]-r[1])*(x-r[0])+(r[0]-q[0])*(y-r[1]))/det,v=((r[1]-p[1])*(x-r[0])+(p[0]-r[0])*(y-r[1]))/det,w=1-u-v;if(u>=-1e-6&&v>=-1e-6&&w>=-1e-6){const original=ids.map(i=>node(i%25,Math.floor(i/25)));return [u*original[0][0]+v*original[1][0]+w*original[2][0],u*original[0][1]+v*original[1][1]+w*original[2][1]];}}}return null;}
