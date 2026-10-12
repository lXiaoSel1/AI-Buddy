// A fixed-texture, anatomical deformation rig. No frame-to-frame optical flow.
export const WORKING_RIG=Object.freeze({version:'v012-working-expression-pilot',width:384,height:416,step:12,phases:24,cycleMs:900,headDegrees:6.5,headPivot:[192,247],leftShoulder:[151,258],rightShoulder:[234,258],tailPivot:[253,326]});
export const TAU=Math.PI*2;
export const smooth=(a,b,v)=>{const t=Math.max(0,Math.min(1,(v-a)/(b-a)));return t*t*(3-2*t);};
export function rigPhase(sample){return ((sample.frame+Math.max(0,Math.min(1,sample.mix??0)))/WORKING_RIG.phases%1)*TAU;}
// Reuse the original short working blink around frames 14–16. No whole-face
// texture change, no iris dissolve; the half/closed drawings are local parts.
export function rigEyeState(phase){const t=((phase/TAU)%1+1)%1;return t>=.60&&t<.67?2:t>=.55&&t<.72?1:0;}
export function rigPose(phase){
  const head=Math.sin(phase)*WORKING_RIG.headDegrees*Math.PI/180,left=Math.sin(phase+.3)*2.6*Math.PI/180,right=-left,tail=Math.sin(phase-1)*1.6*Math.PI/180;
  return {head:[Math.cos(head)-1,Math.sin(head),-2.3*Math.sin(phase),.005*(1-Math.cos(phase))],arms:[Math.cos(left)-1,Math.sin(left),Math.cos(right)-1,Math.sin(right)],detail:[-1.8*Math.sin(phase+.3),1.8*Math.sin(phase+.3),2.9*Math.sin(phase-.65),Math.cos(tail)-1],tailSin:Math.sin(tail)};
}
const ellipse=(x,y,cx,cy,rx,ry)=>1-smooth(.18,1,((x-cx)/rx)**2+((y-cy)/ry)**2);
export function rigPoint(x,y,pose){
  const h=1-smooth(238,310,y),body=1-smooth(332,382,y),chest=smooth(245,270,y)*(1-smooth(327,354,y));
  const l=ellipse(x,y,170,281,31,38),r=ellipse(x,y,211,281,31,38),hl=ellipse(x,y,92,294,40,43),hr=ellipse(x,y,282,294,41,43);
  const t=smooth(258,285,x)*smooth(305-.35*(x-260),319-.35*(x-260),y)*(1-smooth(368,385,y));
  const [hc,hs,lift,expand]=pose.head,[lc,ls,rc,rs]=pose.arms,[ll,rl,hair,tc]=pose.detail,ts=pose.tailSin;
  return [x+h*((x-192)*hc-(y-247)*hs)+chest*(x-192)*expand+l*((x-151)*lc-(y-258)*ls)+r*((x-234)*rc-(y-258)*rs)+(hl+hr)*hair+t*((x-253)*tc-(y-326)*ts),
    y+body*lift+h*((x-192)*hs+(y-247)*hc)+l*((x-151)*ls+(y-258)*lc+ll)+r*((x-234)*rs+(y-258)*rc+rl)+t*((x-253)*ts+(y-326)*tc)];
}
export const gridColumns=Math.ceil(WORKING_RIG.width/WORKING_RIG.step),gridRows=Math.ceil(WORKING_RIG.height/WORKING_RIG.step);
export const gridNode=(x,y)=>[Math.min(WORKING_RIG.width,x*WORKING_RIG.step),Math.min(WORKING_RIG.height,y*WORKING_RIG.step)];
const barycentric=(x,y,a,b,c)=>{const d=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);return [( (b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/d,((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/d];};
export function rigInverse(x,y,pose){
  let sx=x,sy=y;for(let n=0;n<4;n++){const [dx,dy]=rigPoint(sx,sy,pose);sx+=x-dx;sy+=y-dy;}
  const cx=Math.max(0,Math.min(gridColumns-1,Math.floor(sx/WORKING_RIG.step))),cy=Math.max(0,Math.min(gridRows-1,Math.floor(sy/WORKING_RIG.step)));
  // Match the GPU's piecewise-linear triangles, including the shortened last row.
  for(let j=Math.max(0,cy-1);j<=Math.min(gridRows-1,cy+1);j++)for(let i=Math.max(0,cx-1);i<=Math.min(gridColumns-1,cx+1);i++){
    const a=gridNode(i,j),b=gridNode(i+1,j),c=gridNode(i,j+1),d=gridNode(i+1,j+1);
    for(const triangle of [[a,b,c],[b,d,c]]){const mapped=triangle.map(p=>rigPoint(p[0],p[1],pose)),[u,v]=barycentric(x,y,...mapped),w=1-u-v;if(u>=-1e-6&&v>=-1e-6&&w>=-1e-6)return [u*triangle[0][0]+v*triangle[1][0]+w*triangle[2][0],u*triangle[0][1]+v*triangle[1][1]+w*triangle[2][1]];}
  }return null;
}
export function rigMesh(){const vertices=[];for(let y=0;y<gridRows;y++)for(let x=0;x<gridColumns;x++){const a=gridNode(x,y),b=gridNode(x+1,y),c=gridNode(x,y+1),d=gridNode(x+1,y+1);for(const p of [a,b,c,b,d,c])vertices.push(...p);}return new Float32Array(vertices);}
// The same controls as rigPoint(), applied to a static grid on the GPU.
export const workingVertex=`attribute vec2 aPosition;varying vec2 vUv;uniform vec4 uHead;uniform vec4 uArms;uniform vec4 uDetail;uniform float uTailSin;
float ellipse(vec2 p,vec2 center,vec2 radius){vec2 q=(p-center)/radius;return 1.-smoothstep(.18,1.,dot(q,q));}
void main(){vec2 p=aPosition;float h=1.-smoothstep(238.,310.,p.y),body=1.-smoothstep(332.,382.,p.y),chest=smoothstep(245.,270.,p.y)*(1.-smoothstep(327.,354.,p.y));float l=ellipse(p,vec2(170.,281.),vec2(31.,38.)),r=ellipse(p,vec2(211.,281.),vec2(31.,38.));float hl=ellipse(p,vec2(92.,294.),vec2(40.,43.)),hr=ellipse(p,vec2(282.,294.),vec2(41.,43.));float t=smoothstep(258.,285.,p.x)*smoothstep(305.-.35*(p.x-260.),319.-.35*(p.x-260.),p.y)*(1.-smoothstep(368.,385.,p.y));
vec2 q=p; q.x+=h*((p.x-192.)*uHead.x-(p.y-247.)*uHead.y)+chest*(p.x-192.)*uHead.w+l*((p.x-151.)*uArms.x-(p.y-258.)*uArms.y)+r*((p.x-234.)*uArms.z-(p.y-258.)*uArms.w)+(hl+hr)*uDetail.z+t*((p.x-253.)*uDetail.w-(p.y-326.)*uTailSin);
q.y+=body*uHead.z+h*((p.x-192.)*uHead.y+(p.y-247.)*uHead.x)+l*((p.x-151.)*uArms.y+(p.y-258.)*uArms.x+uDetail.x)+r*((p.x-234.)*uArms.w+(p.y-258.)*uArms.z+uDetail.y)+t*((p.x-253.)*uTailSin+(p.y-326.)*uDetail.w);
vUv=p/vec2(384.,416.);gl_Position=vec4(q/vec2(384.,416.)*vec2(2.,-2.)+vec2(-1.,1.),0.,1.);}`;
