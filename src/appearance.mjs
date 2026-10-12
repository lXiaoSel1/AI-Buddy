// Hues sampled from the approved v167 portraits; tones adjusted for readable UI.
export const THEMES=Object.freeze({
 deepseek:{name:'DeepSeek',accent:'#87c9ee',secondary:'#8293d5',hue:218},
 grok:{name:'Grok',accent:'#dfbe79',secondary:'#bc7187',hue:339},
 seed:{name:'Seed',accent:'#b4a3dc',secondary:'#75c9df',hue:256},
 kimi:{name:'Kimi',accent:'#bdc2ed',secondary:'#819ad1',hue:233},
 qwen:{name:'Qwen',accent:'#9caaf0',secondary:'#c7b785',hue:236},
 minimax:{name:'MiniMax',accent:'#e9aa99',secondary:'#e2c8a8',hue:13},
 chatgpt:{name:'GPT',accent:'#d8d2ea',secondary:'#afa1cf',hue:265},
 gemini:{name:'Gemini',accent:'#b59bed',secondary:'#8cbbe8',hue:258},
 claude:{name:'Claude',accent:'#e7ad87',secondary:'#dcc19d',hue:24},
 glm:{name:'GLM',accent:'#b2b6ca',secondary:'#90a8c3',hue:233},
 hunyuan:{name:'混元',nameEn:'Hunyuan',accent:'#a0b1d6',secondary:'#ce8b93',hue:222},
});
export function resolvedTheme(preferences={},character='deepseek'){return preferences.themeMode==='character'&&THEMES[character]?character:THEMES[preferences.theme]?preferences.theme:'deepseek';}
export function chromeColor(id){const h=(THEMES[id]||THEMES.deepseek).hue/360,s=.42,l=.1,a=s*Math.min(l,1-l),f=n=>{const k=(n+h*12)%12;return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1)))).toString(16).padStart(2,'0');};return '#'+f(0)+f(8)+f(4);}
export function themeVariables(id='deepseek'){
 const t=THEMES[id]||THEMES.deepseek,h=t.hue;
 return {'--buddy-bg':`hsl(${h} 43% 8%)`,'--buddy-sidebar':`hsl(${h} 42% 10%)`,'--buddy-surface':`hsl(${h} 36% 13%)`,'--buddy-raised':`hsl(${h} 31% 18%)`,'--buddy-border':`hsl(${h} 24% 28%)`,'--buddy-accent':t.accent,'--buddy-secondary':t.secondary,'--buddy-text':'#e5edf5','--buddy-muted':'#a4b1c2'};
}
export function applyAppearance(preferences={},character='deepseek'){
 if(typeof document==='undefined')return;const id=resolvedTheme(preferences,character);document.documentElement.dataset.theme=id;
 for(const[k,v]of Object.entries(themeVariables(id)))document.documentElement.style.setProperty(k,v);
}
