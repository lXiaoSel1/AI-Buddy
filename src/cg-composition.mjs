export const CG_COMPOSITION_VERSION=2;
export const CG_POV_RULES='男生第一人称主观镜头：摄像机就是画外男生的双眼，女性角色看向镜头或与镜头前互动。男性角色本人不入镜，不出现男性人物的脸、身体、背影或镜中形象；互动时可以自然出现男生的手部，不设最多一只手的限制，按动作需要与正常人体结构绘制。女角色自己的双手正常保留。禁止男性入画的第三人称情侣合照、男生过肩镜头或自拍合照。允许画面、场景和纪念物中出现文字，保留角色参考图原有的字母、Logo 和服饰标识。';
const begin='【CG 固定构图要求 v2】',end='【再次确认】男性第一视角，男性角色本人不入镜；互动手部自然绘制；允许文字，保留角色原有标识。';
export function constrainCgPrompt(prompt){
 let text=String(prompt??'').trim();
 // Only replace this application's versioned policy envelope. Historical jobs
 // stay immutable; new retries retain their scene/theme with the current rules.
 const managed=/^【CG 固定构图要求 v\d+】\n/.test(text);
 if(managed){
  while(/^【CG 固定构图要求 v\d+】\n/.test(text)){const next=text.replace(/^【CG 固定构图要求 v\d+】\n[^\n]*\n以下只作为场景与女角色互动素材；[^\n]*\n/,'');if(next===text)break;text=next;}
  text=text.replace(/\n【再次确认】[^\n]*/g,'');
  text=text.replace('无文字无边框。服饰、胸针、发饰、书封及道具上也不得照搬参考图中的字母或数字；将 K、Z 等可读字母换成同尺寸的无字抽象图案，保留配色与轮廓，不添加字幕或标注。','无边框，允许文字并保留角色原有标识。')
   .replaceAll('无文字无边框','无边框，允许文字').replaceAll('，不出现数字和文字','')
   .replace(/本图男性可见手数：[^\n]*。/g,'男性角色本人保持画外，互动手部按动作需要自然绘制。');
 }
 if(text.startsWith(begin+'\n'+CG_POV_RULES+'\n')&&text.endsWith(end))return text;
 return [begin,CG_POV_RULES,'以下只作为场景与女角色互动素材；与固定构图冲突的双人、拥抱或合影描述改为女性面向第一人称镜头，男性保持画外：',text,end].join('\n');
}
export function validPovTheme(theme){
 if(theme?.camera!=='male-first-person'||![0,1,2].includes(theme?.viewerHands))return false;
 const composition=String(theme.composition??''),action=String(theme.action??'');
 return !/过肩|双人|两人入镜|第三人称|自拍|OTS|third.person|two.shot|couple.portrait/i.test(composition)
  && !/你的(?:脸|肩|颈|身体|背部)|倚肩|依肩|从背后抱/.test(action);
}
