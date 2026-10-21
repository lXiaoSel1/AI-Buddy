// Name plates: a built-in character wears its own theme's plate colours (so speakers stay
// recognisable in group chat whatever theme is active), the user takes the current accent,
// the narrator a quiet surface, and a custom character keeps its chosen colour.
import {THEME_PALETTES} from './theme-palettes.mjs';

const PLATES=Object.fromEntries(THEME_PALETTES.map(p=>[p.id,p.colors]));
const channel=v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;};
const luminance=hex=>{const n=parseInt(hex.slice(1),16);return .2126*channel(n>>16&255)+.7152*channel(n>>8&255)+.0722*channel(n&255);};
export const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
export const readableOn=hex=>contrast('#111111',hex)>=contrast('#FFFFFF',hex)?'#111111':'#FFFFFF';
// who: 'heroine' | 'character' | 'user' | 'narrator'
export function plateVars({who='character',characterId=null,color=null}={}){
 if(who==='user')return {'--plate-bg':'var(--buddy-accent)','--plate-text':'var(--buddy-on-accent)'};
 if(who==='narrator')return {'--plate-bg':'var(--buddy-surface2)','--plate-text':'var(--buddy-text)'};
 const own=PLATES[characterId];if(own)return {'--plate-bg':own.plateBg,'--plate-text':own.plateText};
 if(typeof color==='string'&&/^#[0-9a-f]{6}$/i.test(color))return {'--plate-bg':color,'--plate-text':readableOn(color)};
 return {};
}
