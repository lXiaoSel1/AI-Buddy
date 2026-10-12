import messages from './locales/en.json' with {type:'json'};
let current='zh-CN';
export const locale=()=>current;
export function setLocale(value){current=value==='en'?'en':'zh-CN';if(typeof document!=='undefined')document.documentElement.lang=current;return current;}
export function t(text,language=current){if(typeof text!=='string')return text;return language==='en'?(messages[text]??text):text.replaceAll('AI娘','AI 酱');}
export function localizedTitle(language=current){return language==='en'?'AI Buddy · Local AI activity':'AI 酱 · 本地工作监控';}
