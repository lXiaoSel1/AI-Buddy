// Anatomical controls for the five redrawn actions. Time and gaze are separate.
export const TAU=Math.PI*2;
export const wrap=t=>((t%1)+1)%1;
export const lerp=(a,b,t)=>a+(b-a)*t;
export const ease=t=>{t=Math.max(0,Math.min(1,t));return t*t*t*(10+t*(-15+6*t));};
export const interval=(a,b,t)=>ease((t-a)/(b-a));
const mixPoint=(a,b,t)=>[lerp(a[0],b[0],t),lerp(a[1],b[1],t)];
export function solveTwoBone(root,target,upperLength,lowerLength,bend=1){
 const dx=target[0]-root[0],dy=target[1]-root[1],requestedDistance=Math.hypot(dx,dy),distance=Math.max(Math.abs(upperLength-lowerLength)+1e-5,Math.min(upperLength+lowerLength-1e-5,requestedDistance)),direction=Math.atan2(dy,dx),a=Math.acos(Math.max(-1,Math.min(1,(upperLength**2+distance**2-lowerLength**2)/(2*upperLength*distance)))),upperAngle=direction+bend*a;
 const elbow=[root[0]+upperLength*Math.cos(upperAngle),root[1]+upperLength*Math.sin(upperAngle)],end=[root[0]+distance*Math.cos(direction),root[1]+distance*Math.sin(direction)];
 return {root,joint:elbow,end,upperAngle,lowerAngle:Math.atan2(end[1]-elbow[1],end[0]-elbow[0]),upperLength,lowerLength,reachable:Math.abs(distance-requestedDistance)<.001};
}
export function footPath(phase,direction=1){
 const u=wrap(phase),s=Math.max(0,(u-.4)/.6),swing=64*s**3*(1-s)**3;
 return {x:direction*24*Math.cos(TAU*u),y:363-18*swing,contact:u<=.4,tilt:direction*(u<=.4?lerp(-.14,.22,ease(u/.4)):.22*Math.cos(TAU*u))};
}
export function blinkOpen(clockMs,period=3200){
 const t=((clockMs%period)+period)%period,at=period*.62;
 if(t<at-60||t>=at+120)return 1;
 if(t<at)return 1-ease((t-at+60)/60);
 if(t<at+30)return 0;
 return ease((t-at-30)/90);
}
export function failureExpression(t){
 t=wrap(t);const crying=interval(.18,.34,t)*(1-interval(.66,.82,t)),sad=interval(.66,.82,t)*(1-interval(.94,1,t));
 const fear=interval(0,.08,t)*(1-interval(.18,.34,t));
 return {crying,sad,fear,quiver:crying*Math.sin(TAU*t*8)*.55};
}
export function gazePose(angle,weight=1){const a=angle*Math.PI/180;return {yaw:65*Math.PI/180*Math.sin(a)*weight,pitch:-22*Math.PI/180*Math.cos(a)*weight};}
export function fiveActionPose(id,phase,{clockMs=0,gazeAngle=null,gazeWeight=1,movementDirection=null}={}){
 const t=wrap(phase),p=TAU*t,run=id==='move-left'||id==='move-right',direction=movementDirection??(id==='move-left'?-1:1),expr=id==='fail'?failureExpression(t):null,lift=run?-2*Math.sin(p)**2:-1.2*Math.sin(p),roll=(run?2:3)*Math.PI/180*Math.sin(p),gaze=id==='look'?gazePose(gazeAngle??t*360,gazeWeight):{yaw:run?direction*.72:0,pitch:0};
 const shoulders=[[170,256+lift],[214,256+lift]],arms=[];
 if(run){for(let n=0;n<2;n++){const a=p+n*Math.PI,root=[n?216:168,264+lift],target=[root[0]-direction*20*Math.cos(a),285-9*Math.cos(a)];arms.push(solveTwoBone(root,target,22,24,n?-1:1));}}
 else if(id==='waiting'){const opening=interval(.18,.38,t)*(1-interval(.67,.87,t));for(let n=0;n<2;n++){const a=n?[199,272+lift]:[185,272+lift],b=n?[259,249+lift]:[125,249+lift];arms.push(solveTwoBone(shoulders[n],mixPoint(a,b,opening),25,30,n?-1:1));}gaze.opening=opening;}
 else if(id==='fail'){const raise=interval(.18,.34,t)*(1-interval(.66,.82,t));for(let n=0;n<2;n++){const down=n?[230,301+lift]:[154,301+lift],raw=n?[227,246]:[157,246],x=raw[0]-192,y=raw[1]-247,cheek=[192+x*Math.cos(roll)-y*Math.sin(roll)+expr.quiver,247+x*Math.sin(roll)+y*Math.cos(roll)+lift],target=mixPoint(down,cheek,raise);target[0]+=(n?1:-1)*20*Math.sin(Math.PI*raise);arms.push(solveTwoBone(shoulders[n],target,25,30,n?-1:1));}}
 const legs=run?[0,1].map(n=>{const path=footPath(t+n*.5,direction),root=[n?204:180,332+lift],limb=solveTwoBone(root,[root[0]+path.x,path.y],22,24,n?-1:1);return {...limb,...path};}):[];
 return {id,t,lift,roll,gaze,arms,legs,expression:expr,eyeOpen:expr?1-expr.crying:blinkOpen(clockMs),hair:1.3*Math.sin(p-.65),tail:1.3*Math.PI/180*Math.sin(p-1)};
}
