import {dialogueVisibleText, parseGroupReply} from '../output-events.mjs';

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
    ? '{"type":"control","emotion":"normal","interactionTarget":"user","affectionTarget":"user","affection":0,"topicEnded":false}'
    : '{"type":"control","emotion":"normal"}';
  return '\n请改用逐行 JSON 输出。每行必须是完整对象。' + decision
    + '\n按自然语义分段，每段一行，例如 {"type":"segment","text":"台词","performance":{"emotion":"neutral","strength":"mild","delivery":"语气方向"}}。'
    + '\n表演只反映你对本段的实际表达。emotion 限 ' + [...emotions].join('/') + '。strength 限 mild/moderate/strong。'
    + '\n相关两三句可放同一段，语段合起来要自然通顺，正文保留必要的空格和换行，优先保持声线稳定。输出正文总长度沿用原要求。末行只写控制对象 ' + control
    + '，emotion 沿用原动画标签。正文和控制对象不使用 Markdown 围栏，不要在 text 中放入协议字段。';
}

export function createVoiceSegmentDecoder({group=false, allowSilence=false, onSegment=()=>{}}={}) {
  let raw='', pending='', mode=null, decision, control, sealed=false, result=null,damaged=false;
  const parts=[];
  const deliveries=[];
  const drain=async()=>{const pending=deliveries.splice(0);await Promise.all(pending);};
  const emit = row => {
    const text=dialogueVisibleText(row.text);
    if (!text.trim()) return;
    parts.push(text);
    const delivery=onSegment({text, performance:performance(row)});
    if(delivery&&typeof delivery.then==='function')deliveries.push(delivery);
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
        if (old.speak!==false) emit({text:old.text});
        result={...controlFields(old), text:parts.join(''), speak:old.speak!==false};
      } else {
        const source=raw.trim();
        if (!source || /^(?:[{\[]|```(?:jsonl?|ndjson)\b)/i.test(source)) throw failed();
        const emotion=source.match(/\[\[emotion:([a-z-]+)\]\]\s*$/i)?.[1];
        emit({text:source});
        result={text:parts.join(''), ...(emotion ? {emotion} : {})};
      }
      return result;
    }
  };
}
