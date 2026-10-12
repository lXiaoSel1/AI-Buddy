export const API_PROTOCOLS=Object.freeze(['chat-completions','responses','gemini','anthropic']);
export const MODEL_PRESETS=Object.freeze([
  {kind:'codex',name:'本机 Codex 登录',protocol:'codex',baseUrl:''},
  {kind:'gemini',name:'Gemini',protocol:'gemini',baseUrl:'https://generativelanguage.googleapis.com/v1beta'},
  {kind:'kimi',name:'Kimi / K3',protocol:'chat-completions',baseUrl:'https://api.moonshot.ai/v1'},
  {kind:'grok',name:'Grok',protocol:'chat-completions',baseUrl:'https://api.x.ai/v1'},
  {kind:'openai',name:'OpenAI',protocol:'responses',baseUrl:'https://api.openai.com/v1'},
  {kind:'claude',name:'Claude',protocol:'anthropic',baseUrl:'https://api.anthropic.com/v1'},
  {kind:'deepseek',name:'DeepSeek',protocol:'chat-completions',baseUrl:'https://api.deepseek.com/v1'},
  {kind:'qwen',name:'通义千问',protocol:'chat-completions',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1'},
  {kind:'minimax',name:'MiniMax',protocol:'chat-completions',baseUrl:'https://api.minimax.io/v1'},
  {kind:'custom',name:'自定义接口',protocol:'chat-completions',baseUrl:''},
]);
export const presetFor=kind=>MODEL_PRESETS.find(value=>value.kind===kind);
export function apiBaseUrl(value){
  let url;try{url=new URL(value);}catch{throw Error('请填写有效的服务地址');}
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.protocol!=='https:'&&!(local&&url.protocol==='http:'))throw Error('服务地址须使用 HTTPS；本机接口可使用 HTTP');
  if(url.username||url.password||url.search||url.hash)throw Error('服务地址不能包含密钥、查询参数或用户名');
  return url.toString().replace(/\/+$/,'');
}
export const localEndpoint=value=>{try{return ['localhost','127.0.0.1','[::1]'].includes(new URL(value).hostname);}catch{return false;}};
