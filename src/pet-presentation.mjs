// Fixed, source-pixel calibration from each approved idle pose. All actions of a
// character use the same transform; moving hair, weapons and poses never resize it.
// Bounds and reference hashes are recorded in local/pet-fixes-179/idle-geometry.json.
const CALIBRATION={
 deepseek:{height:541,feet:602},claude:{height:491,feet:602},
 grok:{height:419,feet:599},seed:{height:448,feet:588},
 kimi:{height:454,feet:589},qwen:{height:472,feet:602},
 minimax:{height:459,feet:589},chatgpt:{height:445,feet:602},
 gemini:{height:458,feet:585},glm:{height:477,feet:595},
 hunyuan:{height:451,feet:591}
};
export function petPresentation(character){
 const reference=CALIBRATION[character]??CALIBRATION.deepseek;
 const factor=541/reference.height,scale=.86*factor;
 // Preserve the original DeepSeek canvas transform and its screen foot position.
 const x=96*(1-.86)+276/3*.86-276/3*scale;
 const y=104*(1-.86)+602/3*.86-reference.feet/3*scale;
 return {factor,scale,x,y,sourceHeight:reference.height,sourceFeet:reference.feet,
  transform:`translate(${x}px, ${y}px) scale(${scale})`};
}
// A clip may need a fixed canvas translation to retain every translucent hair
// tip. Register that clip's declared ground anchor to the approved idle anchor;
// this never fits a changing per-frame bounding box or changes body scale.
export function petActionPresentation(character,clip){
 const base=petPresentation(character),anchor=clip?.anchor;
 if(!['sleep-enter','sleep-loop','wake','throw-start','throw-loop','land-recover'].includes(clip?.actionId))return base;
 if(!anchor||!Number.isFinite(anchor.x)||!Number.isFinite(anchor.y)||!clip?.canvas?.width||!clip?.canvas?.height)return base;
 const factor=Number.isFinite(clip.presentationScale)&&clip.presentationScale>0?clip.presentationScale:1,scale=base.scale*factor;
 const x=base.x+276/3*base.scale-anchor.x/clip.canvas.width*192*scale;
 const y=base.y+base.sourceFeet/3*base.scale-anchor.y/clip.canvas.height*208*scale;
 return {...base,scale,x,y,transform:`translate(${x}px, ${y}px) scale(${scale})`};
}
// The window includes transparent room for bubbles/badges. Physics contacts
// the fixed character canvas and registered feet, not that invisible padding.
export function petCollisionInsets(character,petScale=1.25,sequences={}){
 const base=petPresentation(character),poses=[base,...Object.values(sequences).map(clip=>petActionPresentation(character,clip))],width=Math.ceil(270*petScale),height=Math.ceil(280*petScale);
 return {left:Math.max(0,Math.min(...poses.map(p=>39+p.x))*petScale),top:Math.max(0,Math.min(...poses.map(p=>46+p.y))*petScale),
  right:Math.max(0,width-Math.max(...poses.map(p=>39+p.x+192*p.scale))*petScale),
  bottom:Math.max(0,height-(46+base.y+base.sourceFeet/3*base.scale)*petScale)};
}
