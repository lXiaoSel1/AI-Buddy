const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
window.whale.onPetAction(event=>{
 if(event.kind!=='trajectory')return;
 const scale=devicePixelRatio||1,width=Math.round(innerWidth*scale),height=Math.round(innerHeight*scale);
 if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
 ctx.setTransform(scale,0,0,scale,0,0);ctx.clearRect(0,0,innerWidth,innerHeight);
 const {motion}=event.value;if(motion.mode!=='charging')return;
 const body=motion.collisionBounds,center={x:body.x+body.width/2-event.origin.x,y:body.y+body.height/2-event.origin.y},pull=motion.pull;
 ctx.lineWidth=2;ctx.strokeStyle='#b2e5ff';ctx.setLineDash([5,4]);ctx.beginPath();ctx.moveTo(center.x,center.y);ctx.lineTo(center.x+pull.x,center.y+pull.y);ctx.stroke();ctx.setLineDash([]);
 ctx.strokeStyle='#ffcf80';ctx.beginPath();for(const [i,p]of motion.preview.entries()){const x=center.x+p.x+pull.x,y=center.y+p.y+pull.y;i?ctx.lineTo(x,y):ctx.moveTo(x,y);}ctx.stroke();
});
