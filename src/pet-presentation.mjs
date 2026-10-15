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
