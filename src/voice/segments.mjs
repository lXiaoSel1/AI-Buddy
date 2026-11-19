import {parseGroupReply} from '../output-events.mjs';
import {galgameEmotionInstruction, normalizeGalgameEmotion, parseGalgameReply} from '../galgame-expressions.mjs';

const emotions = new Set(['neutral','happy','sad','angry','caring','worried','shy','relieved','surprised','serious','confused']);
const strengths = new Set(['mild','moderate','strong']);
const defaultDelivery = '自然聊天，情绪克制，声线稳定。';
const maxReply = 1024 * 1024;
const failed = () => Object.assign(Error('语音回复格式不完整，请重试'), {code:'VOICE_REPLY_FORMAT'});

function performance(row) {
  const raw = row.performance;
  const legacy = !Object.hasOwn(row,'performance') && typeof row.delivery === 'string' && row.delivery.trim();
  if (!raw || typeof raw !== 'object' || !emotions.has(raw.emotion) || (Object.hasOwn(raw,'strength') && !strengths.has(raw.strength)) || (Object.hasOwn(raw,'delivery') && typeof raw.delivery !== 'string')) {
    return {emotion:'neutral', strength:'mild', delivery:legacy ? row.delivery.trim().slice(0,400) : defaultDelivery, source:legacy ? 'legacy' : 'fallback'};
  }
  return {emotion:raw.emotion, strength:raw.strength ?? 'mild', delivery:raw.delivery?.trim().slice(0,400) || defaultDelivery, source:'model'};
}

function controlFields(row) {
  const result = {};
  for (const key of ['emotion','interactionTarget','affectionTarget']) {
    if (typeof row[key] === 'string' && row[key].length <= 120) result[key] = row[key];
  }
  if ([-1,0,1].includes(row.affection)) result.affection = row.affection;
  if (typeof row.topicEnded === 'boolean') result.topicEnded = row.topicEnded;
  return result;
}

export function voiceReplyInstruction({group=false, allowSilence=false}={}) {
  const decision = group ? '\n第一行只写 {"type":"decision","speak":true}。' + (allowSilence ? '选择沉默时 speak 为 false，只输出 decision 和 control，不写台词。' : '') : '';
  const control = group
    ? '{"type":"control","interactionTarget":"user","affectionTarget":"user","affection":0,"topicEnded":false}'
    : '{"type":"control"}';
  return '\n请改用逐行 JSON 输出。每行必须是完整对象。' + decision
    + '\n每句台词单独一行，例如 {"type":"segment","text":"[[emotion:温柔]]我听着呢。","performance":{"emotion":"neutral","strength":"mild","delivery":"语气方向"}}。'
    + '\n表演只反映你对本段的实际表达。emotion 限 ' + [...emotions].join('/') + '。strength 限 mild/moderate/strong。'
    + galgameEmotionInstruction() + '\n语段合起来要自然通顺，正文保留必要的空格和换行，优先保持声线稳定。输出正文总长度沿用原要求。末行只写控制对象 ' + control
    + '。正文和控制对象不使用 Markdown 围栏，text 中除句首表情标签外只放台词。';
}

