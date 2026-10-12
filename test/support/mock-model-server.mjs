import {createServer} from 'node:http';
export async function mockModelServer(){
 const requests=[];let failure=null,delay=0;
 const server=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  const body=raw?JSON.parse(raw):null,path=req.url,protocol=path.includes('/chat/completions')?'chat-completions':path.includes('/responses')?'responses':path.includes(':streamGenerateContent')?'gemini':'anthropic';
  requests.push({method:req.method,path,body,headers:req.headers,protocol});
  if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify(path.includes('/gemini/')?{models:[{name:'models/fixture',supportedGenerationMethods:['generateContent']}]}:{data:[{id:'fixture'}]}));return;}
  const system=body?.instructions??body?.system??body?.systemInstruction?.parts?.[0]?.text??body?.messages?.find(m=>m.role==='system')?.content??'';
  const purpose=/情绪分类器/.test(system)?'emotion':/选项生成器/.test(system)?'choices':/三幕|acts/.test(system)?'story':'chat';
  const selectedFailure=typeof failure==='function'?failure({purpose,body,path}):failure;
  if(selectedFailure?.status){res.writeHead(selectedFailure.status,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'PRIVATE_KEY_SHOULD_NEVER_BE_EXPOSED'}}));return;}
  if(delay)await new Promise(r=>setTimeout(r,delay));if(res.destroyed)return;
  let text=purpose==='emotion'?'cheerful':purpose==='choices'?JSON.stringify({positive:'再聊一会吧',neutral:'说说今天吧',negative:'我先忙一下'}):'你好呀，今天也一起加油。';
  if(purpose==='story'){
   const ids=[...system.matchAll(/^- ([a-z]+)（/gm)].map(v=>v[1]);
   const cast=[...new Set(ids)].slice(0,3);while(cast.length<3)cast.push(['deepseek','kimi','gemini'][cast.length]);
   const beats=[{speaker:'narrator',text:'窗边洒下温暖的阳光。'},...cast.map(speaker=>({speaker,text:'一起休息一下吧。',emotion:'cheerful'}))];
   const choices=[0,1,2].map(i=>({text:['一起喝茶','看看窗外','聊聊天'][i],effects:{[cast[0]]:1,[cast[1]]:-1},reply:[{speaker:cast[0],text:'好的呀。',emotion:'cheerful'}]}));
   text=JSON.stringify({acts:[{beats,choices},{beats,choices},{beats}]});
  }
  if(selectedFailure?.empty)text='';
  let payloads;
  if(protocol==='gemini')payloads=[{candidates:[{content:{parts:[{text:'private reasoning',thought:true},{text}]}}]},...(!selectedFailure?.incomplete?[{candidates:[{finishReason:'STOP'}],usageMetadata:{promptTokenCount:11,candidatesTokenCount:7,thoughtsTokenCount:3,totalTokenCount:21}}]:[])];
  else if(protocol==='anthropic')payloads=[{type:'message_start',message:{usage:{input_tokens:11,cache_read_input_tokens:2}}},{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'private reasoning'}},{type:'content_block_delta',delta:{type:'text_delta',text}},...(!selectedFailure?.incomplete?[{type:'message_delta',usage:{output_tokens:7}},{type:'message_stop'}]:[])];
  else if(protocol==='responses')payloads=[{type:'response.reasoning_text.delta',delta:'private reasoning'},{type:'response.output_text.delta',delta:text},...(!selectedFailure?.incomplete?[{type:'response.completed',response:{usage:{input_tokens:11,output_tokens:7,total_tokens:18}}}]:[])];
  else payloads=[{choices:[{delta:{reasoning_content:'private reasoning',content:text},finish_reason:null}]},...(!selectedFailure?.incomplete?[{choices:[{delta:{},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:11,completion_tokens:7,total_tokens:18}}]:[])];
  res.writeHead(200,{'content-type':'text/event-stream'});
  const bytes=Buffer.from(payloads.map(value=>'data: '+JSON.stringify(value)+'\r\n\r\n').join(''));
  // Split inside multibyte text and SSE records, not only between events.
  for(let i=0;i<bytes.length;i+=7)res.write(bytes.subarray(i,i+7));res.end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {requests,url:'http://127.0.0.1:'+server.address().port,setFailure:value=>failure=value,setDelay:value=>delay=value,close:()=>new Promise(r=>{server.close(r);server.closeAllConnections();})};
}
export const fakeCrypto={isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from('encrypted:'+Buffer.from(text).toString('base64')),decryptString:bytes=>{const value=bytes.toString();if(!value.startsWith('encrypted:'))throw Error('decrypt');return Buffer.from(value.slice(10),'base64').toString();}};
export const stubCodex=()=>({defaultModel:'fixture-codex',enabled:false,calls:0,setEnabled(value){this.enabled=value;},async *stream(){this.calls++;yield {type:'text-delta',text:'local Codex'};yield {type:'finish',reason:{kind:'stop'}};}});
