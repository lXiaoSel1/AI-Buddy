const eastAsian=/[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\u3000-\u303f\ufe10-\ufe19\ufe30-\ufe4f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/u;

const characterWeight=char=>char.codePointAt(0)<128?30:eastAsian.test(char)?65:100;

function textWeight(text){
 let weight=0;
 for(const char of text)weight+=characterWeight(char);
 return weight;
}

export function boundedPrivateText(text,tokenLimit,byteLimit){
 let length=0,weight=0,bytes=0;
 for(const char of text){
  weight+=characterWeight(char);
  if(weight>tokenLimit*100)break;
  bytes+=Buffer.byteLength(JSON.stringify(char))-2;
  if(bytes>byteLimit)break;
  length+=char.length;
 }
 return text.slice(0,length);
}

export function estimatePrivateMessageTokens(message){
 const weight=typeof message.content==='string'?textWeight(message.content):
  message.content.reduce((total,part)=>total+(part.type==='text'?textWeight(part.text):0),0);
 return 4+Math.ceil(weight/100);
}

const calibrationQueues=new WeakMap();
const clampRatio=value=>Math.min(2,Math.max(.5,value));

export async function privateTokenRatio(calibration,connectionKey){
 if(!calibration||!connectionKey)return 1;
 const ratio=await calibration.read(connectionKey);
 return Number.isFinite(ratio)&&ratio>0?clampRatio(ratio):1;
}

export function updatePrivateTokenRatio(calibration,connectionKey,sample){
 if(!calibration||!connectionKey)return;
 let queue=calibrationQueues.get(calibration);
 if(!queue)calibrationQueues.set(calibration,queue=new Map());
 const pending=queue.get(connectionKey);
 const update=(pending?.catch(()=>{})??Promise.resolve()).then(async()=>{
  const previous=await privateTokenRatio(calibration,connectionKey);
  await calibration.write(connectionKey,clampRatio(.8*previous+.2*sample));
 });
 queue.set(connectionKey,update);
 return update.finally(()=>{
  if(queue.get(connectionKey)===update)queue.delete(connectionKey);
 });
}