export function createVoiceSegmentDecoder({group=false, allowSilence=false, onSegment=()=>{}}={}) {
  let raw='', pending='', mode=null, decision, control, sealed=false, result=null,damaged=false;
  const parts=[];
  let inheritedEmotion=null, lastTaggedEmotion, legacyEmotion;
  let deliveryTail=null;
  const drain=async()=>{if(deliveryTail){await deliveryTail;deliveryTail=null;}};
  const emit = row => {
    const style = performance(row);
    const hasTags = /\[\[emotion:/iu.test(row.text);
    // A legacy NDJSON control line can carry the whole-turn emotion, but
    // it arrives after playback may have started. Keep untagged audio at the
    // visual default until that control is known; TTS performance is separate.
    const fallback = inheritedEmotion ?? normalizeGalgameEmotion(row.emotion);
    const parsed = parseGalgameReply(row.text,fallback,{preserveWhitespace:true});
    if (!parsed.text.trim()) return parsed;
    lastTaggedEmotion = parsed.lastTaggedEmotion ?? lastTaggedEmotion;
    legacyEmotion = parsed.legacyEmotion ?? legacyEmotion;
    // Legacy unmarked lines keep the original audio boundaries. When a
    // model places multiple tagged sentences in one line, give each its
    // own playback marker without losing spaces between the sentences.
    const rows = hasTags ? parsed.sentences : [{start:0,emotion:fallback}];
    for (const [index,sentence] of rows.entries()) {
      const text = parsed.text.slice(index===0 ? 0 : sentence.start, rows[index+1]?.start);
      parts.push(text);
      const marked = inheritedEmotion!==null || parsed.firstTaggedSentence!==undefined && index>=parsed.firstTaggedSentence;
      const deliver = () => onSegment({text,performance:style,visualEmotion:sentence.emotion,marked});
      const delivery = deliveryTail ? deliveryTail.then(deliver) : deliver();
      if (delivery && typeof delivery.then==='function') deliveryTail=delivery;
    }
    if (parsed.firstTaggedSentence!==undefined) inheritedEmotion = parsed.sentences.at(-1).emotion;
    return parsed;
  };
  function line(source) {
    const value=source.trim();
    if (!value || /^```(?:jsonl?|ndjson)?$/i.test(value)) return;
    let record;
    try { record=JSON.parse(value); } catch {
      if((mode==='voice'||/^\{\s*"type"\s*:\s*"segment"/u.test(value))&&!/^\{\s*"type"\s*:\s*"control"/u.test(value))damaged=true;
      return;
    }
    if (!record || typeof record!=='object' || Array.isArray(record)) return;
    if (record.type === 'decision') {
      if (!group || mode || typeof record.speak!=='boolean' || (!allowSilence && !record.speak)) throw failed();
      mode='voice';
      decision=record.speak;
      return;
    }
    const implicit=!group && !Object.hasOwn(record,'type') && typeof record.text==='string'
      && (Object.hasOwn(record,'performance') || Object.hasOwn(record,'delivery'));
    if (record.type === 'segment' || implicit) {
      if (sealed || (group && decision===false)) return;
      if (group && decision!==true) throw failed();
      mode='voice';
      if (typeof record.text==='string') emit(record);
      return;
    }
    if (record.type==='control' && (!group || mode==='voice') && !sealed) {
      mode='voice';
      control=controlFields(record);
      sealed=true;
    }
  }
  return {
    async feedAsync(delta) {
      if(result)return;
      raw+=delta;pending+=delta;
      if(raw.length>maxReply)throw failed();
      let end;
      while((end=pending.indexOf('\n'))>=0){
        const next=pending.slice(0,end);pending=pending.slice(end+1);
        line(next);await drain();
      }
    },
    async finishAsync(){const value=this.finish();await drain();return value;},
    feed(delta) {
      if (result) return;
      raw+=delta;
      pending+=delta;
      if (raw.length>maxReply) throw failed();
      let end;
      while ((end=pending.indexOf('\n'))>=0) {
        const next=pending.slice(0,end);
        pending=pending.slice(end+1);
        line(next);
      }
    },
    finish() {
      if (result) return result;
      line(pending);
      pending='';
      if(damaged)throw failed();
      if (mode==='voice') {
        if (group && (decision===undefined || !control)) throw failed();
        const text=parts.join('');
        if (decision!==false && !text.trim()) throw failed();
        result=group ? {...control,text,speak:decision} : {...control,text};
      } else if (group) {
        const old=parseGroupReply(raw,{allowSilence});
        if (old.speak!==false) emit({text:old.text,emotion:old.emotion});
        result={...controlFields(old), text:parts.join(''), speak:old.speak!==false};
        if (old.format==='plain') result.compatibility=true;
      } else {
        const source=raw.trim();
        if (!source || /^(?:[{\[]|```(?:jsonl?|ndjson)\b)/i.test(source) && !/^\[\[emotion:/iu.test(source)) throw failed();
        const emotion=emit({text:source})?.legacyEmotion;
        result={text:parts.join(''), ...(emotion ? {emotion} : {})};
      }
      if (lastTaggedEmotion!==undefined) result.lastTaggedEmotion=lastTaggedEmotion;
      if (legacyEmotion!==undefined && result.emotion!==legacyEmotion) result.legacyEmotion=legacyEmotion;
      return result;
    }
  };
}
