export const EMOTIONS=Object.freeze({
  cheerful:{label:'开心',actionId:'emotion-cheerful',reuse:'wave'},
  shy:{label:'害羞',actionId:'emotion-shy'},
  serious:{label:'认真',actionId:'emotion-serious',reuse:'reviewing'},
  confused:{label:'困惑',actionId:'emotion-confused'},
  angry:{label:'生气',actionId:'emotion-angry'},
  frightened:{label:'受惊',actionId:'emotion-frightened'},
  exasperated:{label:'无奈',actionId:'emotion-exasperated'},
  starry:{label:'星星眼',actionId:'emotion-starry'},
});
export const EMOTION_KEYS=Object.freeze(Object.keys(EMOTIONS));
export const EMOTION_PROMPT=`你是情绪分类器。只判断用户当前这句话的语气和含义，不推导角色听到后的自主情绪。只输出一个英文标签，不输出解释或 JSON。
cheerful：明确快乐、喜欢、赞美、庆祝。普通赞美如“你好棒”“你真可爱”属于此类。
shy：明确表达羞涩、窘迫、不好意思，如“脸红了”。不能仅因夸奖就选择害羞。
serious：专注分析、学习或安排工作，如“认真讨论方案”。
confused：明确不理解、疑惑，如“没听懂”。普通信息问句如“今天几点？”不因问号而属于此类。
angry：明确不满、愤怒或责备，如“太过分了”“气死我了”。frightened：明确害怕或受到惊吓，如“别吓我”“好恐怖”。
exasperated：明确疲惫、无语或无可奈何，如“唉，算了”“累死了”。starry：明确憧憬、浪漫或强烈欣赏，如“好美”“好浪漫”。
normal：中性、普通信息询问或没有明确情绪。
理解否定和引用：“我不生气”“我不困惑”“没觉得开心”不能仅因含情绪词选择相应标签；引用他人的情绪不代表用户自己的情绪。“我不生气，想认真讨论方案”应选 serious。“星星是什么？”“这个词是什么意思？”等普通求知问句应选 normal；“刚才解释我没听懂”应选 confused。含糊时选 normal。
输出只能是 cheerful、shy、serious、confused、angry、frightened、exasperated、starry、normal。`;
export function validEmotion(value){return value==='normal'||Object.hasOwn(EMOTIONS,value);}
export function parseEmotion(value){const label=typeof value==='string'?value.trim().toLowerCase():'';return validEmotion(label)?label:null;}
export function keywordEmotion(text){
  let value=String(text??'').replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/g,'');
  value=value.replace(/(?:一点也不|完全不|并不|并没|没有|不是|不|没)(?:\s|觉得|感到|那么|特别|很|太|一点|丝毫)*(?:生气|讨厌|害怕|恐怖|开心|高兴|害羞|心动|喜欢|无奈|困惑|累|疲惫|憧憬|烦|过分)/g,'');
  const rules=[['angry',/生气|讨厌|哼|烦|滚|过分|笨蛋|气死|可恶/],['frightened',/害怕|吓|恐怖|啊啊|别吓我/],['exasperated',/无奈|累死|唉|算了|服了|无语|头疼/],['starry',/好美|浪漫|憧憬|心动|闪闪|漂亮|星星眼/],['shy',/害羞|脸红|不好意思/],['confused',/没听懂|没看懂|不懂|困惑|不明白|什么意思/],['serious',/认真|工作|学习|讨论|严肃|分析/],['cheerful',/开心|高兴|哈哈|太好了|好棒|喜欢|可爱|耶|抱抱|亲亲|≧▽≦/]];
  return rules.find(([,pattern])=>pattern.test(value))?.[0]??'normal';
}
export function resolveEmotion(text,output){
  const emotion=parseEmotion(output);
  if(emotion!==null)return {emotion,emotionSource:'model'};
  const fallback=keywordEmotion(text);
  return {emotion:fallback,emotionSource:fallback==='normal'?'default':'keyword'};
}
export function messageEmotion(line){
  if(!line)return 'normal';
  if(validEmotion(line.emotion)&&(line.emotion!=='normal'||line.emotionSource))return line.emotion;
  return keywordEmotion(line.text);
}
export function shortReply(text,maximum=40){
  const value=String(text??'').replace(/[`*_#]/g,'').replace(/\s+/g,' ').trim();
  const sentence=value.match(/^.*?[。！？!?]|^.*?\.(?:\s|$)/)?.[0]?.trim()??value;
  const chars=Array.from(sentence);return chars.length>maximum?chars.slice(0,maximum-1).join('')+'…':sentence;
}
