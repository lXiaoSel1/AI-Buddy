export function affectionText(value){const n=Number(value);return Number.isFinite(n)?String(Math.max(0,Math.floor(n))):'0';}
export function dialogueLineRoom(stageHeight,restHeight,lineHeight){const line=Number.isFinite(lineHeight)&&lineHeight>0?lineHeight:31;return Math.max(2,Math.floor(Math.max(0,stageHeight*.4-restHeight)/line))*line;}
