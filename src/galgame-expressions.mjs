const definitions = [
  ['normal','平常','平静、neutral、默认'],
  ['cheerful','开心','高兴、happy、joy'],
  ['shy','害羞','脸红、embarrassed'],
  ['serious','认真','严肃'],
  ['confused','困惑','疑惑、？'],
  ['angry','生气','愤怒、哼'],
  ['frightened','害怕','惊恐、scared、afraid、受惊'],
  ['exasperated','无语','无奈、叹气、sigh'],
  ['starry','星星眼','期待、兴奋、excited'],
  ['gentle','温柔','安慰、关心、安心、柔和、caring、relieved'],
  ['flustered','慌张','手足无措、心虚、被戳穿、慌了'],
  ['smug','得意','骄傲、炫耀、嘿嘿、赢了'],
  ['laugh','大笑','哈哈、笑出声、乐坏了'],
  ['sleepy','困了','打哈欠、犯困、累了'],
  ['sad','难过','失落、委屈、低落、寂寞、worried'],
  ['cry','哭','流泪、哭泣、呜呜'],
  ['asleep','睡着','睡觉、zzz、sleep'],
  ['thinking','思考','想想、琢磨、考虑一下'],
  ['playful','调皮','坏笑、捉弄、wink、吐舌、恶作剧'],
  ['eating','吃东西','吃饭、干饭、好吃'],
  ['surprised','惊讶','吃惊、意外、诶'],
  ['coax','撒娇','拜托、央求、黏人、装可怜'],
];
const aliasKey = label => label.normalize('NFKC').trim().toLowerCase();
const aliases = new Map(definitions.flatMap(([id,name,other]) =>
  [id,name,...other.split('、')].map(label => [aliasKey(label),id])));
export const GALGAME_EMOTIONS = Object.freeze(definitions.map(([id]) => id));
export const GALGAME_EMOTION_LABELS = Object.freeze(Object.fromEntries(definitions.map(([id,name]) => [id,name])));

export const PET_EMOTION_FALLBACK = Object.freeze({
  gentle:'cheerful', flustered:'shy', smug:'starry', laugh:'cheerful', sleepy:'exasperated',
  sad:'exasperated', cry:'frightened', asleep:'normal', thinking:'confused', playful:'cheerful',
  eating:'cheerful', surprised:'frightened', coax:'shy',
});

export function normalizeGalgameEmotion(label, fallback = 'normal') {
  return (typeof label === 'string' ? aliases.get(aliasKey(label)) : undefined) ?? fallback;
}

export function galgameEmotionInstruction() {
  return '\n每句台词前加 [[emotion:名字]]，例如 [[emotion:温柔]]我听着呢。[[emotion:thinking]]让我想想。名字用下列中文或英文 ID：'
    + definitions.map(([id,name]) => name+'='+id).join('、') + '。标签是表情指令，不是台词。';
}

const markerPrefix = '[[emotion:';
const marker = /\[\[emotion:[ \t]*([^\[\]\r\n]*?)[ \t]*\]\]/giu;

