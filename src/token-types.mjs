export const TOOL_NAMES={codex:'Codex',claude:'Claude Code',gemini:'Gemini CLI',kimi:'Kimi Code CLI',opencode:'OpenCode',cline:'Cline',roo:'Roo Code',dsh:'DeepSeek Harness',companion:'AI娘',custom:'自定义'};
export const PROVIDER_NAMES={openai:'OpenAI',anthropic:'Anthropic',google:'Google',zhipu:'智谱 GLM',moonshot:'Moonshot Kimi',volcengine:'火山方舟 / 豆包',deepseek:'DeepSeek',qwen:'通义千问',xai:'xAI Grok',openrouter:'OpenRouter',minimax:'MiniMax',unknown:'未记录'};
export function providerFor(model='',reported=''){
 const text=String(['custom','openai-compatible'].includes(reported)?model:reported||model).toLowerCase();
 for(const [key,re] of Object.entries({openrouter:/openrouter/,zhipu:/glm|zhipu|bigmodel|z-ai|\bzai\b|z\.ai/,volcengine:/doubao|volc|ark/,moonshot:/kimi|moonshot/,google:/gemini|google/,anthropic:/claude|anthropic/,openai:/gpt|openai|^o[134]-/,deepseek:/deepseek/,qwen:/qwen|dashscope|aliyun/,xai:/grok|xai|x-ai/,minimax:/minimax|^abab/}))if(re.test(text))return key;
 return reported||'unknown';
}

export const FORMATS=['auto','jsonl','jsonl.zstd','json','csv','sqlite'];
export const providerLabel=(id,aliases={})=>Object.hasOwn(aliases,id)?aliases[id]:Object.hasOwn(PROVIDER_NAMES,id)?PROVIDER_NAMES[id]:String(id||'未记录');
