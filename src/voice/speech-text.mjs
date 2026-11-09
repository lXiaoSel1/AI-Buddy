import {cleanDialogueReferences,speechLinkLabels} from '../reply-references.mjs';
// Port of the accepted r18 lab speech_text.py. This copy never replaces history.
const pictures=/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0F\u200D]|[#*0-9]\uFE0F?\u20E3/gu;
const asciiFace=/(?<![\p{L}\p{N}_])(?:\^[_‿.-]\^|[Tt][_.-][Tt]|[Oo][_.-][Oo]|[Oo]w[Oo]|[Uu]w[Uu]|[:;=][-^]?[)D(Pp]|>_<)(?![\p{L}\p{N}_])/gu;
const fullAsciiFace=/^(?:\^[_‿.-]\^|[Tt][_.-][Tt]|[Oo][_.-][Oo]|[Oo]w[Oo]|[Uu]w[Uu]|[:;=][-^]?[)D(Pp]|>_<)$/u;
const face=/^[ﾉノつっ๑\s]*[•◕◉●○◎⊙ಠಥ¬￢＾^￣≧≦＞＜°][\u0300-\u036f]*[ㅂω▽ᴗ_‿﹏Дд□∀ε︿∇ヘ-]{1,3}[•◕◉●○◎⊙ಠಥ¬￢＾^￣≧≦＞＜°][\u0300-\u036f]*[っつ๑\s]*$/u;
export function voiceSpeechText(value){
  const text=speechLinkLabels(cleanDialogueReferences(String(value??'')));
  let cleaned=text.replace(/```[\s\S]*?(?:```|$)/gu,' ').replace(/\[\[(?:emotion|voice|control):[^\]]*\]\]/gi,'');
  cleaned=cleaned.replace(/[(（]([^()（）\n]{1,32})[)）](?:[ﾉノوづっつ✧☆★]+)?/gu,(whole,body)=>{
    if(fullAsciiFace.test(body)||!body.replace(pictures,'').trim())return ' ';
    if(/[A-Za-z0-9\u3400-\u9fff]/u.test(body))return whole;
    return face.test(body)?' ':whole;
  }).replace(/[◉◕●○◎⊙ಠಥ][‿ωᴗ▽﹏_益][◉◕●○◎⊙ಠಥ]/gu,' ').replace(asciiFace,' ').replace(pictures,' ');
  if(cleaned!==text)cleaned=cleaned.replace(/\s+/gu,' ').replace(/\s+([，。！？；：、,.!?;:])/gu,'$1').replace(/([，。！？；：、])\s+/gu,'$1');
  cleaned=cleaned.trim();return cleaned===text||/[\p{L}\p{N}]/u.test(cleaned)?cleaned:'';
}

// Keep the accepted controller boundary: at most 240 Unicode characters,
// preferring the nearest sentence mark after character 80.
export function voiceSpeechChunks(value){
  const result=[],letters=[...String(value??'')];
  while(letters.length){
    let size=Math.min(240,letters.length);
    if(size<letters.length){for(let i=size-1;i>=80;i--){if(/[。！？；，.!?;\n]/.test(letters[i])){size=i+1;break;}}}
    const part=letters.splice(0,size).join('').trim();if(part)result.push(part);
  }
  return result;
}