export function pendingGalgameEmotionMarker(tail) {
  const lower = tail.toLowerCase();
  return lower.length > 0 && (markerPrefix.startsWith(lower) || /^\[\[emotion:[^\[\]\r\n]*\]?$/iu.test(lower));
}

function stripPendingGalgameEmotion(text, streaming) {
  const start = text.lastIndexOf('[[');
  if (start < 0) return text;
  const tail = text.slice(start);
  return (streaming || tail.toLowerCase().startsWith(markerPrefix)) && pendingGalgameEmotionMarker(tail) ? text.slice(0,start) : text;
}

function sentencesIn(text, offset, emotion) {
  const rows = [];
  const add = (from,to) => {
    const slice = text.slice(from,to);
    const leading = slice.length - slice.trimStart().length;
    const value = slice.trim();
    if (value) rows.push({text:value,emotion,start:offset+from+leading,end:offset+from+leading+value.length});
  };
  // Chinese closers, ellipses, and paragraph breaks are independent of the
  // host locale. An ASCII period inside a decimal or abbreviation stays put.
  const end = /(?:[。！？!?]+|…+|\.{2,}|\.(?=\s|$))[”’」』）】"'\]]*|\r?\n+/gu;
  let from = 0;
  for (const match of text.matchAll(end)) {
    const to = match.index + match[0].length;
    add(from,to);
    from = to;
  }
  add(from,text.length);
  return rows;
}

export function parseGalgameReply(raw, defaultEmotion, {streaming=false, preserveWhitespace=false} = {}) {
  const source = String(raw ?? '');
  const body = stripPendingGalgameEmotion(source,streaming);
  const matches = [...body.matchAll(marker)];
  const last = matches.at(-1);
  const suffix = !streaming && last && body.slice(0,last.index).replace(marker,'').trim()
    && !body.slice(last.index+last[0].length).trim() ? matches.pop() : null;
  const legacyEmotion = suffix ? normalizeGalgameEmotion(suffix[1],null) : null;
  const defaultValue = suffix ? legacyEmotion ?? 'normal' : normalizeGalgameEmotion(defaultEmotion,null);
  let emotion = defaultValue ?? 'normal';
  let whole = defaultValue;
  let start = 0;
  let text = '';
  let firstTaggedSentence, lastTaggedEmotion;
  const sentences = [];
  function append(end) {
    const span = body.slice(start,end);
    const rows = sentencesIn(span,text.length,emotion);
    if (rows.length && start>0) {
      firstTaggedSentence ??= sentences.length;
      lastTaggedEmotion = emotion;
    }
    if (rows.length) whole ??= emotion;
    sentences.push(...rows);
    text += span;
  }
  for (const tag of matches) {
    append(tag.index);
    emotion = normalizeGalgameEmotion(tag[1]);
    start = tag.index+tag[0].length;
  }
  append(suffix?.index ?? body.length);
  const leading = preserveWhitespace ? 0 : text.length-text.trimStart().length;
  if (!preserveWhitespace) text = text.trim();
  return {
    text,
    emotion:whole ?? 'normal',
    sentences:leading ? sentences.map(row => ({...row,start:row.start-leading,end:row.end-leading})) : sentences,
    ...(firstTaggedSentence===undefined ? {} : {firstTaggedSentence,lastTaggedEmotion}),
    ...(legacyEmotion ? {legacyEmotion} : {}),
  };
}

export function encodeGalgameSentenceRanges(text,rows){
  if(typeof text!=='string'||!Array.isArray(rows)||!rows.length)return null;
  let end=0;
  const encoded=[];
  for(const row of rows){
    if(!row||Object.keys(row).length!==4||normalizeGalgameEmotion(row.emotion,null)!==row.emotion
      ||!Number.isSafeInteger(row.start)||!Number.isSafeInteger(row.end)||row.start<end||row.end<=row.start
      ||row.end>text.length||text.slice(row.start,row.end)!==row.text)return null;
    encoded.push(row.emotion+':'+row.start+'-'+row.end);
    end=row.end;
  }
  return encoded.join('|');
}

export function decodeGalgameSentenceRanges(text,encoded){
  if(typeof text!=='string'||typeof encoded!=='string'||!encoded)return null;
  let end=0;
  const rows=[];
  for(const item of encoded.split('|')){
    const match=/^([a-z]+):(\d+)-(\d+)$/.exec(item);
    if(!match)return null;
    const [,emotion,from,to]=match,start=Number(from),next=Number(to);
    if(normalizeGalgameEmotion(emotion,null)!==emotion||!Number.isSafeInteger(start)||!Number.isSafeInteger(next)
      ||start<end||next<=start||next>text.length)return null;
    rows.push({emotion,start,end:next,text:text.slice(start,next)});
    end=next;
  }
  return rows;
}

export function galgameReplySentences(message, expressionMode = 'sentence') {
  const text = String(message?.text ?? '');
  const offset = message?.emotionSentenceOffset;
  const ranges = typeof message?.emotionSentences==='string'?decodeGalgameSentenceRanges(text,message.emotionSentences):message?.emotionSentences;
  const stored = Number.isSafeInteger(offset) && offset>0 && Array.isArray(ranges)
    ? ranges.flatMap(row => {
      if (!row || row.end<=offset) return [];
      const start = Math.max(0,row.start-offset);
      return [{...row,start,end:row.end-offset,text:typeof row.text==='string'?row.text.slice(Math.max(0,offset-row.start)):row.text}];
    })
    : ranges;
  let cursor = 0;
  const valid = Array.isArray(stored) && stored.length > 0 && stored.every(row => {
    if (!Number.isSafeInteger(row?.start) || !Number.isSafeInteger(row?.end) || row.start < cursor
      || row.end <= row.start || row.end > text.length || text.slice(cursor,row.start).trim()
      || text.slice(row.start,row.end) !== row.text || !normalizeGalgameEmotion(row.emotion,null)) return false;
    cursor = row.end;
    return true;
  }) && !text.slice(cursor).trim();
  const rows = valid ? stored : parseGalgameReply(text,message?.emotion,{preserveWhitespace:true}).sentences;
  return rows.map(row => ({
    ...row, emotion:normalizeGalgameEmotion(expressionMode === 'reply' ? message?.emotion ?? rows[0]?.emotion : row.emotion),
  }));
}

export function galgamePresentationSettings(settings, characterId) {
  const map = settings?.galgamePresentation;
  const row = (characterId === undefined ? settings : map && Object.hasOwn(map,characterId) ? map[characterId] : undefined) ?? {};
  return {
    dialogueStyle:row.dialogueStyle === 'classic' ? 'classic' : 'frameless',
    fontScale:[.85,1,1.15].includes(row.fontScale) ? row.fontScale : 1,
    expressionMode:row.expressionMode === 'reply' ? 'reply' : 'sentence',
    expressionMotion:row.expressionMotion !== false,
  };
}

export function patchGalgamePresentationSettings(settings, characterId, args) {
  const old = galgamePresentationSettings(settings,characterId);
  const next = {...old};
  if (['classic','frameless'].includes(args.dialogueStyle)) next.dialogueStyle = args.dialogueStyle;
  if ([.85,1,1.15].includes(args.fontScale)) next.fontScale = args.fontScale;
  if (['reply','sentence'].includes(args.expressionMode)) next.expressionMode = args.expressionMode;
  if (typeof args.expressionMotion === 'boolean') next.expressionMotion = args.expressionMotion;
  if (Object.keys(next).some(key => next[key] !== old[key])) {
    settings.galgamePresentation = {...settings.galgamePresentation,[characterId]:next};
  }
}
