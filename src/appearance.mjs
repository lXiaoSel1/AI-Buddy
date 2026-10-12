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
export const DEFAULT_THEME_TONE='medium';
export const THEME_TONES=Object.freeze(['original','medium','light']);
export function hslHex(hue,saturation,lightness){const h=hue/360,s=saturation/100,l=lightness/100,a=s*Math.min(l,1-l),f=n=>{const k=(n+h*12)%12;return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1)))).toString(16).padStart(2,'0');};return '#'+f(0)+f(8)+f(4);}
export function themeTone(id){return !THEMES[id]||id==='deepseek'?'original':DEFAULT_THEME_TONE;}
export function chromeColor(id,tone=themeTone(id)){const h=(THEMES[id]||THEMES.deepseek).hue;return hslHex(h,tone==='light'?26:42,tone==='light'?91:tone==='original'?10:19);}
export function themeVariables(id='deepseek',tone=themeTone(id)){
 const t=THEMES[id]||THEMES.deepseek,h=t.hue,light=tone==='light',original=tone==='original';
 const levels=light?[95,91,98,94,72]:original?[8,10,13,18,28]:[16,19,23,29,43];
 const colors=Object.fromEntries(['bg','sidebar','surface','raised','border'].map((name,i)=>['--buddy-'+name,`hsl(${h} ${light?[28,26,22,26,18][i]:[43,42,36,31,24][i]}% ${levels[i]}%)`]));
 return {...colors,'--buddy-accent':light?hslHex(h,58,35):t.accent,'--buddy-secondary':t.secondary,'--buddy-text':light?hslHex(h,32,18):original?'#e5edf5':'#eef4fb','--buddy-muted':light?hslHex(h,22,36):original?'#a4b1c2':'#c0cedc','--buddy-on-accent':light?'#ffffff':hslHex(h,40,12),'--buddy-success':light?'#17674d':'#99e8c5','--buddy-warning':light?'#755100':'#f4d898','--buddy-danger':light?'#a32c40':'#ffc3ca','--buddy-scrim':light?'#18253d55':'#02071299','--buddy-shadow':light?'#1a31491c':'#03091245','--buddy-scheme':light?'light':'dark'};
}
export function applyAppearance(preferences={},character='deepseek'){
 if(typeof document==='undefined')return;const id=resolvedTheme(preferences,character),tone=globalThis.__buddyPreviewTone??themeTone(id);document.documentElement.dataset.theme=id;document.documentElement.dataset.tone=tone;
 for(const[k,v]of Object.entries(themeVariables(id,tone)))document.documentElement.style.setProperty(k,v);
}
