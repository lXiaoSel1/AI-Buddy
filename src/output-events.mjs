import {randomUUID} from 'node:crypto';

// One queue per request: consumers receive data before the producing turn ends.
export function outputQueue({maxBytes=2*1024*1024}={}) {
  const values=[];let waiter=null,ended=false,error=null,bytes=0;
  return {
    push(value){if(ended)return false;const size=Buffer.byteLength(JSON.stringify(value));if(bytes+size>maxBytes){this.fail(Object.assign(Error('Output consumer fell behind'),{code:'OUTPUT_BACKPRESSURE'}));return false;}values.push({value,size});bytes+=size;waiter?.();waiter=null;return true;},
    close(){ended=true;waiter?.();waiter=null;},
    fail(value){error=value;ended=true;waiter?.();waiter=null;},
    async *[Symbol.asyncIterator](){while(true){if(values.length){const next=values.shift();bytes-=next.size;yield next.value;continue;}if(ended){if(error)throw error;return;}await new Promise(resolve=>{waiter=resolve;});}},
  };
}

export function createOutputEvents({now=()=>performance.now(),onEvent=()=>{},limit=256,maxRequests=128}={}) {
  const requests=new Map();
  function start(scope){const requestId=scope.requestId??randomUUID();if(requests.has(requestId))throw Error('Duplicate output request');const row={...structuredClone(scope),requestId,sequence:0,phase:'queued',text:'',timings:{queued:now()},events:[]};requests.set(requestId,row);if(requests.size>maxRequests)for(const [id,old]of requests){if(requests.size<=maxRequests)break;if(id!==requestId&&['committed','failed'].includes(old.phase))requests.delete(id);}return requestId;}
  function emit(requestId,type,payload={}){const row=requests.get(requestId);if(!row)return null;const event={...row,events:undefined,timings:undefined,text:undefined,phase:undefined,sequence:++row.sequence,type,payload:structuredClone(payload),at:now()};if(type==='text.delta')row.text+=payload.text??'';if(type==='message.snapshot')row.text=payload.text??'';if(type==='request.phase')row.phase=payload.phase;if(type==='timing'&&!Object.hasOwn(row.timings,payload.name))row.timings[payload.name]=event.at;row.events.push(event);if(row.events.length>limit)row.events.splice(0,row.events.length-limit);try{onEvent(event);}catch{}return event;}
  return {start,emit,bind(id,metadata){const row=requests.get(id);if(row)for(const key of ['turnId','itemId'])if(typeof metadata?.[key]==='string')row[key]=metadata[key];},snapshot:id=>requests.has(id)?structuredClone(requests.get(id)):null,remove:id=>requests.delete(id),clear:()=>requests.clear()};
}

const groupFormatError=()=>Object.assign(Error('模型回复格式不完整，请重试'),{code:'GROUP_REPLY_FORMAT'});
function groupReplyKind(raw,partial=false){
 const body=String(raw??'').trimStart();if(!body)return partial?'pending':'json';
 if(body[0]==='`'||body[0]==='"')return 'json';
 if(body[0]==='{')return /^\{[^{}:"'\r\n]{1,40}\}/.test(body)?'plain':'json';
 if(body[0]==='['){const rest=body.slice(1).trimStart();return !rest?(partial?'pending':'json'):/^[\[\]{}"\d-]|^(?:true|false|null)(?:\s|,|\]|$)/.test(rest)?'json':'plain';}
 return /^(?:null|true|false)\s*$/.test(body)?'json':'plain';
}
// Compatibility is restricted to completed ordinary dialogue. A JSON-looking
// response must validate as a whole; damaged JSON never falls back to its text.
export function parseGroupReply(raw,{allowSilence=false,complete=true}={}){
 const original=String(raw??'');if(!complete||!original.trim()||original.length>1024*1024)throw groupFormatError();
 if(groupReplyKind(original)==='plain')return {text:original,emotion:'normal',emotionSource:'compatibility',affection:0,format:'plain'};
 const body=original.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');let value;
 try{value=JSON.parse(body);}catch{throw groupFormatError();}
 if(!value||typeof value!=='object'||Array.isArray(value))throw groupFormatError();
 if(allowSilence&&value.speak===false)return {...value,text:'',affection:0,format:'json'};
 if(value.speak===false||typeof value.text!=='string'||!value.text.trim())throw groupFormatError();
 return {...value,format:'json'};
}
// Decode only a top-level JSON text string, or an ordinary plain response.
// The undecided prefix is withheld until its framing can be distinguished.
export function groupTextDecoder(){
  let raw='',cursor=0,depth=0,inString=false,escape=false,unicode='',key='',readingKey=false,field='',awaitingValue=false,capturing=false,text='',done=false,pendingHigh='';
  const append=char=>{if(pendingHigh){if(/[\uDC00-\uDFFF]/.test(char)){text+=pendingHigh+char;pendingHigh='';return;}text+=pendingHigh;pendingHigh='';}if(/[\uD800-\uDBFF]/.test(char))pendingHigh=char;else text+=char;};
  function feed(chunk){raw+=chunk;if(raw.length>1024*1024)throw Error('Group response too large');const kind=groupReplyKind(raw,true);if(kind==='pending')return text;if(kind==='plain'){text=raw;return text;}for(;cursor<raw.length;cursor++){const c=raw[cursor];if(inString){if(unicode){unicode+=c;if(unicode.length===5){if(!/^u[0-9a-f]{4}$/i.test(unicode))throw Error('Invalid JSON Unicode escape');const ch=String.fromCharCode(parseInt(unicode.slice(1),16));if(capturing)append(ch);if(readingKey)key+=ch;unicode='';}continue;}if(escape){escape=false;if(c==='u'){unicode='u';continue;}const ch=({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f','"':'"','\\':'\\','/':'/'})[c];if(ch===undefined)throw Error('Invalid JSON escape');if(capturing)append(ch);if(readingKey)key+=ch;continue;}if(c==='\\'){escape=true;continue;}if(c==='"'){inString=false;if(readingKey){field=key;readingKey=false;}if(capturing){done=true;capturing=false;}continue;}if(c<' ')throw Error('Invalid JSON string');if(capturing)append(c);if(readingKey)key+=c;continue;}if(c==='{'){depth++;continue;}if(c==='}'){depth--;continue;}if(c===':'){awaitingValue=depth===1;continue;}if(c===','){field='';awaitingValue=false;continue;}if(c==='"'){inString=true;readingKey=depth===1&&!awaitingValue;key='';capturing=depth===1&&awaitingValue&&field==='text'&&!done;awaitingValue=false;}}
    return text;
  }
  return {feed,get text(){return text;},finish:options=>parseGroupReply(raw,options)};
}

export function dialogueVisibleText(raw){
  const index=raw.lastIndexOf('[[');if(index<0)return raw;
  const tail=raw.slice(index);if('[[emotion:'.startsWith(tail)||/^\[\[emotion:[a-z-]*(?:\]?)$/i.test(tail)||/^\[\[emotion:[a-z-]+\]\]\s*$/i.test(tail))return raw.slice(0,index).trimEnd();return raw;
}
