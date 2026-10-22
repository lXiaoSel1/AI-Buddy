const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
// Design 5.4: the rubber band in the theme's second colour, the predicted path as dots that shrink and
// fade towards a dashed landing ring, and the throw strength beside her while charging.
window.whale.onPetAction(event=>{
 if(event.kind!=='trajectory')return;
 const scale=devicePixelRatio||1,width=Math.round(innerWidth*scale),height=Math.round(innerHeight*scale);
 if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
 ctx.setTransform(scale,0,0,scale,0,0);ctx.clearRect(0,0,innerWidth,innerHeight);
 const {motion}=event.value;if(motion.mode!=='charging')return;
 const colors=event.colors,body=motion.collisionBounds,center={x:body.x+body.width/2-event.origin.x,y:body.y+body.height/2-event.origin.y},pull=motion.pull,hand={x:center.x+pull.x,y:center.y+pull.y};
 // a soft theme shadow keeps the light band and dots readable on a light desktop
 ctx.shadowColor=colors.shadow;ctx.shadowBlur=3;
 ctx.lineWidth=2.5;ctx.lineCap='round';ctx.strokeStyle=colors.band;ctx.setLineDash([6,5]);ctx.beginPath();ctx.moveTo(center.x,center.y);ctx.lineTo(hand.x,hand.y);ctx.stroke();ctx.setLineDash([]);
 const path=motion.preview.map(p=>({x:center.x+p.x+pull.x,y:center.y+p.y+pull.y})),count=Math.min(14,path.length);
 ctx.fillStyle=colors.path;
 for(let i=1;i<=count;i++){const p=path[Math.round(i/count*(path.length-1))];ctx.globalAlpha=1-i/count*.72;ctx.beginPath();ctx.arc(p.x,p.y,5-i/count*3.2,0,Math.PI*2);ctx.fill();}
 ctx.globalAlpha=.85;
 // the ring sits under her feet where the flight comes to rest
 if(motion.landing){const x=center.x+motion.landing.x+pull.x,y=center.y+motion.landing.y+pull.y+body.height/2-4;ctx.strokeStyle=colors.path;ctx.lineWidth=2;ctx.setLineDash([4,4]);ctx.beginPath();ctx.ellipse(x,y,34,8,0,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);}
 ctx.globalAlpha=1;ctx.shadowBlur=0;
 // strength: share of the fastest throw this setting allows (velocity is capped at 600 px of pull)
 const pct=Math.min(100,Math.round(Math.hypot(pull.x,pull.y)/6)),text=colors.strengthLabel+' '+pct+'%';
 ctx.font='600 12px "Segoe UI","Microsoft YaHei",sans-serif';const w=ctx.measureText(text).width+64,x=hand.x+18,y=hand.y+22;
 ctx.fillStyle=colors.surface;ctx.globalAlpha=.92;ctx.beginPath();ctx.roundRect(x,y,w,24,12);ctx.fill();ctx.globalAlpha=1;
 ctx.fillStyle=colors.text;ctx.textBaseline='middle';ctx.fillText(colors.strengthLabel,x+10,y+12);
 const label=ctx.measureText(colors.strengthLabel).width,bar={x:x+16+label,y:y+9,w:34,h:6};
 ctx.fillStyle=colors.track;ctx.beginPath();ctx.roundRect(bar.x,bar.y,bar.w,bar.h,3);ctx.fill();
 ctx.fillStyle=colors.path;ctx.beginPath();ctx.roundRect(bar.x,bar.y,Math.max(3,bar.w*pct/100),bar.h,3);ctx.fill();
 ctx.fillStyle=colors.text;ctx.fillText(pct+'%',bar.x+bar.w+6,y+12);
});
